// Deterministic edit planner. PURE FUNCTION — same inputs always produce the same
// output. No Math.random, no Date.now, no clock reads. The whole point is that
// "edit the same image multiple times with the same prompt" gives byte-identical
// adjustments, which is what makes the AI agent feel predictable.

import { ADJUSTMENT_RANGES, ADJUSTMENT_REASONS, STYLE_PROFILES } from "./style-profiles"

// Bump this when the planner output shape or numeric weights change so cached
// plans from older versions are invalidated cleanly.
export const PLANNER_VERSION = 1

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

    // Highlight recovery: if more than ~3% of pixels are clipped white, pull
    // highlights down via a gamma decrease.
    if (typeof highlightClipping === "number" && highlightClipping > 0.03) {
        out.gamma = round(clamp(100 - highlightClipping * 200, 80, 100))
    }

    // Shadow lift: if more than ~6% of pixels are crushed to black, lift gamma.
    if (typeof shadowClipping === "number" && shadowClipping > 0.06) {
        out.gamma = round(clamp(100 + shadowClipping * 140, 100, 122))
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
export const buildEditPlan = ({
    features = null,
    targetStyle = "neutral",
    currentStyle = "neutral",
    gain = 0.6,
    alreadyMatchesTarget = false,
    notes = "",
    imagekitAi = {},
} = {}) => {
    const safeGain = alreadyMatchesTarget
        ? 0
        : clamp(Number.isFinite(gain) ? gain : 0.6, 0, 1)

    // No-change guard: if the image already matches the target AND gain is 0,
    // return a plan with zero adjustments. This guarantees idempotency —
    // applying the same prompt to an already-edited image produces no changes.
    // We also skip corrections because the image is already considered well-edited.
    if (alreadyMatchesTarget && safeGain === 0) {
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

    const styleVec = STYLE_PROFILES[targetStyle] || STYLE_PROFILES.neutral
    const scaledStyle = applyGain(styleVec, safeGain)
    const corrections = computeCorrections(features)

    // Corrections always apply (they fix objective problems), even when style gain is 0.
    const merged = mergeAdjustments(scaledStyle, corrections)
    const entries = enumerateEntries(merged)

    return {
        plannerVersion: PLANNER_VERSION,
        currentStyle,
        targetStyle,
        gain: safeGain,
        alreadyMatchesTarget,
        notes: String(notes || "").trim(),
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
