import { getRoutingMode } from '@/lib/ai-routing'
import { patchInpaint } from '@/lib/cv/patch-inpaint'

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
        const fileName = `${label}-${Date.now()}.${blob.type === 'image/jpeg' ? 'jpg' : 'png'}`
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

export const findInpaintMaskBounds = (maskCanvas, { pad: withPad = true } = {}) => {
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
    if (!withPad) return { left: minX, top: minY, width: boxW, height: boxH }
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

// Largest side the on-device fill works at; bigger crops are filled smaller and
// only the fill itself is scaled back (see composeFill).
const DEVICE_MAX_SIDE = 1024

const cropTo = (source, bounds, w, h, smooth) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.imageSmoothingEnabled = smooth
    if (smooth) ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, bounds.left, bounds.top, bounds.width, bounds.height, 0, 0, w, h)
    return c
}

// Binarise a white-on-black mask and grow it by `px`: object masks stop short of
// their own soft edge and shadow, and a fill that leaves that rim shows a ghost
// outline of the thing it removed.
const growMask = (mask, px) => {
    const { width: w, height: h } = mask
    const ctx = mask.getContext('2d', { willReadFrequently: true })
    if (px > 0) {
        const blurred = document.createElement('canvas')
        blurred.width = w
        blurred.height = h
        const bctx = blurred.getContext('2d', { willReadFrequently: true })
        bctx.filter = `blur(${px / 2}px)`
        bctx.drawImage(mask, 0, 0)
        bctx.filter = 'none'
        ctx.clearRect(0, 0, w, h)
        ctx.drawImage(blurred, 0, 0)
    }
    const image = ctx.getImageData(0, 0, w, h)
    const d = image.data
    let on = 0
    for (let i = 0; i < d.length; i += 4) {
        const v = d[i] > (px > 0 ? 20 : INPAINT_MASK_THRESHOLD) ? 255 : 0
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255
        if (v) on += 1
    }
    ctx.putImageData(image, 0, 0)
    return on
}

// After the server says no fill service is there (501/502/503), skip it for a
// minute: every fill would otherwise encode its crop and wait on the refusal.
const SERVER_COOLDOWN_MS = 60_000
let serverDownUntil = 0

async function serverInpaint(imageCrop, maskCrop, signal) {
    if (Date.now() < serverDownUntil) throw Object.assign(new Error('The AI fill service is not running'), { status: 503 })
    const [imageBlob, maskBlob] = await Promise.all([
        canvasToBlob(imageCrop, 'image/jpeg', INPAINT_IMAGE_QUALITY),
        canvasToBlob(maskCrop, 'image/png'),
    ])
    const form = new FormData()
    form.append('image', imageBlob, 'image.jpg')
    form.append('mask', maskBlob, 'mask.png')
    form.append('backend', inpaintBackendFromRouting())
    const resp = await fetch('/api/ai/inpaint', { method: 'POST', body: form, signal })
    if (!resp.ok) {
        const data = await resp.json().catch(() => ({}))
        if ([501, 502, 503].includes(resp.status)) serverDownUntil = Date.now() + SERVER_COOLDOWN_MS
        throw Object.assign(new Error(data.error || `Inpaint failed (${resp.status})`), { status: resp.status })
    }
    const engine = resp.headers.get('X-Inpaint-Backend') || 'server'
    return { image: await decodeBlobImage(await resp.blob()), engine }
}

async function deviceInpaint(imageCrop, maskCrop, signal) {
    const { width: w, height: h } = imageCrop
    const s = Math.min(1, DEVICE_MAX_SIDE / Math.max(w, h))
    const dw = Math.max(8, Math.round(w * s))
    const dh = Math.max(8, Math.round(h * s))
    const full = { left: 0, top: 0, width: w, height: h }
    const img = s < 1 ? cropTo(imageCrop, full, dw, dh, true) : imageCrop
    const msk = s < 1 ? cropTo(maskCrop, full, dw, dh, true) : maskCrop
    const rgba = img.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, dw, dh)
    const m = msk.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, dw, dh).data
    const hole = new Uint8Array(dw * dh)
    for (let p = 0; p < dw * dh; p += 1) hole[p] = m[p * 4] > 127 ? 1 : 0
    const filled = await patchInpaint(rgba.data, dw, dh, hole, { signal })
    if (!filled) throw new Error('Not enough picture around the selection to fill it from')
    const out = document.createElement('canvas')
    out.width = dw
    out.height = dh
    out.getContext('2d').putImageData(new ImageData(filled, dw, dh), 0, 0)
    return out
}

