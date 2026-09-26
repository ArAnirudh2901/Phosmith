/**
 * Exact Euclidean distance transform — Felzenszwalb & Huttenlocher, *Distance
 * Transforms of Sampled Functions* (Theory of Computing, 2012).
 *
 * Two separable passes over the lower envelope of parabolas: O(N) total, and
 * EXACT, not the chamfer approximation whose error shows up as visible facets in
 * a blur ramp. Used for
 *
 *   · depth-of-field falloff away from a subject silhouette (the on-device
 *     portrait blur — the further a background pixel is from the subject, the
 *     more it blurs, which is what a real lens does to a receding background);
 *   · a cast shadow that is sharp where the subject meets the ground and softens
 *     with distance.
 *
 * Pure: planes in, planes out.
 */

import { makePlane } from './box-filter'

const INF = 1e20

/**
 * 1-D squared distance transform of a sampled function, in place.
 *
 * `f` holds the function, `d` receives the transform, and the three scratch
 * arrays hold the parabola set: `v` their vertices, `z` the boundaries between
 * them. The loop is the paper's Algorithm 1 verbatim — each parabola is pushed
 * and lower ones popped, so every sample is visited a constant number of times.
 */
const dt1d = (f, n, d, v, z) => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < n; q += 1) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
        while (s <= z[k]) {
            k -= 1
            s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
        }
        k += 1
        v[k] = q
        z[k] = s
        z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < n; q += 1) {
        while (z[k + 1] < q) k += 1
        d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
    }
}

/**
 * Squared Euclidean distance from every pixel to the nearest pixel where
 * `mask >= threshold`. Returns squared distances (the caller usually wants a
 * ratio, and skipping the square root is free precision).
 */
export const squaredDistanceTransform = (mask, { threshold = 0.5 } = {}) => {
    const { width: w, height: h, data } = mask
    const out = makePlane(w, h)
    const size = Math.max(w, h)
    const f = new Float64Array(size)
    const d = new Float64Array(size)
    const v = new Int32Array(size + 1)
    const z = new Float64Array(size + 2)

    // Columns first, then rows: separability is what makes this linear.
    for (let x = 0; x < w; x += 1) {
        for (let y = 0; y < h; y += 1) f[y] = data[y * w + x] >= threshold ? 0 : INF
        dt1d(f, h, d, v, z)
        for (let y = 0; y < h; y += 1) out.data[y * w + x] = d[y]
    }
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) f[x] = out.data[y * w + x]
        dt1d(f, w, d, v, z)
        for (let x = 0; x < w; x += 1) out.data[y * w + x] = d[x]
    }
    return out
}

/** Euclidean distance (in pixels) to the nearest masked pixel. */
export const distanceTransform = (mask, opts = {}) => {
    const sq = squaredDistanceTransform(mask, opts)
    for (let i = 0; i < sq.data.length; i += 1) sq.data[i] = Math.sqrt(sq.data[i])
    return sq
}

/**
 * Signed distance to the mask boundary: negative inside, positive outside. Two
 * transforms — one to the mask, one to its complement — which is still O(N).
 */
export const signedDistanceTransform = (mask, { threshold = 0.5 } = {}) => {
    const outside = distanceTransform(mask, { threshold })
    const inverted = makePlane(mask.width, mask.height)
    for (let i = 0; i < inverted.data.length; i += 1) {
        inverted.data[i] = mask.data[i] >= threshold ? 0 : 1
    }
    const inside = distanceTransform(inverted, { threshold: 0.5 })
    const out = makePlane(mask.width, mask.height)
    for (let i = 0; i < out.data.length; i += 1) {
        out.data[i] = mask.data[i] >= threshold ? -inside.data[i] : outside.data[i]
    }
    return out
}

/**
 * A 0..1 ramp that grows with distance OUTSIDE the mask and stays 0 inside.
 *
 * `reach` is in pixels: the distance at which the ramp reaches 1. `gamma` bends
 * it — above 1 keeps the area near the subject sharper for longer, which reads as
 * a longer focal plane.
 */
export const distanceRamp = (mask, { reach = 64, gamma = 1, threshold = 0.5 } = {}) => {
    const distance = distanceTransform(mask, { threshold })
    const r = Math.max(1, reach)
    const g = Math.max(0.05, gamma)
    const out = makePlane(mask.width, mask.height)
    for (let i = 0; i < out.data.length; i += 1) {
        const inside = mask.data[i] >= threshold
        if (inside) { out.data[i] = 0; continue }
        const t = Math.min(1, distance.data[i] / r)
        out.data[i] = Math.pow(t, g)
    }
    return out
}
