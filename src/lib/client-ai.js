"use client"

/**
 * client-ai — fully in-browser AI for the masking pipeline
 * ---------------------------------------------------------
 * Optional "On-device AI" mode: the NL mask pipeline's model calls run
 * entirely in the browser via transformers.js (ONNX, WebGPU when available,
 * WASM otherwise) instead of the local Python service / server routes.
 * Combined with the editor's already-client-side rendering (Fabric +
 * megashader WebGL), this makes the whole masking flow work with zero
 * server inference:
 *
 *   - text grounding  → CLIPSeg  (Xenova/clipseg-rd64-refined, ~150 MB ONNX)
 *   - depth planes    → Depth Anything V2 small (onnx-community, ~50 MB)
 *
 * Models lazy-load on first use and are cached by the browser (HF hub files
 * land in the Cache API), so the download cost is paid once per device.
 *
 * SlimSAM can also run on the SERVER (the masking service's /sam/*), for
 * devices too weak to run it here: the Selection engine card
 * (`selection-engine.js`) picks the side, and every SlimSAM entry point below
 * (click, box, subject, every subject) runs on that side only. The same
 * pickers choose among the same three candidates either way.
 *
 * The mode is a user preference persisted in localStorage; the executor also
 * uses this engine as an AUTOMATIC fallback when the server reports 501
 * (MASK_SERVICE_URL unset), so masking degrades gracefully instead of dying.
 */

import {
    analyzeCoverage,
    analyzeRange,
    evaluateSelfTest,
    validateDepthOutput,
    validateGroundOutput,
    withTimeout,
} from './client-ai-core'
import { runHeavy } from '@/lib/heavy-job-queue'
import { noteSelectionServer, selectionSide } from '@/lib/selection-engine'
import { gradientMagnitude, scoreSubjectCandidate, subjectPrompts } from '@/lib/subject-pick'

const ENABLED_KEY = 'phosmith:client-ai'
const CHANGED_EVENT = 'phosmith:client-ai-changed'

const GROUND_MODEL = 'Xenova/clipseg-rd64-refined'
// Click/box select runs on SlimSAM (~40 MB, distilled SAM) — the one
// segmentation model this project ships for prompted selection. The slow image
// encode is cached per image so multi-click refine stays fast.
// Xenova/slimsam-77-uniform's encoder with a decoder that takes BOXES (its own
// declares no input_boxes, so transformers.js silently dropped every box):
// scripts/slimsam-onnx/export_decoder.py.
const SAM_ENGINE = { id: 'ArAnirudh/slimsam-77-uniform-boxes', label: 'SlimSAM' }
// Mirror the server's peak-relative thresholding (services/segment/main.py):
// CLIPSeg sigmoids are range-compressed, so absolute cuts drop real targets.
const GROUND_THRESHOLD_REL = 0.55
const GROUND_FLOOR = 0.1
const GROUND_MIN_PEAK = 0.25
const INPUT_MAX_SIDE = 1024

// First load downloads model files (~50–150 MB each) — generous; cached
// loads finish in seconds. Inference gets its own, tighter budget.
const LOAD_TIMEOUT_MS = 8 * 60 * 1000
const INFER_TIMEOUT_MS = 120 * 1000
const DIAG_MAX = 20

// Golden-input calibration: a freshly loaded CLIPSeg must score at least
// this peak on the built-in synthetic scene before it may serve real
// requests. A healthy model scores ~0.96; the observed cold-start failure
// mode scored ~0.06 — wrong-but-finite outputs that per-request validation
// can't distinguish from a genuinely absent target. 0.5 separates cleanly.
const CALIBRATION_MIN_PEAK = 0.5

const hasWindow = () => typeof window !== 'undefined'

/* ─── Preference ─────────────────────────────────────────────────────────── */

export const isClientAIEnabled = () => {
    if (!hasWindow()) return false
    try { return window.localStorage.getItem(ENABLED_KEY) === '1' } catch { return false }
}

export const setClientAIEnabled = (value) => {
    if (!hasWindow()) return
    try {
        if (value) window.localStorage.setItem(ENABLED_KEY, '1')
        else window.localStorage.removeItem(ENABLED_KEY)
    } catch { /* storage blocked */ }
    try {
        window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { enabled: !!value } }))
    } catch { /* SSR */ }
}

export const subscribeClientAI = (cb) => {
    if (!hasWindow() || typeof cb !== 'function') return () => {}
    const handler = () => cb(getClientAIState())
    window.addEventListener(CHANGED_EVENT, handler)
    return () => window.removeEventListener(CHANGED_EVENT, handler)
}

/* ─── Engine state ───────────────────────────────────────────────────────── */

const state = {
    device: null,        // 'webgpu' | 'wasm' once known
    forcedWasm: false,   // sticky downgrade after a WebGPU runtime failure
    loading: null,       // human label of whatever is downloading right now
    groundReady: false,
    segmentReady: false,   // subject cutout — SlimSAM, mirrors samReady
    samReady: false,
    diagnostics: [],     // last DIAG_MAX runs: {capability, device, ms, ok, error?, at}
}

export const getClientAIState = () => ({
    enabled: isClientAIEnabled(),
    ...state,
    diagnostics: [...state.diagnostics],
})

const emitState = () => {
    if (!hasWindow()) return
    try {
        window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: getClientAIState() }))
    } catch { /* SSR */ }
}

const recordDiag = (capability, startedAt, ok, error, device = state.device) => {
    state.diagnostics.push({
        capability,
        device,
        ms: Date.now() - startedAt,
        ok,
        ...(error ? { error: String(error?.message || error).slice(0, 160) } : {}),
        at: Date.now(),
    })
    if (state.diagnostics.length > DIAG_MAX) state.diagnostics.shift()
    // Mirror for devtools debugging (read-only convention).
    if (hasWindow()) {
        window.__phosmith = window.__phosmith || {}
        window.__phosmith.clientAI = getClientAIState()
    }
}

const pickDevice = async () => {
    if (state.forcedWasm) { state.device = 'wasm'; return 'wasm' }
    if (state.device) return state.device
    let device = 'wasm'
    try {
        if (hasWindow() && navigator.gpu && await navigator.gpu.requestAdapter()) {
            device = 'webgpu'
        }
    } catch { /* no WebGPU */ }
    state.device = device
    return device
}

/**
 * Run an inference attempt; on failure while on WebGPU, downgrade to WASM
 * (sticky), drop the loaded models (they're bound to the dead device), and
 * retry ONCE. WebGPU context loss / driver bugs are the dominant real-world
 * failure mode of in-browser inference — a silent hang or hard fail here
 * must not kill the user's mask request when WASM can still serve it.
 */
const withDeviceFallback = async (capability, run) => {
    const startedAt = Date.now()
    try {
        const out = await run()
        recordDiag(capability, startedAt, true)
        return out
    } catch (err) {
        if (state.device !== 'webgpu' || state.forcedWasm) {
            recordDiag(capability, startedAt, false, err)
            throw err
        }
        console.warn(`[client-ai] ${capability} failed on WebGPU; retrying on WASM:`, err?.message)
        recordDiag(capability, startedAt, false, err)
        state.forcedWasm = true
        state.device = 'wasm'
        state.groundReady = false
        state.segmentReady = false
        state.samReady = false
        groundPromise = null
        samPromise = null
        samImage = null
        emitState()
        const retryAt = Date.now()
        try {
            const out = await run()
            recordDiag(capability, retryAt, true)
            return out
        } catch (err2) {
            recordDiag(capability, retryAt, false, err2)
            throw err2
        }
    }
}

