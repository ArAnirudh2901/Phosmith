// Deterministic edit planner. PURE FUNCTION — same inputs always produce the same
// output. No Math.random, no Date.now, no clock reads. The whole point is that
// "edit the same image multiple times with the same prompt" gives byte-identical
// adjustments, which is what makes the AI agent feel predictable.

import { ADJUSTMENT_RANGES, ADJUSTMENT_REASONS, STYLE_PROFILES } from "./style-profiles"

// Bump this when the planner output shape or numeric weights change so cached
// plans from older versions are invalidated cleanly.
//
// v4: expanded STYLE_PROFILES with film-stock and camera presets
//     (kodachrome, kodak-portra, fuji-pro400h, cinestill-800t, polaroid,
//     super8, bw-tri-x, red-cinema, arri-alexa, vhs-tape, golden-hour,
//     faded-pastel). Old cached plans used the 8-style vocabulary and would
//     misroute requests like "shot on RED camera" → "cinematic".
// v5: +17 creative grades/moods (moody-dark, bright-airy, matte-film,
//     hdr-clarity, teal-orange, neo-noir, sepia, cyberpunk, dreamy-glow,
//     autumn, cold-winter, tropical, cross-process, bleach-bypass,
//     technicolor, lomography, earthy-muted) AND a directAdjustments channel
//     so explicit tonal requests ("30% brighter", "warmer", "add grain") apply
//     even with no named style. Old caches lacked both.
// v6: criticFeedback channel — the judge/critic loop (see agent/critic.js and
//     /api/ai/edit-judge) re-enters the planner with a SMALL ADDITIVE corrective
//     delta ("lift highlights -8 inside mask") instead of a full re-plan. The
//     corrective layer applies LAST (after style, corrections, and direct
//     adjustments) and bypasses the no-change guard, because a corrective by
//     definition means the previous output needs to move. Old cached plans
//     never carried corrective state, so a version bump invalidates cleanly.
export const PLANNER_VERSION = 6

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

const round = (v) => Math.round(v)

const isNonZero = (key, value) => {
    const neutral = ADJUSTMENT_RANGES[key]?.neutral ?? 0
    return Math.abs(value - neutral) >= 1
}

// Light "always-on" corrections derived from objective image features. These run
// independently of the style target — they fix obvious problems (underexposed,
// blown-out highlights, strong color cast) before we apply any stylistic look.
const computeCorrections = (features) => {
    const out = {}
    if (!features) return out
    const { luminance, contrast, highlightClipping, shadowClipping, warmth } = features

    // Exposure: pull mean luminance toward 0.5 (50% gray) — only nudge, never overshoot.
    if (luminance && luminance.mean < 0.36) {
        out.brightness = round(clamp((0.5 - luminance.mean) * 110, 0, 22))
    } else if (luminance && luminance.mean > 0.72) {
        out.brightness = round(clamp((0.5 - luminance.mean) * 110, -22, 0))
    }

    // Contrast: low-contrast images get a small boost; already-punchy images left alone.
    if (typeof contrast === "number" && contrast < 0.4) {
        out.contrast = round(clamp((0.55 - contrast) * 35, 0, 14))
    }

    // Highlight recovery and shadow lift both move gamma. Compute each as a
    // signed delta from neutral (100) and net them into a single gamma value so
    // one signal does not clobber the other (an image can be both highlight-
    // clipped and shadow-crushed). Single-signal magnitudes are preserved.
    let gammaDelta = 0
    // Highlight recovery: if more than ~3% of pixels are clipped white, pull
    // highlights down via a gamma decrease.
    if (typeof highlightClipping === "number" && highlightClipping > 0.03) {
        gammaDelta += clamp(100 - highlightClipping * 200, 80, 100) - 100
    }
    // Shadow lift: if more than ~6% of pixels are crushed to black, lift gamma.
    if (typeof shadowClipping === "number" && shadowClipping > 0.06) {
        gammaDelta += clamp(100 + shadowClipping * 140, 100, 122) - 100
    }
    if (gammaDelta !== 0) {
        out.gamma = round(clamp(100 + gammaDelta, 80, 122))
    }

    // White-balance: strong warm cast → cool slightly; strong cool cast → warm slightly.
    if (typeof warmth === "number" && Math.abs(warmth) > 0.08) {
        out.temperature = round(clamp(-warmth * 60, -18, 18))
    }

    return out
}

