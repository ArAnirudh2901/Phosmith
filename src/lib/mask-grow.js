/**
 * mask-grow
 * ----------
 * Boundary extension (grow) / contraction (shrink) for texture-backed mask
 * layers — the "extend the selection by N px" primitive. Works on ANY mask
 * texture regardless of where it came from (AI subject detection, text
 * grounding, lasso, brush), so an automatically detected subject mask is
 * just as expandable as a hand-drawn one.
 *
 * Morphology is approximated with a single-pass separable box blur followed
 * by a smoothstep re-threshold: blurring a step edge by radius R produces a
 * linear ramp over [-R, +R], so cutting that ramp at the value the ramp takes
 * `px` beyond the original edge dilates (or erodes, for negative `px`) by
 * almost exactly `px` pixels — in O(n) and with a soft anti-aliased edge.
 *
 * The pure core (`growCoverage`) is DOM-free and unit-testable; the canvas
 * and layer-level wrappers live below it.
 */

import {
    applyMegashaderFilter,
    getMaskTexture,
    sanitiseLayer,
    setMaskTexture,
    setMaskTextureResolver,
    clearMaskTexture,
    listMaskTextureKeys,
} from '@/lib/megashader'
import { growCoverage, refineCoverage, MAX_GROW_PX } from './mask-grow-core'
import { isAgentActing, recordChange } from './change-journal'

// Re-export the pure core so consumers (commands, UI) import one module.
export { growCoverage, MAX_GROW_PX } from './mask-grow-core'

const MEGASHADER_TYPE = 'Megashader'

/** Mask kinds whose selection lives in a registered texture. */
export const TEXTURE_BACKED_KINDS = ['semantic', 'lasso', 'path', 'brush', 'smartBrush']

/**
 * Grow/shrink a mask texture canvas. Preserves the channel convention of the
 * input: alpha-styled canvases (the brush kind samples painted alpha) get the
 * result written to alpha; opaque luma-styled canvases (lasso/semantic — the
 * shader samples R) get it written to RGB.
 *
 * @param {HTMLCanvasElement|ImageData|CanvasImageSource} source
 * @param {number} px
 * @returns {HTMLCanvasElement} a NEW canvas (the input is untouched)
 */
// Working-resolution cap for boundary growth. The shader samples masks by UV,
// so a capped texture renders at any size; full-res growth on a 24 MP matte
// took ~1.2 s per release and each variant pinned ~96 MB.
const GROW_MAX_DIM = 2048
// Decoded coverage per pristine texture and working size: decoding reads the
// whole texture, and the pristine base never changes between slider releases.
const coverageCache = new WeakMap()

const readCoverage = (source, w, h) => {
    let perSize = coverageCache.get(source)
    const sizeKey = `${w}x${h}`
    const cached = perSize?.get(sizeKey)
    if (cached) return cached

    const sw = source.width || source.naturalWidth
    const sh = source.height || source.naturalHeight
    let data
    if (typeof ImageData !== 'undefined' && source instanceof ImageData && sw === w && sh === h) {
        data = source
    } else {
        let drawable = source
        if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
            drawable = document.createElement('canvas')
            drawable.width = sw
            drawable.height = sh
            drawable.getContext('2d').putImageData(source, 0, 0)
        }
        const tmp = document.createElement('canvas')
        tmp.width = w
        tmp.height = h
        const tctx = tmp.getContext('2d', { willReadFrequently: true })
        tctx.imageSmoothingQuality = 'high'
        tctx.drawImage(drawable, 0, 0, w, h)
        data = tctx.getImageData(0, 0, w, h)
    }
    const pxs = data.data
    let alphaStyled = false
    for (let i = 3; i < pxs.length; i += 4) {
        if (pxs[i] < 250) { alphaStyled = true; break }
    }
    const cover = new Uint8ClampedArray(w * h)
    if (alphaStyled) {
        for (let i = 0, p = 0; i < pxs.length; i += 4, p += 1) {
            const luma = 0.2126 * pxs[i] + 0.7152 * pxs[i + 1] + 0.0722 * pxs[i + 2]
            cover[p] = Math.max(luma, pxs[i + 3] < 250 ? pxs[i + 3] : 0)
        }
    } else {
        for (let i = 0, p = 0; i < pxs.length; i += 4, p += 1) {
            cover[p] = 0.2126 * pxs[i] + 0.7152 * pxs[i + 1] + 0.0722 * pxs[i + 2]
        }
    }
    const entry = { cover, alphaStyled }
    if (!perSize) { perSize = new Map(); coverageCache.set(source, perSize) }
    perSize.set(sizeKey, entry)
    return entry
}