/* ─── transformers.js import + ONNX runtime config ───────────────────────── */

// Bundlers (Next/Turbopack included) break onnxruntime's runtime fetch of
// ort-wasm-simd-threaded.jsep.{mjs,wasm} — the JSEP glue that defines
// `webgpuInit` — so WebGPU init throws "webgpuInit is not a function" and WASM
// reports "no available backend found", killing every in-browser model. Fix:
// serve the version-matched dist files from /ort/ (scripts/setup-ort.mjs,
// wired into dev/build) and point wasmPaths at them. Probed once so
// environments without the files keep the bundler defaults.
let ortEnvPromise = null
const loadTransformers = async () => {
    const tf = await import('@huggingface/transformers')
    if (!ortEnvPromise) {
        ortEnvPromise = (async () => {
            if (!hasWindow()) return
            try {
                const base = new URL('/ort/', window.location.origin)
                const probe = await fetch(new URL('ort-wasm-simd-threaded.jsep.mjs', base), { method: 'HEAD' })
                if (probe.ok) {
                    tf.env.backends.onnx.wasm.wasmPaths = base.href
                    // No cross-origin isolation → no SharedArrayBuffer; pin
                    // single-threaded WASM instead of letting ort probe.
                    tf.env.backends.onnx.wasm.numThreads = 1
                } else {
                    console.warn('[client-ai] /ort/ runtime files missing (run: bun run setup:ort) — using bundler defaults')
                }
            } catch { /* keep bundler defaults */ }
        })()
    }
    await ortEnvPromise
    return tf
}

/* ─── Model singletons ───────────────────────────────────────────────────── */

let groundPromise = null
let samPromise = null
// Cached SAM image encode: { el, w, h, rawImage, embeddings, scale }. The
// ViT encode is the slow part, so it's reused across clicks on the same image.
let samImage = null

/** Shared CLIPSeg inference: element + phrase → sigmoid relevance map. */
const groundLogits = async (bundle, el, phrase, { width, height }) => {
    const input = toInputCanvas(el, width, height)
    const image = await canvasToRawImage(input)
    const textInputs = bundle.tokenizer([phrase], { padding: true, truncation: true })
    const imageInputs = await bundle.processor(image)
    const { logits } = await withTimeout(
        bundle.model({ ...textInputs, ...imageInputs }),
        INFER_TIMEOUT_MS,
        'CLIPSeg inference',
    )
    const dims = logits.dims
    const mh = dims[dims.length - 2]
    const mw = dims[dims.length - 1]
    if (!mw || !mh || !logits.data || logits.data.length < mw * mh) {
        throw new Error(`CLIPSeg returned malformed logits (dims ${JSON.stringify(dims)})`)
    }
    const data = logits.data
    const map = new Float32Array(mw * mh)
    for (let i = 0; i < map.length; i += 1) {
        map[i] = 1 / (1 + Math.exp(-data[i]))
    }
    return { map, mw, mh }
}

/**
 * Golden-input gate: a freshly loaded model must find the red disc in the
 * built-in scene. Catches the cold-start failure mode where a bad
 * load/compile yields plausible-but-wrong logits that per-request checks
 * cannot tell apart from "target not in image".
 */
const calibrateGround = async (bundle) => {
    const { canvas, disc } = buildSelfTestScene()
    const { map, mw, mh } = await groundLogits(bundle, canvas, 'the red circle', {
        width: disc.w,
        height: disc.h,
    })
    const stats = analyzeCoverage(map, mw, mh, GROUND_FLOOR)
    return { ok: stats.finite && stats.peak >= CALIBRATION_MIN_PEAK, peak: stats.peak }
}

const loadGroundModel = () => {
    if (groundPromise) return groundPromise
    groundPromise = (async () => {
        const { AutoTokenizer, AutoProcessor, CLIPSegForImageSegmentation } =
            await loadTransformers()
        const device = await pickDevice()
        state.loading = 'CLIPSeg (text grounding)'
        emitState()
        try {
            const loadModel = () =>
                CLIPSegForImageSegmentation.from_pretrained(GROUND_MODEL, { device })
                    .catch(() => CLIPSegForImageSegmentation.from_pretrained(GROUND_MODEL))

            const [tokenizer, processor, model] = await withTimeout(
                Promise.all([
                    AutoTokenizer.from_pretrained(GROUND_MODEL),
                    AutoProcessor.from_pretrained(GROUND_MODEL),
                    loadModel(),
                ]),
                LOAD_TIMEOUT_MS,
                'CLIPSeg model load',
            )

            let bundle = { tokenizer, processor, model }
            let cal = await calibrateGround(bundle)
            if (!cal.ok) {
                // Bad load (truncated/corrupt compile) — rebuild the model
                // once; the files are already in the browser cache so this
                // is cheap. A second failure is a real, reportable error.
                console.warn(`[client-ai] CLIPSeg calibration failed (peak ${cal.peak.toFixed(3)}); reloading model`)
                try { bundle.model?.dispose?.() } catch { /* best-effort */ }
                bundle = { tokenizer, processor, model: await withTimeout(loadModel(), LOAD_TIMEOUT_MS, 'CLIPSeg model reload') }
                cal = await calibrateGround(bundle)
                if (!cal.ok) {
                    throw new Error(`On-device CLIPSeg failed calibration twice (peak ${cal.peak.toFixed(3)}) — falling back to the server`)
                }
            }
            console.log(`[client-ai] CLIPSeg calibrated (peak ${cal.peak.toFixed(3)}, ${state.device})`)
            state.groundReady = true
            return bundle
        } finally {
            state.loading = null
            emitState()
        }
    })()
    groundPromise.catch(() => { groundPromise = null })
    return groundPromise
}

const CAPABILITY_LOADERS = {
    ground: { load: loadGroundModel, pending: () => groundPromise != null, ready: () => state.groundReady },
    subjects: { load: loadGroundModel, pending: () => groundPromise != null, ready: () => state.groundReady },
    // Subject cutout is SlimSAM over a saliency box — same model as click select.
    segment: { load: () => loadSamModel(), pending: () => samPromise != null, ready: () => state.samReady },
    // loadSamModel is declared further down — reading it eagerly here is a TDZ
    // ReferenceError that crashes the whole module (and the editor) on import;
    // the thunk defers the read to call time.
    sam: { load: () => loadSamModel(), pending: () => samPromise != null, ready: () => state.samReady },
}

/* ─── Idle release ───────────────────────────────────────────────────────────
 * One model per job, and none of them squats in RAM: a model untouched for
 * IDLE_RELEASE_MS is disposed and its promise cleared, so the next call rebuilds
 * it from the browser's model cache (no re-download). Never fires while an
 * inference is in flight.
 */
const IDLE_RELEASE_MS = 5 * 60 * 1000
const IDLE_SWEEP_MS = 60 * 1000

const MODEL_SLOTS = {
    ground: {
        get: () => groundPromise,
        clear: () => { groundPromise = null; state.groundReady = false },
    },
    sam: {
        get: () => samPromise,
        clear: () => { samPromise = null; samImage = null; state.samReady = false },
    },
}
const slotUse = {}   // name → { lastUsed, inFlight }
let sweepTimer = null

const disposeLoaded = async (value) => {
    if (!value || typeof value !== 'object') return
    for (const target of [value, value.model, value.processor, value.session]) {
        try { await target?.dispose?.() } catch { /* best-effort */ }
    }
}

