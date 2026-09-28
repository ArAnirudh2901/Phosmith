/**
 * Focus effects: tilt-shift, depth-of-field and motion blur, expressed as
 * megashader layers.
 *
 * All three are the same engine — a layer whose coverage IS the circle of
 * confusion (radius = `blurPx` × coverage). What differs is where the coverage
 * comes from: a procedural ellipse/band for tilt-shift, a CV-derived map for
 * depth of field, the whole frame for motion.
 */

import { gradientLayer, linearLayer, radialLayer, luminanceLayer } from '../megashader/mask-types'
import { setMaskTexture } from '../megashader/mask-types'
import { defocusCoverage, defocusMap, sparseDefocus } from '../cv/defocus-map'
import { fromDefocus, fromDepth, fromGroundPlane, fromLinear, fromMatte, combine } from '../cv/coc'
import { canvasToPlane, imageToLumaPlane, matchPlane, planeToCoverageCanvas, workingSize } from '../cv/plane-image'
import { refineMatte } from '../cv/guided-filter'

const key = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

/** Aperture shapes the gather supports, in UI order. */
export const APERTURE_SHAPES = ['disc', 'hex', 'ring']

/**
 * Tilt-shift: a sharp band or ellipse, blur growing outward.
 * `inverted` is what turns "inside the shape" into "everywhere but the shape",
 * which is the coverage the blur wants.
 */
export const tiltShiftLayer = ({
    mode = 'radial',
    imageSize,
    center = { x: 0.5, y: 0.5 },
    radius = 0.3,
    aspect = 1,
    rotation = 0,
    feather = 0.35,
    blurPx = 28,
    shape = 'disc',
    highlightGain = 1.5,
    miniature = 0,
} = {}) => {
    const w = Math.max(1, imageSize?.width || 1000)
    const h = Math.max(1, imageSize?.height || 1000)
    const base = mode === 'linear'
        ? linearLayer({
            imageSize: { width: w, height: h },
            p1: { x: 0, y: h * (0.5 - radius) },
            p2: { x: 0, y: h * (0.5 + radius) },
            position: 0.5,
            feather,
        })
        : radialLayer({
            imageSize: { width: w, height: h },
            center: { x: center.x * w, y: center.y * h },
            radius: { x: radius * Math.min(w, h), y: radius * Math.min(w, h) * Math.max(0.05, aspect) },
            rotation,
            feather,
        })
    return {
        ...base,
        label: mode === 'linear' ? 'Tilt-shift band' : 'Tilt-shift',
        inverted: true,
        blurPx,
        blurKind: shape,
        highlightGain,
        // The miniature look Instagram pairs with tilt-shift: the toy-model read
        // comes from the extra contrast and colour, not from the blur alone.
        contrast: miniature * 0.25,
        saturation: miniature * 0.3,
    }
}

/** Motion blur over a region (or the whole frame when no mask is given). */
export const motionBlurLayer = ({
    angle = 0,
    length = 0.6,
    blurPx = 40,
    spin = false,
    region = null,
} = {}) => {
    const base = region || luminanceLayer({ min: 0, max: 1, softness: 0 })
    return {
        ...base,
        label: spin ? 'Spin blur' : 'Motion blur',
        blurPx,
        blurKind: spin ? 'spin' : 'motion',
        blurAngle: angle,
        blurLength: length,
        highlightGain: 0,
    }
}

/**
 * Depth of field. Resolves a circle-of-confusion map from whatever evidence
 * exists, best first, and reports which one it used so the UI can say so.
 *
 * - `depthCanvas`: a service depth map (Depth Anything V2) — real thin-lens CoC.
 * - `matteCanvas`: a subject matte (SlimSAM on-device) — portrait falloff by
 *   distance from the silhouette, guided-filter refined against the photo.
 * - neither: single-image defocus estimation, which needs no model at all.
 *
 * @returns {{ layer: object, source: string, coverage: number, mapKey: string }}
 */
export const buildDepthOfField = (imageEl, {
    depthCanvas = null,
    matteCanvas = null,
    focus = 0.5,
    aperture = 1,
    nearBias = 1.4,
    blurPx = 36,
    shape = 'disc',
    highlightGain = 2,
    reach = 0.25,
    gamma = 1.2,
    groundHorizon = null,
} = {}) => {
    const guide = imageToLumaPlane(imageEl)
    if (!guide) throw new Error('[effects.focus] no pixels to analyse')
    const { width, height } = guide

    let coc = null
    let source = 'none'
    let coverage = 1

    if (depthCanvas) {
        const depth = matchPlane(canvasToPlane(depthCanvas, 'red'), width, height)
        coc = fromDepth(depth, { focus, aperture, nearBias })
        source = 'depth'
    } else if (matteCanvas) {
        const raw = matchPlane(canvasToPlane(matteCanvas, 'luma'), width, height)
        // The matte arrives from a 512²-ish model output; the guided filter is
        // what makes its edge follow hair instead of the model's grid.
        const matte = refineMatte(raw, guide, { radius: 8, eps: 1e-3, subsample: 2 })
        coc = fromMatte(matte, { reach, gamma, aperture })
        source = 'matte'
    } else {
        const { sigma, confidence } = sparseDefocus(guide)
        coverage = defocusCoverage(confidence)
        const dense = defocusMap(guide)
        if (dense.usable && coverage > 0.004) {
            coc = fromDefocus(dense.map, { focus: 0, aperture })
            source = 'defocus'
        } else if (groundHorizon !== null) {
            coc = fromGroundPlane(width, height, { horizon: groundHorizon, focus, aperture })
            source = 'ground'
        } else {
            // Nothing measurable: a centred ellipse is honest about being a guess.
            coc = fromLinear(width, height, { p1: { x: 0, y: 0.35 }, p2: { x: 0, y: 0.65 }, feather: 0.4, aperture })
            source = 'fallback'
        }
        void sigma
    }

    const mapKey = key('coc')
    setMaskTexture(mapKey, planeToCoverageCanvas(coc))
    return {
        layer: {
            ...gradientLayer({ gradientMapKey: mapKey, low: 0, high: 1, gamma: 1 }),
            label: source === 'matte' ? 'Depth of field (subject)' : `Depth of field (${source})`,
            blurPx,
            blurKind: shape,
            highlightGain,
        },
        source,
        coverage,
        mapKey,
    }
}

/**
 * Add a tilt-shift band on top of an existing CoC map: two maps, `max` keeps
 * whichever is blurrier, so a portrait can also have a soft foreground.
 */
export const combineCocMaps = (a, b, mode = 'max') => combine(a, b, mode)

/** Working-copy size for the analysis, exposed so the UI can show it. */
export const focusWorkingSize = (imageEl) => workingSize(imageEl)
