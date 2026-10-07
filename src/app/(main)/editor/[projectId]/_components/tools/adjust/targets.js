import { PROXY_MAX_PX } from "./config"

export const isImageObject = (obj) => obj?.type === "image" || obj?.type === "Image"

export const isVisibleImageObject = (obj) => isImageObject(obj) && obj.visible !== false

export const getSelectedImage = (canvasEditor) => {
    if (!canvasEditor) return null
    const active = canvasEditor.getActiveObject()
    return isVisibleImageObject(active) ? active : null
}

export const getVisibleImages = (canvasEditor) =>
    (canvasEditor?.getObjects?.() || []).filter(isVisibleImageObject)

export const getAdjustmentTargets = (canvasEditor) => {
    const active = canvasEditor?.getActiveObject?.()
    if (active?.type === "activeSelection") {
        const picked = active.getObjects?.().filter(isVisibleImageObject) || []
        if (picked.length) return picked
    }
    const selected = getSelectedImage(canvasEditor)
    return selected ? [selected] : getVisibleImages(canvasEditor)
}

export const getAdjustmentSourceImage = (canvasEditor) =>
    getSelectedImage(canvasEditor) || getVisibleImages(canvasEditor)[0] || null

export const ensureAdjustmentObjectId = (imageObject) => {
    if (!imageObject) return null
    const existing = imageObject.phosmithAdjustmentId || imageObject._phosmithAdjustmentId || imageObject.__uid
    const id = existing || `image-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    imageObject.phosmithAdjustmentId = id
    imageObject._phosmithAdjustmentId = id
    return id
}

export const getImageSrc = (image) =>
    image?.getSrc?.() ||
    image?._originalElement?.src ||
    image?._element?.src ||
    image?.src ||
    ""

// Downscale a source element (img/canvas) to a proxy canvas whose long edge is
// PROXY_MAX_PX, using pure browser APIs (createImageBitmap's off-thread resize,
// falling back to a canvas draw). Returns null when the source is already small
// enough (no proxy needed) — enterPreviewMode treats null as "don't swap", so
// tiny images keep filtering full-res.
export const buildProxyCanvas = async (sourceEl) => {
    if (!sourceEl || typeof document === "undefined") return null
    const W = sourceEl.naturalWidth || sourceEl.width || 0
    const H = sourceEl.naturalHeight || sourceEl.height || 0
    if (!W || !H || Math.max(W, H) <= PROXY_MAX_PX) return null
    const scale = PROXY_MAX_PX / Math.max(W, H)
    const pw = Math.max(1, Math.round(W * scale))
    const ph = Math.max(1, Math.round(H * scale))
    const out = document.createElement("canvas")
    out.width = pw
    out.height = ph
    const ctx = out.getContext("2d")
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    try {
        // Prefer the browser's own high-quality resize (runs off the main thread
        // where supported). Explicit dest dims keep it correct even on engines
        // that ignore resizeWidth (older Safari) — there the canvas smoothing
        // does the downscale.
        const bmp = await createImageBitmap(sourceEl, { resizeWidth: pw, resizeHeight: ph, resizeQuality: "high" })
        ctx.drawImage(bmp, 0, 0, pw, ph)
        bmp.close?.()
    } catch {
        // Fallback: direct canvas downscale (e.g. createImageBitmap unavailable).
        ctx.drawImage(sourceEl, 0, 0, pw, ph)
    }
    return out
}