const sweepIdleModels = () => {
    const now = Date.now()
    let live = 0
    for (const [name, slot] of Object.entries(MODEL_SLOTS)) {
        const pending = slot.get()
        if (!pending) continue
        const use = slotUse[name]
        if (use?.inFlight > 0 || !use?.lastUsed) { live += 1; continue }
        if (now - use.lastUsed < IDLE_RELEASE_MS) { live += 1; continue }
        slot.clear()
        pending.then(disposeLoaded).catch(() => {})
        emitState()
    }
    if (!live && sweepTimer) {
        clearInterval(sweepTimer)
        sweepTimer = null
    }
}

/** Mark a model in use for the duration of `run` (and keep the sweeper alive). */
const withModelUse = async (name, run) => {
    const use = slotUse[name] || (slotUse[name] = { lastUsed: 0, inFlight: 0 })
    use.inFlight += 1
    use.lastUsed = Date.now()
    if (!sweepTimer && hasWindow()) {
        sweepTimer = setInterval(sweepIdleModels, IDLE_SWEEP_MS)
        sweepTimer.unref?.()
    }
    try {
        return await run()
    } finally {
        use.inFlight -= 1
        use.lastUsed = Date.now()
    }
}

/** Drop loaded in-browser models now (frees RAM immediately); all by default. */
export const releaseClientModels = async (names = Object.keys(MODEL_SLOTS)) => {
    for (const [name, slot] of Object.entries(MODEL_SLOTS)) {
        if (!names.includes(name)) continue
        const pending = slot.get()
        slot.clear()
        delete slotUse[name]
        if (pending) await pending.then(disposeLoaded).catch(() => {})
    }
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
    emitState()
}

// Run during browser idle time so a multi-hundred-MB download + ONNX compile
// never competes with canvas rendering or the user's actual edits.
const onIdle = (fn, timeout = 3000) => {
    if (hasWindow() && typeof window.requestIdleCallback === 'function') {
        try { window.requestIdleCallback(fn, { timeout }); return } catch { /* fall through */ }
    }
    setTimeout(fn, 200)
}

// Don't burn a metered / very slow connection on a speculative download —
// the model still lazy-loads on first real use if the user goes there.
const connectionAllowsPrefetch = () => {
    if (!hasWindow()) return false
    try {
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection
        if (!conn) return true
        if (conn.saveData) return false
        if (typeof conn.effectiveType === 'string' && /(^|-)2g$/.test(conn.effectiveType)) return false
    } catch { /* unknown — allow */ }
    return true
}

/**
 * Warm the in-browser models for the given capabilities in the BACKGROUND, so
 * the first on-device request doesn't block on the ~50–150 MB download + ONNX
 * compile. The HF hub files land in the browser Cache API, so the cost is paid
 * once per device and survives reloads.
 *
 * Safe to call repeatedly: the model singletons dedupe (a concurrent real
 * request reuses the same in-flight load — no double download), and loaders
 * already loading/loaded are skipped. Loads run one-at-a-time during idle
 * time. A failed prefetch stays silent; the real call path re-attempts and
 * surfaces the error there.
 *
 * @param {string[]} capabilities  routing capability ids to warm
 * @param {{ force?: boolean }} [opts]  force=true ignores the connection check
 */
export const prefetchClientModels = (capabilities, { force = false } = {}) => {
    if (!hasWindow()) return
    if (!force && !connectionAllowsPrefetch()) return

    const tasks = []
    const seen = new Set()
    for (const cap of capabilities || []) {
        const entry = CAPABILITY_LOADERS[cap]
        if (!entry || seen.has(entry.load)) continue
        seen.add(entry.load)
        if (entry.ready() || entry.pending()) continue
        tasks.push(entry.load)
    }
    if (!tasks.length) return

    let i = 0
    const runNext = () => {
        if (i >= tasks.length) return
        const load = tasks[i++]
        onIdle(() => {
            Promise.resolve().then(load).catch(() => {}).finally(runNext)
        })
    }
    runNext()
}

/* ─── Image plumbing ─────────────────────────────────────────────────────── */

/** Draw an image-like element to a capped canvas (model input). */
const toInputCanvas = (el, naturalW, naturalH) => {
    // Fall back to the element's own measured size when the caller's dims are
    // missing/degenerate (e.g. an <img> whose load hadn't settled), then refuse
    // outright if there's still nothing real to draw — a 1px model input only
    // yields garbage downstream.
    const w0 = Number(naturalW) || el?.naturalWidth || el?.width || 0
    const h0 = Number(naturalH) || el?.naturalHeight || el?.height || 0
    if (!Number.isFinite(w0) || !Number.isFinite(h0) || w0 < 1 || h0 < 1) {
        throw new Error('Image is not ready for on-device AI (no usable dimensions)')
    }
    const scale = Math.min(1, INPUT_MAX_SIDE / Math.max(w0, h0))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w0 * scale))
    c.height = Math.max(1, Math.round(h0 * scale))
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('Could not allocate a canvas for on-device AI')
    ctx.drawImage(el, 0, 0, c.width, c.height)
    return c
}

const canvasToRawImage = async (canvas) => {
    const { RawImage } = await loadTransformers()
    const blob = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'))
    return RawImage.fromBlob(blob)
}

/** Render a 0..1 Float32 map (mw×mh) to a luma coverage canvas at outW×outH. */
const mapToCanvas = (map, mw, mh, outW, outH, { threshold = null, peak = 1 } = {}) => {
    const small = document.createElement('canvas')
    small.width = mw
    small.height = mh
    const sctx = small.getContext('2d')
    const img = sctx.createImageData(mw, mh)
    for (let i = 0; i < mw * mh; i += 1) {
        let v = map[i]
        if (threshold != null) v = v >= threshold ? Math.min(1, v / (peak || 1)) : 0
        const byte = Math.round(Math.max(0, Math.min(1, v)) * 255)
        img.data[i * 4] = byte
        img.data[i * 4 + 1] = byte
        img.data[i * 4 + 2] = byte
        img.data[i * 4 + 3] = 255
    }
    sctx.putImageData(img, 0, 0)

    const out = document.createElement('canvas')
    out.width = Math.max(1, outW)
    out.height = Math.max(1, outH)
    const octx = out.getContext('2d')
    octx.imageSmoothingEnabled = true
    octx.imageSmoothingQuality = 'high'
    octx.drawImage(small, 0, 0, out.width, out.height)
    return out
}

/* ─── Public inference API ───────────────────────────────────────────────── */

const groundOnce = async (el, phrase, { width, height }) => {
    const bundle = await loadGroundModel()
    const { map, mw, mh } = await groundLogits(bundle, el, phrase, { width, height })

    const stats = analyzeCoverage(map, mw, mh, GROUND_FLOOR)
    if (!stats.finite) throw new Error('CLIPSeg produced non-finite values (broken backend)')
    const score = Math.round(stats.peak * 1e4) / 1e4
    if (stats.peak < GROUND_MIN_PEAK) return { canvas: null, score, bbox: null }

    const threshold = Math.max(GROUND_FLOOR, GROUND_THRESHOLD_REL * stats.peak)
    const cutStats = analyzeCoverage(map, mw, mh, threshold)
    const verdict = validateGroundOutput(
        { ...cutStats, peak: stats.peak },
        { minPeak: GROUND_MIN_PEAK },
    )
    if (!verdict.usable) {
        // Empty/degenerate cut = treat as a miss, not a crash — routing and
        // callers handle "not found" gracefully.
        return { canvas: null, score, bbox: null, reason: verdict.reason }
    }

    const canvas = mapToCanvas(map, mw, mh, width, height, { threshold, peak: stats.peak })
    // Scale the model-space bbox to output space for callers/self-test.
    const sx = width / mw
    const sy = height / mh
    const bbox = cutStats.bbox
        ? [
            Math.round(cutStats.bbox[0] * sx),
            Math.round(cutStats.bbox[1] * sy),
            Math.round(cutStats.bbox[2] * sx),
            Math.round(cutStats.bbox[3] * sy),
        ]
        : null
    return { canvas, score, bbox }
}

