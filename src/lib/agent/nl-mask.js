/**
 * NL Mask Executor
 * -----------------
 * Resolves a validated MaskPlan (see nl-mask-parser.js) into actual mask
 * layers on the active image. This is the back half of the
 * `mask.fromDescription` agent command:
 *
 *   description ─→ /api/ai/mask-plan (Gemini, heuristic fallback)
 *               ─→ MaskPlan steps ─→ THIS module resolves each target:
 *
 *   subjects    → /api/ai/segment-instances (cached per image) + qualifier
 *                 scoring (position/ordinal/size/color); falls back to
 *                 concept grounding when no instance matches the label.
 *   concept     → /api/ai/ground (CLIPSeg + SAM 2 box refinement).
 *   depth       → /api/ai/depth → depth-range layer.
 *   luminance   → pure GPU luminance-range layer.
 *   colorRange  → pure GPU colour-range layer.
 *   region      → geometric layer (rect texture / radial gradient).
 *
 * Steps compose through the megashader chain's native blend ops
 * (add/subtract/intersect), so "the dog but not its collar" is two layers,
 * not a pre-baked bitmap — every part stays individually editable, and the
 * boundary of any texture-backed result can still be extended afterwards
 * (mask.expandLayer / the Mask tool's boundary slider).
 *
 * Dependency-injected (createNlMaskRunner) so it shares mask-commands.js's
 * existing upload/decode/addLayer helpers instead of duplicating them.
 *
 * @module agent/nl-mask
 */

import {
    colorLayer,
    depthLayer,
    luminanceLayer,
    radialLayer,
    semanticLayer,
    setMaskTexture,
} from '@/lib/megashader'
import { growMaskCanvas } from '@/lib/mask-grow'
import { clientDepthMap, clientGroundPhrase } from '@/lib/client-ai'
import { getRoutingMode, prefersClient, resolveOrder } from '@/lib/ai-routing'
import {
    COLOR_NAME_HEX,
    classifyColor,
    parseMaskDescription,
    pickSubjectInstances,
    validateMaskPlan,
} from './nl-mask-parser'

const DEPTH_RANGES = {
    // Depth maps are white = near.
    foreground: { min: 0.55, max: 1, softness: 0.15 },
    midground: { min: 0.3, max: 0.7, softness: 0.2 },
    background: { min: 0, max: 0.45, softness: 0.15 },
}

const LUMINANCE_RANGES = {
    shadows: { min: 0, max: 0.35, softness: 0.12 },
    midtones: { min: 0.3, max: 0.7, softness: 0.12 },
    highlights: { min: 0.65, max: 1, softness: 0.12 },
}

const uniqueKey = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const titleCase = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase())

/* ─── Canvas helpers (DOM) ───────────────────────────────────────────────── */

const unionCanvases = (canvases) => {
    const w = Math.max(...canvases.map((c) => c.width))
    const h = Math.max(...canvases.map((c) => c.height))
    const union = document.createElement('canvas')
    union.width = w
    union.height = h
    const ctx = union.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'lighten'
    for (const c of canvases) ctx.drawImage(c, 0, 0, w, h)
    return union
}

const rectCanvas = (w, h, rect) => {
    const c = document.createElement('canvas')
    c.width = Math.max(1, w)
    c.height = Math.max(1, h)
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = '#fff'
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
    return c
}

/* ─── Runner ─────────────────────────────────────────────────────────────── */

/**
 * @param {object} deps  helpers shared with mask-commands.js
 * @param {() => any} deps.requireImage
 * @param {(layer: object, op?: string) => string} deps.addLayer
 * @param {(extraOpts: object) => void} deps.applyExtra
 * @param {(image: any, opts?: object) => Promise<any>} deps.fetchSubjectInstances
 * @param {(image: any) => Promise<{blob: Blob, scale: number}>} deps.imageToUploadBlob
 * @param {(b64: string) => Promise<HTMLImageElement>} deps.decodeBase64Png
 * @param {(img: HTMLImageElement) => HTMLCanvasElement} deps.toCoverageCanvas
 * @param {(route: string, formBuilder?: Function) => Promise<Blob>} deps.postMask
 * @param {(blob: Blob) => Promise<HTMLImageElement>} deps.decodePng
 * @param {(image: any) => {w: number, h: number}} deps.naturalSize
 */
