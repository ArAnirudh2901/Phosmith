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
 * Trade-offs vs the local service: no SAM 3.1 edge refinement and no YOLO
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
// Click/box select runs on SlimSAM (~40 MB, distilled SAM) — the one
// segmentation model this project ships for prompted selection. The slow image
// encode is cached per image so multi-click refine stays fast.
const SAM_ENGINE = { id: 'Xenova/slimsam-77-uniform', label: 'SlimSAM' }
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

/** Drop every loaded in-browser model now (frees RAM immediately). */
export const releaseClientModels = async () => {
    for (const [name, slot] of Object.entries(MODEL_SLOTS)) {
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

/* ─── Subject cutout (saliency box → SlimSAM) ────────────────────────────────
 * The browser ships ONE model, so the subject matte is a SlimSAM box prompt
 * seeded by a saliency box instead of a second segmentation network. Saliency
 * is frequency-tuned colour distance from the frame's mean with a centre prior
 * — the same idea the collage Composer uses.
 */
const SALIENCY_SIDE = 160
const SUBJECT_MASS = 0.86   // share of saliency mass the seed box must contain

const saliencySeed = (el, width, height) => {
    const k = SALIENCY_SIDE / Math.max(width, height)
    const w = Math.max(16, Math.round(width * k))
    const h = Math.max(16, Math.round(height * k))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Could not allocate a canvas for subject detection')
    ctx.drawImage(el, 0, 0, w, h)
    const px = ctx.getImageData(0, 0, w, h).data
    const n = w * h
    let mr = 0, mg = 0, mb = 0
    for (let i = 0; i < px.length; i += 4) { mr += px[i]; mg += px[i + 1]; mb += px[i + 2] }
    mr /= n; mg /= n; mb /= n
    const sal = new Float32Array(n)
    let total = 0
    for (let p = 0, i = 0; p < n; p += 1, i += 4) {
        const d = Math.abs(px[i] - mr) + Math.abs(px[i + 1] - mg) + Math.abs(px[i + 2] - mb)
        const x = (p % w) / w - 0.5
        const y = Math.floor(p / w) / h - 0.5
        // Centre prior: photographers put the subject near the middle.
        const v = d * (1 - 0.6 * Math.min(1, Math.hypot(x, y) * 1.6))
        sal[p] = v
        total += v
    }
    if (total <= 0) return { box: [0, 0, width, height], seeds: [[width / 2, height / 2]] }
    // Smallest interval per axis holding SUBJECT_MASS of the saliency mass.
    const interval = (marginal, size) => {
        const target = SUBJECT_MASS * marginal.reduce((a, b) => a + b, 0)
        let best = [0, size - 1], bestLen = size + 1, lo = 0, acc = 0
        for (let hi = 0; hi < size; hi += 1) {
            acc += marginal[hi]
            while (acc - marginal[lo] >= target) { acc -= marginal[lo]; lo += 1 }
            if (acc >= target && hi - lo < bestLen) { bestLen = hi - lo; best = [lo, hi] }
        }
        return best
    }
    const cols = new Float32Array(w)
    const rows = new Float32Array(h)
    for (let p = 0; p < n; p += 1) { cols[p % w] += sal[p]; rows[Math.floor(p / w)] += sal[p] }
    const [x0, x1] = interval(Array.from(cols), w)
    const [y0, y1] = interval(Array.from(rows), h)
    const pad = 0.02
    const sx = width / w, sy = height / h
    // Peak saliency INSIDE the box: a box centre can land on foreground clutter
    // (a wall, a railing) while the peak sits on the subject itself.
    let peak = -1, px_ = (x0 + x1) / 2, py_ = (y0 + y1) / 2
    for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
            // 3×3 mean keeps a single bright speckle from winning.
            let acc = 0, cnt = 0
            for (let dy = -1; dy <= 1; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    const qx = x + dx, qy = y + dy
                    if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue
                    acc += sal[qy * w + qx]
                    cnt += 1
                }
            }
            const v = cnt ? acc / cnt : 0
            if (v > peak) { peak = v; px_ = x; py_ = y }
        }
    }
    // Saliency-weighted centroid inside the box: usually the subject's body.
    let mx = 0, my = 0, mass = 0
    for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
            const v = sal[y * w + x]
            mx += x * v; my += y * v; mass += v
        }
    }
    const box = [
        Math.max(0, (x0 - pad * w) * sx),
        Math.max(0, (y0 - pad * h) * sy),
        Math.min(width, (x1 + 1 + pad * w) * sx),
        Math.min(height, (y1 + 1 + pad * h) * sy),
    ]
    const seeds = [
        [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
    ]
    if (mass > 0) seeds.push([(mx / mass + 0.5) * sx, (my / mass + 0.5) * sy])
    seeds.push([(px_ + 0.5) * sx, (py_ + 0.5) * sy])
    return { box, seeds }
}