/**
 * Ground a phrase against an image entirely in-browser (CLIPSeg), with
 * inference timeout, WebGPU→WASM downgrade-and-retry, and output validation.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} el  the image source element
 * @param {string} phrase
 * @param {{ width: number, height: number }} naturalDims  output mask size
 * @returns {Promise<{ canvas: HTMLCanvasElement|null, score: number, bbox: number[]|null }>}
 */
export const clientGroundPhrase = (el, phrase, dims) =>
    withModelUse('ground', () => withDeviceFallback('ground', () => groundOnce(el, phrase, dims)))

/* ─── Subject cutout (Select Subject) ────────────────────────────────────────
 * One model, so the subject is chosen from SlimSAM's own answers: a border-
 * prior saliency box, the box with seed points, the seeds alone and a 6×6 grid,
 * three candidates each, scored on the 256-px decoder grid by subject-pick.js
 * (confident, off the frame's border, detailed, whole, central). Only the
 * winner is upsampled.
 */
const SUBJECT_SALIENCY_SIDE = 96

const pixelsAt = (el, w, h) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Could not allocate a canvas for subject detection')
    ctx.drawImage(el, 0, 0, w, h)
    return ctx.getImageData(0, 0, w, h).data
}

const subjectOnce = async (el, dims, side) => {
    const W = dims.width
    const H = dims.height
    const k = SUBJECT_SALIENCY_SIDE / Math.max(W, H)
    const w = Math.max(16, Math.round(W * k))
    const h = Math.max(16, Math.round(H * k))
    const { box, seeds } = subjectPrompts(pixelsAt(el, w, h), w, h)
    const sx = W / w
    const sy = H / h
    const nbox = [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy]
    const nseeds = seeds.map(([x, y]) => [x * sx, y * sy])
    const prompts = [
        { box: nbox },
        ...nseeds.map((seed) => ({ box: nbox, points: [seed] })),
        ...nseeds.map((seed) => ({ points: [seed] })),
        ...naturalGrid(dims).map((pt) => ({ points: [pt] })),
    ]
    const dec = await decodeLow(el, dims, side, prompts, { all: true })
    // The decoder grid's valid region is the whole frame at vw×vh.
    const grad = gradientMagnitude(pixelsAt(el, dec.vw, dec.vh), dec.vw, dec.vh)
    let gradMean = 0
    for (let p = 0; p < grad.length; p += 1) gradMean += grad[p]
    gradMean /= grad.length
    let best = null
    for (let i = 0; i < dec.n; i += 1) {
        for (let m = 0; m < dec.k; m += 1) {
            const v = scoreSubjectCandidate({ bits: dec.bits(i, m), w: dec.vw, h: dec.vh, sam: dec.iou[i * dec.k + m] }, grad, gradMean)
            if (v.score > 0 && (!best || v.score > best.score)) best = { i, m, ...v }
        }
    }
    if (!best) throw new Error('No subject could be separated from the background')
    const [canvas] = await dec.render([best], W, H)
    return canvas
}

/**
 * Subject cutout: a coverage canvas (white = subject) at the image's natural
 * size, on the Selection engine's side. Throws when nothing reads as a subject.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} el
 * @param {{ width: number, height: number }} naturalDims
 * @returns {Promise<HTMLCanvasElement>}
 */
export const clientSubjectMask = async (el, dims) => {
    const server = onServer('segment')
    const run = async () => {
        const startedAt = Date.now()
        try {
            const width = Number(dims?.width) || el?.naturalWidth || el?.width || 0
            const height = Number(dims?.height) || el?.naturalHeight || el?.height || 0
            if (width < 1 || height < 1) throw new Error('Image is not ready for subject detection')
            const size = { width, height }
            const out = server
                ? await withServerUse('sam', () => subjectOnce(el, size, 'server'))
                : await withModelUse('sam', () => withDeviceFallback('sam', () => subjectOnce(el, size, 'client')))
            recordDiag('segment', startedAt, true)
            return out
        } catch (err) {
            recordDiag('segment', startedAt, false, err)
            throw err
        }
    }
    // Loading SlimSAM and decoding ~40 prompts is the other big allocator in
    // the app. Queued so it cannot land on top of a bake or export. No
    // supersede key: two callers wanting mattes for DIFFERENT images are two
    // intents, and dropping the queued one would silently lose a result.
    // On the server it allocates nothing here, so it does not hold the slot.
    return server ? run() : runHeavy('subject detection', run)
}

/* ─── On-device SAM (click / box select) ─────────────────────────────────── */

const loadSamModel = () => {
    if (samPromise) return samPromise
    samPromise = (async () => {
        const { SamModel, AutoProcessor } = await loadTransformers()
        const device = await pickDevice()
        const engine = SAM_ENGINE
        state.loading = `${engine.label} (click select)`
        emitState()
        try {
            const loadModel = () => SamModel.from_pretrained(engine.id, { device })
                .catch(() => SamModel.from_pretrained(engine.id))
            const [model, processor] = await withTimeout(
                Promise.all([loadModel(), AutoProcessor.from_pretrained(engine.id)]),
                LOAD_TIMEOUT_MS,
                `${engine.label} model load`,
            )
            state.samReady = true
            return { model, processor, engine }
        } finally {
            state.loading = null
            emitState()
        }
    })()
    samPromise.catch(() => { samPromise = null })
    return samPromise
}

// Encode the image ONCE (the slow ViT pass) and cache embeddings + the input
// scale (natural → capped input coords) so every later click reuses them.
const ensureSamImage = async (el, { width, height }) => {
    const { model, processor, engine } = await loadSamModel()
    const w0 = Number(width) || el?.naturalWidth || el?.width || 0
    const h0 = Number(height) || el?.naturalHeight || el?.height || 0
    if (samImage && samImage.el === el && samImage.w === w0 && samImage.h === h0 && samImage.engineId === engine.id) {
        return { model, processor, engine, ...samImage }
    }
    const input = toInputCanvas(el, w0, h0) // capped to INPUT_MAX_SIDE
    const scale = input.width / w0          // natural → input coords
    const rawImage = await canvasToRawImage(input)
    let embeddings = null
    let sizes = null
    try {
        const pre = await processor(rawImage)
        sizes = { original_sizes: pre.original_sizes, reshaped_input_sizes: pre.reshaped_input_sizes }
        embeddings = await model.get_image_embeddings(pre)
    } catch { embeddings = null }
    samImage = { el, w: w0, h: h0, rawImage, embeddings, sizes, scale, engineId: engine.id }
    return { model, processor, engine, ...samImage }
}

