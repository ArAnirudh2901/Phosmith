// ─── /api/ai/edit-judge ──────────────────────────────────────────────────────
// Human-aligned, 12-axis judge for executed edits — the "did the colour grade
// actually land?" half of the planner-executor-critic loop.
//
// Mirrors /api/ai/edit-plan's production discipline exactly:
//   1. Clerk auth + per-user rate limit.
//   2. Neon editJudgeCache keyed (beforeHash, afterHash, planHash, judgeVersion)
//      — identical tuples return byte-identical scores forever.
//   3. Cache miss → Gemini vision pass over BOTH renders (before + after) with
//      temperature 0, seed 42, and a strict reasoning-first response schema:
//      one { reasoning, score } object PER axis, because decomposed judges
//      match human raters and single-score judges don't.
//   4. Deterministic guards run BEFORE the model: byte-identical before/after
//      short-circuits to a no-change verdict with zero model calls.
//   5. No API key / model failure → deterministic heuristic verdict from the
//      client-computed feature vectors (marked source:"fallback") so the loop
//      keeps functioning offline.
//
// The response embeds the pure-function critic's verdict (`critic`) so a
// single round-trip tells the caller both "how good is it per axis" and
// "what corrective delta should re-enter the planner".

import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { createHash } from "node:crypto"
import { getNeonAuthContext } from "@/lib/neon/auth"
import { runNeonMutation, runNeonQuery } from "@/lib/neon/functions"
import { enforceRateLimit, rateLimitResponse } from "@/lib/rate-limit"
import { critique, JUDGE_AXES } from "@/lib/agent/critic"
import { STYLE_KEYS, STYLE_DESCRIPTORS } from "@/lib/style-profiles"

export const maxDuration = 60
export const runtime = "nodejs"

// Bump when the axis set, prompt, or scoring semantics change so cached
// verdicts from older judges are invalidated cleanly (same rule as
// PLANNER_VERSION).
export const JUDGE_VERSION = 1

