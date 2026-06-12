/**
 * Crop Commands (agent-facing, UI-decoupled)
 * ------------------------------------------
 * Imperative crop operations that drive the editor's primary image without any
 * React/UI involvement, so the in-app agent can perform automatic and
 * arbitrary-box crops headlessly. Mirrors the same engine the manual Crop
 * tool uses: an offscreen canvas extracts source pixels, the result is
 * uploaded to ImageKit, and a fresh FabricImage replaces the original at the
 * same z-index with its mask-chain filters preserved.
 *
 * Commands registered (see `command-registry.js` discovery):
 *
 *   crop.auto         — run /api/ai/auto-crop, pick the recommended box (or
 *                       the requested strategy) and apply it.
 *   crop.subjectAware — alias for crop.auto with mode=subject.
 *   crop.fitAspect    — max-area crop at a given aspect ratio centred on the
 *                       subject (or the image centre when no subject is
 *                       detected).
 *   crop.contentFill  — trim near-solid borders.
 *   crop.applyBox     — apply an arbitrary `[x, y, w, h]` image-pixel box.
 *
 * Every command dispatches `pixxel:image-replaced` after a successful crop so
 * other mounted tools can re-sync against the new Fabric object.
 *
 * NOT wired to any agent yet — registered by canvas.jsx the same way the
 * mask domain is.
 *
 * @module agent/crop-commands
 */

import { FabricImage } from 'fabric'

const UPLOAD_MAX_SIDE = 2048

const getSourceEl = (image) =>
    image?._originalElement || image?.getElement?.() || image?._element || null

const naturalSize = (image) => {
    const el = getSourceEl(image)
    const w = el?.naturalWidth || el?.videoWidth || el?.width || image?.width || 0
    const h = el?.naturalHeight || el?.videoHeight || el?.height || image?.height || 0
    return { w, h }
}

const hasUnsupportedTransform = (image) => {
    const angle = Math.abs(((image?.angle || 0) % 360 + 360) % 360)
    const hasRotation = angle > 0.01 && Math.abs(angle - 360) > 0.01
    return hasRotation || Math.abs(image?.skewX || 0) > 0.01 || Math.abs(image?.skewY || 0) > 0.01
}

const copyDefinedProps = (source, keys) => {
    const props = {}
    keys.forEach((key) => {
        if (source?.[key] !== undefined) props[key] = source[key]
    })
    return props
}

const PRESERVED_IMAGE_PROPS = [
    'opacity', 'visible', 'flipX', 'flipY',
    'lockMovementX', 'lockMovementY', 'lockScalingX', 'lockScalingY',
    'lockRotation', 'lockSkewingX', 'lockSkewingY', 'lockScalingFlip',
    'hoverCursor', 'moveCursor', 'perPixelTargetFind',
    'globalCompositeOperation', 'name', 'id', 'data',
]

/**
 * Encode the image source's bitmap to JPEG sized to UPLOAD_MAX_SIDE so the
 * /api/ai/auto-crop endpoint sees the same recipe as /api/ai/segment-instances
 * (cap → JPEG q88).
 */
const imageToUploadBlob = async (image) => {
    const { w: origW, h: origH } = naturalSize(image)
    if (!origW || !origH) throw new Error('[agent.crop] image element not ready')
    const scale = Math.min(1, UPLOAD_MAX_SIDE / Math.max(origW, origH))
    const w = Math.max(1, Math.round(origW * scale))
    const h = Math.max(1, Math.round(origH * scale))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('[agent.crop] could not allocate upload canvas')
    ctx.drawImage(getSourceEl(image), 0, 0, w, h)
    const blob = await new Promise((res, rej) =>
        c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/jpeg', 0.88),
    )
    return { blob, scale, origW, origH }
}

const canvasToPngBlob = (canvas) =>
    new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob)
            else reject(new Error('could not encode cropped image'))
        }, 'image/png')
    })