// SAM output → coverage canvas at outW×outH (white = selected); picks the
// highest-IoU candidate. Ported from the mask-studio testbed.
const samMaskToCanvas = (maskTensor, iou, outW, outH, whole = false, object = false) => {
    const dims = maskTensor.dims
    const w = dims[dims.length - 1]
    const h = dims[dims.length - 2]
    const nMasks = dims.length >= 3 ? dims[dims.length - 3] : 1
    const scores = iou && iou.data ? Array.from(iou.data) : []
    let bi = 0
    let best = -Infinity
    for (let i = 0; i < nMasks; i += 1) { const s = scores[i] ?? 0; if (s > best) { best = s; bi = i } }
    const plane = w * h
    // SAM answers a prompt with whole / part / sub-part. The best-scored one is
    // often the part under the prompt point (a motorbike's engine); `whole` takes
    // the largest of the confident answers instead.
    // `object` (the remover): the largest answer within 0.1 of the best score —
    // a click on a headlight's glass gets the headlight (0.895 vs the glass's
    // 0.926), not the glass that would leave its chrome ring behind, nor the
    // whole motorbike (0.73).
    if (object && nMasks > 1) {
        let bigArea = -1
        const pick = bi
        for (let i = 0; i < nMasks; i += 1) {
            if ((scores[i] ?? 0) < scores[pick] - 0.1) continue
            let a = 0
            const o = i * plane
            for (let p = 0; p < plane; p += 1) if (maskTensor.data[o + p]) a += 1
            if (a > bigArea) { bigArea = a; bi = i }
        }
    } else if (whole && nMasks > 1) {
        let bigArea = -1
        for (let i = 0; i < nMasks; i += 1) {
            if ((scores[i] ?? 0) < Math.max(0.5, best - 0.25)) continue
            let a = 0
            const o = i * plane
            for (let p = 0; p < plane; p += 1) if (maskTensor.data[o + p]) a += 1
            if (a > bigArea) { bigArea = a; bi = i }
        }
    }
    const off = bi * plane
    const small = document.createElement('canvas')
    small.width = w
    small.height = h
    const sctx = small.getContext('2d')
    const img = sctx.createImageData(w, h)
    const d = maskTensor.data
    for (let p = 0; p < plane; p += 1) {
        const v = d[off + p] ? 255 : 0
        const q = p * 4
        img.data[q] = v
        img.data[q + 1] = v
        img.data[q + 2] = v
        img.data[q + 3] = 255
    }
    sctx.putImageData(img, 0, 0)
    const out = document.createElement('canvas')
    out.width = Math.max(1, outW || w)
    out.height = Math.max(1, outH || h)
    const octx = out.getContext('2d')
    octx.imageSmoothingEnabled = true
    octx.imageSmoothingQuality = 'high'
    octx.drawImage(small, 0, 0, out.width, out.height)
    return out
}

// The decoder takes a box as two more points labelled 2 (top-left) and 3
// (bottom-right), Meta's SAM ONNX convention; a prompt without a box carries
// the "not a point" pad (0, 0, label -1) that HF's encoder would add itself.
const devicePrompt = ({ points = [], labels = null, box = null }, scale) => {
    const at = ([x, y]) => [Math.round(x * scale), Math.round(y * scale)]
    const pts = points.map(at)
    const lab = points.map((_, i) => (labels ? (labels[i] ? 1 : 0) : 1))
    if (box) {
        pts.push(at([box[0], box[1]]), at([box[2], box[3]]))
        lab.push(2, 3)
    } else {
        pts.push([0, 0])
        lab.push(-1)
    }
    return { pts, lab }
}

// Prompt tensors from the sizes cached at encode time. Running the processor
// per prompt re-preprocessed the whole image only to scale a few coordinates.
const promptInputs = async ({ processor, rawImage, embeddings, sizes }, input_points, input_labels) => {
    if (!embeddings || !sizes) return processor(rawImage, { input_points, input_labels })
    const points = processor.reshape_input_points(input_points, sizes.original_sizes, sizes.reshaped_input_sizes)
    return { ...sizes, input_points: points, input_labels: processor.image_processor.add_input_labels(input_labels, points) }
}

/** One prompt — points, a box, or both — on device. */
const samPromptOnce = async (el, dims, prompt, { whole = false, object = false } = {}) => {
    const sam = await ensureSamImage(el, dims)
    const { model, processor, engine, rawImage, embeddings, scale } = sam
    const { pts, lab } = devicePrompt(prompt, scale)
    let inputs = await promptInputs(sam, [[pts]], [[lab]])
    let outputs
    if (embeddings) {
        // The cached-embeddings call can RESOLVE with unusable outputs (no
        // pred_masks) instead of throwing — validate, don't just catch, or the
        // full-encode fallback below never runs and post-processing crashes.
        try {
            outputs = await model({ ...embeddings, input_points: inputs.input_points, input_labels: inputs.input_labels })
        } catch { outputs = null }
        if (!outputs?.pred_masks) outputs = null
    }
    if (!outputs) {
        // The full pass needs pixel values, which the cached path skipped.
        if (!inputs.pixel_values) inputs = await processor(rawImage, { input_points: [[pts]], input_labels: [[lab]] })
        outputs = await withTimeout(model(inputs), INFER_TIMEOUT_MS, `${engine.label} inference`)
    }
    const masks = await processor.post_process_masks(outputs.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes)
    if (!masks?.[0]?.dims) throw new Error(`${engine.label} returned no mask for the prompt`)
    return samMaskToCanvas(masks[0], outputs.iou_scores, dims.width, dims.height, whole, object)
}

/**
 * In-browser SlimSAM click-select. `points` are [[x, y], ...] and `labels`
 * [1|0, ...] in the image's NATURAL pixel coords; returns a coverage canvas at
 * (width, height). Same timeout + WebGPU→WASM hardening as the rest.
 * `{ object: true }` returns the whole object under the click rather than the
 * part SAM scores best (see samMaskToCanvas).
 */
export const clientSamClick = (el, points, labels, dims, { object = false, whole = false } = {}) =>
    onServer('sam')
        ? withServerUse('sam', () => samClickServer(el, points, labels, dims, object, whole))
        : withModelUse('sam', () => withDeviceFallback('sam', () => samPromptOnce(el, dims, { points, labels }, { object, whole })))

/**
 * SlimSAM box-select. `box` is [x0, y0, x1, y1] natural px; `points`
 * ([[x, y], …] natural px) and `labels` (1 keep / 0 exclude, default all 1)
 * prompt with it. `{ whole: true }` returns the largest confident answer
 * rather than the best-scored part.
 */
export const clientSamBox = (el, box, dims, { whole = false, points = null, labels = null } = {}) => {
    const pts = Array.isArray(points) ? points : []
    return onServer('sam')
        ? withServerUse('sam', async () => (await samBoxServer(el, box, dims, [pts], { whole, labels }))[0])
        : withModelUse('sam', () => withDeviceFallback('sam', () => samPromptOnce(el, dims, { points: pts, labels, box }, { whole })))
}

/** Is SlimSAM already on this device (loaded, or in transformers.js's cache)? */
export const isSelectionModelCached = async () => {
    if (state.samReady) return true
    try {
        if (!hasWindow() || !('caches' in window)) return false
        // `has` first: `open` would create the cache just to look in it.
        if (!(await caches.has('transformers-cache'))) return false
        const keys = await (await caches.open('transformers-cache')).keys()
        return keys.some((req) => req.url.includes(SAM_ENGINE.id) && req.url.endsWith('.onnx'))
    } catch {
        return false
    }
}

/* ─── SlimSAM on the server (Selection engine: Server) ───────────────────────
 * The same SlimSAM for devices too weak to run it here. The browser sends its
 * own model input (the ≤1024 px canvas the device path encodes) once per
 * image; each click, box or grid is then a small JSON round trip that names
 * the image by `key`. Masks come back as SlimSAM's three candidates, so the
 * same pickers (best / whole / object) choose among them as on device.
 */

// Which side the self-test pins; null follows the Selection engine.
let sideOverride = null
const onServer = (capability) => (sideOverride || selectionSide(capability)) === 'server'

