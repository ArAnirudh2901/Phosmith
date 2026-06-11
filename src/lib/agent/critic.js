/**
 * Agent Critic (pure function)
 * ----------------------------
 * Takes a 12-axis judge verdict (see /api/ai/edit-judge) and decides whether
 * the executed edit is acceptable or needs a corrective re-plan. PURE —
 * no clock, no random source, no I/O — so the same verdict always produces
 * the same critique, mirroring the planner's determinism guarantee.
 *
 * The corrective payload it emits is shaped to feed straight back into
 * `buildEditPlan({ criticFeedback })` (planner v6+) as a SMALL ADDITIVE DELTA
 * — surgical edits, never a throw-away-and-regenerate.
 *
 * Escalation guard: if the critic returns the SAME corrective axis twice in a
 * row (pass `history`), it escalates to user confirmation instead of looping —
 * corrective-hint convergence on pathological prompts is unproven.
 *
 * @module agent/critic
 */

export const CRITIC_VERSION = 1

/** The judge's 12 interpretable axes (order = presentation order). */
export const JUDGE_AXES = [
    "instruction_fidelity",       // does the edit do what the prompt asked?
    "identity_preservation",      // pixels outside the mask byte-stable?
    "mask_edge_plausibility",     // halos / fringing / hard lines at the boundary
    "local_artifact_rate",        // posterization, banding, blocking inside the edit
    "exposure_correctness",       // luminance + clipping match intent and source
    "color_faithfulness",         // hue/sat move in the intended direction, no parasitic shifts
    "aesthetic_improvement",      // honest before-vs-after preference call
    "no_change_idempotency",      // same prompt twice = no-op
    "prompt_keyword_coverage",    // every salient prompt keyword maps to a measurable change
    "style_profile_match",        // output sits inside the requested STYLE_PROFILES gravity
    "depth_geometry_consistency", // Depth Anything maps before/after agree where they should
    "overall",                    // single calibrated number for ranking + the no-change guard
]

/** Per-axis acceptance floors. Axes not listed use DEFAULT_FLOOR. */
const AXIS_FLOORS = {
    identity_preservation: 0.7, // touching pixels outside the mask is worse than a weak look
    local_artifact_rate: 0.65,
    overall: 0.6,
}
const DEFAULT_FLOOR = 0.6

/**
 * Map a failing axis to a deterministic corrective adjustment-delta vector
 * (planner units, additive). The judge's free-text hint rides along for the
 * vision pass; these numeric deltas are the surgical fallback that works even
 * with no second model call. Signs are derived from the before/after feature
 * movement when available.
 */
const correctiveDeltasFor = (axis, { beforeFeatures, afterFeatures } = {}) => {
    const lumBefore = beforeFeatures?.luminance?.mean
    const lumAfter = afterFeatures?.luminance?.mean
    const warmBefore = beforeFeatures?.warmth
    const warmAfter = afterFeatures?.warmth
    switch (axis) {
        case "exposure_correctness": {
            if (typeof lumAfter === "number") {
                if (lumAfter > 0.66) return { brightness: -8 }
                if (lumAfter < 0.34) return { brightness: 8 }
            }
            if (typeof lumBefore === "number" && typeof lumAfter === "number") {
                return { brightness: lumAfter > lumBefore ? -6 : 6 }
            }
            return {}
        }
        case "color_faithfulness": {
            if (typeof warmAfter === "number" && Math.abs(warmAfter) > 0.08) {
                return { temperature: Math.round(-warmAfter * 40) }
            }
            if (typeof warmBefore === "number" && typeof warmAfter === "number") {
                return { temperature: warmAfter > warmBefore ? -6 : 6 }
            }
            return {}
        }
        case "local_artifact_rate":
            // Banding/posterization is usually over-pushed contrast. (Sharpness
            // can't go below its neutral of 0, so contrast is the safe lever.)
            return { contrast: -6 }
        case "aesthetic_improvement":
        case "style_profile_match":
            // The look overshot or undershot — the planner re-runs with the
            // judge's hint; no blind numeric delta is safe here.
            return {}
        default:
            return {}
    }
}

/**
 * Critique a judge verdict.
 *
 * @param {object} params
 * @param {object} params.judgeJSON       { axes: { axis: {score, reasoning} }, corrective_hint }
 * @param {object} [params.plan]          the executed plan (context for the payload)
 * @param {object} [params.beforeFeatures] extractImageFeatures() of the source
 * @param {object} [params.afterFeatures]  extractImageFeatures() of the result
 * @param {Array<{axis: string}>} [params.history] previous corrective payloads this run
 * @returns {{ ok: true } | { ok: false, escalate: boolean, corrective: object }}
 */
export const critique = ({ judgeJSON, plan = null, beforeFeatures = null, afterFeatures = null, history = [] } = {}) => {
    const axes = judgeJSON?.axes || {}
    const failing = Object.entries(axes)
        .filter(([k, v]) => k !== "overall" && JUDGE_AXES.includes(k) && typeof v?.score === "number")
        .filter(([k, v]) => v.score < (AXIS_FLOORS[k] ?? DEFAULT_FLOOR))

    const overall = axes.overall?.score
    if (!failing.length && (typeof overall !== "number" || overall >= (AXIS_FLOORS.overall ?? DEFAULT_FLOOR))) {
        return { ok: true }
    }

    // Worst axis first; tie-break alphabetically so the critique is stable.
    const sorted = failing.sort((a, b) => (a[1].score - b[1].score) || (a[0] < b[0] ? -1 : 1))
    const [axis, verdict] = sorted[0] || ["overall", axes.overall || { score: overall ?? 0, reasoning: "overall below floor" }]

    // Escalation guard: same axis failed in the previous round → stop looping,
    // ask the user. (The brief's "same corrective twice in a row" rule.)
    const prev = Array.isArray(history) && history.length ? history[history.length - 1] : null
    const escalate = !!prev && prev.axis === axis

    return {
        ok: false,
        escalate,
        corrective: {
            criticVersion: CRITIC_VERSION,
            axis,
            score: verdict.score,
            reasoning: verdict.reasoning || "",
            hint: judgeJSON?.corrective_hint || null,
            deltas: correctiveDeltasFor(axis, { beforeFeatures, afterFeatures }),
            failingAxes: sorted.map(([k, v]) => ({ axis: k, score: v.score })),
            planTargetStyle: plan?.targetStyle ?? null,
        },
    }
}

/**
 * Shape a critic corrective into the planner v6 `criticFeedback` channel.
 * Returns null when there is nothing actionable (lets callers skip a re-plan).
 */
export const toCriticFeedback = (corrective) => {
    if (!corrective) return null
    const deltas = corrective.deltas && Object.keys(corrective.deltas).length ? corrective.deltas : null
    const notes = [
        `critic: ${corrective.axis} scored ${Number(corrective.score).toFixed(2)}`,
        corrective.reasoning,
        corrective.hint,
    ].filter(Boolean).join(" — ")
    if (!deltas && !corrective.hint) return null
    return { axis: corrective.axis, deltas, notes }
}
