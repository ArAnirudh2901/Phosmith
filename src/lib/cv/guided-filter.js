/**
 * Guided image filtering — He, Sun & Tang (ECCV 2010 / TPAMI 2013) and the fast
 * variant (He & Sun, arXiv:1505.00996).
 *
 * The filter fits, inside every window, a LINEAR model of the output against a
 * guide image: `q = a·I + b`. Where the guide has an edge, the fit keeps it;
 * where the guide is flat, the fit averages. That single property is why this one
 * routine solves three separate problems in this codebase:
 *
 *   1. a 512² SlimSAM matte becomes a 24MP mask whose edge follows hair and
 *      cloth, with the photo itself as the guide — no second model, no matting
 *      solve;
 *   2. halo-free local contrast (Structure), using the filtered luma as the base
 *      layer instead of a Gaussian, which is what causes unsharp halos;
 *   3. propagation of sparse per-edge defocus estimates across the frame.
 *
 * The fast variant is the one that matters in production: every box filter runs
 * at 1/s resolution and only the final `q = ā·I + b̄` touches full resolution, so
 * cost is O(N/s²) plus one evaluation — and that evaluation is two multiplies,
 * cheap enough to live in a fragment shader.
 *
 * Pure: planes in, planes out (see box-filter.js). No DOM, no Fabric.
 */

import { boxMean, makePlane, mapPlane, resamplePlane, upsamplePlane, zipPlanes } from './box-filter'

/** @typedef {import('./box-filter').Plane} Plane */

/** Below this the variance term is noise, not structure. */
export const DEFAULT_EPS = 1e-4

/**
 * The window radius as a FRACTION of the image's short side, so a radius means
 * the same thing on a thumbnail and on a 24MP frame.
 */
export const radiusForShortSide = (shortSide, fraction) =>
    Math.max(1, Math.round(Math.max(1, shortSide) * Math.max(0, fraction)))

/**
 * Per-window linear coefficients. Returned separately from the filtered result
 * because the GPU path wants exactly these two maps and nothing else.
 *
 * @param {Plane} guide  the image whose edges should be respected (usually luma)
 * @param {Plane} input  the map being filtered (matte, sparse σ, luma…)
 * @param {{ radius?: number, eps?: number }} [opts]
 * @returns {{ a: Plane, b: Plane }}
 */
export const guidedCoefficients = (guide, input, { radius = 8, eps = DEFAULT_EPS } = {}) => {
    if (guide.width !== input.width || guide.height !== input.height) {
        throw new Error('[cv] guidedCoefficients: guide and input must be the same size')
    }
    // eps divides the variance, so a NaN poisons the whole map and a literal 0
    // divides by zero wherever the guide is flat (a clear sky, a studio
    // backdrop). Floor it at a value far below any real image variance.
    const safeEps = Number.isFinite(Number(eps)) ? Math.max(Number(eps), 1e-8) : DEFAULT_EPS
    const meanI = boxMean(guide, radius)
    const meanP = boxMean(input, radius)
    const corrI = boxMean(zipPlanes(guide, guide, (g) => g * g), radius)
    const corrIp = boxMean(zipPlanes(guide, input, (g, p) => g * p), radius)

    const a = makePlane(guide.width, guide.height)
    const b = makePlane(guide.width, guide.height)
    for (let i = 0; i < a.data.length; i += 1) {
        const mI = meanI.data[i]
        const mP = meanP.data[i]
        const varI = corrI.data[i] - mI * mI
        const covIp = corrIp.data[i] - mI * mP
        // eps is what decides "edge or noise": a window whose variance is below
        // it collapses to a plain mean, which is the behaviour wanted in flat sky.
        const ai = covIp / (varI + safeEps)
        a.data[i] = ai
        b.data[i] = mP - ai * mI
    }
    // Averaging the coefficients over the same window is what makes the output
    // continuous — without it, neighbouring windows disagree and the result tiles.
    return { a: boxMean(a, radius), b: boxMean(b, radius) }
}

/** The exact filter: `q = ā·I + b̄` at full resolution. */
export const guidedFilter = (guide, input, opts = {}) => {
    const { a, b } = guidedCoefficients(guide, input, opts)
    return zipPlanes(a, b, (ai, bi, i) => ai * guide.data[i] + bi)
}