let serverSam = null   // { el, w, h, key, scale, width, height, model }
let serverSamPending = null

const postSelection = async (path, init) => {
    const res = await fetch(path, init)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
        const err = new Error(body?.error || `The selection server answered HTTP ${res.status}`)
        err.status = res.status
        throw err
    }
    return body
}

const ensureServerSamImage = async (el, { width, height }, { fresh = false } = {}) => {
    const w0 = Number(width) || el?.naturalWidth || el?.width || 0
    const h0 = Number(height) || el?.naturalHeight || el?.height || 0
    const same = (r) => r && r.el === el && r.w === w0 && r.h === h0
    if (!fresh && same(serverSam)) return serverSam
    // Two calls on a new image share one upload.
    if (!fresh && same(serverSamPending)) return serverSamPending.promise
    const promise = (async () => {
        const input = toInputCanvas(el, w0, h0)
        // JPEG: a 1024 px PNG is ~1.5 MB on exactly the connections this mode is for.
        const blob = await new Promise((res, rej) =>
            input.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/jpeg', 0.9))
        const form = new FormData()
        form.append('image', blob, 'sam-input.jpg')
        const body = await postSelection('/api/ai/sam/embed', { method: 'POST', body: form })
        serverSam = { el, w: w0, h: h0, key: body.key, scale: input.width / w0, width: input.width, height: input.height, model: body.model }
        return serverSam
    })()
    serverSamPending = { el, w: w0, h: h0, promise }
    try {
        return await promise
    } finally {
        if (serverSamPending?.promise === promise) serverSamPending = null
    }
}

/** `buildPrompts(scale)` gives prompts in model-input px. Re-encodes once on a 404. */
const serverDecode = async (el, dims, buildPrompts, output = 'masks', extra = {}) => {
    let img = await ensureServerSamImage(el, dims)
    const send = (key) => postSelection('/api/ai/sam/decode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, prompts: buildPrompts(img.scale), output, ...extra }),
    })
    try {
        return { img, out: await send(img.key) }
    } catch (err) {
        if (err.status !== 404) throw err
        // The server forgot the image (evicted, or restarted while idle).
        img = await ensureServerSamImage(el, dims, { fresh: true })
        return { img, out: await send(img.key) }
    }
}

const decodePng = async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }),
        { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const c = document.createElement('canvas')
    c.width = bitmap.width
    c.height = bitmap.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close?.()
    return ctx.getImageData(0, 0, c.width, c.height)
}

// R, G, B = candidates 0, 1, 2 → the [masks, h, w] shape samMaskToCanvas reads.
// `only` keeps one candidate.
const candidatesFromPng = async (b64, only = null) => {
    const { data, width, height } = await decodePng(b64)
    const plane = width * height
    const channels = only == null ? [0, 1, 2] : [only]
    const out = new Uint8Array(channels.length * plane)
    channels.forEach((ch, k) => {
        const o = k * plane
        for (let p = 0; p < plane; p += 1) out[o + p] = data[p * 4 + ch] > 127 ? 1 : 0
    })
    return { dims: [channels.length, height, width], data: out }
}

const serverMaskCanvas = async (result, outW, outH, whole = false, object = false) =>
    samMaskToCanvas(await candidatesFromPng(result.png), { data: result.scores }, outW, outH, whole, object)

const toInput = (scale) => ([x, y]) => [Math.round(x * scale), Math.round(y * scale)]

const samClickServer = async (el, points, labels, dims, object = false, whole = false) => {
    const { out } = await serverDecode(el, dims, (scale) => [{
        points: points.map(toInput(scale)),
        labels: labels.map((l) => (l ? 1 : 0)),
    }])
    return serverMaskCanvas(out.results[0], dims.width, dims.height, whole, object)
}

/** One prompt per point set, each with `box`; one canvas each. */
const samBoxServer = async (el, box, dims, pointSets, { whole = false, labels = null } = {}) => {
    const { out } = await serverDecode(el, dims, (scale) => pointSets.map((pts) => ({
        box: box.map((v) => Math.round(v * scale)),
        points: pts.map(toInput(scale)),
        labels: pts.map((_, i) => (labels ? (labels[i] ? 1 : 0) : 1)),
    })))
    return Promise.all(out.results.map((r) => serverMaskCanvas(r, dims.width, dims.height, whole)))
}

const withServerUse = async (capability, run) => {
    const startedAt = Date.now()
    try {
        const out = await run()
        recordDiag(capability, startedAt, true, null, 'server')
        noteSelectionServer(true)
        return out
    } catch (err) {
        recordDiag(capability, startedAt, false, err, 'server')
        noteSelectionServer(false, err?.message || '')
        throw err
    }
}

/* ─── On-device subject instances (SlimSAM "everything" mode) ────────────── */

// A grid of single-point prompts decoded in ONE batched pass against the cached
// image embedding. Every prompt SlimSAM is confident about is a candidate; the
// largest whole objects are kept and anything that overlaps or sits inside one
// is a duplicate or a part. Selection happens on the 256px decoder output, so
// only the kept masks are ever upsampled to full size.
const INSTANCE_GRID = 6
const INSTANCE_MIN_SCORE = 0.8
const INSTANCE_MIN_AREA = 0.01
const INSTANCE_MAX_AREA = 0.8
const INSTANCE_OVERLAP = 0.6 // IoU, or share of the smaller mask inside a kept one
// Background runs round the frame; a subject cut by the edge covers little of it.
const INSTANCE_MAX_BORDER = 0.4
const INSTANCE_MAX = 8
const INSTANCE_PNG_MAX_SIDE = 2048

// The grid prompts, natural px: one positive point per cell.
const naturalGrid = ({ width: W, height: H }) => {
    const points = []
    for (let gy = 0; gy < INSTANCE_GRID; gy += 1) {
        for (let gx = 0; gx < INSTANCE_GRID; gx += 1) points.push([((gx + 0.5) / INSTANCE_GRID) * W, ((gy + 0.5) / INSTANCE_GRID) * H])
    }
    return points
}

/*
 * Prompts ({ points, labels, box }, natural px) decoded on the 256-px decoder
 * grid, whichever side decodes them: k candidates per prompt with scores, each
 * candidate's mask on the grid (`bits`), and `render` for the chosen ones at
 * output size. Detect All Subjects and Select Subject choose from this alone,
 * so both sides choose alike. `all: false` lets the server send only each
 * prompt's best candidate.
 */
const decodeLow = (el, dims, side, prompts, { all = true } = {}) =>
    side === 'server' ? serverDecodeLow(el, dims, prompts, all) : deviceDecodeLow(el, dims, prompts)

