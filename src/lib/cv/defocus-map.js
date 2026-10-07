/**
 * Single-image defocus estimation (Zhuo & Sim, Pattern Recognition 2011): re-blur
 * by a known σ0, take the gradient ratio at edges, recover σ, propagate.
 * No model, no training data — the image's own edges carry the answer.
 *
 * Propagation uses normalised guided filtering instead of the paper's matting
 * Laplacian: same shape of result, two O(N) passes instead of a sparse solve.
 */

import { gaussianBlur, makePlane, mapPlane } from './box-filter.js'
import { propagateSparse } from './guided-filter.js'

/** Sobel gradient magnitude. */
export const gradientMagnitude = (plane) => {
    const { width: w, height: h, data } = plane
    const out = makePlane(w, h)
    const at = (x, y) => data[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
                - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
            const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
                - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
            out.data[y * w + x] = Math.hypot(gx, gy) / 4
        }
    }
    return out
}

/**
 * σ at edge pixels from the re-blur ratio, over several re-blur scales.
 *
 * A step edge blurred by σ, re-blurred by σ0, has gradient ratio
 * `R = sqrt((σ² + σ0²) / σ²)`, so `σ = σ0 / sqrt(R² − 1)`. One σ0 is not enough:
 * the expression is only well conditioned while R is comfortably above 1, and a
 * σ0 of 1.5 puts a σ = 4 edge at R ≈ 1.07, where the Sobel operator's own
 * smoothing biases the ratio low and the estimate explodes. So each edge is
 * measured at a ladder of scales and answered at the one where it is legible —
 * adaptive scale selection, as the defocus literature recommends.
 *
 * R ≤ 1 means the edge is already softer than that scale can resolve; it gets no
 * estimate rather than a guessed one.
 */
export const DEFAULT_REBLUR_SCALES = [1, 2, 4, 8]

/** R at which the inversion is best conditioned (σ ≈ σ0). */
const IDEAL_RATIO = Math.SQRT2

/**
 * The 3×3 Sobel operator carries its own smoothing, so what the ratio recovers is
 * `sqrt(σ² + σs²)`, not σ. Calibrated against synthetic step edges of known blur
 * (σ = 1, 2, 4 read back as 1.25, 2.13, 4.08): σs ≈ 0.75, stable across scales.
 */
const OPERATOR_SIGMA = 0.75

const removeOperatorBias = (estimate) => Math.sqrt(Math.max(0, estimate * estimate - OPERATOR_SIGMA * OPERATOR_SIGMA))

export const sparseDefocus = (luma, { scales = DEFAULT_REBLUR_SCALES, edgeThreshold = 0.02, sigmaMax = 12, sigma0 = null } = {}) => {
    const ladder = (sigma0 ? [sigma0] : scales).filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b)
    const g1 = gradientMagnitude(luma)
    const reblurred = ladder.map((s) => gradientMagnitude(gaussianBlur(luma, s)))

    const sigma = makePlane(luma.width, luma.height)
    const confidence = makePlane(luma.width, luma.height)
    for (let i = 0; i < sigma.data.length; i += 1) {
        const a = g1.data[i]
        if (a < edgeThreshold) continue
        let bestSigma = 0
        let bestScore = -Infinity
        for (let k = 0; k < ladder.length; k += 1) {
            const b = reblurred[k].data[i]
            if (b < 1e-6) continue
            const r = a / b
            if (r <= 1.02) continue
            const s = removeOperatorBias(ladder[k] / Math.sqrt(r * r - 1))
            if (!Number.isFinite(s) || s <= 0) continue
            // Prefer the scale whose ratio sits nearest the conditioned point.
            const score = -Math.abs(Math.log(r / IDEAL_RATIO))
            if (score > bestScore) { bestScore = score; bestSigma = s }
        }
        if (bestSigma <= 0) continue
        sigma.data[i] = Math.min(sigmaMax, bestSigma)
        confidence.data[i] = Math.min(1, a / (edgeThreshold * 8))
    }
    return { sigma, confidence, sigmaMax }
}

/**
 * Dense defocus map in 0..1 (0 = sharpest region found, 1 = softest).
 * `guide` defaults to the luma the estimate came from.
 */
export const defocusMap = (luma, { scales = DEFAULT_REBLUR_SCALES, edgeThreshold = 0.02, sigmaMax = 12, radius = 24, eps = 1e-3, subsample = 2 } = {}) => {
    const { sigma, confidence } = sparseDefocus(luma, { scales, edgeThreshold, sigmaMax })
    const dense = propagateSparse(sigma, confidence, luma, { radius, eps, subsample })

    // Robust range: the extremes of a propagated map are single-pixel outliers, so
    // normalising against them flattens everything else to mid grey — which is
    // exactly what a weak-signal frame looked like before this.
    const sorted = Float32Array.from(dense.data).sort()
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]
    const lo = pick(0.05)
    const hi = pick(0.95)
    const span = hi - lo
    // No spread between the 5th and 95th percentile means the frame carried no
    // usable defocus signal — report that instead of amplifying noise.
    if (!Number.isFinite(span) || span < 1e-4) {
        return { map: makePlane(luma.width, luma.height), usable: false, min: lo, max: hi }
    }
    return {
        map: mapPlane(dense, (v) => Math.max(0, Math.min(1, (v - lo) / span))),
        usable: true,
        min: lo,
        max: hi,
    }
}

/** Fraction of pixels carrying a real estimate — the UI uses it to decide whether
 *  to offer defocus-based focus at all. */
export const defocusCoverage = (confidence, threshold = 0.15) => {
    let hits = 0
    for (const v of confidence.data) if (v >= threshold) hits += 1
    return hits / Math.max(1, confidence.data.length)
}
