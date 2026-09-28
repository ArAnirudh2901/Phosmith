/**
 * Selective colour: one subject (or one colour) keeps its colour, the rest goes
 * monochrome.
 *
 * Two lessons from how this effect fails in practice drive the design: a halo is a
 * masking problem, so the mask is guided-filter refined against the photo before
 * the effect is pushed; and a fully grey surround reads dead, so the default keeps
 * a little colour (`keep`) instead of slamming saturation to -100.
 */

import { gradientLayer, setMaskTexture } from '../megashader/mask-types'
import { refineMatte } from '../cv/guided-filter'
import { makePlane } from '../cv/box-filter'
import { canvasToPlane, imageToLumaPlane, matchPlane, planeToCoverageCanvas } from '../cv/plane-image'
import { squaredDistanceTransform } from '../cv/distance-transform'
import { magicWandMask } from '../magic-wand'

const key = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

const rgbToHsl = (r, g, b) => {
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const l = (max + min) / 2
    if (max === min) return [0, 0, l]
    const d = max - min
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    let h
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
    return [h, s, l]
}

/**
 * Mask of pixels close to a target colour.
 *
 * Hue distance alone keeps the red jacket AND the red car behind it, so a
 * `spatial` limit (in fractions of the short side, measured from the picked
 * point) fades the match out with distance — the cheap version of "only near
 * where I tapped".
 */
export const colorRangeMask = (canvas, {
    target,
    tolerance = 0.12,
    saturationFloor = 0.12,
    point = null,
    spatial = 0,
} = {}) => {
    const el = canvas
    const ctx = el.getContext('2d', { willReadFrequently: true })
    const { data, width, height } = ctx.getImageData(0, 0, el.width, el.height)
    const [th, ts] = rgbToHsl(target.r, target.g, target.b)
    const mask = makePlane(width, height)
    const tol = Math.max(0.01, tolerance)
    for (let p = 0, i = 0; p < mask.data.length; p += 1, i += 4) {
        const [h, s] = rgbToHsl(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255)
        // Grey pixels have no meaningful hue, so they never match a colour pick.
        if (s < saturationFloor || ts < saturationFloor) continue
        let dh = Math.abs(h - th)
        if (dh > 0.5) dh = 1 - dh
        const ds = Math.abs(s - ts) * 0.5
        const d = Math.hypot(dh * 2, ds)
        mask.data[p] = Math.max(0, 1 - d / tol)
    }
    if (point && spatial > 0) {
        const px = point.x * width
        const py = point.y * height
        const reach = Math.max(4, spatial * Math.min(width, height))
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const i = y * width + x
                if (mask.data[i] <= 0) continue
                const t = Math.min(1, Math.hypot(x - px, y - py) / reach)
                mask.data[i] *= 1 - t * t
            }
        }
    }
    return mask
}

/** Keep only the blob containing the picked point (the strict spatial limit). */
export const restrictToBlob = (mask, point, { threshold = 0.25 } = {}) => {
    const { width, height } = mask
    const sx = Math.max(0, Math.min(width - 1, Math.round(point.x * width)))
    const sy = Math.max(0, Math.min(height - 1, Math.round(point.y * height)))
    const out = makePlane(width, height)
    if (mask.data[sy * width + sx] < threshold) return out
    const stack = [sy * width + sx]
    const seen = new Uint8Array(width * height)
    seen[sy * width + sx] = 1
    while (stack.length) {
        const i = stack.pop()
        out.data[i] = mask.data[i]
        const x = i % width
        const y = (i - x) / width
        const push = (nx, ny) => {
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) return
            const j = ny * width + nx
            if (seen[j] || mask.data[j] < threshold) return
            seen[j] = 1
            stack.push(j)
        }
        push(x + 1, y)
        push(x - 1, y)
        push(x, y + 1)
        push(x, y - 1)
    }
    return out
}