const deviceDecodeLow = async (el, dims, prompts) => {
    const { Tensor } = await loadTransformers()
    const sam = await ensureSamImage(el, dims)
    const { model, processor, engine, rawImage, embeddings, scale } = sam
    const conv = prompts.map((p) => devicePrompt(p, scale))
    // A batch needs one point count, so prompts decode in groups by length.
    const groups = new Map()
    conv.forEach((c, i) => groups.set(c.pts.length, [...(groups.get(c.pts.length) || []), i]))
    const where = new Array(prompts.length)
    const iou = []
    let k = 3, lowW = 256, lowH = 256, sizes = null
    for (const idx of groups.values()) {
        const points = [idx.map((i) => conv[i].pts)]
        const labels = [idx.map((i) => conv[i].lab)]
        let inputs = await promptInputs(sam, points, labels)
        let outputs = null
        if (embeddings) {
            try { outputs = await model({ ...embeddings, input_points: inputs.input_points, input_labels: inputs.input_labels }) } catch { outputs = null }
            if (!outputs?.pred_masks) outputs = null
        }
        if (!outputs) {
            if (!inputs.pixel_values) inputs = await processor(rawImage, { input_points: points, input_labels: labels })
            outputs = await withTimeout(model(inputs), INFER_TIMEOUT_MS, `${engine.label} inference`)
        }
        const pm = outputs.pred_masks
        ;[, , k, lowH, lowW] = pm.dims
        sizes ??= inputs
        const sc = outputs.iou_scores.data
        idx.forEach((i, j) => {
            where[i] = { data: pm.data, off: j * k * lowW * lowH }
            for (let m = 0; m < k; m += 1) iou[i * k + m] = sc[j * k + m]
        })
    }
    const [rh, rw] = Array.from(sizes.reshaped_input_sizes[0] ?? sizes.reshaped_input_sizes)
    const [oh, ow] = Array.from(sizes.original_sizes[0] ?? sizes.original_sizes)
    const longest = Math.max(rh, rw) || 1024
    const vw = Math.max(1, Math.min(lowW, Math.round((lowW * rw) / longest)))
    const vh = Math.max(1, Math.min(lowH, Math.round((lowH * rh) / longest)))
    const plane = lowW * lowH
    return {
        n: prompts.length, k, iou, lowW, lowH, vw, vh, oh, ow, scale, model: engine.id,
        bestOf: (i) => {
            let m = 0
            for (let j = 1; j < k; j += 1) if (iou[i * k + j] > iou[i * k + m]) m = j
            return m
        },
        bits: (i, m) => {
            const { data, off } = where[i]
            const o = off + m * plane
            const b = new Uint8Array(vw * vh)
            for (let y = 0; y < vh; y += 1) for (let x = 0; x < vw; x += 1) b[y * vw + x] = data[o + y * lowW + x] > 0 ? 1 : 0
            return b
        },
        render: async (chosen, outW, outH) => {
            const canvases = []
            for (const c of chosen) {
                const { data, off } = where[c.i]
                const o = off + c.m * plane
                const one = new Tensor('float32', data.slice(o, o + plane), [1, 1, 1, lowH, lowW])
                const masks = await processor.post_process_masks(one, sizes.original_sizes, sizes.reshaped_input_sizes)
                canvases.push(samMaskToCanvas(masks[0], null, outW, outH))
            }
            return canvases
        },
    }
}

const serverDecodeLow = async (el, dims, prompts, all) => {
    const toServer = (scale) => prompts.map((p) => ({
        points: (p.points || []).map(toInput(scale)),
        labels: (p.points || []).map((_, j) => (p.labels ? (p.labels[j] ? 1 : 0) : 1)),
        ...(p.box ? { box: p.box.map((v) => Math.round(v * scale)) } : {}),
    }))
    const { img, out } = await serverDecode(el, dims, toServer, 'low', { all })
    const { vw, vh, grid, candidates } = out.low
    const atlas = (await decodePng(out.low.png)).data
    const best = out.results.map((r) => r.best)
    return {
        n: out.results.length, k: 3, iou: out.results.flatMap((r) => r.scores),
        lowW: grid, lowH: grid, vw, vh, oh: img.height, ow: img.width, scale: img.scale, model: img.model || 'server',
        // The server picked each prompt's best on unrounded scores.
        bestOf: (i) => best[i],
        bits: (i, m) => {
            const b = new Uint8Array(vw * vh)
            // Rows: prompt by prompt, and candidate by candidate when all were sent.
            const row = candidates === 3 ? i * 3 + m : m === best[i] ? i : -1
            if (row < 0) return b
            const o = row * vw * vh
            for (let p = 0; p < vw * vh; p += 1) b[p] = atlas[(o + p) * 4] > 127 ? 1 : 0
            return b
        },
        // One more round trip for the chosen few, at full size.
        render: async (chosen, outW, outH) => {
            const { out: full } = await serverDecode(el, dims, (scale) => {
                const every = toServer(scale)
                return chosen.map((c) => every[c.i])
            })
            return Promise.all(full.results.map(async (r, j) =>
                samMaskToCanvas(await candidatesFromPng(r.png, chosen[j].m), null, outW, outH)))
        },
    }
}

const instancesOnce = async (el, dims, side) => {
    const grid = await decodeLow(el, dims, side, naturalGrid(dims).map((pt) => ({ points: [pt] })), { all: false })
    const W = dims.width
    const H = dims.height
    const { n, k, iou, lowW, lowH, vw, vh, oh, ow, scale } = grid

    const candidates = []
    for (let i = 0; i < n; i += 1) {
        const m = grid.bestOf(i)
        const score = iou[i * k + m]
        if (!(score >= INSTANCE_MIN_SCORE)) continue
        const bits = grid.bits(i, m)
        let area = 0
        let x0 = vw, y0 = vh, x1 = -1, y1 = -1, sx = 0, sy = 0
        for (let y = 0; y < vh; y += 1) {
            for (let x = 0; x < vw; x += 1) {
                if (bits[y * vw + x]) {
                    area += 1
                    sx += x; sy += y
                    if (x < x0) x0 = x
                    if (x > x1) x1 = x
                    if (y < y0) y0 = y
                    if (y > y1) y1 = y
                }
            }
        }
        const frac = area / (vw * vh)
        if (frac < INSTANCE_MIN_AREA || frac > INSTANCE_MAX_AREA) continue
        let edge = 0
        for (let x = 0; x < vw; x += 1) edge += bits[x] + bits[(vh - 1) * vw + x]
        for (let y = 1; y < vh - 1; y += 1) edge += bits[y * vw] + bits[y * vw + vw - 1]
        if (edge / (2 * (vw + vh) - 4) > INSTANCE_MAX_BORDER) continue
        candidates.push({ i, m, score, bits, area, frac, box: [x0, y0, x1, y1], c: [sx / area, sy / area] })
    }

    // Whole objects first: a part (a face, a sleeve) arrives later and is
    // dropped because it sits inside a subject that is already kept.
    candidates.sort((a, b) => b.area - a.area || b.score - a.score)
    const kept = []
    let truncated = false
    for (const cand of candidates) {
        const dup = kept.some((other) => {
            let inter = 0
            for (let p = 0; p < cand.bits.length; p += 1) if (cand.bits[p] && other.bits[p]) inter += 1
            const union = cand.area + other.area - inter
            return inter / union > INSTANCE_OVERLAP || inter / Math.min(cand.area, other.area) > INSTANCE_OVERLAP
        })
        if (dup) continue
        if (kept.length === INSTANCE_MAX) { truncated = true; break }
        kept.push(cand)
    }

    const outScale = Math.min(1, INSTANCE_PNG_MAX_SIDE / Math.max(W, H))
    const outW = Math.max(1, Math.round(W * outScale))
    const outH = Math.max(1, Math.round(H * outScale))
    // Decoder grid → the input SlimSAM was given (its longest side spans the grid) → natural px.
    const toNatural = (lx, ly) => [(lx * Math.max(oh, ow)) / lowW / scale, (ly * Math.max(oh, ow)) / lowH / scale]
    const union = document.createElement('canvas')
    union.width = outW
    union.height = outH
    const uctx = union.getContext('2d')
    uctx.fillStyle = '#000'
    uctx.fillRect(0, 0, outW, outH)
    uctx.globalCompositeOperation = 'lighten'

    const canvases = kept.length ? await grid.render(kept, outW, outH) : []
    const instances = []
    for (const [index, cand] of kept.entries()) {
        const canvas = canvases[index]
        uctx.drawImage(canvas, 0, 0)
        const [bx0, by0] = toNatural(cand.box[0], cand.box[1])
        const [bx1, by1] = toNatural(cand.box[2] + 1, cand.box[3] + 1)
        const [cx, cy] = toNatural(cand.c[0] + 0.5, cand.c[1] + 0.5)
        instances.push({
            index,
            label: 'Subject',
            confidence: Math.round(cand.score * 1000) / 1000,
            area: Math.round(cand.frac * 1000) / 1000,
            bbox: [Math.round(bx0), Math.round(by0), Math.round(bx1 - bx0), Math.round(by1 - by0)],
            centroid: [Math.round(cx), Math.round(cy)],
            maskPng: canvas.toDataURL('image/png').split(',')[1],
        })
    }
    return {
        instances,
        count: instances.length,
        truncated,
        unionPng: instances.length ? union.toDataURL('image/png').split(',')[1] : null,
        width: outW,
        height: outH,
        mode: side === 'server' ? 'slimsam-grid-server' : 'slimsam-grid',
        model: grid.model,
    }
}