const mergeAdjustments = (base, extra) => {
    const out = { ...base }
    for (const [key, value] of Object.entries(extra || {})) {
        const range = ADJUSTMENT_RANGES[key]
        if (!range) continue
        const existing = Object.prototype.hasOwnProperty.call(out, key) ? out[key] : range.neutral
        // For gamma the "neutral" is 100, so we treat both as deltas from neutral.
        const delta1 = existing - range.neutral
        const delta2 = value - range.neutral
        // Sum deltas but don't let them double when both push the same direction:
        // use a soft cap at the larger absolute delta to avoid over-correction stacking.
        let combinedDelta
        if (Math.sign(delta1) === Math.sign(delta2)) {
            combinedDelta = Math.sign(delta1 || delta2) * Math.max(Math.abs(delta1), Math.abs(delta2))
            // Add a small fraction of the other to retain some additivity
            combinedDelta += Math.sign(combinedDelta) * Math.min(Math.abs(delta1), Math.abs(delta2)) * 0.4
        } else {
            combinedDelta = delta1 + delta2
        }
        out[key] = round(clamp(range.neutral + combinedDelta, range.min, range.max))
    }
    return out
}

const applyGain = (vec, gain) => {
    if (gain >= 0.999) return { ...vec }
    if (gain <= 0.001) return {}
    const out = {}
    for (const [key, value] of Object.entries(vec || {})) {
        const range = ADJUSTMENT_RANGES[key]
        if (!range) continue
        const delta = value - range.neutral
        out[key] = round(clamp(range.neutral + delta * gain, range.min, range.max))
    }
    return out
}

const enumerateEntries = (adjustments) =>
    Object.entries(adjustments)
        .filter(([key, value]) => ADJUSTMENT_RANGES[key] && isNonZero(key, value))
        .map(([key, value]) => {
            const range = ADJUSTMENT_RANGES[key]
            return {
                key,
                value,
                min: range.min,
                max: range.max,
                neutral: range.neutral,
                label: range.label,
                kind: "fabric-adjustment",
                why: ADJUSTMENT_REASONS[key] || "",
            }
        })

/**
 * Build a deterministic edit plan.
 *
 * @param {object} params
 * @param {object} params.features          Output of extractImageFeatures()
 * @param {string} params.targetStyle       One of STYLE_PROFILES keys
 * @param {string} [params.currentStyle]    Classification of the source image (for context)
 * @param {number} [params.gain]            0..1 strength multiplier. ~0 = no-op.
 * @param {boolean} [params.alreadyMatchesTarget]  Force gain to 0 when true.
 * @param {string} [params.notes]           Human-readable rationale (passed through)
 * @param {object} [params.imagekitAi]      { retouch, bgRemove, upscale, sharpen, contrast }
 * @returns {object} Plan
 */
const sanitizeDirectAdjustments = (raw) => {
    const out = {}
    if (!raw || typeof raw !== "object") return out
    for (const [key, value] of Object.entries(raw)) {
        const range = ADJUSTMENT_RANGES[key]
        let num = Number(value)
        if (!range || !Number.isFinite(num)) continue
        // Gamma disambiguation: gamma is an absolute scale (neutral 100, 20..220)
        // but every other channel uses deltas around their neutral. Models often
        // emit gamma as a delta too (e.g. 15 meaning "+15", -10 meaning "-10").
        // A small-magnitude absolute value (|v| <= 40) would otherwise clamp to
        // the 20 floor and cause heavy unintended darkening, so treat it as a
        // delta from neutral instead. Legitimate absolute values (>= ~50) are
        // left untouched.
        if (key === "gamma" && Math.abs(num) <= 40) {
            num = range.neutral + num
        }
        const clamped = round(clamp(num, range.min, range.max))
        if (isNonZero(key, clamped)) out[key] = clamped
    }
    return out
}