// Box of the white area of a mask, padded for context, in bitmap px. The mask
// may be smaller than the bitmap (a 1024 px SAM answer) or a crop of it: it
// sits at (x, y) and each of its pixels covers `scale` bitmap px.
const fillBounds = (mask, { x = 0, y = 0, scale = 1, bitmapW, bitmapH }) => {
    const box = findInpaintMaskBounds(mask, { pad: false })
    if (!box) return null
    const bx0 = x + box.left * scale
    const by0 = y + box.top * scale
    const bw = box.width * scale
    const bh = box.height * scale
    const pad = Math.max(32, Math.min(220, Math.round(Math.max(bw, bh) * 0.35)))
    const left = Math.max(0, Math.floor(bx0 - pad))
    const top = Math.max(0, Math.floor(by0 - pad))
    const right = Math.min(bitmapW, Math.ceil(bx0 + bw + pad))
    const bottom = Math.min(bitmapH, Math.ceil(by0 + bh + pad))
    return { left, top, width: right - left, height: bottom - top }
}

/**
 * Regenerate the white area of `fillMask` in the image. The server (LaMa, or
 * Stable Diffusion) goes first; when it is not running, or fails, the fill is
 * computed on this device instead — so the remover fills rather than leaving a
 * hole. Only the region around the mask is ever read or copied: a 24 MP frame
 * used to be copied and scanned whole before the request even left.
 *
 * @param {object} o
 * @param {CanvasImageSource} o.sourceEl  the image's full source
 * @param {number} o.cropX, o.cropY        where bitmap space starts in the source
 * @param {number} o.bitmapW, o.bitmapH    bitmap size
 * @param {HTMLCanvasElement} o.fillMask   white = fill; at (maskX, maskY), maskScale bitmap px per pixel
 * @returns {Promise<{ patch, mask, bounds, engine, serverError } | null>} `patch`
 *   drawable at `bounds` (bitmap px); `mask` the grown white-on-black fill area at its size.
 */
export async function inpaintRegion({ sourceEl, cropX = 0, cropY = 0, bitmapW, bitmapH, fillMask, maskX = 0, maskY = 0, maskScale = 1, signal, grow = 0, deviceOnly = false }) {
    const bounds = fillBounds(fillMask, { x: maskX, y: maskY, scale: maskScale, bitmapW, bitmapH })
    if (!bounds || bounds.width < 2 || bounds.height < 2) return null
    const scale = Math.min(1, INPAINT_UPLOAD_MAX_SIDE / Math.max(bounds.width, bounds.height))
    const w = Math.max(1, Math.round(bounds.width * scale))
    const h = Math.max(1, Math.round(bounds.height * scale))
    const imageCrop = cropTo(sourceEl, { left: cropX + bounds.left, top: cropY + bounds.top, width: bounds.width, height: bounds.height }, w, h, true)
    const maskCrop = cropTo(fillMask, {
        left: (bounds.left - maskX) / maskScale,
        top: (bounds.top - maskY) / maskScale,
        width: bounds.width / maskScale,
        height: bounds.height / maskScale,
    }, w, h, maskScale > 1)
    if (!growMask(maskCrop, Math.round(grow * scale))) return null

    let serverError = null
    if (!deviceOnly) {
        try {
            const { image, engine } = await serverInpaint(imageCrop, maskCrop, signal)
            return { patch: image, mask: maskCrop, bounds, engine, serverError: null }
        } catch (err) {
            if (err?.name === 'AbortError') throw err
            serverError = err
        }
    }
    const patch = await deviceInpaint(imageCrop, maskCrop, signal)
    return { patch, mask: maskCrop, bounds, engine: 'device', serverError }
}

/**
 * The full source with a fill blended in through its own feathered mask. Only
 * the filled area changes: the patch is drawn through the mask, so a crop the
 * server or device worked on at reduced size never softens the pixels around it.
 * (cropX, cropY) places bitmap space in the source, so a cropped image keeps
 * its crop and the rest of its source.
 */