/**
 * Every separate subject in the photo, from the same SlimSAM that does click
 * select, on the Selection engine's side. Subjects come back unlabelled
 * ('Subject'); bbox and centroid are in NATURAL px, masks are PNGs capped at
 * 2048px.
 */
export const clientSubjectInstances = (el, dims) =>
    onServer('subjects')
        ? withServerUse('subjects', () => instancesOnce(el, dims, 'server'))
        : runHeavy('subject detection', () =>
            withModelUse('sam', () => withDeviceFallback('sam', () => instancesOnce(el, dims, 'client'))))

/* ─── Self-test ──────────────────────────────────────────────────────────── */

/** Synthetic scene with a known answer: red disc, off-centre, on flat grey. */
const buildSelfTestScene = () => {
    const w = 320
    const h = 240
    const cx = 100
    const cy = 130
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    ctx.fillStyle = 'rgb(122,130,140)'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = 'rgb(225,30,30)'
    ctx.beginPath()
    ctx.arc(cx, cy, 58, 0, Math.PI * 2)
    ctx.fill()
    return { canvas: c, disc: { cx, cy, w, h } }
}

/** Two separate objects on flat grey: a red disc and a blue square. */
const buildInstancesScene = () => {
    const w = 320
    const h = 240
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    ctx.fillStyle = 'rgb(122,130,140)'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = 'rgb(225,30,30)'
    ctx.beginPath()
    ctx.arc(90, 120, 50, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgb(30,60,220)'
    ctx.fillRect(190, 70, 95, 95)
    return { canvas: c, w, h, targets: [[90, 120], [237.5, 117.5]] }
}

/**
 * End-to-end self-test of the on-device engine: runs the REAL models on a
 * synthetic image with a known answer and validates every invariant the
 * masking pipeline depends on. Used by the Mask tool's "Test device AI"
 * button and by scripts/verify-client-ai.mjs (headless browser harness) —
 * this is what makes the in-browser path verifiable instead of
 * works-on-my-machine.
 *
 * `side: 'server'` runs the SlimSAM checks on the server instead (the
 * Selection engine card's test) and skips CLIPSeg, which never leaves the
 * browser; the default tests this device, whatever the engine is set to.
 *
 * @param {{ onProgress?: (msg: string) => void, side?: 'client'|'server' }} [opts]
 * @returns {Promise<{ ok: boolean, device: string, totalMs: number,
 *                     checks: Array<{label: string, ok: boolean, detail: string}> }>}
 */
export const runClientAISelfTest = async ({ onProgress, side = 'client' } = {}) => {
    sideOverride = side === 'server' ? 'server' : 'client'
    try {
        return await selfTestOnce({ onProgress, server: side === 'server' })
    } finally {
        sideOverride = null
    }
}

const selfTestOnce = async ({ onProgress, server }) => {
    const startedAt = Date.now()
    const progress = (msg) => { try { onProgress?.(msg) } catch { /* ignore */ } }
    const { canvas, disc } = buildSelfTestScene()
    const where = server ? 'on the server' : 'on this device'

    let ground
    if (!server) {
        progress('Loading CLIPSeg + grounding "the red circle"…')
        ground = { found: false, score: 0, bbox: null }
        try {
            const g = await clientGroundPhrase(canvas, 'the red circle', { width: disc.w, height: disc.h })
            ground = { found: Boolean(g.canvas), score: g.score, bbox: g.bbox }
        } catch (err) {
            ground = { found: false, score: 0, bbox: null, error: String(err?.message || err) }
        }
    }

    // Depth is not a browser model any more (service only).
    const depth = undefined

    progress(`Cutting out the subject with SlimSAM ${where}…`)
    let segment = null
    try {
        const s = await clientSubjectMask(canvas, { width: disc.w, height: disc.h })
        const ctx = s.getContext('2d', { willReadFrequently: true })
        const px = ctx.getImageData(0, 0, s.width, s.height).data
        const map = new Float32Array(s.width * s.height)
        for (let i = 0, p = 0; i < px.length; i += 4, p += 1) map[p] = px[i] / 255
        const stats = analyzeCoverage(map, s.width, s.height, 0.5)
        segment = { width: s.width, height: s.height, coverage: stats.coverage, bbox: stats.bbox }
    } catch (err) {
        segment = null
        progress(`Background removal failed: ${err?.message}`)
    }

    progress(`Click-selecting the disc with SlimSAM ${where}…`)
    let sam = null
    try {
        const m = await clientSamClick(canvas, [[disc.cx, disc.cy]], [1], { width: disc.w, height: disc.h })
        const ctx = m.getContext('2d', { willReadFrequently: true })
        const px = ctx.getImageData(0, 0, m.width, m.height).data
        const map = new Float32Array(m.width * m.height)
        for (let i = 0, p = 0; i < px.length; i += 4, p += 1) map[p] = px[i] / 255
        const stats = analyzeCoverage(map, m.width, m.height, 0.5)
        sam = {
            width: m.width,
            height: m.height,
            coverage: stats.coverage,
            bbox: stats.bbox,
            engine: server ? (serverSam?.model || 'server') : SAM_ENGINE.id,
        }
    } catch (err) {
        sam = null
        progress(`SAM click-select failed: ${err?.message}`)
    }

    progress(`Finding every subject with SlimSAM ${where}…`)
    const shapes = buildInstancesScene()
    let instances = null
    try {
        const r = await clientSubjectInstances(shapes.canvas, { width: shapes.w, height: shapes.h })
        instances = { count: r.count, centroids: r.instances.map((i) => i.centroid), areas: r.instances.map((i) => i.area) }
    } catch (err) {
        progress(`Subject detection failed: ${err?.message}`)
    }

    const report = evaluateSelfTest({ ground, depth, segment, sam }, disc)
    const near = (c, t) => c && Math.hypot(c[0] - t[0], c[1] - t[1]) < 30
    report.checks.push({
        label: 'Detect all subjects finds both shapes and nothing else',
        ok: Boolean(instances)
            && shapes.targets.every((t) => instances.centroids.some((c) => near(c, t)))
            && instances.centroids.every((c) => shapes.targets.some((t) => near(c, t))),
        detail: instances ? `${instances.count} found · centroids ${JSON.stringify(instances.centroids)}` : 'failed',
    })
    report.ok = report.checks.every((c) => c.ok)
    return {
        ...report,
        device: server ? 'server' : state.device || 'unknown',
        totalMs: Date.now() - startedAt,
        ground,
        depth,
        segment,
        sam,
    }
}
