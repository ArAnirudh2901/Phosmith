// Auto-crop engine shared by the Crop panel and the agent's crop.* commands.
// Runs without the segmentation service (no SAM): subject-aware crops first
// READ the photo with Gemini vision (/api/ai/crop-analyze), tighten subject
// edges with the Mask studio's on-device matte (RMBG-1.4), then compose.
// Without a vision key it analyses on-device (matte + saliency + horizon).
// Returns the /api/ai/auto-crop payload shape.

import { clientDepthMap, clientSubjectMask } from './client-ai'
import { cleanSubjectMatte } from './subject-mask-cleanup'
import { analyzePixels } from './collage/analyze'
import {
    clipBox,
    composeAnalyzedCrop,
    computeAspectCrop,
    computeContentFillCrop,
    computeDepthCrop,
    heuristicCropAnalysis,
    recommendCrop,
} from './auto-crop-core'

const ANALYSIS_MAX_SIDE = 1024
const VISION_MAX_SIDE = 768
const SALIENCY_SIDE = 192
const THUMB_SIDE = 160

const drawTo = (el, w, h) => {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(el, 0, 0, w, h)
    return { canvas, ctx }
}

const channelOf = (el, w, h) => {
    const { ctx } = drawTo(el, w, h)
    const px = ctx.getImageData(0, 0, w, h).data
    const out = new Uint8Array(w * h)
    for (let i = 0, p = 0; p < out.length; p += 1, i += 4) out[p] = px[i]
    return out
}

const lumaThumb = (el, W, H) => {
    const k = THUMB_SIDE / Math.max(W, H)
    const lw = Math.max(16, Math.round(W * k)), lh = Math.max(16, Math.round(H * k))
    const { ctx } = drawTo(el, lw, lh)
    const px = ctx.getImageData(0, 0, lw, lh).data
    const luma = new Uint8Array(lw * lh)
    for (let i = 0, p = 0; p < luma.length; p += 1, i += 4) luma[p] = (px[i] * 54 + px[i + 1] * 183 + px[i + 2] * 19) >> 8
    return { luma, lw, lh }
}

// Quota (429) applies to the whole key, so stop asking for a while.
const VISION_COOLDOWN_MS = 90 * 1000
let visionCooldownUntil = 0

const abortError = () => Object.assign(new Error('Auto-crop cancelled'), { name: 'AbortError' })
const throwIfAborted = (signal) => { if (signal?.aborted) throw abortError() }

const requestVisionAnalysis = async (canvas, { width, height, signal }) => {
    if (Date.now() < visionCooldownUntil) return null
    const k = Math.min(1, VISION_MAX_SIDE / Math.max(canvas.width, canvas.height))
    const { canvas: small } = drawTo(canvas, Math.round(canvas.width * k), Math.round(canvas.height * k))
    const base64 = small.toDataURL('image/jpeg', 0.86).split(',')[1]
    const res = await fetch('/api/ai/crop-analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: { base64, mimeType: 'image/jpeg' }, width, height }),
        signal,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || data?.source !== 'gemini' || !data.analysis) {
        const detail = data?.detail || data?.error || data?.reason
        if (res.status === 429 || /\b429\b/.test(String(detail))) visionCooldownUntil = Date.now() + VISION_COOLDOWN_MS
        if (detail) console.warn('[auto-crop] vision analysis unavailable:', detail)
        return null
    }
    return { analysis: data.analysis, model: data.model }
}

const subjectMatte = async (canvas, w, h) => {
    const matte = await clientSubjectMask(canvas, { width: w, height: h })
    const cleaned = cleanSubjectMatte(matte, { sourceCanvas: canvas })
    return cleaned.diagnostics.coverage > 0.003 ? channelOf(cleaned.canvas, w, h) : null
}

// Rect mask from the Composer's saliency box, for when the matte model is unavailable.
const saliency = (canvas, w, h) => {
    const k = SALIENCY_SIDE / Math.max(w, h)
    const sw = Math.max(8, Math.round(w * k)), sh = Math.max(8, Math.round(h * k))
    const { ctx } = drawTo(canvas, sw, sh)
    const result = analyzePixels(ctx.getImageData(0, 0, sw, sh).data, sw, sh)
    const mask = new Uint8Array(w * h)
    if (result?.box) {
        const x0 = Math.floor(result.box.x0 * w), x1 = Math.ceil(result.box.x1 * w)
        const y0 = Math.floor(result.box.y0 * h), y1 = Math.ceil(result.box.y1 * h)
        for (let y = y0; y < y1; y += 1) mask.fill(255, y * w + x0, y * w + x1)
    }
    return { mask, openSide: result?.openSide || null }
}