/** How well a mask fills the saliency box without leaking outside it. */
const scoreSubjectMask = (canvas, box, width, height) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const kx = canvas.width / width, ky = canvas.height / height
    const bx0 = Math.max(0, Math.floor(box[0] * kx)), bx1 = Math.min(canvas.width, Math.ceil(box[2] * kx))
    const by0 = Math.max(0, Math.floor(box[1] * ky)), by1 = Math.min(canvas.height, Math.ceil(box[3] * ky))
    const boxArea = Math.max(1, (bx1 - bx0) * (by1 - by0))
    let inside = 0, outside = 0
    for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
            if (px[(y * canvas.width + x) * 4] <= 127) continue
            if (x >= bx0 && x < bx1 && y >= by0 && y < by1) inside += 1
            else outside += 1
        }
    }
    const frame = canvas.width * canvas.height || 1
    const coverage = (inside + outside) / frame
    // A part of the subject (a knee) fills little of the box; the whole scene leaks out of it.
    let score = inside / boxArea - 1.5 * (outside / boxArea)
    if (coverage < 0.01 || coverage > 0.9) score -= 1
    return { score, coverage }
}

/**
 * In-browser subject cutout: a coverage canvas (white = subject) at the image's
 * natural size, produced by prompting SlimSAM with a saliency box. One model,
 * so nothing else has to load. Throws when the result is empty or fills the
 * frame (no separable subject).
 *
 * @param {HTMLImageElement|HTMLCanvasElement} el
 * @param {{ width: number, height: number }} naturalDims
 * @returns {Promise<HTMLCanvasElement>}
 */
export const clientSubjectMask = async (el, dims) => {
    const startedAt = Date.now()
    try {
        const width = Number(dims?.width) || el?.naturalWidth || el?.width || 0
        const height = Number(dims?.height) || el?.naturalHeight || el?.height || 0
        if (width < 1 || height < 1) throw new Error('Image is not ready for subject detection')
        const { box, seeds } = saliencySeed(el, width, height)
        // Each seed is one cheap decoder pass (the image embedding is cached),
        // so try them all and keep the mask that reads as the whole subject.
        let best = null
        let lastErr = null
        for (const seed of seeds) {
            try {
                const candidate = await withModelUse('sam', () =>
                    withDeviceFallback('sam', () => samBoxOnce(el, box, { width, height }, seed)))
                const verdict = scoreSubjectMask(candidate, box, width, height)
                if (!best || verdict.score > best.verdict.score) best = { canvas: candidate, verdict }
            } catch (err) {
                lastErr = err
            }
        }
        if (!best) throw lastErr || new Error('Subject detection failed')
        if (best.verdict.coverage < 0.004) throw new Error('No subject could be separated from the background')
        if (best.verdict.coverage > 0.985) throw new Error('Subject selection covered the whole frame')
        recordDiag('segment', startedAt, true)
        return best.canvas
    } catch (err) {
        recordDiag('segment', startedAt, false, err)
        throw err
    }
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
    try { embeddings = await model.get_image_embeddings(await processor(rawImage)) } catch { embeddings = null }
    samImage = { el, w: w0, h: h0, rawImage, embeddings, scale, engineId: engine.id }
    return { model, processor, engine, ...samImage }
}

