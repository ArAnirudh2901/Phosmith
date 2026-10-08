import { FabricImage } from 'fabric'
import { PIXEL_MASK_CLIP_NAME, featherAlphaCanvas, maskRectToAlpha } from '@/lib/canvas-mask'

// The image's clip, kept as a GPU canvas whose alpha IS the grey mask. A stroke
// paints both dab for dab (stampMask's `alpha` mode), so the erase is visible
// while dragging and nothing reads the full-res mask back on release. The clip
// is rebuilt from the mask only after edits that bypass the brush (flood fill,
// invert, a full undo snapshot…), and then only over the rect that changed.

const CLIP_OPTIONS = {
    left: 0,
    top: 0,
    originX: 'center',
    originY: 'center',
    absolutePositioned: false,
    selectable: false,
    evented: false,
    objectCaching: false,
    name: PIXEL_MASK_CLIP_NAME,
    phosmithMaskClipPath: true,
    _phosmithMaskClipPath: true,
}

/**
 * The image's live clip for this mask, created if missing — by a full
 * conversion, or as a plain white fill when the caller knows the mask is empty.
 */
export function ensureLiveClip(img, maskCanvas, { blank = false } = {}) {
    const existing = img._phosmithLiveClip
    if (existing?.mask === maskCanvas
        && existing.canvas.width === maskCanvas.width
        && existing.canvas.height === maskCanvas.height) {
        return { live: existing, fresh: false }
    }
    const canvas = document.createElement('canvas')
    canvas.width = maskCanvas.width
    canvas.height = maskCanvas.height
    const live = { mask: maskCanvas, canvas, feathered: null, featherPx: 0, object: null }
    if (blank) resetLiveClip(live)
    else maskRectToAlpha(maskCanvas, canvas)
    img._phosmithLiveClip = live
    return { live, fresh: true }
}

/** Re-copy a rect (null = all) of the mask into the clip. */
export const updateLiveClip = (live, rect = null) => maskRectToAlpha(live.mask, live.canvas, rect)

/**
 * Point the image's clipPath at the live clip — the crisp canvas, or its
 * feathered copy. The copy is re-blurred whole only when `refeather` (a full
 * sync, a feather change); a stroke keeps it current per frame with
 * featherLiveClipRect.
 */
export function attachLiveClip(img, live, { feather = 0, refeather = true } = {}) {
    let element = live.canvas
    if (feather > 0) {
        if (refeather || !live.feathered || live.featherPx !== feather) {
            live.feathered = featherAlphaCanvas(live.canvas, feather, live.feathered)
            live.featherPx = feather
        }
        element = live.feathered
    }
    if (!live.object) {
        live.object = new FabricImage(element, CLIP_OPTIONS)
    } else if (live.object.getElement() !== element) {
        live.object.setElement(element)
    }
    if (img.clipPath !== live.object) img.clipPath = live.object
    live.object.dirty = true
    img.dirty = true
}

/**
 * Re-feather only around `rect` (mask px). The blur reads a margin of 3×feather
 * beyond the rect and the copy back stops at the rect, so the clamped edge of
 * the scratch never shows; at the image border featherAlphaCanvas replicates
 * the edge as it does for the whole clip.
 */
export function featherLiveClipRect(live, feather, rect) {
    if (!live.feathered || live.featherPx !== feather) return
    const W = live.canvas.width
    const H = live.canvas.height
    const pad = Math.ceil(feather * 3)
    const clamp = (x0, y0, x1, y1) => {
        const x = Math.max(0, Math.floor(x0)), y = Math.max(0, Math.floor(y0))
        return { x, y, w: Math.min(W, Math.ceil(x1)) - x, h: Math.min(H, Math.ceil(y1)) - y }
    }
    const r = clamp(rect.x - pad, rect.y - pad, rect.x + rect.w + pad, rect.y + rect.h + pad)
    const src = clamp(r.x - pad, r.y - pad, r.x + r.w + pad, r.y + r.h + pad)
    if (r.w <= 0 || r.h <= 0) return
    const sub = document.createElement('canvas')
    sub.width = src.w
    sub.height = src.h
    sub.getContext('2d').drawImage(live.canvas, src.x, src.y, src.w, src.h, 0, 0, src.w, src.h)
    const blurred = featherAlphaCanvas(sub, feather)
    const ctx = live.feathered.getContext('2d')
    ctx.clearRect(r.x, r.y, r.w, r.h)
    ctx.drawImage(blurred, r.x - src.x, r.y - src.y, r.w, r.h, r.x, r.y, r.w, r.h)
}

/** Blank (fully visible) clip, without reading the mask: for an empty mask. */
export function resetLiveClip(live) {
    const ctx = live.canvas.getContext('2d')
    ctx.globalCompositeOperation = 'copy'
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, live.canvas.width, live.canvas.height)
    ctx.globalCompositeOperation = 'source-over'
    if (live.feathered) {
        const f = live.feathered.getContext('2d')
        f.globalCompositeOperation = 'copy'
        f.fillStyle = '#ffffff'
        f.fillRect(0, 0, live.feathered.width, live.feathered.height)
        f.globalCompositeOperation = 'source-over'
    }
}

export const detachLiveClip = (img) => {
    if (img?._phosmithLiveClip && img.clipPath === img._phosmithLiveClip.object) img.clipPath = undefined
}