export const buildEditPlan = ({
    features = null,
    targetStyle = "neutral",
    currentStyle = "neutral",
    gain = 0.6,
    alreadyMatchesTarget = false,
    notes = "",
    imagekitAi = {},
    directAdjustments = null,
    // v6: corrective feedback from the critic loop — `{ deltas, notes, axis }`.
    // `deltas` are SIGNED moves from the previous output (e.g. {brightness: -8})
    // in the same units as STYLE_PROFILES; they apply as the LAST layer.
    criticFeedback = null,
} = {}) => {
    const safeGain = alreadyMatchesTarget
        ? 0
        : clamp(Number.isFinite(gain) ? gain : 0.6, 0, 1)

    // Explicit, user-requested tonal moves ("warmer", "30% brighter", "add
    // grain"). These are authoritative and apply regardless of style gain, so a
    // bare "make it warmer" works even with no named style (targetStyle=neutral).
    const directVec = sanitizeDirectAdjustments(directAdjustments)
    const hasDirect = Object.keys(directVec).length > 0

    // v6: corrective deltas from the critic. Deltas are signed moves, so they
    // are converted to absolute values around each range's neutral before the
    // sanitizer (which expects absolutes) sees them. An empty/invalid payload
    // degrades to "no corrective" — the loop never crashes the planner.
    const criticVec = (() => {
        const deltas = criticFeedback?.deltas
        if (!deltas || typeof deltas !== "object") return {}
        const abs = {}
        for (const [key, delta] of Object.entries(deltas)) {
            const range = ADJUSTMENT_RANGES[key]
            const num = Number(delta)
            if (!range || !Number.isFinite(num)) continue
            abs[key] = range.neutral + num
        }
        return sanitizeDirectAdjustments(abs)
    })()
    const hasCorrective = Object.keys(criticVec).length > 0
    const correctiveNotes = hasCorrective || criticFeedback?.notes
        ? String(criticFeedback?.notes || "").trim()
        : ""

    // No-change guard: if the image already matches the target AND gain is 0 AND
    // the user didn't ask for any explicit adjustment, return a zero-change plan.
    // This guarantees idempotency for pure restyle prompts on already-styled
    // images — but never suppresses an explicit direct adjustment or a critic
    // corrective (a corrective means the previous output must move).
    if (alreadyMatchesTarget && safeGain === 0 && !hasDirect && !hasCorrective) {
        return {
            plannerVersion: PLANNER_VERSION,
            currentStyle,
            targetStyle,
            gain: 0,
            alreadyMatchesTarget: true,
            notes: String(notes || "Image already matches the target style — no changes applied.").trim(),
            adjustments: {},
            entries: [],
            imagekitAi: {
                retouch: !!imagekitAi.retouch,
                bgRemove: !!imagekitAi.bgRemove,
                upscale: !!imagekitAi.upscale,
                sharpen: !!imagekitAi.sharpen,
                contrast: !!imagekitAi.contrast,
            },
        }
    }

    // Direct-only path: the no-change guard above was bypassed ONLY because the
    // user asked for an explicit adjustment on an image that already matches the
    // target (gain 0). In that case apply just the requested delta — do not drag
    // in the objective correction stack (brightness/contrast/gamma), which the
    // user did not ask for. So "make it warmer" applies only the warmth move.
    const directOnly = alreadyMatchesTarget && safeGain === 0 && (hasDirect || hasCorrective)
    const base = directOnly
        ? mergeAdjustments({}, directVec)
        : (() => {
              const styleVec = STYLE_PROFILES[targetStyle] || STYLE_PROFILES.neutral
              const scaledStyle = applyGain(styleVec, safeGain)
              const corrections = computeCorrections(features)
              // Layer order: style (gain-scaled) → objective corrections →
              // explicit user adjustments last so a direct "make it warmer" is
              // never overridden by the style/correction layers. Corrections
              // always apply even when style gain is 0.
              return mergeAdjustments(mergeAdjustments(scaledStyle, corrections), directVec)
          })()
    // v6: the critic corrective is the FINAL layer — it encodes what the judge
    // saw in the actual rendered output, which trumps every prior heuristic.
    const merged = hasCorrective ? mergeAdjustments(base, criticVec) : base
    const entries = enumerateEntries(merged)

    const combinedNotes = [String(notes || "").trim(), correctiveNotes]
        .filter(Boolean)
        .join(" | ")

    return {
        plannerVersion: PLANNER_VERSION,
        currentStyle,
        targetStyle,
        gain: safeGain,
        alreadyMatchesTarget,
        notes: combinedNotes,
        criticApplied: hasCorrective ? { axis: criticFeedback?.axis ?? null, deltas: criticFeedback?.deltas ?? null } : null,
        adjustments: merged,
        entries,
        imagekitAi: {
            retouch: !!imagekitAi.retouch,
            bgRemove: !!imagekitAi.bgRemove,
            upscale: !!imagekitAi.upscale,
            sharpen: !!imagekitAi.sharpen,
            contrast: !!imagekitAi.contrast,
        },
    }
}

// Re-export ranges for the UI so it can render sliders without importing two files.
export { ADJUSTMENT_RANGES }