/**
 * Fast guided filter: box filters at 1/s, coefficients bilinearly upsampled, the
 * final evaluation against the FULL-resolution guide (He & Sun, §2). `s` is
 * clamped so the low-res pass never drops under 16px on a side.
 *
 * @returns {{ a: Plane, b: Plane, scale: number }} low-res coefficients plus the
 *   ratio they were computed at, ready to upload as two small textures.
 */
export const fastGuidedCoefficients = (guide, input, { radius = 8, eps = DEFAULT_EPS, subsample = 4 } = {}) => {
    const s = Math.max(1, Math.floor(subsample))
    if (s === 1) return { ...guidedCoefficients(guide, input, { radius, eps }), scale: 1 }
    const lowW = Math.max(16, Math.round(guide.width / s))
    const lowH = Math.max(16, Math.round(guide.height / s))
    const guideLow = resamplePlane(guide, lowW, lowH)
    const inputLow = resamplePlane(input, lowW, lowH)
    // The window has to shrink with the image or it covers a different fraction
    // of the scene than the caller asked for.
    const lowRadius = Math.max(1, Math.round(radius / s))
    const { a, b } = guidedCoefficients(guideLow, inputLow, { radius: lowRadius, eps })
    return { a, b, scale: s }
}

/** Evaluate low-res coefficients against a full-resolution guide (CPU mirror of
 *  the one-line shader form). */
export const applyGuidedCoefficients = (coefficients, guide) => {
    const a = upsamplePlane(coefficients.a, guide.width, guide.height)
    const b = upsamplePlane(coefficients.b, guide.width, guide.height)
    return zipPlanes(a, b, (ai, bi, i) => ai * guide.data[i] + bi)
}

export const fastGuidedFilter = (guide, input, opts = {}) =>
    applyGuidedCoefficients(fastGuidedCoefficients(guide, input, opts), guide)

/**
 * Edge-aware refinement of a soft matte against the photo it came from, clamped
 * back into 0..1.
 *
 * `feather` widens the transition on purpose: a mask that is too crisp is what
 * makes a colour-splash or a cut-out read as pasted, and the research on colour
 * splash is blunt that halos are a masking problem, not an effect problem.
 */
export const refineMatte = (matte, guide, { radius = 8, eps = 1e-3, subsample = 4, feather = 0 } = {}) => {
    const refined = fastGuidedFilter(guide, matte, { radius, eps, subsample })
    const f = Math.max(0, Math.min(1, feather))
    return mapPlane(refined, (v) => {
        const clamped = Math.max(0, Math.min(1, v))
        if (f <= 0) return clamped
        // Pull values toward 0.5 → a softer ramp across the boundary.
        return Math.max(0, Math.min(1, 0.5 + (clamped - 0.5) * (1 - f)))
    })
}

/**
 * Normalised (weighted) guided propagation: spread values that exist only at a
 * few pixels across the whole frame, respecting the guide's edges.
 *
 * This is the substitution that makes the defocus estimator affordable — Zhuo &
 * Sim propagate their sparse per-edge estimates with a matting Laplacian, a
 * global sparse solve; filtering `value × weight` and `weight` separately and
 * dividing gives the same shape of answer in two O(N) passes.
 */
export const propagateSparse = (values, weights, guide, { radius = 16, eps = 1e-3, subsample = 2 } = {}) => {
    const weighted = zipPlanes(values, weights, (v, w) => v * w)
    const num = fastGuidedFilter(guide, weighted, { radius, eps, subsample })
    const den = fastGuidedFilter(guide, weights, { radius, eps, subsample })
    return zipPlanes(num, den, (n, d) => (d > 1e-4 ? n / d : 0))
}

/**
 * Local-contrast detail split. `base` is the guided-filtered luma, `detail` is
 * what is left — boosting the detail is Structure; boosting it at a small radius
 * is Texture. Both are halo-free because the base follows edges.
 */
export const detailSplit = (luma, { radius = 8, eps = 1e-2, subsample = 2 } = {}) => {
    const base = fastGuidedFilter(luma, luma, { radius, eps, subsample })
    return { base, detail: zipPlanes(luma, base, (l, b) => l - b) }
}