/**
 * Grow/shrink a mask texture canvas. Preserves the channel convention of the
 * input: alpha-styled canvases (the brush kind samples painted alpha) get the
 * result written to alpha; opaque luma-styled canvases (lasso/semantic — the
 * shader samples R) get it written to RGB.
 *
 * Accepts every shape setMaskTexture stores (canvas, ImageData from the AI
 * subject path, or any drawable from texture restore). Works at a capped
 * resolution, stepping finer only when the grow distance would otherwise round
 * to under ~2 working pixels, so small adjustments stay exact.
 *
 * @param {HTMLCanvasElement|ImageData|CanvasImageSource} source
 * @param {number} px  signed distance in SOURCE pixels
 * @param {{ smooth?: number, contrast?: number }} [edge]  Select-and-Mask refinement (0..100 each)
 * @returns {HTMLCanvasElement} a NEW canvas (the input is untouched)
 */
export const growMaskCanvas = (source, px, edge = {}) => {
    const sw = source.width || source.naturalWidth
    const sh = source.height || source.naturalHeight
    const dist = Math.round(Number(px) || 0)
    const capScale = Math.min(1, GROW_MAX_DIM / Math.max(sw, sh))
    const scale = dist === 0 ? capScale : Math.min(1, Math.max(capScale, 2 / Math.abs(dist)))
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))

    const { cover, alphaStyled } = readCoverage(source, w, h)
    const grown = refineCoverage(growCoverage(cover, w, h, dist * (w / sw)), w, h, {
        smooth: edge.smooth,
        contrast: edge.contrast,
        scale: Math.max(w, h) / GROW_MAX_DIM,
    })

    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const ctx = out.getContext('2d')
    const outData = ctx.createImageData(w, h)
    const op = outData.data
    if (alphaStyled) {
        op.fill(255)
        for (let p = 0, i = 3; p < grown.length; p += 1, i += 4) op[i] = grown[p]
    } else {
        for (let i = 0, p = 0; i < op.length; i += 4, p += 1) {
            const v = grown[p]
            op[i] = v; op[i + 1] = v; op[i + 2] = v; op[i + 3] = 255
        }
    }
    ctx.putImageData(outData, 0, 0)
    return out
}

const GROW_KEY = /^(.*)::grow(-?\d+)(?:~s(\d+)c(\d+))?$/
const edgeKey = (baseKey, dist, smooth, contrast) =>
    `${baseKey}::grow${dist}${smooth || contrast ? `~s${smooth}c${contrast}` : ''}`

// Undo can point a layer back at a grown variant that was evicted below.
setMaskTextureResolver((key) => {
    const m = GROW_KEY.exec(key)
    if (!m) return null
    const base = getMaskTexture(m[1])
    return base ? growMaskCanvas(base, Number(m[2]), { smooth: Number(m[3]) || 0, contrast: Number(m[4]) || 0 }) : null
})

// Keep only the newest grown variant per pristine base.
const evictOtherGrowVariants = (baseKey, keepKey, liveKeys) => {
    for (const key of listMaskTextureKeys()) {
        if (key === keepKey || liveKeys.has(key)) continue
        const m = GROW_KEY.exec(key)
        if (m && m[1] === baseKey) clearMaskTexture(key)
    }
}

const getFilter = (image) => (image?.filters || []).find((f) => f && f.type === MEGASHADER_TYPE) || null

/**
 * Set a texture-backed layer's boundary extension to `px` (absolute, not
 * cumulative — calling with 12 then 20 yields a 20 px extension, and 0
 * restores the original). The ORIGINAL texture is kept under the layer's
 * `baseTextureKey` so repeated edits never re-blur an already-grown mask.
 *
 * Works on any texture-backed kind — including AI-detected subject masks —
 * which is exactly the "extend the boundary of an auto-detected selection"
 * use case.
 *
 * @param {object} image    Fabric image carrying the megashader filter
 * @param {string} layerId
 * @param {number} px       signed pixels, clamped to ±MAX_GROW_PX
 * @returns {{ id: string, growPx: number }}
 */