// SAM output → coverage canvas at outW×outH (white = selected); picks the
// highest-IoU candidate. Ported from the mask-studio testbed.
const samMaskToCanvas = (maskTensor, iou, outW, outH) => {
    const dims = maskTensor.dims
    const w = dims[dims.length - 1]
    const h = dims[dims.length - 2]
    const nMasks = dims.length >= 3 ? dims[dims.length - 3] : 1
    const scores = iou && iou.data ? Array.from(iou.data) : []
    let bi = 0
    let best = -Infinity
    for (let i = 0; i < nMasks; i += 1) { const s = scores[i] ?? 0; if (s > best) { best = s; bi = i } }
    const plane = w * h
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

const samClickOnce = async (el, points, labels, dims) => {
    const { model, processor, engine, rawImage, embeddings, scale } = await ensureSamImage(el, dims)
    const input_points = [[points.map(([x, y]) => [Math.round(x * scale), Math.round(y * scale)])]]
    const input_labels = [[labels.map((l) => (l ? 1 : 0))]]
    const inputs = await processor(rawImage, { input_points, input_labels })
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
    if (!outputs) outputs = await withTimeout(model(inputs), INFER_TIMEOUT_MS, `${engine.label} inference`)
    const masks = await processor.post_process_masks(outputs.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes)
    if (!masks?.[0]?.dims) throw new Error(`${engine.label} returned no mask for the point prompt`)
    return samMaskToCanvas(masks[0], outputs.iou_scores, dims.width, dims.height)
}

const samBoxOnce = async (el, box, dims, seedPoint = null) => {
    const { model, processor, engine, rawImage, embeddings, scale } = await ensureSamImage(el, dims)
    const input_boxes = [[[
        Math.round(box[0] * scale), Math.round(box[1] * scale),
        Math.round(box[2] * scale), Math.round(box[3] * scale),
    ]]]
    // SlimSAM's prompt encoder always reads point tensors: a box-only prompt
    // throws (`dims` of undefined), so the box centre rides along as a positive
    // point. The box still constrains the result.
    const seed = seedPoint || [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
    const input_points = [[[[Math.round(seed[0] * scale), Math.round(seed[1] * scale)]]]]
    const input_labels = [[[1]]]
    const inputs = await processor(rawImage, { input_boxes, input_points: input_points[0], input_labels })
    let outputs
    if (embeddings) {
        try {
            outputs = await model({
                ...embeddings,
                input_boxes: inputs.input_boxes,
                input_points: inputs.input_points,
                input_labels: inputs.input_labels,
            })
        } catch { outputs = null }
        if (!outputs?.pred_masks) outputs = null // resolved-but-unusable (see samClickOnce)
    }
    if (!outputs) outputs = await withTimeout(model(inputs), INFER_TIMEOUT_MS, `${engine.label} inference`)
    const masks = await processor.post_process_masks(outputs.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes)
    if (!masks?.[0]?.dims) throw new Error(`${engine.label} returned no mask for the box prompt`)
    return samMaskToCanvas(masks[0], outputs.iou_scores, dims.width, dims.height)
}

/**
 * In-browser SlimSAM click-select. `points` are [[x, y], ...] and `labels`
 * [1|0, ...] in the image's NATURAL pixel coords; returns a coverage canvas at
 * (width, height). Same timeout + WebGPU→WASM hardening as the rest.
 */
export const clientSamClick = (el, points, labels, dims) =>
    withModelUse('sam', () => withDeviceFallback('sam', () => samClickOnce(el, points, labels, dims)))

/** In-browser SlimSAM box-select. `box` is [x0, y0, x1, y1] natural px. */
export const clientSamBox = (el, box, dims) =>
    withModelUse('sam', () => withDeviceFallback('sam', () => samBoxOnce(el, box, dims)))

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

    // Depth is not a browser model any more (service only).
    const depth = undefined

    progress('Cutting out the subject with SlimSAM…')
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

    progress('Click-selecting the disc with SlimSAM…')
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
            engine: SAM_ENGINE.id,
        }
    } catch (err) {
        sam = null
        progress(`SAM click-select failed: ${err?.message}`)
    }

    const report = evaluateSelfTest({ ground, depth, segment, sam }, disc)
    return {
        ...report,
        device: state.device || 'unknown',
        totalMs: Date.now() - startedAt,
        ground,
        depth,
        segment,
        sam,
    }
}