// Vision analysis + matte depend only on the pixels, not the aspect: cache per element.
const readCache = new WeakMap()
const readPhoto = (sourceEl, canvas, { w, h, width, height, signal }) => {
    const key = `${w}x${h}`
    const hit = readCache.get(sourceEl)
    if (hit?.key === key) return hit
    const entry = {
        key,
        vision: requestVisionAnalysis(canvas, { width, height, signal }).catch((error) => {
            if (error?.name !== 'AbortError') console.warn('[auto-crop] vision analysis failed:', error?.message || error)
            return null
        }),
        matte: subjectMatte(canvas, w, h).catch((error) => {
            console.warn('[auto-crop] on-device matte failed:', error?.message || error)
            return null
        }),
    }
    // A cancelled read must not poison the cache for the next attempt.
    signal?.addEventListener?.('abort', () => { if (readCache.get(sourceEl) === entry) readCache.delete(sourceEl) }, { once: true })
    readCache.set(sourceEl, entry)
    return entry
}

/**
 * @param {HTMLImageElement|HTMLCanvasElement} sourceEl  image pixels (natural size)
 * @param {{ width:number, height:number, mode:'subject'|'content'|'depth'|'aspect'|'all',
 *           aspect?:number|null, signal?:AbortSignal, onStage?:(stage:string)=>void }} opts
 *   width/height: the pixel space boxes are returned in.
 */
export const runAutoCropEngine = async (sourceEl, { width, height, mode = 'subject', aspect = null, signal, onStage } = {}) => {
    const k = Math.min(1, ANALYSIS_MAX_SIDE / Math.max(width, height))
    const w = Math.max(16, Math.round(width * k))
    const h = Math.max(16, Math.round(height * k))
    const { canvas, ctx } = drawTo(sourceEl, w, h)
    const crops = {}
    let analysis = null
    let analysisSource = null
    let model = null

    if (aspect) crops.aspect = computeAspectCrop(w, h, aspect)
    crops.content = computeContentFillCrop(ctx.getImageData(0, 0, w, h).data, w, h, { aspect })

    if (mode === 'subject' || mode === 'all') {
        onStage?.('reading')
        const read = readPhoto(sourceEl, canvas, { w, h, width, height, signal })
        const [vision, matte] = await Promise.all([read.vision, read.matte])
        throwIfAborted(signal)
        onStage?.('composing')
        let mask = matte
        if (vision) {
            analysis = vision.analysis
            analysisSource = 'gemini'
            model = vision.model
        } else {
            const fallback = saliency(canvas, w, h)
            if (!mask) mask = fallback.mask
            const { luma, lw, lh } = lumaThumb(canvas, w, h)
            analysis = heuristicCropAnalysis({ W: w, H: h, mask, openSide: fallback.openSide, luma, lw, lh })
            analysisSource = matte ? 'device' : 'device-saliency'
        }
        crops.subject = composeAnalyzedCrop({ W: w, H: h, aspect, analysis, mask, source: analysisSource })
    }

    if (mode === 'depth' || mode === 'all') {
        onStage?.('depth')
        try {
            const depthCanvas = await clientDepthMap(canvas, { width: w, height: h })
            throwIfAborted(signal)
            crops.depth = computeDepthCrop(channelOf(depthCanvas, w, h), w, h, { aspect })
        } catch (error) {
            if (error?.name === 'AbortError' || mode === 'depth') throw error
            console.warn('[auto-crop] depth strategy skipped:', error?.message || error)
        }
    }
    throwIfAborted(signal)

    const sx = width / w, sy = height / h
    const scaleBox = ([x, y, bw, bh]) => clipBox([x * sx, y * sy, bw * sx, bh * sy], width, height)
    for (const key of Object.keys(crops)) {
        const c = crops[key]
        if (!c) { delete crops[key]; continue }
        c.box = scaleBox(c.box)
        if (c.subjects) c.subjects = c.subjects.map((s) => ({ ...s, box: s.box ? scaleBox(s.box) : null }))
    }

    return {
        width,
        height,
        aspect,
        crops,
        subjects: crops.subject?.subjects || [],
        recommended: recommendCrop(crops),
        source: analysisSource || 'device',
        model,
        analysis,
    }
}
