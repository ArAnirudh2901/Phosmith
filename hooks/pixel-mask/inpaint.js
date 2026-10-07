import { getRoutingMode } from '@/lib/ai-routing'

export const INPAINT_UPLOAD_MAX_SIDE = 1536
export const INPAINT_MASK_THRESHOLD = 16
export const INPAINT_IMAGE_QUALITY = 0.88

/**
 * Fraction of a decoded greyscale mask that's "on" (white). Used to tell an
 * empty SAM result (no object under the click → all-black) from a real hit,
 * and to flag a near-full-frame selection. Sampled at ≤128px because only the
 * rough proportion matters, not the exact area. Same-origin mask, so
 * getImageData won't taint; the guards just keep a transient failure from
 * blocking the erase (assume non-empty and proceed).
 */
/**
 * Turn an AI-result blob into a URL that SURVIVES — undo/redo recreates Fabric
 * images from their serialized `src` (loadFromJSON), and the canvas state is
 * persisted to Neon, so a `blob:` URL (revoked, page-scoped) would break both.
 * Primary: upload to ImageKit (same pattern as the Crop tool) → permanent
 * remote URL. Fallback (offline / upload failed): a `data:` URL — in-session
 * undo/redo keeps working, and canvas-state.js already knows how to handle
 * oversized data: srcs at save time.
 */
export const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('could not read result blob'))
        reader.readAsDataURL(blob)
    })

export const persistResultBlob = async (blob, { signal, label = 'inpaint' } = {}) => {
    try {
        const fileName = `${label}-${Date.now()}.png`
        const form = new FormData()
        form.append('fileName', fileName)
        form.append('rasterFile', blob, fileName)
        form.append('rasterFileName', fileName)
        const resp = await fetch('/api/imagekit/upload', { method: 'POST', body: form, signal })
        const data = await resp.json().catch(() => null)
        if (resp.ok && data?.success && data?.url) return data.url
        console.warn('[pixel-tool] result upload failed, falling back to data URL:', data?.error || resp.status)
    } catch (err) {
        if (err?.name === 'AbortError') throw err
        console.warn('[pixel-tool] result upload failed, falling back to data URL:', err?.message)
    }
    return blobToDataUrl(blob)
}

/** The /api/ai/inpaint backend for the user's `inpaint` routing preference. */
export const inpaintBackendFromRouting = () => {
    const mode = getRoutingMode('inpaint')
    if (mode === 'client') return 'lama'
    if (mode === 'server') return 'hf'
    return 'auto'
}

export const sampleMaskCoverage = (imageEl) => {
    const cap = 128
    const iw = imageEl?.naturalWidth || imageEl?.width || 0
    const ih = imageEl?.naturalHeight || imageEl?.height || 0
    if (!iw || !ih) return 1
    const s = Math.min(1, cap / Math.max(iw, ih))
    const w = Math.max(1, Math.round(iw * s))
    const h = Math.max(1, Math.round(ih * s))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return 1
    ctx.drawImage(imageEl, 0, 0, w, h)
    try {
        const { data } = ctx.getImageData(0, 0, w, h)
        let on = 0
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 127) on += 1
        }
        return on / (w * h)
    } catch {
        return 1
    }
}

export const canvasToBlob = (canvas, type = 'image/png', quality) =>
    new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error('canvas toBlob failed'))),
            type,
            quality,
        )
    })

export const decodeBlobImage = (blob) =>
    new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob)
        const image = new Image()
        image.onload = () => {
            URL.revokeObjectURL(url)
            resolve(image)
        }
        image.onerror = () => {
            URL.revokeObjectURL(url)
            reject(new Error('image decode failed'))
        }
        image.src = url
    })

export const findInpaintMaskBounds = (maskCanvas) => {
    if (!maskCanvas?.width || !maskCanvas?.height) return null
    const w = maskCanvas.width
    const h = maskCanvas.height
    const ctx = maskCanvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null

    let data
    try {
        data = ctx.getImageData(0, 0, w, h).data
    } catch {
        return null
    }

    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < h; y += 1) {
        const row = y * w * 4
        for (let x = 0; x < w; x += 1) {
            if (data[row + x * 4] <= INPAINT_MASK_THRESHOLD) continue
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
        }
    }
    if (maxX < minX || maxY < minY) return null

    const boxW = maxX - minX + 1
    const boxH = maxY - minY + 1
    const pad = Math.max(32, Math.min(220, Math.round(Math.max(boxW, boxH) * 0.35)))
    const left = Math.max(0, minX - pad)
    const top = Math.max(0, minY - pad)
    const right = Math.min(w - 1, maxX + pad)
    const bottom = Math.min(h - 1, maxY + pad)
    return {
        left,
        top,
        width: right - left + 1,
        height: bottom - top + 1,
    }
}

export const buildCompactInpaintPayload = async (imageCanvas, maskCanvas) => {
    const bounds = findInpaintMaskBounds(maskCanvas)
    if (!bounds) return null

    const scale = Math.min(1, INPAINT_UPLOAD_MAX_SIDE / Math.max(bounds.width, bounds.height))
    const outW = Math.max(1, Math.round(bounds.width * scale))
    const outH = Math.max(1, Math.round(bounds.height * scale))

    const imageCrop = document.createElement('canvas')
    imageCrop.width = outW
    imageCrop.height = outH
    const imageCtx = imageCrop.getContext('2d')
    if (!imageCtx) throw new Error('Could not allocate inpaint image crop')
    imageCtx.imageSmoothingEnabled = true
    imageCtx.imageSmoothingQuality = 'high'
    imageCtx.drawImage(
        imageCanvas,
        bounds.left,
        bounds.top,
        bounds.width,
        bounds.height,
        0,
        0,
        outW,
        outH,
    )

    const maskCrop = document.createElement('canvas')
    maskCrop.width = outW
    maskCrop.height = outH
    const maskCtx = maskCrop.getContext('2d')
    if (!maskCtx) throw new Error('Could not allocate inpaint mask crop')
    maskCtx.imageSmoothingEnabled = false
    maskCtx.drawImage(
        maskCanvas,
        bounds.left,
        bounds.top,
        bounds.width,
        bounds.height,
        0,
        0,
        outW,
        outH,
    )

    const [imageBlob, maskBlob] = await Promise.all([
        canvasToBlob(imageCrop, 'image/jpeg', INPAINT_IMAGE_QUALITY),
        canvasToBlob(maskCrop, 'image/png'),
    ])

    return { imageBlob, maskBlob, bounds, scale }
}

export const compositeInpaintPatch = async (baseCanvas, patchBlob, bounds) => {
    const patch = await decodeBlobImage(patchBlob)
    const out = document.createElement('canvas')
    out.width = baseCanvas.width
    out.height = baseCanvas.height
    const ctx = out.getContext('2d')
    if (!ctx) throw new Error('Could not allocate inpaint composite canvas')
    ctx.drawImage(baseCanvas, 0, 0)
    ctx.drawImage(patch, bounds.left, bounds.top, bounds.width, bounds.height)
    return canvasToBlob(out, 'image/png')
}
