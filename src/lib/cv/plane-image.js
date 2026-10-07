/**
 * Bridge between the CV core's planes and the DOM/GPU world: image → working
 * luma, plane → a texture the megashader can bind.
 *
 * Every analysis runs on a downscaled working copy (`WORKING_SIDE`), which is why
 * a 50MP frame costs the same as a 2MP one. Only the final mask is full-size, and
 * the guided filter is what makes that upscale follow real edges.
 */

import { makePlane, resamplePlane, upsamplePlane } from './box-filter.js'

/** Long edge of the analysis copy. 512 is where defocus estimation stops gaining. */
export const WORKING_SIDE = 512

const LUMA = [0.2126, 0.7152, 0.0722]

const sourceElementOf = (input) => input?._originalElement || input?._element
    || (typeof input?.getElement === 'function' ? input.getElement() : null) || input

export const elementSize = (input) => {
    const el = sourceElementOf(input)
    return {
        width: el?.naturalWidth || el?.videoWidth || el?.width || 0,
        height: el?.naturalHeight || el?.videoHeight || el?.height || 0,
    }
}

/** Draw any image-like source into a canvas at the given size. */
export const drawToCanvas = (input, width, height) => {
    const el = sourceElementOf(input)
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(el, 0, 0, w, h)
    return canvas
}

/** Working-size dimensions for a source, long edge capped at `side`. */
export const workingSize = (input, side = WORKING_SIDE) => {
    const { width, height } = elementSize(input)
    if (!width || !height) return { width: 0, height: 0, scale: 1 }
    const scale = Math.min(1, side / Math.max(width, height))
    return {
        width: Math.max(8, Math.round(width * scale)),
        height: Math.max(8, Math.round(height * scale)),
        scale,
    }
}

/** Luma plane of the working copy — the guide every CV routine uses. */
export const imageToLumaPlane = (input, side = WORKING_SIDE) => {
    const size = workingSize(input, side)
    if (!size.width) return null
    const canvas = drawToCanvas(input, size.width, size.height)
    const { data } = canvas.getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, size.width, size.height)
    const plane = makePlane(size.width, size.height)
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        plane.data[p] = (data[i] * LUMA[0] + data[i + 1] * LUMA[1] + data[i + 2] * LUMA[2]) / 255
    }
    return plane
}

/**
 * Plane from a canvas/ImageData channel. `alpha` is the channel a painted or
 * cut-out mask actually lives in; `luma` is what a white-on-black matte uses.
 */
export const canvasToPlane = (source, channel = 'luma') => {
    const el = sourceElementOf(source)
    const imageData = el instanceof ImageData
        ? el
        : el.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, el.width, el.height)
    const plane = makePlane(imageData.width, imageData.height)
    const { data } = imageData
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        plane.data[p] = channel === 'alpha'
            ? data[i + 3] / 255
            : channel === 'red'
                ? data[i] / 255
                : (data[i] * LUMA[0] + data[i + 1] * LUMA[1] + data[i + 2] * LUMA[2]) / 255
    }
    return plane
}

/**
 * Plane → an opaque greyscale canvas, which is what `setMaskTexture` wants. The
 * value goes in RGB and alpha stays 255, because the shader reads the R channel
 * for every kind except `brush`.
 */
export const planeToCoverageCanvas = (plane, { width, height } = {}) => {
    const target = (width && height)
        ? upsamplePlane(plane, width, height)
        : plane
    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const imageData = ctx.createImageData(target.width, target.height)
    for (let p = 0, i = 0; p < target.data.length; p += 1, i += 4) {
        const v = Math.max(0, Math.min(255, Math.round(target.data[p] * 255)))
        imageData.data[i] = v
        imageData.data[i + 1] = v
        imageData.data[i + 2] = v
        imageData.data[i + 3] = 255
    }
    ctx.putImageData(imageData, 0, 0)
    return canvas
}

/** Resample a plane to another plane's grid (for combining maps of different sizes). */
export const matchPlane = (plane, width, height) => (
    plane.width === width && plane.height === height
        ? plane
        : (plane.width > width ? resamplePlane(plane, width, height) : upsamplePlane(plane, width, height))
)
