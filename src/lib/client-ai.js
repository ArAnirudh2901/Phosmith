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
 * Trade-offs vs the local service: no SAM 2 edge refinement and no YOLO
 * instance detection — subject phrases fall back to text grounding, so
 * positional qualifiers ("second from the left") are not separable.
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

const ENABLED_KEY = 'phosmith:client-ai'
const CHANGED_EVENT = 'phosmith:client-ai-changed'

const GROUND_MODEL = 'Xenova/clipseg-rd64-refined'
const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small'
// Background removal / subject matting engines, in preference order. Chosen
// empirically via verify:client-ai: BiRefNet-lite and MODNet's pipeline
// graphs fail in this onnxruntime-web build (WASM: OrtRun std::bad_alloc
// even in isolation; WebGPU: unsupported shader op), while RMBG-1.4 through
// the canonical MANUAL recipe (AutoModel with model_type:'custom') runs
// correctly on plain WASM — it's the engine behind the well-known in-browser
// background-removal demos. NOTE: RMBG-1.4 is CC BY-NC (non-commercial),
// the same licence caveat the server's bria-rmbg option documents.
const SEGMENT_ENGINES = [
    { id: 'briaai/RMBG-1.4', kind: 'rmbg-manual' },
    { id: 'Xenova/modnet', kind: 'pipeline' },
]

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
    depthReady: false,
    segmentReady: false,
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