export const expandLayerBoundary = (image, layerId, px, edge) => {
    const filter = getFilter(image)
    const chain = filter?.stack?.chain
    if (!Array.isArray(chain)) throw new Error('[mask-grow] no mask chain on this image')
    const idx = chain.findIndex((e) => e?.layer?.id === layerId)
    if (idx < 0) throw new Error(`[mask-grow] no layer ${layerId}`)

    const entry = chain[idx]
    const layer = entry.layer
    if (!TEXTURE_BACKED_KINDS.includes(layer.kind) || !(layer.maskTextureKey || layer.depthMapKey)) {
        throw new Error(`[mask-grow] layer ${layerId} (${layer.kind}) has no editable mask texture — boundary extension applies to subject/lasso/brush selections`)
    }
    if (layer.depthMapKey && !layer.maskTextureKey) {
        throw new Error('[mask-grow] depth-range layers are range-based; adjust min/max instead of growing')
    }

    const baseKey = layer.baseTextureKey || layer.maskTextureKey
    const base = getMaskTexture(baseKey)
    if (!base) throw new Error('[mask-grow] base mask texture is gone (reload the project)')

    const dist = Math.max(-MAX_GROW_PX, Math.min(MAX_GROW_PX, Math.round(Number(px) || 0)))
    // Omitted edge params keep the layer's current smooth/contrast.
    const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)))
    const smooth = clampPct(edge?.smooth ?? layer.edgeSmooth)
    const contrast = clampPct(edge?.contrast ?? layer.edgeContrast)
    let nextKey = baseKey
    if (dist !== 0 || smooth || contrast) {
        nextKey = edgeKey(baseKey, dist, smooth, contrast)
        if (!getMaskTexture(nextKey)) {
            setMaskTexture(nextKey, growMaskCanvas(base, dist, { smooth, contrast }))
        }
    }
    const liveKeys = new Set(chain.map((e) => e?.layer?.maskTextureKey).filter(Boolean))
    evictOtherGrowVariants(baseKey, nextKey, liveKeys)

    const nextChain = chain.slice()
    nextChain[idx] = {
        op: entry.op,
        layer: sanitiseLayer({
            ...layer,
            maskTextureKey: nextKey,
            baseTextureKey: baseKey,
            growPx: dist,
            edgeSmooth: smooth,
            edgeContrast: contrast,
        }),
    }
    const stack = { chain: nextChain }
    applyMegashaderFilter(image, stack, {
        globalMaskAlpha: filter?.globalMaskAlpha ?? 1,
        globalInvert: filter?.globalInvert ?? false,
        maskOverlay: filter?.maskOverlay ?? false,
    })
    try { image.canvas?.requestRenderAll?.() } catch { /* headless */ }
    try { window.dispatchEvent(new CustomEvent('phosmith:mask-chain-replaced', { detail: { stack } })) } catch { /* SSR */ }
    // The agent path (mask.expandLayer) is journaled by the command registry;
    // only the panel's Boundary slider logs here.
    if (!isAgentActing()) {
        recordChange({
            label: edge && (edge.smooth !== undefined || edge.contrast !== undefined)
                ? `Mask: refine edge (smooth ${smooth}, contrast ${contrast})`
                : `Mask: boundary ${dist > 0 ? '+' : ''}${dist}px`,
            domain: 'mask',
        })
    }
    return { id: layerId, growPx: dist, edgeSmooth: smooth, edgeContrast: contrast }
}

/* ─── Brush-refine (ported from mask-studio) ────────────────────────────────
 * Paint DIRECTLY on a texture-backed layer's mask to add or remove coverage,
 * stroke by stroke — instead of committing new layers. `beginLayerRefine`
 * normalises the layer's texture onto a paintable working canvas (preserving
 * the kind's coverage channel: painted alpha for the plain brush, opaque
 * red/luma for semantic & friends) and swaps it in under a NEW key (the
 * pre-refine texture stays cached under the old key). `applyRefineStroke`
 * composites a finished brush stroke into that canvas and re-renders through
 * the same direct filter path the Boundary slider uses.
 */

// Draw any texture shape (canvas / ImageData / drawable) scaled into a ctx.
const drawTextureInto = (ctx, tex, w, h) => {
    if (typeof ImageData !== 'undefined' && tex instanceof ImageData) {
        const tmp = document.createElement('canvas')
        tmp.width = tex.width
        tmp.height = tex.height
        tmp.getContext('2d').putImageData(tex, 0, 0)
        ctx.drawImage(tmp, 0, 0, w, h)
        return
    }
    ctx.drawImage(tex, 0, 0, w, h)
}

/**
 * Start a brush-refine session on a texture-backed layer.
 *
 * @param {object} image   Fabric image carrying the megashader filter
 * @param {string} layerId
 * @param {{width: number, height: number}} dims  working-canvas size (use the
 *                                                brush canvas dims so strokes
 *                                                composite 1:1)
 * @returns {{layerId: string, key: string, keyField: string, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, channel: 'alpha' | 'red'}}
 */
