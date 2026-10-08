/**
 * Committing a pixel stretch to the canvas.
 *
 * The Pixel Stretch panel and the agent's `stretch.*` commands must produce the
 * SAME thing — an independent Fabric layer above the photo, carrying the params
 * and a durable copy of its source in `data.pixelStretch` so re-selecting it
 * re-enters the tool. That shared contract lives here rather than inside the
 * panel, so an agent edit and a hand edit are the same object.
 */

import { FabricImage } from 'fabric'
import { runHeavy } from './heavy-job-queue'
import {
    clampStretchParams,
    createStretchBuffer,
    renderStretchLayer,
    matteToAlphaCanvas,
    releaseStretchScratch,
} from './pixel-stretch'

export const MAX_BAKE_DIM = 4096

/**
 * Blend modes worth offering for a stretch layer. Photoshop users reach for
 * Screen and Overlay on these ribbons constantly — the streaks then take light
 * from the photo instead of covering it — so the committed layer carries a real
 * composite operation rather than only an opacity.
 */
export const STRETCH_BLEND_MODES = [
    { id: 'source-over', label: 'Normal' },
    { id: 'screen', label: 'Screen' },
    { id: 'multiply', label: 'Multiply' },
    { id: 'overlay', label: 'Overlay' },
    { id: 'lighten', label: 'Lighten' },
    { id: 'soft-light', label: 'Soft light' },
    { id: 'hard-light', label: 'Hard light' },
    { id: 'difference', label: 'Difference' },
]

export const isStretchBlend = (id) => STRETCH_BLEND_MODES.some((b) => b.id === id)

export const getSourceElement = (img) => img?._originalElement || img?.getElement?.() || img?._element || null

export const isSourceReady = (el) => {
    if (!el) return false
    if (typeof HTMLImageElement !== 'undefined' && el instanceof HTMLImageElement) return el.complete && el.naturalWidth > 0
    return (el.naturalWidth || el.videoWidth || el.width || 0) > 0
}

/** Snapshot a source element into a W×H buffer, baking in the object's flip. */
export const snapshotSource = (srcEl, W, H, flipX, flipY) => {
    const c = createStretchBuffer(W, H)
    const ctx = c.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.save()
    ctx.translate(flipX ? c.width : 0, flipY ? c.height : 0)
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1)
    ctx.drawImage(srcEl, 0, 0, c.width, c.height)
    ctx.restore()
    return c
}

export const encodeToPngBlob = async (canvas) => {
    if (typeof canvas.convertToBlob === 'function') {
        // OffscreenCanvas — the PNG encode runs off the main thread.
        return canvas.convertToBlob({ type: 'image/png' })
    }
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))), 'image/png')
    })
}

export const uploadStretchBlob = async (blob, w, h) => {
    const fileName = `stretch-${Date.now()}.png`
    const formData = new FormData()
    formData.append('fileName', fileName)
    formData.append('rasterFile', blob, fileName)
    formData.append('rasterFileName', fileName)
    formData.append('rasterWidth', String(w))
    formData.append('rasterHeight', String(h))
    const response = await fetch('/api/imagekit/upload', { method: 'POST', body: formData })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.success || !data?.url) {
        throw new Error(data?.error || 'Could not upload stretched image')
    }
    return data.url
}

/** Bake dimensions for a source element, capped at MAX_BAKE_DIM on the long edge. */
export const bakeSizeOf = (srcEl) => {
    const natW = srcEl?.naturalWidth || srcEl?.videoWidth || srcEl?.width || 0
    const natH = srcEl?.naturalHeight || srcEl?.videoHeight || srcEl?.height || 0
    if (!natW || !natH) throw new Error('Image has no dimensions')
    const sf = Math.min(1, MAX_BAKE_DIM / Math.max(natW, natH))
    return { natW, natH, W: Math.max(1, Math.round(natW * sf)), H: Math.max(1, Math.round(natH * sf)) }
}

/**
 * Render the ribbons onto a TRANSPARENT buffer at bake resolution. The photo
 * stays its own layer underneath, so the stretch can be moved, graded or deleted
 * on its own. `matte` (a luminance subject matte) plus `coverage` knocks the
 * subject back out of the ribbon, which is how the streaks pass BEHIND a person;
 * `wrapAt` brings the ribbon back in front from that point along it.
 */
export const bakeStretchBuffer = ({ srcEl, params, W, H, flipX = false, flipY = false, matte = null, coverage = 0, feather = 0, wrapAt = null }) => {
    // NOTE: intentionally NOT queued here. It is synchronous, and its caller
    // `applyStretchToCanvas` takes the slot around the whole bake-encode-upload
    // sequence — queueing both would deadlock the queue against itself.

    const sample = snapshotSource(srcEl, W, H, flipX, flipY)
    const out = createStretchBuffer(W, H)
    const octx = out.getContext('2d')
    let drew = false
    try {
        const alpha = coverage > 0 && matte ? matteToAlphaCanvas(matte, W, H, feather * Math.min(W, H), sample) : null
        drew = renderStretchLayer(octx, sample, clampStretchParams(params), W, H, { quality: 'max', alpha, coverage, wrapAt })
    } finally {
        // A bake sizes the shared scratch canvases to the FULL image and they are
        // kept between frames by design; at 4096px that is tens of MB each, so the
        // commit hands them back rather than holding them for the session.
        sample.width = 1
        sample.height = 1
        releaseStretchScratch()
    }
    return drew ? out : null
}