const recordDiag = (capability, startedAt, ok, error) => {
    state.diagnostics.push({
        capability,
        device: state.device,
        ms: Date.now() - startedAt,
        ok,
        ...(error ? { error: String(error?.message || error).slice(0, 160) } : {}),
        at: Date.now(),
    })
    if (state.diagnostics.length > DIAG_MAX) state.diagnostics.shift()
    // Mirror for devtools debugging (read-only convention).
    if (hasWindow()) {
        window.__pixxel = window.__pixxel || {}
        window.__pixxel.clientAI = getClientAIState()
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
        state.depthReady = false
        state.segmentReady = false
        groundPromise = null
        depthPromise = null
        segmentPromise = null
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

/* ─── Model singletons ───────────────────────────────────────────────────── */

let groundPromise = null
let depthPromise = null
let segmentPromise = null

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
            await import('@huggingface/transformers')
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

const loadDepthModel = () => {
    if (depthPromise) return depthPromise
    depthPromise = (async () => {
        const { pipeline } = await import('@huggingface/transformers')
        const device = await pickDevice()
        state.loading = 'Depth Anything V2'
        emitState()
        try {
            const pipe = await withTimeout(
                pipeline('depth-estimation', DEPTH_MODEL, { device })
                    .catch(() => pipeline('depth-estimation', DEPTH_MODEL)),
                LOAD_TIMEOUT_MS,
                'Depth model load',
            )
            state.depthReady = true
            return pipe
        } finally {
            state.loading = null
            emitState()
        }
    })()
    depthPromise.catch(() => { depthPromise = null })
    return depthPromise
}

// Index into SEGMENT_ENGINES — bumped (sticky) when an engine fails at
// inference so every later call goes straight to the survivor.
let segmentEngineIndex = 0

const loadSegmentModel = () => {
    if (segmentPromise) return segmentPromise
    segmentPromise = (async () => {
        const transformers = await import('@huggingface/transformers')
        const device = await pickDevice()
        const engine = SEGMENT_ENGINES[Math.min(segmentEngineIndex, SEGMENT_ENGINES.length - 1)]
        state.loading = `${engine.id.split('/').pop()} (background removal)`
        emitState()
        try {
            if (engine.kind === 'rmbg-manual') {
                // Canonical RMBG-1.4 recipe: the repo's config lacks a usable
                // model_type/preprocessor for the pipeline API, so the model
                // and processor are constructed explicitly.
                const { AutoModel, AutoProcessor } = transformers
                const [model, processor] = await withTimeout(
                    Promise.all([
                        AutoModel.from_pretrained(engine.id, { config: { model_type: 'custom' }, device })
                            .catch(() => AutoModel.from_pretrained(engine.id, { config: { model_type: 'custom' } })),
                        AutoProcessor.from_pretrained(engine.id, {
                            config: {
                                do_normalize: true,
                                do_pad: false,
                                do_rescale: true,
                                do_resize: true,
                                image_mean: [0.5, 0.5, 0.5],
                                image_std: [1, 1, 1],
                                feature_extractor_type: 'ImageFeatureExtractor',
                                resample: 2,
                                rescale_factor: 0.00392156862745098,
                                size: { width: 1024, height: 1024 },
                            },
                        }),
                    ]),
                    LOAD_TIMEOUT_MS,
                    'Background-removal model load',
                )
                state.segmentReady = true
                return { kind: engine.kind, model, processor, transformers }
            }
            const pipe = await withTimeout(
                transformers.pipeline('image-segmentation', engine.id, { device })
                    .catch(() => transformers.pipeline('image-segmentation', engine.id)),
                LOAD_TIMEOUT_MS,
                'Background-removal model load',
            )
            state.segmentReady = true
            return { kind: engine.kind, pipe }
        } finally {
            state.loading = null
            emitState()
        }
    })()
    segmentPromise.catch(() => { segmentPromise = null })
    return segmentPromise
}

/* ─── Background prefetch ────────────────────────────────────────────────── */

// Map a routing capability → the loader that downloads + caches its model.
// 'ground' and 'subjects' share CLIPSeg (the on-device subjects path is text
// grounding). 'maskPlan' (JS rule parser) and 'inpaint' (the LOCAL mask
// service's LaMa, not in-browser) have no browser model, so they're absent —
// prefetch silently skips any capability without an entry here.
const CAPABILITY_LOADERS = {
    ground: { load: loadGroundModel, pending: () => groundPromise != null, ready: () => state.groundReady },
    subjects: { load: loadGroundModel, pending: () => groundPromise != null, ready: () => state.groundReady },
    depth: { load: loadDepthModel, pending: () => depthPromise != null, ready: () => state.depthReady },
    segment: { load: loadSegmentModel, pending: () => segmentPromise != null, ready: () => state.segmentReady },
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
    const { RawImage } = await import('@huggingface/transformers')
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
    withDeviceFallback('ground', () => groundOnce(el, phrase, dims))

const depthOnce = async (el, { width, height }) => {
    const pipe = await loadDepthModel()
    const input = toInputCanvas(el, width, height)
    const image = await canvasToRawImage(input)
    const { depth } = await withTimeout(pipe(image), INFER_TIMEOUT_MS, 'Depth inference')

    // `depth` is a single-channel RawImage at model resolution, 0..255.
    const mw = depth?.width
    const mh = depth?.height
    if (!mw || !mh || !depth.data || depth.data.length < mw * mh) {
        throw new Error('Depth model returned a malformed map')
    }
    const map = new Float32Array(mw * mh)
    for (let i = 0; i < map.length; i += 1) map[i] = depth.data[i] / 255

    const range = analyzeRange(map)
    const out = mapToCanvas(map, mw, mh, width, height)
    const verdict = validateDepthOutput(
        { width: out.width, height: out.height, ...range },
        { width, height },
    )
    if (!verdict.usable) throw new Error(`Depth output rejected: ${verdict.reason}`)
    return out
}

/**
 * In-browser depth map (white = near) at the image's natural size, with the
 * same timeout/downgrade/validation hardening as grounding.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} el
 * @param {{ width: number, height: number }} naturalDims
 * @returns {Promise<HTMLCanvasElement>}
 */
export const clientDepthMap = (el, dims) =>
    withDeviceFallback('depth', () => depthOnce(el, dims))

const segmentOnce = async (el, { width, height }) => {
    const bundle = await loadSegmentModel()
    const input = toInputCanvas(el, width, height)
    const image = await canvasToRawImage(input)

    let matte
    if (bundle.kind === 'rmbg-manual') {
        const { RawImage } = bundle.transformers
        const { pixel_values } = await bundle.processor(image)
        const { output } = await withTimeout(
            bundle.model({ input: pixel_values }),
            INFER_TIMEOUT_MS,
            'Background-removal inference',
        )
        matte = await RawImage.fromTensor(output[0].mul(255).to('uint8'))
            .resize(image.width, image.height)
    } else {
        const out = await withTimeout(bundle.pipe(image), INFER_TIMEOUT_MS, 'Background-removal inference')
        // image-segmentation output for matting models: [{ label, mask }] —
        // a single entry whose mask is a single-channel soft matte 0..255.
        matte = Array.isArray(out) ? out[0]?.mask : out?.mask
    }

    const mw = matte?.width
    const mh = matte?.height
    if (!mw || !mh || !matte.data || matte.data.length < mw * mh) {
        throw new Error('Background-removal model returned no usable matte')
    }
    const map = new Float32Array(mw * mh)
    for (let i = 0; i < map.length; i += 1) map[i] = matte.data[i] / 255

    const stats = analyzeCoverage(map, mw, mh, 0.5)
    if (!stats.finite) throw new Error('Segmentation produced non-finite values (broken backend)')
    if (stats.coverage <= 0.0005) {
        throw new Error('Background removal found no subject (empty matte)')
    }
    // A near-solid matte means the model failed to separate fore/background
    // (it returned essentially "everything is subject"). Treat it as a failure
    // so the demotion/fallback chain can try another engine or the server,
    // instead of handing back a useless full-frame mask. A genuine subject
    // never fills the whole frame to within 0.1%.
    if (stats.coverage >= 0.999) {
        throw new Error('Background removal could not separate the subject (solid matte)')
    }
    // Soft matte rendered as-is — feathered edges come from the model.
    return mapToCanvas(map, mw, mh, width, height)
}

/** segmentOnce with sticky engine demotion: when the active engine fails AT
 *  INFERENCE (not just load), drop to the next one in SEGMENT_ENGINES and
 *  retry once — every later call goes straight to the survivor. */
const segmentWithModelFallback = async (el, dims) => {
    try {
        return await segmentOnce(el, dims)
    } catch (err) {
        if (segmentEngineIndex >= SEGMENT_ENGINES.length - 1) throw err
        console.warn(`[client-ai] ${SEGMENT_ENGINES[segmentEngineIndex].id} failed (${err?.message}); demoting to ${SEGMENT_ENGINES[segmentEngineIndex + 1].id}`)
        segmentEngineIndex += 1
        segmentPromise = null
        state.segmentReady = false
        emitState()
        return segmentOnce(el, dims)
    }
}

/**
 * In-browser background removal: a soft subject matte (white = subject) at
 * the image's natural size. Hardening: load/inference timeouts, sticky
 * RMBG-1.4 → MODNet engine demotion (see SEGMENT_ENGINES — the survivor list
 * is empirical, pinned by verify:client-ai), output validation.
 *
 * Deliberately NOT wrapped in withDeviceFallback: downgrading the shared
 * device to WASM on a segmentation failure would needlessly demote the
 * grounding/depth engines that run fine on WebGPU.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} el
 * @param {{ width: number, height: number }} naturalDims
 * @returns {Promise<HTMLCanvasElement>}
 */
export const clientSubjectMask = async (el, dims) => {
    const startedAt = Date.now()
    try {
        const out = await segmentWithModelFallback(el, dims)
        recordDiag('segment', startedAt, true)
        return out
    } catch (err) {
        recordDiag('segment', startedAt, false, err)
        throw err
    }
}

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

/**
 * End-to-end self-test of the on-device engine: runs the REAL models on a
 * synthetic image with a known answer and validates every invariant the
 * masking pipeline depends on. Used by the Mask tool's "Test device AI"
 * button and by scripts/verify-client-ai.mjs (headless browser harness) —
 * this is what makes the in-browser path verifiable instead of
 * works-on-my-machine.
 *
 * @param {{ onProgress?: (msg: string) => void }} [opts]
 * @returns {Promise<{ ok: boolean, device: string, totalMs: number,
 *                     checks: Array<{label: string, ok: boolean, detail: string}> }>}
 */
export const runClientAISelfTest = async ({ onProgress } = {}) => {
    const startedAt = Date.now()
    const progress = (msg) => { try { onProgress?.(msg) } catch { /* ignore */ } }
    const { canvas, disc } = buildSelfTestScene()

    progress('Loading CLIPSeg + grounding "the red circle"…')
    let ground = { found: false, score: 0, bbox: null }
    try {
        const g = await clientGroundPhrase(canvas, 'the red circle', { width: disc.w, height: disc.h })
        ground = { found: Boolean(g.canvas), score: g.score, bbox: g.bbox }
    } catch (err) {
        ground = { found: false, score: 0, bbox: null, error: String(err?.message || err) }
    }

    progress('Loading Depth Anything + estimating depth…')
    let depth = null
    try {
        const d = await clientDepthMap(canvas, { width: disc.w, height: disc.h })
        // Re-measure spread from the produced canvas for an end-to-end check.
        const ctx = d.getContext('2d', { willReadFrequently: true })
        const px = ctx.getImageData(0, 0, d.width, d.height).data
        let min = 255
        let max = 0
        for (let i = 0; i < px.length; i += 4) {
            if (px[i] < min) min = px[i]
            if (px[i] > max) max = px[i]
        }
        depth = { width: d.width, height: d.height, spread: (max - min) / 255 }
    } catch (err) {
        depth = null
        progress(`Depth failed: ${err?.message}`)
    }

    progress('Loading RMBG-1.4 + removing the background…')
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

    const report = evaluateSelfTest({ ground, depth, segment }, disc)
    return {
        ...report,
        device: state.device || 'unknown',
        totalMs: Date.now() - startedAt,
        ground,
        depth,
        segment,
    }
}