/**
 * Build the layer that desaturates everything OUTSIDE the keep mask.
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.imageEl    the photo (guide for refinement)
 * @param {HTMLCanvasElement} [opts.matteCanvas]  subject matte, 'subject' mode
 * @param {{r:number,g:number,b:number}} [opts.target]  colour pick, 'color' mode
 * @param {number} [opts.keep=15]   saturation left in the surround, percent
 * @param {number} [opts.feather=0.15]
 * @returns {{ layer: object, mode: string, mapKey: string, keptFraction: number }}
 */
export const buildColorPop = ({
    imageEl,
    matteCanvas = null,
    target = null,
    tolerance = 0.12,
    point = null,
    spatial = 0.45,
    contiguous = false,
    keep = 15,
    feather = 0.15,
    monoContrast = 0,
} = {}) => {
    const guide = imageToLumaPlane(imageEl)
    if (!guide) throw new Error('[effects.colorPop] no pixels to analyse')
    const { width, height } = guide

    let raw = null
    let mode = 'subject'
    if (matteCanvas) {
        raw = matchPlane(canvasToPlane(matteCanvas, 'luma'), width, height)
    } else if (target) {
        const small = document.createElement('canvas')
        small.width = width
        small.height = height
        const sctx = small.getContext('2d', { willReadFrequently: true })
        sctx.drawImage(imageEl._originalElement || imageEl._element || imageEl, 0, 0, width, height)
        if (contiguous && point) {
            // A region the user pointed at is a flood fill, not a hue test — reuse
            // the Magic Wand, which already handles scanline filling, seed
            // sampling and anti-aliased edges (and is pinned by verify:selection).
            const { data } = sctx.getImageData(0, 0, width, height)
            const { cover } = magicWandMask(
                data, width, height,
                Math.round(point.x * width), Math.round(point.y * height),
                { tolerance: Math.round(tolerance * 255), contiguous: true, antiAlias: true, sample: '5x5' },
            )
            raw = makePlane(width, height)
            for (let i = 0; i < raw.data.length; i += 1) raw.data[i] = cover[i] / 255
        } else {
            raw = colorRangeMask(small, { target, tolerance, point, spatial })
        }
        mode = 'color'
    } else {
        throw new Error('[effects.colorPop] needs a subject matte or a colour target')
    }

    const refined = refineMatte(raw, guide, { radius: 8, eps: 1e-3, subsample: 2, feather })
    let kept = 0
    for (const v of refined.data) if (v > 0.5) kept += 1
    const keptFraction = kept / Math.max(1, refined.data.length)

    // A keep mask that covers almost everything (or almost nothing) produces an
    // invisible effect. Saying so beats applying a layer the user cannot see.
    if (mode === 'color') {
        if (keptFraction > 0.85) {
            throw new Error(`That colour matches ${Math.round(keptFraction * 100)}% of the photo — lower "Match width" or pick a more distinct colour`)
        }
        if (keptFraction < 0.005) {
            throw new Error('That colour barely appears in the photo — raise "Match width" or pick again')
        }
    }

    const mapKey = key('pop')
    setMaskTexture(mapKey, planeToCoverageCanvas(refined))
    return {
        layer: {
            ...gradientLayer({ gradientMapKey: mapKey, low: 0, high: 1, gamma: 1 }),
            label: mode === 'subject' ? 'Colour pop (subject)' : 'Colour pop (colour)',
            // Inverted: the KEEP mask marks what stays, so the grade lands on
            // everything else.
            inverted: true,
            saturation: -(100 - Math.max(0, Math.min(100, keep))),
            contrast: monoContrast,
        },
        mode,
        mapKey,
        keptFraction,
    }
}

/** How far the keep mask sits from the frame edge — a cheap "is this plausible"
 *  signal the UI can use to warn about a mask that covers everything. */
export const maskEdgeDistance = (mask) => {
    const sq = squaredDistanceTransform(mask, { threshold: 0.5 })
    let max = 0
    for (const v of sq.data) if (v > max) max = v
    return Math.sqrt(max)
}