export const beginLayerRefine = (image, layerId, dims) => {
    const filter = getFilter(image)
    const chain = filter?.stack?.chain
    if (!Array.isArray(chain)) throw new Error('[mask-grow] no mask chain on this image')
    const idx = chain.findIndex((e) => e?.layer?.id === layerId)
    if (idx < 0) throw new Error(`[mask-grow] no layer ${layerId}`)
    const entry = chain[idx]
    const layer = entry.layer
    const keyField = layer.maskTextureKey ? 'maskTextureKey' : layer.brushTextureKey ? 'brushTextureKey' : null
    if (!TEXTURE_BACKED_KINDS.includes(layer.kind) || !keyField) {
        throw new Error(`[mask-grow] layer ${layerId} (${layer.kind}) has no paintable mask texture`)
    }
    const tex = getMaskTexture(layer[keyField])
    if (!tex) throw new Error('[mask-grow] mask texture is gone (reselect the subject)')

    const w = Math.max(1, Math.round(dims?.width || tex.width || 1))
    const h = Math.max(1, Math.round(dims?.height || tex.height || 1))
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const cx = cv.getContext('2d', { willReadFrequently: true })
    // Coverage channel per kind — same convention as growMaskCanvas: the
    // plain brush samples painted alpha; every other kind samples R off an
    // opaque canvas, so start from solid black.
    const channel = layer.kind === 'brush' ? 'alpha' : 'red'
    if (channel === 'red') {
        cx.fillStyle = '#000'
        cx.fillRect(0, 0, w, h)
    }
    if (tex.width) drawTextureInto(cx, tex, w, h)

    const key = `refine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    setMaskTexture(key, cv)
    const nextChain = chain.slice()
    nextChain[idx] = {
        op: entry.op,
        layer: sanitiseLayer({
            ...layer,
            [keyField]: key,
            // The working canvas is also the boundary base, so grow/shrink
            // always readjusts from the latest painted edge.
            baseTextureKey: key,
            growPx: 0,
            edgeSmooth: 0,
            edgeContrast: 0,
        }),
    }
    const stack = { chain: nextChain }
    applyMegashaderFilter(image, stack, {
        globalMaskAlpha: filter?.globalMaskAlpha ?? 1,
        globalInvert: filter?.globalInvert ?? false,
        maskOverlay: filter?.maskOverlay ?? false,
    })
    try { image.canvas?.requestRenderAll?.() } catch { /* headless */ }
    try { window.dispatchEvent(new CustomEvent('phosmith:mask-chain-replaced', { detail: { stack } })) } catch { /* SSR */ }
    return { layerId, key, keyField, canvas: cv, ctx: cx, channel }
}

/**
 * Composite a finished brush stroke into a refine session's working canvas
 * and re-render. Stroke canvas must match the session canvas dims (both come
 * from the Mask tool's brush canvas). Studio semantics: add paints white,
 * erase paints black (red channel) or punches alpha out (alpha channel).
 *
 * @param {object} image
 * @param {ReturnType<typeof beginLayerRefine>} session
 * @param {HTMLCanvasElement} strokeCanvas  painted alpha stencil
 * @param {{erase?: boolean}} [opts]
 */
export const applyRefineStroke = (image, session, strokeCanvas, { erase = false } = {}) => {
    const { ctx, canvas, channel } = session || {}
    if (!ctx || !canvas || !strokeCanvas) return
    // Re-tint the stencil (erase strokes preview red on the overlay) to the
    // target coverage colour while keeping its soft alpha edge.
    const tmp = document.createElement('canvas')
    tmp.width = canvas.width
    tmp.height = canvas.height
    const tx = tmp.getContext('2d')
    tx.drawImage(strokeCanvas, 0, 0, tmp.width, tmp.height)
    tx.globalCompositeOperation = 'source-in'
    tx.fillStyle = erase && channel === 'red' ? '#000' : '#fff'
    tx.fillRect(0, 0, tmp.width, tmp.height)

    if (channel === 'alpha') {
        ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
        ctx.drawImage(tmp, 0, 0)
        ctx.globalCompositeOperation = 'source-over'
    } else {
        ctx.drawImage(tmp, 0, 0)
    }

    // Chain fields are unchanged — re-applying the filter re-uploads the
    // mutated working canvas (textures are re-read per application).
    const filter = getFilter(image)
    if (filter) {
        applyMegashaderFilter(image, filter.stack, {
            globalMaskAlpha: filter.globalMaskAlpha ?? 1,
            globalInvert: filter.globalInvert ?? false,
            maskOverlay: filter.maskOverlay ?? false,
        })
    }
    try { image.canvas?.requestRenderAll?.() } catch { /* headless */ }
    if (!isAgentActing()) {
        recordChange({
            label: erase ? 'Mask: erase region' : 'Mask: add region',
            domain: 'mask',
        })
    }
}
