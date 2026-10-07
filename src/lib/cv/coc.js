/**
 * Circle-of-confusion maps: every way of saying "what is out of focus here",
 * normalised to one 0..1 plane the blur shader reads. 0 = sharp, 1 = max blur.
 *
 * Sources, best first: service depth (thin lens), single-image defocus, subject
 * matte + distance ramp, procedural linear/radial (tilt-shift), ground plane.
 * All but the first run on-device with no model.
 */

import { makePlane, mapPlane } from './box-filter.js'
import { distanceRamp } from './distance-transform.js'

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Thin lens in DISPARITY space, which is what a monocular depth map actually
 * gives: CoC ∝ |disparity − disparityAtFocus|. Equivalent to `|1/z − 1/zf|` in
 * depth space, without inverting a normalised map first.
 *
 * @param {import('./box-filter').Plane} depth  0 = far, 1 = near
 */
export const fromDepth = (depth, { focus = 0.5, aperture = 1, nearBias = 1 } = {}) => {
    const f = clamp01(focus)
    const a = Math.max(0, aperture)
    const nb = Math.max(0, nearBias)
    return mapPlane(depth, (d) => {
        const delta = clamp01(d) - f
        // A real lens blurs the FOREGROUND harder than the background at equal
        // distance; nearBias exposes that asymmetry instead of hiding it.
        const weighted = delta > 0 ? delta * nb : -delta
        return clamp01(weighted * a * 2)
    })
}

/** Defocus magnification: blur what the lens already blurred (Bae & Durand). */
export const fromDefocus = (map, { focus = 0, aperture = 1 } = {}) => {
    const f = clamp01(focus)
    const a = Math.max(0, aperture)
    return mapPlane(map, (v) => clamp01(Math.abs(clamp01(v) - f) * a * 1.5))
}

/**
 * Portrait depth of field with no depth map: the subject stays sharp and the
 * background softens with its distance from the silhouette.
 *
 * @param {import('./box-filter').Plane} matte  1 = subject
 */
export const fromMatte = (matte, { reach = 0.25, gamma = 1.2, aperture = 1, threshold = 0.5 } = {}) => {
    const shortSide = Math.max(1, Math.min(matte.width, matte.height))
    const ramp = distanceRamp(matte, {
        reach: Math.max(2, shortSide * Math.max(0.01, reach)),
        gamma,
        threshold,
    })
    const a = Math.max(0, aperture)
    // Soft matte edges must not snap to full blur, so the matte itself keeps its
    // say over the ramp.
    return mapPlane(ramp, (r, i) => clamp01(r * a * (1 - clamp01(matte.data[i]))))
}

/** Tilt-shift, linear: sharp in a band, blurring away from it. */
export const fromLinear = (width, height, { p1 = { x: 0, y: 0.35 }, p2 = { x: 0, y: 0.65 }, feather = 0.25, aperture = 1 } = {}) => {
    const out = makePlane(width, height)
    const ax = p1.x * out.width
    const ay = p1.y * out.height
    const bx = p2.x * out.width
    const by = p2.y * out.height
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy || 1
    const f = Math.max(1e-3, feather)
    const a = Math.max(0, aperture)
    for (let y = 0; y < out.height; y += 1) {
        for (let x = 0; x < out.width; x += 1) {
            const t = ((x - ax) * dx + (y - ay) * dy) / len2
            // t in [0,1] is inside the band; outside it the distance grows.
            const outside = t < 0 ? -t : t > 1 ? t - 1 : 0
            out.data[y * out.width + x] = clamp01((outside / f) * a)
        }
    }
    return out
}

/** Tilt-shift, radial: sharp inside an ellipse, blurring outward. */
export const fromRadial = (width, height, {
    center = { x: 0.5, y: 0.5 }, radius = 0.3, aspect = 1, rotation = 0, feather = 0.35, aperture = 1,
} = {}) => {
    const out = makePlane(width, height)
    const cx = center.x * out.width
    const cy = center.y * out.height
    const rx = Math.max(1, radius * Math.min(out.width, out.height))
    const ry = Math.max(1, rx * Math.max(0.05, aspect))
    const cos = Math.cos(-rotation)
    const sin = Math.sin(-rotation)
    const f = Math.max(1e-3, feather)
    const a = Math.max(0, aperture)
    for (let y = 0; y < out.height; y += 1) {
        for (let x = 0; x < out.width; x += 1) {
            const px = x - cx
            const py = y - cy
            const rxr = (px * cos - py * sin) / rx
            const ryr = (px * sin + py * cos) / ry
            const d = Math.hypot(rxr, ryr)
            out.data[y * out.width + x] = clamp01(((d - 1) / f) * a)
        }
    }
    return out
}

/**
 * Ground plane: everything above the horizon is far, the foreground below it comes
 * toward the viewer. For landscapes and table tops, where there is no subject to
 * matte and no defocus to measure.
 */
export const fromGroundPlane = (width, height, { horizon = 0.5, focus = 0.75, aperture = 1, falloff = 1 } = {}) => {
    const out = makePlane(width, height)
    const hz = clamp01(horizon)
    const f = clamp01(focus)
    const a = Math.max(0, aperture)
    const k = Math.max(0.05, falloff)
    for (let y = 0; y < out.height; y += 1) {
        const v = (y + 0.5) / out.height
        // Depth proxy: 0 at the horizon, growing toward the bottom of the frame.
        const depth = v <= hz ? 0 : (v - hz) / Math.max(1e-3, 1 - hz)
        const focusDepth = f <= hz ? 0 : (f - hz) / Math.max(1e-3, 1 - hz)
        const coc = clamp01(Math.pow(Math.abs(depth - focusDepth), k) * a)
        for (let x = 0; x < out.width; x += 1) out.data[y * out.width + x] = coc
    }
    return out
}

/** Combine two CoC maps. `max` keeps whichever is blurrier — the right default for
 *  stacking a tilt-shift band on top of a subject matte. */
export const combine = (a, b, mode = 'max') => {
    if (a.width !== b.width || a.height !== b.height) throw new Error('[cv] combine: size mismatch')
    const out = makePlane(a.width, a.height)
    for (let i = 0; i < out.data.length; i += 1) {
        const x = clamp01(a.data[i])
        const y = clamp01(b.data[i])
        out.data[i] = mode === 'min' ? Math.min(x, y)
            : mode === 'multiply' ? x * y
                : mode === 'average' ? (x + y) / 2
                    : Math.max(x, y)
    }
    return out
}

/** Re-centre an existing CoC map on a new focus value, so tapping to focus does
 *  not need the source recomputed. */
export const refocus = (coc, { focus = 0, aperture = 1 } = {}) => {
    const f = clamp01(focus)
    const a = Math.max(0, aperture)
    return mapPlane(coc, (v) => clamp01(Math.abs(clamp01(v) - f) * a))
}

export const COC_SOURCES = ['depth', 'defocus', 'matte', 'linear', 'radial', 'ground']