const uploadCroppedCanvas = async (canvas) => {
    const blob = await canvasToPngBlob(canvas)
    const fileName = `agent-crop-${Date.now()}.png`
    const formData = new FormData()
    formData.append('fileName', fileName)
    formData.append('rasterFile', blob, fileName)
    formData.append('rasterFileName', fileName)
    formData.append('rasterWidth', String(canvas.width))
    formData.append('rasterHeight', String(canvas.height))

    const response = await fetch('/api/imagekit/upload', {
        method: 'POST',
        body: formData,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.success || !data?.url) {
        throw new Error(data?.error || '[agent.crop] cropped image upload failed')
    }
    return data.url
}

const getImageCanvasBounds = (image) => {
    const scaleX = image.scaleX || 1
    const scaleY = image.scaleY || 1
    const w = (image.width || 0) * scaleX
    const h = (image.height || 0) * scaleY
    let left = image.left || 0
    let top = image.top || 0
    if (image.originX === 'center') left -= w / 2
    if (image.originY === 'center') top -= h / 2
    return { left, top, width: w, height: h }
}

/**
 * Validate a `[x, y, w, h]` box against the source image dimensions and
 * return a clamped, rounded integer box.
 *
 * Image-pixel coordinates are the source bitmap's natural pixel grid — NOT
 * canvas coords, NOT scaled — so a 4000×3000 photo with the crop tool
 * showing it at 1000×750 still receives `[0, 0, 4000, 3000]` for a full crop.
 */
const validateBox = (box, sourceW, sourceH) => {
    if (!Array.isArray(box) || box.length !== 4) {
        throw new Error('[agent.crop] box must be [x, y, w, h] in image pixels')
    }
    let [x, y, w, h] = box.map((v) => Number(v))
    if (![x, y, w, h].every((v) => Number.isFinite(v))) {
        throw new Error('[agent.crop] box values must be finite numbers')
    }
    x = Math.max(0, Math.min(sourceW - 1, Math.round(x)))
    y = Math.max(0, Math.min(sourceH - 1, Math.round(y)))
    w = Math.max(2, Math.min(sourceW - x, Math.round(w)))
    h = Math.max(2, Math.min(sourceH - y, Math.round(h)))
    if (w <= 1 || h <= 1) throw new Error('[agent.crop] degenerate box after clip')
    return [x, y, w, h]
}

/**
 * Extract image-pixel rect from the source bitmap, accounting for flipX /
 * flipY / existing cropX/cropY (so a crop on an image that's already been
 * cropped once doesn't double-offset).
 */
const extractCropToCanvas = (image, [x, y, w, h]) => {
    const el = getSourceEl(image)
    if (!el) throw new Error('[agent.crop] image source not ready')
    const { w: sw0, h: sh0 } = naturalSize(image)
    const baseX = image.flipX ? (image.width || sw0) - x - w : x
    const baseY = image.flipY ? (image.height || sh0) - y - h : y
    const sx = Math.max(0, Math.round(baseX + (image.cropX || 0)))
    const sy = Math.max(0, Math.round(baseY + (image.cropY || 0)))
    const sw = Math.round(Math.min(w, sw0 - sx))
    const sh = Math.round(Math.min(h, sh0 - sy))
    if (sw <= 1 || sh <= 1) throw new Error('[agent.crop] resulting source rect is empty')

    const c = document.createElement('canvas')
    c.width = sw
    c.height = sh
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('[agent.crop] could not allocate output canvas')
    ctx.drawImage(el, sx, sy, sw, sh, 0, 0, sw, sh)
    return { canvas: c, sw, sh }
}

/**
 * Apply a validated [x,y,w,h] image-pixel box to the given Fabric image:
 *  - extract pixels to an offscreen canvas
 *  - upload via /api/imagekit/upload
 *  - swap in a fresh FabricImage that preserves filters, locks and z-index,
 *    positioned to occupy the same canvas-space region as the source crop
 *
 * Returns the new FabricImage instance.
 */
const replaceImageWithCrop = async (canvas, image, box) => {
    if (hasUnsupportedTransform(image)) {
        throw new Error('[agent.crop] image is rotated/skewed — reset transform first')
    }
    const { w: sourceW, h: sourceH } = naturalSize(image)
    if (!sourceW || !sourceH) throw new Error('[agent.crop] source has no dimensions')
    const validated = validateBox(box, sourceW, sourceH)
    const { canvas: off, sw, sh } = extractCropToCanvas(image, validated)

    const url = await uploadCroppedCanvas(off)
    const cropped = await FabricImage.fromURL(url, { crossOrigin: 'anonymous' })

    const imgBounds = getImageCanvasBounds(image)
    const imageScaleX = Math.abs(image.scaleX || 1)
    const imageScaleY = Math.abs(image.scaleY || 1)
    const canvasLeft = imgBounds.left + validated[0] * imageScaleX
    const canvasTop = imgBounds.top + validated[1] * imageScaleY
    const canvasW = validated[2] * imageScaleX
    const canvasH = validated[3] * imageScaleY

    const originalIndex = canvas.getObjects().indexOf(image)
    cropped.set({
        ...copyDefinedProps(image, PRESERVED_IMAGE_PROPS),
        left: canvasLeft,
        top: canvasTop,
        originX: 'left',
        originY: 'top',
        selectable: image.selectable ?? true,
        evented: image.evented ?? true,
        hasControls: image.hasControls ?? true,
        hasBorders: image.hasBorders ?? true,
        angle: 0,
        skewX: 0,
        skewY: 0,
        cropX: 0,
        cropY: 0,
        scaleX: canvasW / sw,
        scaleY: canvasH / sh,
        filters: image.filters?.slice?.() || [],
        resizeFilter: image.resizeFilter,
    })
    if (cropped.filters?.length) cropped.applyFilters()

    canvas.remove(image)
    if (originalIndex >= 0) canvas.insertAt(originalIndex, cropped)
    else canvas.add(cropped)
    canvas.setActiveObject(cropped)
    cropped.setCoords()
    canvas.requestRenderAll()
    canvas.__pushHistoryState?.({ label: 'Applied crop', domain: 'crop' })
    canvas.__saveCanvasState?.()
    window?.dispatchEvent?.(new CustomEvent('pixxel:image-replaced', { detail: { reason: 'crop' } }))
    return cropped
}

/**
 * POST the current image to /api/ai/auto-crop and return the decoded payload.
 * Results are cached on the Fabric image keyed by (mode, aspect) so repeated
 * agent calls don't re-run BiRefNet/YOLO/depth for the same image.
 */
const fetchAutoCrop = async (image, { mode = 'all', aspect = null, padding = null, refresh = false } = {}) => {
    const key = `${mode}|${aspect || ''}|${padding ?? ''}`
    if (!refresh && image.__pixxelAutoCrop?.[key]) return image.__pixxelAutoCrop[key]
    const { blob } = await imageToUploadBlob(image)
    const form = new FormData()
    form.append('image', blob, 'image.jpg')
    form.append('mode', mode)
    if (aspect) form.append('aspect', String(aspect))
    if (padding != null) form.append('padding', String(padding))
    const resp = await fetch('/api/ai/auto-crop', { method: 'POST', body: form })
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.error || `/api/ai/auto-crop failed (${resp.status})`)
    }
    const data = await resp.json()
    image.__pixxelAutoCrop = image.__pixxelAutoCrop || {}
    image.__pixxelAutoCrop[key] = data
    return data
}

