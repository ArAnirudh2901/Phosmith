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
} from '@/lib/megashader'
import { growCoverage, MAX_GROW_PX } from './mask-grow-core'
import { isAgentActing, recordChange } from './change-journal'

// Re-export the pure core so consumers (commands, UI) import one module.
export { growCoverage, MAX_GROW_PX } from './mask-grow-core'

const MEGASHADER_TYPE = 'Megashader'

/** Mask kinds whose selection lives in a registered texture. */
export const TEXTURE_BACKED_KINDS = ['semantic', 'lasso', 'brush', 'smartBrush']

/**
 * Grow/shrink a mask texture canvas. Preserves the channel convention of the
 * input: alpha-styled canvases (the brush kind samples painted alpha) get the
 * result written to alpha; opaque luma-styled canvases (lasso/semantic — the
 * shader samples R) get it written to RGB.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} px
 * @returns {HTMLCanvasElement} a NEW canvas (the input is untouched)
 */
export const growMaskCanvas = (canvas, px) => {
    const w = canvas.width
    const h = canvas.height
    const src = canvas.getContext('2d', { willReadFrequently: true })
    const data = src.getImageData(0, 0, w, h)
    const pxs = data.data

    let alphaStyled = false
    const cover = new Uint8ClampedArray(w * h)
    for (let i = 0, p = 0; i < pxs.length; i += 4, p += 1) {
        if (pxs[i + 3] < 250) alphaStyled = true
        const luma = 0.2126 * pxs[i] + 0.7152 * pxs[i + 1] + 0.0722 * pxs[i + 2]
        cover[p] = Math.max(luma, pxs[i + 3] < 250 ? pxs[i + 3] : 0)
    }
    // Opaque canvas: coverage is the luma itself.
    if (!alphaStyled) {
        for (let i = 0, p = 0; i < pxs.length; i += 4, p += 1) {
            cover[p] = 0.2126 * pxs[i] + 0.7152 * pxs[i + 1] + 0.0722 * pxs[i + 2]
        }
    }

    const grown = growCoverage(cover, w, h, px)

    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const ctx = out.getContext('2d')
    const outData = ctx.createImageData(w, h)
    const op = outData.data
    for (let i = 0, p = 0; i < op.length; i += 4, p += 1) {
        const v = grown[p]
        if (alphaStyled) {
            op[i] = 255
            op[i + 1] = 255
            op[i + 2] = 255
            op[i + 3] = v
        } else {
            op[i] = v
            op[i + 1] = v
            op[i + 2] = v
            op[i + 3] = 255
        }
    }
    ctx.putImageData(outData, 0, 0)
    return out
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
export const expandLayerBoundary = (image, layerId, px) => {
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
    let nextKey = baseKey
    if (dist !== 0) {
        nextKey = `${baseKey}::grow${dist}`
        if (!getMaskTexture(nextKey)) {
            setMaskTexture(nextKey, growMaskCanvas(base, dist))
        }
    }

    const nextChain = chain.slice()
    nextChain[idx] = {
        op: entry.op,
        layer: sanitiseLayer({
            ...layer,
            maskTextureKey: nextKey,
            baseTextureKey: baseKey,
            growPx: dist,
        }),
    }
    const stack = { chain: nextChain }
    applyMegashaderFilter(image, stack, {
        globalMaskAlpha: filter?.globalMaskAlpha ?? 1,
        globalInvert: filter?.globalInvert ?? false,
        maskOverlay: filter?.maskOverlay ?? false,
    })
    try { image.canvas?.requestRenderAll?.() } catch { /* headless */ }
    try { window.dispatchEvent(new CustomEvent('pixxel:mask-chain-replaced', { detail: { stack } })) } catch { /* SSR */ }
    // The agent path (mask.expandLayer) is journaled by the command registry;
    // only the panel's Boundary slider logs here.
    if (!isAgentActing()) {
        recordChange({
            label: `Mask: boundary ${dist > 0 ? '+' : ''}${dist}px`,
            domain: 'mask',
        })
    }
    return { id: layerId, growPx: dist }
}
