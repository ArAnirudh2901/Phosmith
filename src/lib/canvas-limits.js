/**
 * What this device's 2D canvas can actually hold.
 *
 * Every engine caps a canvas twice: a maximum side length and a maximum total
 * area. Cross the area cap and the result is not an exception — Safari on iOS
 * hands back a blank or partly drawn canvas, which is how a 9:16 export at 3×
 * "succeeds" and saves an empty file. So the caps are probed, not assumed, and
 * the probe is a real allocation plus a read-back of one pixel.
 *
 * Pure apart from the probe; safe to import in Node (probing then reports the
 * conservative floor).
 */

/** Side lengths to try, largest first. Chrome/Firefox reach 32767, iOS 16384/8192. */
const EDGE_CANDIDATES = [32767, 16384, 8192, 4096]
/** Total pixels to try, largest first. iOS caps area far below its edge cap. */
const AREA_CANDIDATES = [268_435_456, 134_217_728, 67_108_864, 33_554_432, 16_777_216]

/**
 * ImageKit's serving limits, which bound what may be UPLOADED (it answers 400
 * "ELIMIT" above 25 MP). Unrelated to the device caps below, but they live here
 * so the upload path and the project-creation path cannot drift apart.
 */
export const IMAGEKIT_MAX_MP = 24_000_000
export const IMAGEKIT_MAX_EDGE = 8192

/** Conservative floor when nothing can be probed (SSR, worker without canvas). */
export const FALLBACK_LIMITS = { maxEdge: 4096, maxArea: 16_777_216 }

let probed = null

const makeCanvas = (w, h) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
    if (typeof document === 'undefined') return null
    const el = document.createElement('canvas')
    el.width = w
    el.height = h
    return el
}

/**
 * Does a canvas of this size draw? A size past the cap still constructs, so the
 * test has to paint and read a pixel back.
 */
const canAllocate = (w, h) => {
    let canvas = null
    try {
        canvas = makeCanvas(w, h)
        if (!canvas || canvas.width !== w || canvas.height !== h) return false
        const ctx = canvas.getContext('2d')
        if (!ctx) return false
        ctx.fillStyle = '#010203'
        ctx.fillRect(w - 1, h - 1, 1, 1)
        const px = ctx.getImageData(w - 1, h - 1, 1, 1).data
        return px[0] === 1 && px[1] === 2 && px[2] === 3
    } catch {
        return false
    } finally {
        // Release the backing store promptly — some of these are hundreds of MB.
        if (canvas && 'width' in canvas) { try { canvas.width = 1; canvas.height = 1 } catch { /* detached */ } }
    }
}

/**
 * Probe once per session and cache. The probe costs a handful of allocations and
 * is only reached the first time something exports or resizes.
 */
export const canvasLimits = () => {
    if (probed) return probed
    if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') {
        probed = { ...FALLBACK_LIMITS, probed: false }
        return probed
    }
    let maxEdge = FALLBACK_LIMITS.maxEdge
    for (const edge of EDGE_CANDIDATES) {
        // A 1px-tall strip isolates the side-length cap from the area cap.
        if (canAllocate(edge, 1)) { maxEdge = edge; break }
    }
    let maxArea = FALLBACK_LIMITS.maxArea
    for (const area of AREA_CANDIDATES) {
        const side = Math.min(maxEdge, Math.floor(Math.sqrt(area)))
        if (canAllocate(side, Math.floor(area / side))) { maxArea = area; break }
    }
    probed = { maxEdge, maxArea, probed: true }
    return probed
}

/** Test seam: force the caps (used by the verifiers to model an iOS ceiling). */
export const __setCanvasLimits = (limits) => {
    probed = limits ? { maxEdge: limits.maxEdge, maxArea: limits.maxArea, probed: false } : null
}

/**
 * Largest scale at or below `scale` that keeps `width × height × scale²` inside
 * both caps. Returns `scale` untouched when it already fits.
 */
export const maxRenderScale = (width, height, scale = 1, limits = canvasLimits()) => {
    const w = Math.max(1, Math.floor(width || 0))
    const h = Math.max(1, Math.floor(height || 0))
    const byEdge = limits.maxEdge / Math.max(w, h)
    const byArea = Math.sqrt(limits.maxArea / (w * h))
    return Math.max(0, Math.min(scale, byEdge, byArea))
}

/**
 * Fit a target size inside the caps, preserving aspect ratio. Returns the same
 * numbers when they already fit, so callers can compare and report a cap.
 */
export const clampToCanvasLimits = (width, height, limits = canvasLimits()) => {
    const w = Math.max(1, Math.floor(width || 0))
    const h = Math.max(1, Math.floor(height || 0))
    const factor = maxRenderScale(w, h, 1, limits)
    if (factor >= 1) return { width: w, height: h, clamped: false }
    return {
        width: Math.max(1, Math.floor(w * factor)),
        height: Math.max(1, Math.floor(h * factor)),
        clamped: true,
    }
}