/* ─── command surface ─────────────────────────────────────────────────────── */

export const createCropCommands = ({ getPrimaryImage, getCanvas }) => ({
    auto: {
        description:
            "AI: auto-crop the photo. mode picks the strategy (subject|aspect|content|depth|all). Returns the box without applying it when {apply:false}. Aspect '16:9' / '4:5' / '1' etc. fits the chosen strategy to that ratio.",
        params: {
            mode: 'string — subject|aspect|content|depth|all (default all → recommended box)',
            aspect: 'string — "W:H" or float (e.g. "16:9", "1.5")',
            padding: 'number 0..1 — subject padding override',
            apply: 'boolean (default true) — apply the recommended/specific box to the canvas',
            preferStrategy: 'string — when mode=all, pick this strategy if present (default = recommended)',
        },
        run: async ({ mode = 'all', aspect = null, padding = null, apply = true, preferStrategy = null } = {}) => {
            const canvas = getCanvas()
            const image = getPrimaryImage()
            if (!canvas || !image) throw new Error('[agent.crop] no image on canvas')
            const data = await fetchAutoCrop(image, { mode, aspect, padding })

            const which =
                (preferStrategy && data.crops?.[preferStrategy]?.box && preferStrategy) ||
                (mode !== 'all' && data.crops?.[mode]?.box && mode) ||
                data.recommended ||
                Object.keys(data.crops || {}).find((k) => data.crops[k]?.box)

            if (!which || !data.crops?.[which]?.box) {
                throw new Error('[agent.crop] no usable crop returned (try a different mode or image)')
            }
            const chosen = data.crops[which]
            const box = chosen.box

            // ── "Already tight" detection ────────────────────────────────
            // When the crop box covers ≥ 92% of the image the photo is
            // already tightly framed and cropping is a no-op.
            const imgArea = (data.width || 1) * (data.height || 1)
            const boxArea = (box[2] || 1) * (box[3] || 1)
            const isAlreadyTight =
                chosen.already_tight === true ||
                (imgArea > 0 && (boxArea / imgArea) >= 0.92)

            if (isAlreadyTight) {
                const alternatives = Object.entries(data.crops || {})
                    .filter(([k, v]) => k !== which && v?.box && !v.already_tight)
                    .map(([k]) => k)
                return {
                    strategy: which,
                    box,
                    score: chosen.score,
                    rationale: chosen.rationale,
                    alreadyTight: true,
                    reason: `Photo is already tightly framed — the ${which} crop covers ${Math.round((boxArea / imgArea) * 100)}% of the image`,
                    alternatives: alternatives.length > 0 ? alternatives : null,
                    applied: false,
                }
            }

            if (!apply) {
                return { strategy: which, box, score: chosen.score, rationale: chosen.rationale, all: data.crops, subjects: data.subjects }
            }
            await replaceImageWithCrop(canvas, image, box)
            return { strategy: which, box, score: chosen.score, rationale: chosen.rationale, applied: true }
        },
    },
    subjectAware: {
        description: 'AI: crop tightly around every detected subject (people, animals, salient objects) with rule-of-thirds composition. Optional aspect.',
        params: { aspect: 'string — W:H or float', padding: 'number 0..1' },
        run: async ({ aspect = null, padding = null, apply = true } = {}) =>
            createCropCommands({ getPrimaryImage, getCanvas }).auto.run({
                mode: 'subject', aspect, padding, apply,
            }),
    },
    fitAspect: {
        description: 'Fit a max-area crop at the requested aspect ratio, centred on detected subjects when available, otherwise on the image centre.',
        params: { aspect: 'string — required, e.g. "16:9" / "4:5" / "1"' },
        run: async ({ aspect, apply = true } = {}) => {
            if (!aspect) throw new Error('[agent.crop] aspect is required (e.g. "16:9")')
            return createCropCommands({ getPrimaryImage, getCanvas }).auto.run({
                mode: 'all', aspect, apply, preferStrategy: 'subject',
            })
        },
    },
    contentFill: {
        description: 'Trim near-solid borders (white mats, sky padding, letterboxing).',
        params: { aspect: 'string — optional' },
        run: async ({ aspect = null, apply = true } = {}) =>
            createCropCommands({ getPrimaryImage, getCanvas }).auto.run({
                mode: 'content', aspect, apply,
            }),
    },
    applyBox: {
        description: 'Apply an arbitrary [x, y, w, h] image-pixel crop box to the active image.',
        params: { box: '[x,y,w,h] in image pixels (NOT canvas coords)' },
        run: async ({ box } = {}) => {
            const canvas = getCanvas()
            const image = getPrimaryImage()
            if (!canvas || !image) throw new Error('[agent.crop] no image on canvas')
            await replaceImageWithCrop(canvas, image, box)
            return { applied: true, box }
        },
    },
})