/**
 * Insert (or re-point) the stretch layer above `frameObj`, matching its placement
 * so the ribbons land exactly where the preview drew them.
 *
 * @returns {Promise<import('fabric').FabricImage>} the layer
 */
export const placeStretchLayer = async ({ editor, frameObj, url, W, H, meta, existingLayer = null, blend = 'source-over' }) => {
    const mode = isStretchBlend(blend) ? blend : 'source-over'
    if (existingLayer) {
        // Re-edit: swap the layer's pixels, keep its transforms / filters / crop.
        const layer = existingLayer
        const prevScaledW = (layer.width || W) * Math.abs(layer.scaleX || 1)
        const prevScaledH = (layer.height || H) * Math.abs(layer.scaleY || 1)
        await layer.setSrc(url, { crossOrigin: 'anonymous' })
        const newW = layer.width || W, newH = layer.height || H
        layer.set({ scaleX: prevScaledW / newW, scaleY: prevScaledH / newH, flipX: false, flipY: false, globalCompositeOperation: mode })
        layer.data = { ...(layer.data || {}), pixelStretch: { ...meta, blend: mode } }
        if (layer.filters?.length) layer.applyFilters()
        layer.setCoords()
        return layer
    }
    const newImg = await FabricImage.fromURL(url, { crossOrigin: 'anonymous' })
    const srcScaledW = (frameObj.width || W) * Math.abs(frameObj.scaleX || 1)
    const srcScaledH = (frameObj.height || H) * Math.abs(frameObj.scaleY || 1)
    newImg.set({
        left: frameObj.left, top: frameObj.top,
        originX: frameObj.originX, originY: frameObj.originY,
        angle: frameObj.angle || 0,
        flipX: false, flipY: false,
        scaleX: srcScaledW / W, scaleY: srcScaledH / H,
        opacity: frameObj.opacity ?? 1,
        selectable: true, evented: true, hasControls: true, hasBorders: true,
        globalCompositeOperation: mode,
        name: 'Pixel Stretch',
        data: { pixelStretch: { ...meta, blend: mode } },
    })
    const idx = editor.getObjects().indexOf(frameObj)
    if (idx >= 0) editor.insertAt(idx + 1, newImg)
    else editor.add(newImg)
    newImg.setCoords()
    return newImg
}

/**
 * Bake → upload → place, in one call. The agent's path; the panel runs the same
 * steps around its own refs and toasts.
 *
 * @returns {Promise<{ layer: object, url: string, meta: object, W: number, H: number }>}
 */
export const applyStretchToCanvas = async (args) =>
    // Bake + PNG encode + upload holds three image-sized buffers at once, so the
    // whole sequence takes the slot rather than each step racing something else.
    // No supersede key here: the agent may legitimately queue several distinct
    // ribbons. Double-click protection belongs to the button, not the engine.
    runHeavy('pixel stretch commit', () => applyStretchInner(args))

const applyStretchInner = async ({
    editor,
    frameObj,
    params,
    coverage = 0,
    feather = 0,
    matte = null,
    existingLayer = null,
    durableSrc = null,
    blend = 'source-over',
    wrapAt = null,
}) => {
    const srcEl = getSourceElement(frameObj)
    if (!isSourceReady(srcEl)) throw new Error('Image is still loading')
    const { natW, natH, W, H } = bakeSizeOf(srcEl)
    const flipX = !!frameObj.flipX
    const flipY = !!frameObj.flipY

    const out = bakeStretchBuffer({ srcEl, params, W, H, flipX, flipY, matte, coverage, feather, wrapAt })
    if (!out) throw new Error('Nothing to stretch — set a region, a flow path or a scanline threshold first')
    const url = await uploadStretchBlob(await encodeToPngBlob(out), W, H)

    // The layer must survive the photo being deleted, so a non-durable source
    // (blob:/data:) is snapshotted once, unflipped — re-edit re-applies the flip.
    let src = durableSrc || frameObj.getSrc?.() || srcEl.src || null
    if (!(typeof src === 'string' && /^https?:\/\//i.test(src))) {
        src = await uploadStretchBlob(await encodeToPngBlob(snapshotSource(srcEl, W, H, false, false)), W, H)
    }

    const meta = {
        version: 1,
        params: clampStretchParams(params),
        coverage,
        feather,
        wrapAt: Number.isFinite(wrapAt) ? wrapAt : null,
        sourceSrc: src,
        sourceW: natW, sourceH: natH,
        sourceFlipX: flipX, sourceFlipY: flipY,
    }
    const layer = await placeStretchLayer({ editor, frameObj, url, W, H, meta, existingLayer, blend })
    return { layer, url, meta, W, H }
}