export const createNlMaskRunner = (deps) => {
    /** Mean colour name inside an instance's bbox, sampled at thumb scale. */
    const buildColorLookup = (image) => {
        try {
            const el = image?._element || image?.getElement?.() || image?._originalElement
            const { w, h } = deps.naturalSize(image)
            if (!el || !w || !h) return null
            const scale = Math.min(1, 256 / Math.max(w, h))
            const c = document.createElement('canvas')
            c.width = Math.max(1, Math.round(w * scale))
            c.height = Math.max(1, Math.round(h * scale))
            const ctx = c.getContext('2d', { willReadFrequently: true })
            ctx.drawImage(el, 0, 0, c.width, c.height)
            return (inst) => {
                const [bx, by, bw, bh] = inst.bboxImage || inst.bbox || []
                if (!bw || !bh) return null
                const x = Math.max(0, Math.floor(bx * scale))
                const y = Math.max(0, Math.floor(by * scale))
                const iw = Math.max(1, Math.min(c.width - x, Math.ceil(bw * scale)))
                const ih = Math.max(1, Math.min(c.height - y, Math.ceil(bh * scale)))
                // Inner 60% of the bbox — skips background bleed at the edges.
                const ix = x + Math.floor(iw * 0.2)
                const iy = y + Math.floor(ih * 0.2)
                const iiw = Math.max(1, Math.floor(iw * 0.6))
                const iih = Math.max(1, Math.floor(ih * 0.6))
                const data = ctx.getImageData(ix, iy, iiw, iih).data
                let r = 0; let g = 0; let b = 0; let n = 0
                for (let i = 0; i < data.length; i += 4) {
                    r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1
                }
                return n ? classifyColor({ r: r / n, g: g / n, b: b / n }) : null
            }
        } catch {
            return null
        }
    }

    const sourceElOf = (image) =>
        image?._element || image?.getElement?.() || image?._originalElement || null

    /** In-browser grounding (CLIPSeg via transformers.js). */
    const groundPhraseOnDevice = async (image, phrase) => {
        const el = sourceElOf(image)
        const { w, h } = deps.naturalSize(image)
        if (!el || !w || !h) throw new Error('image element not ready for on-device AI')
        return clientGroundPhrase(el, phrase, { width: w, height: h })
    }

    /** Server grounding via /api/ai/ground (CLIPSeg + SAM 2 refinement). */
    const groundPhraseOnServer = async (image, phrase) => {
        const { blob } = await deps.imageToUploadBlob(image)
        const form = new FormData()
        form.append('image', blob, 'image.jpg')
        form.append('phrases', JSON.stringify([phrase]))
        const resp = await fetch('/api/ai/ground', { method: 'POST', body: form })
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}))
            const e = new Error(err.error || `/api/ai/ground failed (${resp.status})`)
            e.status = resp.status
            throw e
        }
        const data = await resp.json()
        const result = data?.results?.[0]
        if (!result?.found || !result?.maskPng) {
            return { canvas: null, score: result?.score ?? 0 }
        }
        const img = await deps.decodeBase64Png(result.maskPng)
        return { canvas: deps.toCoverageCanvas(img), score: result.score }
    }

    /**
     * Ground a phrase → coverage canvas (or null), following the user's AI
     * routing policy (`ai-routing.js`): the preferred side runs first and the
     * other side is the runtime fallback, so masking keeps working whichever
     * stack is actually available.
     */
    const groundPhrase = async (image, phrase, notes = []) => {
        const order = resolveOrder('ground')
        let lastErr = null
        for (const side of order) {
            try {
                if (side === 'client') {
                    const r = await groundPhraseOnDevice(image, phrase)
                    notes.push(`"${phrase}" grounded on-device (in-browser CLIPSeg)`)
                    return r
                }
                return await groundPhraseOnServer(image, phrase)
            } catch (err) {
                lastErr = err
                notes.push(`${side === 'client' ? 'on-device' : 'server'} grounding failed (${err?.message}); ${
                    side === order[order.length - 1] ? 'no fallback left' : 'trying the other side'}`)
            }
        }
        throw lastErr || new Error('grounding failed on every configured side')
    }

    /**
     * Resolve one plan step's target to either `{ canvas, label }` (texture
     * kinds) or `{ layer }` (pure GPU kinds). Throws with an actionable
     * message when nothing binds.
     */
    const resolveTarget = async (image, target, helpers) => {
        switch (target.type) {
            case 'subjects': {
                const phrase = target.phrase || target.labels.join(' ')
                // Instance detection itself is server-only (YOLO), but the
                // capability still honours an explicit "Device" routing: it
                // skips the server and resolves the phrase via on-device
                // grounding instead (degraded — no instance separation).
                // Any server failure falls through to grounding the same way.
                let data = null
                if (getRoutingMode('subjects') !== 'client') {
                    try {
                        data = await deps.fetchSubjectInstances(image)
                    } catch (err) {
                        helpers.notes.push(`instance detection unavailable (${err?.message}); using text grounding for "${phrase}"`)
                    }
                } else {
                    helpers.notes.push(`subject detection routed to device — text grounding "${phrase}" (positional qualifiers can't separate instances)`)
                }
                if (data) {
                    const { picked, note } = pickSubjectInstances(data.instances || [], target, {
                        imageWidth: data.width || 0,
                        colorOf: helpers.colorOf,
                    })
                    if (note) helpers.notes.push(note)
                    if (picked.length) {
                        const canvases = []
                        for (const inst of picked) {
                            canvases.push(deps.toCoverageCanvas(await deps.decodeBase64Png(inst.maskPng)))
                        }
                        const label = picked.length === 1
                            ? `NL ${titleCase(picked[0].label)}`
                            : `NL ${titleCase(target.labels.join('+'))} (${picked.length})`
                        return { canvas: unionCanvases(canvases), label }
                    }
                    // Detection ran but no instance carries this label.
                    helpers.notes.push(`no "${target.labels.join('/')}" instance detected; fell back to text grounding for "${phrase}"`)
                }
                const { canvas, score } = await groundPhrase(image, phrase, helpers.notes)
                if (!canvas) {
                    const have = (data?.instances || []).map((i) => i.label).join(', ') || 'nothing'
                    throw new Error(`Couldn't find "${phrase}" (grounding score ${score}). Detected subjects: ${have}.`)
                }
                return { canvas, label: `NL ${titleCase(phrase)}` }
            }
            case 'concept': {
                const { canvas, score } = await groundPhrase(image, target.phrase, helpers.notes)
                if (!canvas) {
                    throw new Error(`Couldn't find "${target.phrase}" in the image (grounding score ${score}). Try different words or "Detect All Subjects".`)
                }
                return { canvas, label: `NL ${titleCase(target.phrase)}` }
            }
            case 'depth': {
                let cover = null
                let lastErr = null
                for (const side of resolveOrder('depth')) {
                    try {
                        if (side === 'client') {
                            const el = sourceElOf(image)
                            const { w, h } = deps.naturalSize(image)
                            cover = await clientDepthMap(el, { width: w, height: h })
                            helpers.notes.push('depth estimated on-device (in-browser Depth Anything V2)')
                        } else {
                            const depthBlob = await deps.postMask('/api/ai/depth')
                            cover = deps.toCoverageCanvas(await deps.decodePng(depthBlob))
                        }
                        break
                    } catch (err) {
                        lastErr = err
                        helpers.notes.push(`${side === 'client' ? 'on-device' : 'server'} depth failed (${err?.message})`)
                    }
                }
                if (!cover) throw lastErr || new Error('depth estimation failed on every configured side')
                const key = uniqueKey('nl-depth')
                setMaskTexture(key, cover)
                const range = DEPTH_RANGES[target.region]
                return {
                    layer: depthLayer({ depthMapKey: key, ...range, label: `NL ${titleCase(target.region)}` }),
                }
            }
            case 'luminance': {
                const range = LUMINANCE_RANGES[target.region]
                return { layer: luminanceLayer({ ...range, label: `NL ${titleCase(target.region)}` }) }
            }
            case 'colorRange': {
                const hex = target.hex || COLOR_NAME_HEX[target.name] || '#e53935'
                const n = parseInt(hex.slice(1), 16)
                const { rgbToHsb } = await import('@/lib/color-utils')
                const hsb = rgbToHsb((n >> 16) & 255, (n >> 8) & 255, n & 255)
                return {
                    layer: colorLayer({
                        target: hsb,
                        tolerance: target.tolerance ?? 0.18,
                        softness: 0.1,
                        label: `NL ${titleCase(target.name || hex)}`,
                    }),
                }
            }
            case 'region': {
                const { w, h } = deps.naturalSize(image)
                const f = target.fraction ?? 0.5
                if (target.area === 'center') {
                    return {
                        layer: radialLayer({
                            center: { x: w / 2, y: h / 2 },
                            radius: { x: (w * f) / 1.6, y: (h * f) / 1.6 },
                            feather: 0.25,
                            label: 'NL Center',
                        }),
                    }
                }
                if (target.area === 'edges') {
                    return {
                        layer: {
                            ...radialLayer({
                                center: { x: w / 2, y: h / 2 },
                                radius: { x: w * 0.45, y: h * 0.45 },
                                feather: 0.35,
                                label: 'NL Edges',
                            }),
                            inverted: true,
                        },
                    }
                }
                const rects = {
                    top: { x: 0, y: 0, w, h: h * f },
                    bottom: { x: 0, y: h * (1 - f), w, h: h * f },
                    left: { x: 0, y: 0, w: w * f, h },
                    right: { x: w * (1 - f), y: 0, w: w * f, h },
                }
                return {
                    canvas: rectCanvas(w, h, rects[target.area]),
                    label: `NL ${titleCase(target.area)} ${Math.round(f * 100)}%`,
                }
            }
            default:
                throw new Error(`Unknown target type "${target.type}"`)
        }
    }

    /**
     * Execute a full plan. Returns `{ plan, layers, notes }`.
     */
    const runPlan = async (plan, { hadChainBefore = false } = {}) => {
        const image = deps.requireImage()
        const notes = []
        const helpers = { notes, colorOf: null }

        const needsColor = plan.steps.some((s) => s.target.type === 'subjects' && s.target.qualifiers?.color)
        if (needsColor) helpers.colorOf = buildColorLookup(image)

        const singleStep = plan.steps.length === 1
        if (plan.invert && !singleStep && hadChainBefore) {
            throw new Error('Inverting a multi-part selection on top of existing mask layers isn\'t supported — clear the mask first or invert a single region.')
        }

        const layers = []
        for (const step of plan.steps) {
            const resolved = await resolveTarget(image, step.target, helpers)
            let layer
            if (resolved.layer) {
                layer = resolved.layer
            } else {
                let canvas = resolved.canvas
                const baseKey = uniqueKey('nl-mask')
                setMaskTexture(baseKey, canvas)
                let textureKey = baseKey
                if (plan.grow) {
                    canvas = growMaskCanvas(canvas, plan.grow)
                    textureKey = `${baseKey}::grow${plan.grow}`
                    setMaskTexture(textureKey, canvas)
                }
                layer = {
                    ...semanticLayer({
                        maskTextureKey: textureKey,
                        feather: plan.feather ?? 0.05,
                        label: resolved.label,
                    }),
                    baseTextureKey: baseKey,
                    growPx: plan.grow || 0,
                }
            }
            if (plan.feather != null && layer.feather !== undefined) layer.feather = plan.feather
            layer.fillMode = plan.fillMode
            // TOGGLE rather than set: an "edges" region layer is already
            // inverted internally, so "everything except the edges" must
            // flip it back rather than re-assert it.
            if (plan.invert && singleStep) layer.inverted = !layer.inverted

            const id = deps.addLayer(layer, step.op)
            layers.push({ id, op: step.op, kind: layer.kind, label: layer.label })
        }

        if (plan.invert && !singleStep) {
            deps.applyExtra({ globalInvert: true })
            notes.push('inverted the whole mask (multi-part "everything except …")')
        }

        return { plan, layers, notes }
    }

    /**
     * Full pipeline: description → plan (server, heuristic fallback) → layers.
     */
    const fromDescription = async ({ description, fillMode, feather, grow, dryRun = false, hadChainBefore = false }) => {
        const text = String(description || '').trim()
        if (!text) throw new Error('description is required')

        let plan = null
        // Planning follows the routing policy too: "Device" uses the local
        // rule parser outright (zero network); otherwise Gemini plans with
        // the parser as the offline/keyless fallback.
        if (!prefersClient('maskPlan')) {
            try {
                const resp = await fetch('/api/ai/mask-plan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ description: text }),
                })
                if (resp.ok) {
                    const data = await resp.json()
                    const checked = validateMaskPlan(data?.plan)
                    if (checked.valid) plan = checked.plan
                }
            } catch { /* offline — heuristic below */ }
        }
        if (!plan) plan = parseMaskDescription(text)

        // Explicit args override whatever the language implied.
        if (fillMode) plan = { ...plan, fillMode: validateMaskPlan({ ...plan, fillMode }).plan?.fillMode ?? plan.fillMode }
        if (typeof feather === 'number') plan = { ...plan, feather: Math.max(0, Math.min(0.5, feather)) }
        if (typeof grow === 'number') plan = { ...plan, grow: Math.round(Math.max(-200, Math.min(200, grow))) }

        if (dryRun) return { plan, layers: [], notes: ['dry run — no layers added'] }
        return runPlan(plan, { hadChainBefore })
    }

    return { fromDescription, runPlan }
}