export function composeFill(sourceEl, region, cropX = 0, cropY = 0) {
    const sw = sourceEl.naturalWidth || sourceEl.width
    const sh = sourceEl.naturalHeight || sourceEl.height
    const { bounds, patch, mask } = region
    const layer = document.createElement('canvas')
    layer.width = bounds.width
    layer.height = bounds.height
    const lctx = layer.getContext('2d')
    lctx.imageSmoothingQuality = 'high'
    lctx.drawImage(patch, 0, 0, bounds.width, bounds.height)
    // White-on-black mask → alpha, feathered by a pixel and a half.
    const alpha = document.createElement('canvas')
    alpha.width = mask.width
    alpha.height = mask.height
    const actx = alpha.getContext('2d', { willReadFrequently: true })
    const md = mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, mask.width, mask.height)
    for (let i = 0; i < md.data.length; i += 4) { md.data[i + 3] = md.data[i]; md.data[i] = 255; md.data[i + 1] = 255; md.data[i + 2] = 255 }
    actx.putImageData(md, 0, 0)
    lctx.globalCompositeOperation = 'destination-in'
    lctx.filter = `blur(${Math.max(1, (bounds.width / mask.width) * 1.5)}px)`
    lctx.drawImage(alpha, 0, 0, bounds.width, bounds.height)
    lctx.filter = 'none'
    lctx.globalCompositeOperation = 'source-over'

    const out = document.createElement('canvas')
    out.width = sw
    out.height = sh
    const ctx = out.getContext('2d')
    ctx.drawImage(sourceEl, 0, 0, sw, sh)
    ctx.drawImage(layer, cropX + bounds.left, cropY + bounds.top)
    return out
}

export const engineLabel = (engine) => ({
    lama: 'LaMa',
    hf: 'Stable Diffusion',
    device: 'on this device',
})[engine] || 'AI'

// Opaque photos are stored as JPEG at 0.95 — a fifth of the PNG's bytes for the
// upload and the reload, with no visible loss; anything with transparency
// (a cut-out) stays PNG. Decided and encoded in a worker: the result is a
// full-size frame, and a 24 MP toBlob plus the opacity probe cost ~120 ms of
// main thread. An inline worker, so no bundler has to know about it.
const ENCODER_SRC = `
onmessage = async (e) => {
  const { id, bitmap } = e.data
  try {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height)
    c.getContext('2d').drawImage(bitmap, 0, 0)
    const s = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height))
    const probe = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * s)), Math.max(1, Math.round(bitmap.height * s)))
    const pctx = probe.getContext('2d')
    pctx.drawImage(bitmap, 0, 0, probe.width, probe.height)
    bitmap.close()
    const d = pctx.getImageData(0, 0, probe.width, probe.height).data
    let opaque = true
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { opaque = false; break }
    const blob = await c.convertToBlob(opaque ? { type: 'image/jpeg', quality: 0.95 } : { type: 'image/png' })
    postMessage({ id, blob })
  } catch (err) {
    postMessage({ id, error: String(err) })
  }
}`
let encoder = null

const encodeOffThread = async (canvas) => {
    if (typeof OffscreenCanvas === 'undefined' || typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') return null
    try {
        if (!encoder) {
            encoder = { worker: new Worker(URL.createObjectURL(new Blob([ENCODER_SRC], { type: 'text/javascript' }))), next: 0, waiting: new Map() }
            encoder.worker.onmessage = (e) => {
                const done = encoder.waiting.get(e.data.id)
                encoder.waiting.delete(e.data.id)
                done?.(e.data.blob || null)
            }
        }
        const bitmap = await createImageBitmap(canvas)
        const id = ++encoder.next
        return await new Promise((resolve) => {
            encoder.waiting.set(id, resolve)
            encoder.worker.postMessage({ id, bitmap }, [bitmap])
        })
    } catch {
        return null
    }
}

const encodeOnThread = (canvas) => {
    const probe = document.createElement('canvas')
    const s = Math.min(1, 256 / Math.max(canvas.width, canvas.height))
    probe.width = Math.max(1, Math.round(canvas.width * s))
    probe.height = Math.max(1, Math.round(canvas.height * s))
    const pctx = probe.getContext('2d', { willReadFrequently: true })
    pctx.drawImage(canvas, 0, 0, probe.width, probe.height)
    const d = pctx.getImageData(0, 0, probe.width, probe.height).data
    let opaque = true
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { opaque = false; break }
    return opaque ? canvasToBlob(canvas, 'image/jpeg', 0.95) : canvasToBlob(canvas, 'image/png')
}

export const encodeResult = async (canvas) => (await encodeOffThread(canvas)) || encodeOnThread(canvas)

/** An <img> for `url`, decoded off the main thread before it is drawn. */
export async function loadDecodedImage(url) {
    const el = new Image()
    el.crossOrigin = 'anonymous'
    el.src = url
    await el.decode()
    return el
}