const GEMINI_MODEL = process.env.GEMINI_JUDGE_MODEL || process.env.GEMINI_MODEL || "gemini-3.5-flash"
const GEMINI_ENDPOINT = (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
// The judge reasons across 12 axes over two images — give it more room than
// the planner's 12 s, but stay well inside maxDuration.
const GEMINI_TIMEOUT_MS = 25_000
const MAX_IMAGE_BASE64_CHARS = 3 * 1024 * 1024

const isGemini3Model = (model) => /^gemini-3/i.test(model || "")
const GEMINI3_THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || "low"
const GEMINI3_MEDIA_RESOLUTION = process.env.GEMINI_MEDIA_RESOLUTION || "MEDIA_RESOLUTION_HIGH"

const tuneGenerationConfig = (model, baseConfig, { safe = false } = {}) => {
    if (safe) {
        const safeConfig = { ...baseConfig }
        delete safeConfig.seed
        delete safeConfig.topP
        delete safeConfig.topK
        return safeConfig
    }
    if (!isGemini3Model(model)) return baseConfig
    return {
        ...baseConfig,
        mediaResolution: GEMINI3_MEDIA_RESOLUTION,
        thinkingConfig: { thinkingLevel: GEMINI3_THINKING_LEVEL },
    }
}

const sha16 = (input) => createHash("sha256").update(input).digest("hex").slice(0, 16)

// Stable stringify: sorted keys at every level so the SAME plan always hashes
// to the SAME planHash regardless of property insertion order.
const stableStringify = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`
}

// ── The 12-axis system prompt ────────────────────────────────────────────────

const AXIS_GUIDANCE = `Score every axis from 0.0 (complete failure) to 1.0 (flawless), reasoning BEFORE scoring:

1. instruction_fidelity — does the AFTER image actually do what the user's instruction asked? Judge the instruction, not your taste.
2. identity_preservation — is everything OUTSIDE the intended edit region unchanged? Faces, textures, and background must not drift.
3. mask_edge_plausibility — look at edit boundaries: halos, fringing, hard cut lines, glow bleeding past the subject.
4. local_artifact_rate — inside the edited region: posterization, banding in gradients (sky!), blocking, crushed texture.
5. exposure_correctness — luminance level and highlight/shadow clipping match BOTH the instruction's intent and the source's latitude. Blown highlights that weren't requested are a failure.
6. color_faithfulness — hue and saturation moved in the INTENDED direction only. Watch for parasitic shifts: skin going orange when only the sky should warm, greens going neon from a global vibrance push.
7. aesthetic_improvement — an honest before-vs-after preference call, as a senior colourist would make it. "Different" is not "better".
8. no_change_idempotency — if the plan says no change was needed, the images must match; if the plan made changes, score how well a REPEAT of the same instruction would now be a no-op (is the target state actually reached, not overshot?).
9. prompt_keyword_coverage — every salient keyword in the instruction ("warmer", "30%", "cinematic", "the sky") corresponds to a visible, measurable change. Ignored keywords lower the score.
10. style_profile_match — when a target style is named, does the AFTER image sit inside that style's expected look (its descriptor is provided)?
11. depth_geometry_consistency — depth/geometry must be untouched by a tonal grade: no warping, no smearing, subject-background separation preserved. If depth maps are provided, compare them.
12. overall — one calibrated number for ranking. NOT an average: weigh instruction_fidelity and identity_preservation most heavily.

Then, ONLY if overall < 0.8, emit corrective_hint: ONE surgical, quantified instruction the planner can apply as a small additive delta (e.g. "Lift highlights -8 inside the mask; leave shadows unchanged."). If overall >= 0.8 omit corrective_hint entirely.

Judge like a working professional: a grade can be technically clean and still fail instruction_fidelity; a beautiful grade the user didn't ask for is a failure. Be strict about parasitic colour shifts — they are the #1 reason humans reject automated grades.`

const buildSystemPrompt = (targetStyle) => {
    const descriptor = targetStyle && STYLE_KEYS.includes(targetStyle) ? STYLE_DESCRIPTORS?.[targetStyle] : null
    const styleNote = descriptor
        ? `\nThe requested target style is "${targetStyle}": ${descriptor.characteristics || JSON.stringify(descriptor)}.`
        : "\nNo named target style was requested."
    return `You are a senior photo colourist and retoucher acting as a fine-grained edit judge. You receive the BEFORE image, the AFTER image, the user's instruction, the executed plan JSON, and client-computed feature vectors for both images.${styleNote}

${AXIS_GUIDANCE}

Output JSON only, matching the response schema exactly.`
}

const STRICTER_RETRY_SUFFIX =
    "\n\nPrevious response was not valid JSON. YOU MUST RETURN VALID JSON. NO COMMENTS. NO MARKDOWN FENCES. NO PROSE. Only the object."

const axisSchema = {
    type: "OBJECT",
    // reasoning FIRST — the model must justify before it scores.
    properties: {
        reasoning: { type: "STRING" },
        score: { type: "NUMBER" },
    },
    required: ["reasoning", "score"],
}

const buildResponseSchema = () => ({
    type: "OBJECT",
    properties: {
        axes: {
            type: "OBJECT",
            properties: Object.fromEntries(JUDGE_AXES.map((a) => [a, axisSchema])),
            required: [...JUDGE_AXES],
        },
        corrective_hint: { type: "STRING" },
    },
    required: ["axes"],
})

const callGeminiOnce = async ({
    apiKey, model, prompt, plan, beforeImage, afterImage, beforeFeatures, afterFeatures,
    beforeDepth, afterDepth, systemPrompt, safeConfig = false,
}) => {
    const parts = [
        { text: "BEFORE image:" },
        { inlineData: { mimeType: beforeImage.mimeType, data: beforeImage.base64 } },
        { text: "AFTER image:" },
        { inlineData: { mimeType: afterImage.mimeType, data: afterImage.base64 } },
    ]
    if (beforeDepth && afterDepth) {
        parts.push({ text: "BEFORE depth map (white = near):" })
        parts.push({ inlineData: { mimeType: "image/png", data: beforeDepth } })
        parts.push({ text: "AFTER depth map (white = near):" })
        parts.push({ inlineData: { mimeType: "image/png", data: afterDepth } })
    }
    parts.push({
        text: [
            `User instruction: ${prompt || "(none — default enhancement)"}`,
            `Executed plan JSON:\n${JSON.stringify(plan || {})}`,
            `BEFORE image features:\n${JSON.stringify(beforeFeatures || {})}`,
            `AFTER image features:\n${JSON.stringify(afterFeatures || {})}`,
        ].join("\n\n"),
    })

    const baseGenerationConfig = {
        temperature: 0,
        topP: 0,
        topK: 1,
        seed: 42,
        responseMimeType: "application/json",
        responseSchema: buildResponseSchema(),
        // 12 axes × (reasoning + score) needs real room; Flash handles this fine.
        maxOutputTokens: 4096,
    }

    const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts }],
        generationConfig: tuneGenerationConfig(model, baseGenerationConfig, { safe: safeConfig }),
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
    try {
        const response = await fetch(`${GEMINI_ENDPOINT(model)}?key=${encodeURIComponent(apiKey)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        })
        if (!response.ok) {
            const text = await response.text().catch(() => "")
            throw new Error(`Gemini ${response.status}: ${text.slice(0, 200)}`)
        }
        const json = await response.json()
        const textOut = json?.candidates?.[0]?.content?.parts?.[0]?.text
        if (!textOut) throw new Error("Gemini returned no text")
        return JSON.parse(textOut)
    } finally {
        clearTimeout(timeout)
    }
}

const callGemini = async (params) => {
    const systemPrompt = buildSystemPrompt(params.targetStyle)
    try {
        return await callGeminiOnce({ ...params, systemPrompt })
    } catch (firstError) {
        console.warn("[edit-judge] Gemini first attempt failed, retrying strict + safe:", firstError?.message)
        return await callGeminiOnce({
            ...params,
            systemPrompt: systemPrompt + STRICTER_RETRY_SUFFIX,
            safeConfig: true,
        })
    }
}

// ── Verdict sanitization ─────────────────────────────────────────────────────
// The schema constrains shape, not sanity. Clamp every score into [0,1], fill
// any missing axis with a conservative 0.5 ("could not verify"), and bound
// reasoning length so a runaway string never lands in the cache.

const clamp01 = (v) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return null
    return Math.max(0, Math.min(1, n))
}

const sanitizeVerdict = (raw) => {
    const axes = {}
    for (const axis of JUDGE_AXES) {
        const entry = raw?.axes?.[axis]
        const score = clamp01(entry?.score)
        axes[axis] = {
            score: score ?? 0.5,
            reasoning: String(entry?.reasoning || (score == null ? "axis missing from model output" : "")).slice(0, 600),
        }
    }
    const hint = typeof raw?.corrective_hint === "string" && raw.corrective_hint.trim()
        ? raw.corrective_hint.trim().slice(0, 300)
        : null
    return { axes, correctiveHint: hint }
}

// ── Deterministic verdicts (no model call) ───────────────────────────────────

const NO_CHANGE_REASON = "before and after are byte-identical"

const buildNoChangeVerdict = (plan) => {
    const planMadeChanges = Object.keys(plan?.adjustments || {}).length > 0
    const axes = {}
    for (const axis of JUDGE_AXES) {
        axes[axis] = { score: 1, reasoning: NO_CHANGE_REASON }
    }
    // If the plan CLAIMED to change things but pixels didn't move, fidelity and
    // coverage failed even though preservation is perfect.
    if (planMadeChanges) {
        axes.instruction_fidelity = { score: 0, reasoning: "plan specified adjustments but the output is identical to the input — the edit did not apply" }
        axes.prompt_keyword_coverage = { score: 0, reasoning: "no measurable change corresponds to any prompt keyword" }
        axes.aesthetic_improvement = { score: 0.5, reasoning: NO_CHANGE_REASON }
        axes.overall = { score: 0.2, reasoning: "edit failed to apply" }
    }
    return {
        axes,
        correctiveHint: planMadeChanges ? "Re-execute the plan — the rendered output did not change." : null,
    }
}

// Heuristic fallback: deterministic per-axis scores from feature-vector deltas.
// Coarse, but honest about its own uncertainty (0.5 = could not verify) and
// directionally correct on exposure/colour — enough to keep the critic loop
// alive with no model.
const buildHeuristicVerdict = ({ plan, beforeFeatures, afterFeatures }) => {
    const axes = {}
    for (const axis of JUDGE_AXES) {
        axes[axis] = { score: 0.5, reasoning: "no vision model available — unverified" }
    }
    const adj = plan?.adjustments || {}
    const lumB = beforeFeatures?.luminance?.mean
    const lumA = afterFeatures?.luminance?.mean
    const warmB = beforeFeatures?.warmth
    const warmA = afterFeatures?.warmth

    if (typeof lumB === "number" && typeof lumA === "number") {
        const delta = lumA - lumB
        const wanted = Number(adj.brightness) || 0
        const directionOk = wanted === 0 ? Math.abs(delta) < 0.04 : Math.sign(delta) === Math.sign(wanted)
        axes.exposure_correctness = {
            score: directionOk ? 0.8 : 0.25,
            reasoning: `luminance moved ${delta.toFixed(3)} vs planned brightness ${wanted}`,
        }
        const clippedA = afterFeatures?.highlightClipping
        if (typeof clippedA === "number" && clippedA > 0.06) {
            axes.exposure_correctness = { score: Math.min(axes.exposure_correctness.score, 0.3), reasoning: `highlight clipping at ${(clippedA * 100).toFixed(1)}% after the edit` }
        }
    }
    if (typeof warmB === "number" && typeof warmA === "number") {
        const delta = warmA - warmB
        const wanted = Number(adj.temperature) || 0
        const directionOk = wanted === 0 ? Math.abs(delta) < 0.03 : Math.sign(delta) === Math.sign(wanted)
        axes.color_faithfulness = {
            score: directionOk ? 0.75 : 0.25,
            reasoning: `warmth moved ${delta.toFixed(3)} vs planned temperature ${wanted}`,
        }
    }
    const moved = (typeof lumB === "number" && typeof lumA === "number" && Math.abs(lumA - lumB) > 0.005)
        || (typeof warmB === "number" && typeof warmA === "number" && Math.abs(warmA - warmB) > 0.005)
    const planMadeChanges = Object.keys(adj).length > 0
    axes.instruction_fidelity = {
        score: planMadeChanges === moved ? 0.7 : 0.3,
        reasoning: planMadeChanges
            ? (moved ? "plan made changes and features moved" : "plan made changes but features did not move")
            : (moved ? "plan made no changes but features moved" : "no-op plan, no movement"),
    }
    const scores = JUDGE_AXES.filter((a) => a !== "overall").map((a) => axes[a].score)
    axes.overall = {
        score: Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 100) / 100,
        reasoning: "heuristic mean of verifiable axes (no vision model)",
    }
    return { axes, correctiveHint: null }
}

// ── Route ────────────────────────────────────────────────────────────────────

export async function POST(request) {
    try {
        const { userId } = await auth()
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const limited = rateLimitResponse(await enforceRateLimit("edit-judge", userId))
        if (limited) return limited

        const neonAuth = await getNeonAuthContext()
        const body = await request.json().catch(() => ({}))

        const projectId = body.projectId
        const prompt = String(body.prompt || "").slice(0, 1000)
        const plan = body.plan && typeof body.plan === "object" ? body.plan : null
        const targetStyle = typeof body.targetStyle === "string" ? body.targetStyle : plan?.targetStyle || null
        const beforeFeatures = body.beforeFeatures && typeof body.beforeFeatures === "object" ? body.beforeFeatures : null
        const afterFeatures = body.afterFeatures && typeof body.afterFeatures === "object" ? body.afterFeatures : null
        const history = Array.isArray(body.criticHistory) ? body.criticHistory.slice(-4) : []

        const beforeBase64 = typeof body.beforeImageBase64 === "string" ? body.beforeImageBase64 : null
        const afterBase64 = typeof body.afterImageBase64 === "string" ? body.afterImageBase64 : null
        if (!plan) {
            return NextResponse.json({ error: "plan (object) is required" }, { status: 400 })
        }
        if (!beforeBase64 || !afterBase64) {
            return NextResponse.json({ error: "beforeImageBase64 and afterImageBase64 are required" }, { status: 400 })
        }
        if (beforeBase64.length > MAX_IMAGE_BASE64_CHARS || afterBase64.length > MAX_IMAGE_BASE64_CHARS) {
            return NextResponse.json({ error: "image payload too large" }, { status: 413 })
        }
        const beforeDepth = typeof body.beforeDepthBase64 === "string" && body.beforeDepthBase64.length <= MAX_IMAGE_BASE64_CHARS
            ? body.beforeDepthBase64 : null
        const afterDepth = typeof body.afterDepthBase64 === "string" && body.afterDepthBase64.length <= MAX_IMAGE_BASE64_CHARS
            ? body.afterDepthBase64 : null

        // Content-addressable identity — server-computed, never trusted from
        // the client, so cache rows can't be poisoned with mismatched hashes.
        const beforeHash = sha16(beforeBase64)
        const afterHash = sha16(afterBase64)
        const planHash = sha16(stableStringify(plan))

        // 1) Cache lookup.
        let verdict = null
        let source = null
        let cached = false
        try {
            const hit = await runNeonQuery(
                "editJudgeCache.getVerdict",
                { beforeHash, afterHash, planHash, judgeVersion: JUDGE_VERSION },
                { auth: neonAuth },
            )
            if (hit?.axes) {
                verdict = { axes: hit.axes, correctiveHint: hit.correctiveHint ?? null }
                source = hit.source || "cache"
                cached = true
            }
        } catch (cacheError) {
            console.warn("[edit-judge] cache lookup failed:", cacheError?.message || cacheError)
        }

        // 2) Deterministic no-change short-circuit — zero model calls.
        if (!verdict && beforeHash === afterHash) {
            verdict = buildNoChangeVerdict(plan)
            source = "deterministic"
        }

        // 3) Gemini 12-axis judge.
        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY
        let rawResponse = null
        if (!verdict && apiKey) {
            try {
                rawResponse = await callGemini({
                    apiKey,
                    model: GEMINI_MODEL,
                    prompt,
                    plan,
                    targetStyle,
                    beforeImage: { base64: beforeBase64, mimeType: body.beforeImageMime || "image/jpeg" },
                    afterImage: { base64: afterBase64, mimeType: body.afterImageMime || "image/jpeg" },
                    beforeFeatures,
                    afterFeatures,
                    beforeDepth,
                    afterDepth,
                })
                verdict = sanitizeVerdict(rawResponse)
                source = "gemini"
            } catch (error) {
                console.warn("[edit-judge] Gemini failed, using heuristic fallback:", error?.message || error)
            }
        }

        // 4) Heuristic fallback keeps the loop alive with no model.
        if (!verdict) {
            verdict = buildHeuristicVerdict({ plan, beforeFeatures, afterFeatures })
            source = "fallback"
        }

        // 5) Persist (best-effort) so the same tuple never pays for inference twice.
        if (!cached) {
            try {
                await runNeonMutation(
                    "editJudgeCache.saveVerdict",
                    {
                        beforeHash,
                        afterHash,
                        planHash,
                        judgeVersion: JUDGE_VERSION,
                        axes: verdict.axes,
                        overall: verdict.axes.overall?.score ?? 0,
                        correctiveHint: verdict.correctiveHint,
                        source,
                        projectId,
                        model: source === "gemini" ? GEMINI_MODEL : undefined,
                        rawResponse: source === "gemini" ? rawResponse : undefined,
                    },
                    { auth: neonAuth },
                )
            } catch (saveError) {
                console.warn("[edit-judge] cache save failed:", saveError?.message || saveError)
            }
        }

        // 6) Run the pure critic so one round-trip yields scores AND the
        // corrective payload for the planner's criticFeedback channel.
        const criticVerdict = critique({
            judgeJSON: { axes: verdict.axes, corrective_hint: verdict.correctiveHint },
            plan,
            beforeFeatures,
            afterFeatures,
            history,
        })

        return NextResponse.json({
            judgeVersion: JUDGE_VERSION,
            beforeHash,
            afterHash,
            planHash,
            axes: verdict.axes,
            overall: verdict.axes.overall?.score ?? 0,
            correctiveHint: verdict.correctiveHint,
            critic: criticVerdict,
            source,
            cached,
            model: source === "gemini" || cached ? GEMINI_MODEL : null,
        })
    } catch (error) {
        console.error("[edit-judge] ✗", error?.message)
        return NextResponse.json(
            { error: error?.message || "Edit judging failed" },
            { status: 500 },
        )
    }
}
