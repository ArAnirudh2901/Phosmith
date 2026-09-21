/**
 * Megashader Renderer
 * -------------------
 * Owns a *private* WebGL2 context and a program cache. The renderer is
 * deliberately decoupled from Fabric's filter chain — the codebase already
 * disables Fabric's WebGL filtering (`fabricConfig.enableGLFiltering = false`
 * in `canvas.jsx`) because the curves LUT filter had subtle interaction
 * bugs. Routing the megashader through Fabric's GL pipeline would inherit
 * that problem, so we manage our own context here.
 *
 * The contract with `fabric-megashader-filter.js` is:
 *   1. Caller calls `renderMegashader(sourceCanvas, compiledShader, stack)`.
 *   2. Renderer binds the source 2D canvas as a texture, runs the megashader
 *      fragment shader across a fullscreen quad, reads the result back to a
 *      2D canvas, and returns it. The Fabric filter then `drawImage`s this
 *      result onto the chain's output canvas.
 *   3. If WebGL2 is unavailable, the renderer falls back to a CPU path that
 *      draws the source canvas to the output (no-op for Step 1's stub
 *      layers, but the integration stays correct so later steps can plug in
 *      real CPU math without touching the caller).
 *
 * This module also owns the WebGLProgram cache. The key is the
 * `compiledShader.cacheKey` produced by `megashader-compiler.js`.
 *
 * @module megashader/megashader-renderer
 */

import { compileMegashader,
    compilePass,
    MAX_LAYERS_PER_PASS,
} from './megashader-compiler'
import { getKindSchema, normaliseUniformValue } from './glsl-mask-kinds'
import { getMaskTexture, getMaskTextureVersion, stackHasNoVisibleEffect, fillModeToFloat } from './mask-types'
import { isFoldableOp } from './chain-fold'

const MAX_PROGRAM_CACHE = 64

// Step 10.3: lightweight perf metrics. The renderer tracks compile
// count, cache hit/miss, eviction count, and the most recent compile
// wall-clock time. Exposed via `getRenderMetrics()` (read-only
// snapshot) so the dev test panel can display them. Reset by
// `resetRenderMetrics()` (also exposed) — useful when taking a
// "before/after" measurement around a code change.
//
// All counters are module-scoped (not exposed for write) so the
// renderer is the only writer. The metrics are best-effort and have
// no perf cost in the hot path — they're only touched on a cache
// miss (compile) and on every getOrCreateProgram call (hit/miss
// branch).
const renderMetrics = {
    /** Total number of unique programs compiled across the lifetime. */
    compileCount: 0,
    /** Cache hits (program was already compiled and is still in the LRU). */
    cacheHits: 0,
    /** Cache misses (program had to be compiled and linked). */
    cacheMisses: 0,
    /** Number of programs evicted from the LRU (size capped at MAX_PROGRAM_CACHE). */
    evictions: 0,
    /** Wall-clock time (ms) of the most recent compile+link. */
    lastCompileMs: 0,
    /** Cumulative wall-clock time (ms) spent compiling across the lifetime. */
    totalCompileMs: 0,
    /** Number of `renderMegashader` calls that actually drew a frame. */
    drawCount: 0,
    /** Number of `renderMegashader` calls that took the identity short-circuit. */
    identityShortCircuits: 0,
    /** Full-resolution source uploads to the GPU (33 MB each at 4K). */
    sourceUploads: 0,
    /** Uploads avoided because the cached GPU copy was still valid. */
    sourceUploadsSkipped: 0,
    /** Extra GPU passes run for chains longer than one batch. */
    statePasses: 0,
    /** Frames that reused the cached composite below the edited layer. */
    prefixHits: 0,
    /** Frames rendered through the suffix fold (one draw, any chain depth). */
    foldFrames: 0,
    /** Times the state below the edited layer was rebuilt. */
    foldPrefixBuilds: 0,
    /** Times the maps above the edited layer were rebuilt. */
    foldSuffixBuilds: 0,
}

/**
 * Read-only snapshot of the current render metrics. The returned
 * object is a fresh copy, so callers can compare snapshots across
 * code paths without aliasing issues.
 *
 * @returns {typeof renderMetrics}
 */
const getRenderMetrics = () => ({ ...renderMetrics })

/**
 * Reset all render metrics to zero. Mainly for tests and for the
 * "Reset metrics" button in the test panel — useful when taking a
 * measurement around a specific user action (e.g. dragging a slider)
 * to isolate that action's cost.
 */
const resetRenderMetrics = () => {
    renderMetrics.compileCount = 0
    renderMetrics.cacheHits = 0
    renderMetrics.cacheMisses = 0
    renderMetrics.evictions = 0
    renderMetrics.lastCompileMs = 0
    renderMetrics.totalCompileMs = 0
    renderMetrics.drawCount = 0
    renderMetrics.identityShortCircuits = 0
    renderMetrics.sourceUploads = 0
    renderMetrics.sourceUploadsSkipped = 0
    renderMetrics.statePasses = 0
    renderMetrics.prefixHits = 0
    renderMetrics.foldFrames = 0
    renderMetrics.foldPrefixBuilds = 0
    renderMetrics.foldSuffixBuilds = 0
}

/**
 * Minimal fullscreen-quad vertex shader. Compiled once into the quad program
 * (see `getQuadProgram`) so the VAO can be set up against a real, linked
 * program. We also `bindAttribLocation(program, 0, 'aPosition')` before
 * linking on every program (quad + megashader) so `aPosition` is always at
 * location 0 — that lets the same VAO bind to any megashader program.
 */
const QUAD_VERT = `attribute vec2 aPosition;
varying vec2 vUV;
void main() {
    vUV = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

/** Fragment counterpart — outputs solid black, never actually drawn. */
const QUAD_FRAG = `precision mediump float;
void main() {
    gl_FragColor = vec4(0.0);
}
`

let glContext = null
let glCanvas = null

// `getUniformLocation` is a driver-side string lookup, and this shader has
// ~30 uniform names per layer rewritten on every frame. Cache per program;
// the WeakMap drops entries when the program cache evicts them.
const uniformLocationCache = new WeakMap()
const uloc = (gl, program, name) => {
    let names = uniformLocationCache.get(program)
    if (!names) {
        names = new Map()
        uniformLocationCache.set(program, names)
    }
    if (names.has(name)) return names.get(name)
    const location = gl.getUniformLocation(program, name)
    names.set(name, location)
    return location
}

// Source pixels re-uploaded per frame cost 33 MB at 4K. Callers that know
// their canvas is unchanged (a preview session's downscaled source, a
// benchmark) pass `sourceVersion`; the upload is then skipped while that
// version holds. Without a version the upload still happens every frame, so
// the default stays correct for callers that redraw into the same canvas.
const sourceTextureCache = new WeakMap()
const liveSourceTextures = new Set()

/** Drop the cached GPU copy of `canvas` (call after redrawing into it). */
export const invalidateSourceTexture = (canvas) => {
    const entry = canvas && sourceTextureCache.get(canvas)
    if (!entry) return
    entry.version = undefined
}

// One reusable output canvas for callers that copy the result immediately
// (`reuseOutput`), instead of allocating a 4K canvas per frame.
let reusableOutput = null

/** The megashader draws a fullscreen quad; the transform never changes. */
const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

let programCache = /** @type {Map<string, WebGLProgram>} */ (new Map())
// Persistent GL texture cache for mask/LUT uploads (Cluster A change 1).
// Keyed by the mask-texture cache key; each entry records the GL texture and
// the data VERSION it was uploaded from (see getMaskTextureVersion). Reused
// across frames; re-uploaded only on a version bump. LRU-capped well above
// the <=16 textures any single frame can bind, so eviction never removes a
// texture that was bound earlier in the current frame.
let maskGlTextureCache = /** @type {Map<string, { tex: WebGLTexture, version: number }>} */ (new Map())
const MAX_MASK_GL_TEXTURES = 64
// Full-res masks are ~100 MB each on a 24 MP photo; the count cap alone could
// pin gigabytes of VRAM. Byte budget evicts older entries but never the 16 most
// recent (a single frame binds at most 16).
const MAX_MASK_GL_BYTES = 512 * 1024 * 1024
const MIN_KEPT_MASK_GL_TEXTURES = 16
let maskGlTextureBytes = 0
let quadProgram = /** @type {WebGLProgram | null} */ (null)
let quadVbo = /** @type {WebGLBuffer | null} */ (null)
let quadVao = /** @type {WebGLVertexArrayObject | null} */ (null)

const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined'

/**
 * Lazily create (and cache) the private WebGL2 context. Returns `null` if
 * the browser doesn't support WebGL2 — the renderer then runs in CPU mode.
 *
 * @returns {WebGL2RenderingContext | null}
 */
const ensureGl = () => {
    if (!isBrowser()) return null
    if (glContext) return glContext
    if (typeof document.createElement !== 'function') return null

    glCanvas = document.createElement('canvas')
    glCanvas.width = 1
    glCanvas.height = 1
    const ctx = /** @type {any} */ (glCanvas.getContext('webgl2', {
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
    })) || /** @type {any} */ (glCanvas.getContext('webgl'))
    if (!ctx) return null

    glContext = ctx
    return glContext
}

/**
 * Compile + link a GLSL program and cache it by `cacheKey`. Programs are
 * stored module-scope so the same shader source reuses the same program
 * across calls. LRU eviction keeps memory bounded.
 *
 * Step 10.3: updates `renderMetrics` on every call. A hit increments
 * `cacheHits` and returns early. A miss runs the compile+link and
 * increments `cacheMisses` + `compileCount` + `lastCompileMs` +
 * `totalCompileMs`. An eviction (LRU overflow) increments `evictions`.
 *
 * @param {import('./mask-types').CompiledShader} compiled
 * @returns {WebGLProgram | null}
 */
// Insert a linked program, evicting the oldest past MAX_PROGRAM_CACHE (Map
// iteration order is insertion order, so the first key is the oldest).
const cacheProgram = (gl, key, program) => {
    if (programCache.size >= MAX_PROGRAM_CACHE) {
        const oldest = programCache.keys().next().value
        if (oldest) {
            const oldProgram = programCache.get(oldest)
            if (oldProgram) gl.deleteProgram(oldProgram)
            programCache.delete(oldest)
            renderMetrics.evictions += 1
        }
    }
    programCache.set(key, program)
    renderMetrics.compileCount += 1
}

// A new chain structure otherwise links synchronously inside the render
// (~300 ms on the main thread). With KHR_parallel_shader_compile the driver
// links in the background: poll completion per frame, then cache the program
// so the render that follows is a cache hit. Resolves immediately when there
// is nothing to link or the extension is missing (the render path then links
// as before and reports any link error).
const pendingPrograms = new Map()
// True when rendering `stack` will not trigger a synchronous shader link.
export const isMegashaderProgramReady = (stack) => {
    try {
        const compiled = compileMegashader(stack)
        return !compiled || compiled.passthrough || programCache.has(compiled.cacheKey)
    } catch {
        return true
    }
}

export const prewarmMegashaderProgram = (stack) => {
    const gl = ensureGl()
    if (!gl || typeof requestAnimationFrame !== 'function') return Promise.resolve(false)
    let compiled
    try { compiled = compileMegashader(stack) } catch { return Promise.resolve(false) }
    if (!compiled || compiled.passthrough || programCache.has(compiled.cacheKey)) return Promise.resolve(true)
    const ext = gl.getExtension('KHR_parallel_shader_compile')
    if (!ext) return Promise.resolve(false)
    const pending = pendingPrograms.get(compiled.cacheKey)
    if (pending) return pending

    const stage = (type, src) => {
        const sh = gl.createShader(type)
        gl.shaderSource(sh, src)
        gl.compileShader(sh)
        return sh
    }
    const vert = stage(gl.VERTEX_SHADER, compiled.vert)
    const frag = stage(gl.FRAGMENT_SHADER, compiled.frag)
    const program = gl.createProgram()
    if (!vert || !frag || !program) return Promise.resolve(false)
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.bindAttribLocation(program, 0, 'aPosition')
    gl.linkProgram(program)

    const promise = new Promise((resolve) => {
        const poll = () => {
            if (!gl.getProgramParameter(program, ext.COMPLETION_STATUS_KHR)) {
                requestAnimationFrame(poll)
                return
            }
            pendingPrograms.delete(compiled.cacheKey)
            gl.deleteShader(vert)
            gl.deleteShader(frag)
            if (programCache.has(compiled.cacheKey) || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
                gl.deleteProgram(program)
            } else {
                cacheProgram(gl, compiled.cacheKey, program)
            }
            resolve(programCache.has(compiled.cacheKey))
        }
        requestAnimationFrame(poll)
    })
    pendingPrograms.set(compiled.cacheKey, promise)
    return promise
}

const getOrCreateProgram = (compiled) => {
    const gl = ensureGl()
    if (!gl) return null

    if (programCache.has(compiled.cacheKey)) {
        renderMetrics.cacheHits += 1
        return programCache.get(compiled.cacheKey) ?? null
    }
    renderMetrics.cacheMisses += 1
    const t0 = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now()

    const vert = compileShader(gl, gl.VERTEX_SHADER, compiled.vert)
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, compiled.frag)
    if (!vert || !frag) return null

    const program = gl.createProgram()
    if (!program) return null
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    // Pin `aPosition` to attribute location 0 so the quad VAO (set up in
    // `ensureQuadBuffers`) binds to the same slot on every program.
    gl.bindAttribLocation(program, 0, 'aPosition')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        // Surface the link error to the console (one-line, no exception
        // throw — the renderer is best-effort and falls back to CPU).
        const info = gl.getProgramInfoLog(program) || '(no info log)'
        console.warn('[megashader] program link failed:', info)
        gl.deleteShader(vert)
        gl.deleteShader(frag)
        gl.deleteProgram(program)
        return null
    }
    gl.deleteShader(vert)
    gl.deleteShader(frag)

    cacheProgram(gl, compiled.cacheKey, program)
    const t1 = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now()
    const dt = t1 - t0
    renderMetrics.lastCompileMs = dt
    renderMetrics.totalCompileMs += dt
    return program
}

/**
 * Compile a single GLSL shader stage.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {GLenum} type
 * @param {string} source
 * @returns {WebGLShader | null}
 */
const compileShader = (gl, type, source) => {
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader) || '(no info log)'
        console.warn(`[megashader] shader compile failed (${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'}):`, info)
        gl.deleteShader(shader)
        return null
    }
    return shader
}

/**
 * Check whether WebGL2 is available. Public so the Fabric filter can short-
 * circuit on the CPU path without allocating anything.
 *
 * @returns {boolean}
 */
export const hasWebGL2 = () => {
    if (!isBrowser()) return false
    return Boolean(ensureGl())
}

/**
 * Compile + link a one-off program whose only job is to give the VAO a
 * real, linked program to query attribute locations against. Cached
 * module-scope so we pay the compile cost exactly once per renderer
 * lifetime.
 *
 * @param {WebGL2RenderingContext} gl
 * @returns {WebGLProgram | null}
 */
const getQuadProgram = (gl) => {
    if (quadProgram) return quadProgram
    const program = gl.createProgram()
    if (!program) return null
    const vert = compileShader(gl, gl.VERTEX_SHADER, QUAD_VERT)
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, QUAD_FRAG)
    if (!vert || !frag) {
        if (vert) gl.deleteShader(vert)
        if (frag) gl.deleteShader(frag)
        gl.deleteProgram(program)
        return null
    }
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.bindAttribLocation(program, 0, 'aPosition')
    gl.linkProgram(program)
    gl.deleteShader(vert)
    gl.deleteShader(frag)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program) || '(no info log)'
        console.warn('[megashader] quad program link failed:', info)
        gl.deleteProgram(program)
        return null
    }
    quadProgram = program
    return quadProgram
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @param {object} layer
 * @param {number} slotIndex
 * @param {{ kindUnits?: Map<number, number> }} textureBindings
 */
const writeKindSamplers = (gl, program, layer, slotIndex, textureBindings) => {
    let schema
    try {
        schema = getKindSchema(layer.kind)
    } catch {
        return
    }
    const samplers = schema.samplers
    if (!Array.isArray(samplers) || samplers.length === 0) return
    const unit = textureBindings.kindUnits?.get(slotIndex)
    for (const sampler of samplers) {
        const glslName = sampler.glsl.replace('<S>', String(slotIndex))
        const loc = uloc(gl, program, glslName)
        if (!loc) continue
        if (unit !== undefined) gl.uniform1i(loc, unit)
    }
}

/**
 * Bind the per-layer tone-curve LUT sampler to its texture unit and flip
 * `curveOn` on. When the layer has no curve LUT bound (the common case), force
 * `curveOn` to 0 so the GLSL skips the four LUT lookups and the early-out fires.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @param {object} layer
 * @param {number} slotIndex
 * @param {{ curveUnits?: Map<number, number> }} textureBindings
 */
const writeCurveUniforms = (gl, program, layer, slotIndex, textureBindings) => {
    const onLoc = uloc(gl, program, `uLayer_${slotIndex}_curveOn`)
    const unit = textureBindings?.curveUnits?.get(slotIndex)
    if (unit === undefined) {
        if (onLoc) gl.uniform1f(onLoc, 0.0)
        return
    }
    const sLoc = uloc(gl, program, `uLayer_${slotIndex}_curveLut`)
    if (sLoc) gl.uniform1i(sLoc, unit)
    if (onLoc) gl.uniform1f(onLoc, 1.0)
}

/**
 * Write the per-kind UNIFORM fields (floats / vec2s) for one layer. Reads
 * the layer object's field name (matched against the schema's `name`),
 * normalises into the canonical shape the GLSL uniform writer expects
 * (via `normaliseUniformValue`), and pushes it to the GPU.
 *
 * Skips sampler fields — those are owned by `writeKindSamplers`.
 *
 * Step 8: adjustment fields (exposure/contrast/saturation/brightness)
 * are written separately by `writeLayerAdjustUniforms` because they're
 * not part of the per-kind schema.
 *
 * Bug history: pre-Step 8 this function only accepted `Array.isArray`
 * for vec2/vec3 values. The kind factories store those fields as
 * `{x, y}` objects (e.g. `linear.p1`, `radial.center`), so the
 * `Array.isArray` check failed and the value silently fell back to
 * the schema's `[0, 0]` default — every linear/radial mask rendered
 * at the origin with a zero radius regardless of the user's drag.
 * Step 8 routed vec2/vec3 through `normaliseUniformValue`, which
 * accepts both array AND `{x, y}` shapes and clamps each component
 * individually.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @param {object} layer
 * @param {number} slotIndex
 */
const writeKindUniforms = (gl, program, layer, slotIndex) => {
    let schema
    try {
        schema = getKindSchema(layer.kind)
    } catch {
        return
    }
    const uniforms = schema.uniforms
    if (!Array.isArray(uniforms) || uniforms.length === 0) return
    for (const field of uniforms) {
        const glslName = field.glsl.replace('<S>', String(slotIndex))
        const loc = uloc(gl, program, glslName)
        if (!loc) continue
        // Bug #4: the color factory stores the picked colour nested as
        // `target: { h, s, b }`, but COLOR_SCHEMA declares flat
        // `targetH/targetS/targetB`. Without this remap, layer.targetH is
        // undefined → the schema default (H=0/red) is used → every colour
        // mask matched pure red regardless of the eyedropper pick.
        let raw = layer[field.name]
        if (layer.kind === 'color' && raw === undefined && layer.target && typeof layer.target === 'object') {
            if (field.name === 'targetH') raw = layer.target.h
            else if (field.name === 'targetS') raw = layer.target.s
            else if (field.name === 'targetB') raw = layer.target.b
        }
        const value = normaliseUniformValue(raw, field)
        if (field.type === 'float' && typeof value === 'number') {
            gl.uniform1f(loc, value)
        } else if (field.type === 'vec2' && Array.isArray(value) && value.length === 2) {
            gl.uniform2f(loc, value[0], value[1])
        } else if (field.type === 'vec3' && Array.isArray(value) && value.length === 3) {
            gl.uniform3f(loc, value[0], value[1], value[2])
        }
    }
}

/**
 * Write the universal COMMON uniforms for one layer: opacity (0..1),
 * inverted (0 or 1), visible (0 or 1). These are declared by
 * `buildLayerFunction` in glsl-fragments.js for every layer regardless
 * of kind.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @param {object} layer
 * @param {number} slotIndex
 */
const writeLayerCommonUniforms = (gl, program, layer, slotIndex) => {
    const prefix = `uLayer_${slotIndex}`
    const opacityLoc = uloc(gl, program, `${prefix}_opacity`)
    if (opacityLoc) {
        const op = (typeof layer.opacity === 'number' && Number.isFinite(layer.opacity))
            ? Math.max(0, Math.min(1, layer.opacity))
            : 1
        gl.uniform1f(opacityLoc, op)
    }
    const invLoc = uloc(gl, program, `${prefix}_inverted`)
    if (invLoc) gl.uniform1f(invLoc, layer.inverted === true ? 1.0 : 0.0)
    const visLoc = uloc(gl, program, `${prefix}_visible`)
    if (visLoc) gl.uniform1f(visLoc, layer.visible === false ? 0.0 : 1.0)
}

/**
 * Step 8 — Write the per-layer image-adjustment uniforms: exposure
 * (EV stops, -3..+3), contrast (-100..+100), saturation (-100..+100),
 * brightness (-100..+100). All default to 0 so a freshly-created
 * layer's `applyLayerAdjust_<slot>(rgb)` early-outs to identity.
 *
 * Why the renderer writes 0 for missing fields rather than relying on
 * the GLSL function: every layer in the chain has its own function, so
 * every slot needs a uniform location set — leaving it unbound would
 * produce undefined behaviour on first draw.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @param {object} layer
 * @param {number} slotIndex
 */
const writeLayerAdjustUniforms = (gl, program, layer, slotIndex) => {
    const prefix = `uLayer_${slotIndex}_adjust_`
    const set = (name, raw, lo, hi) => {
        const loc = uloc(gl, program, `${prefix}${name}`)
        if (!loc) return
        const value = (typeof raw === 'number' && Number.isFinite(raw))
            ? Math.max(lo, Math.min(hi, raw))
            : 0
        gl.uniform1f(loc, value)
    }
    set('exposure',    layer.exposure,    -3,   3)
    set('contrast',    layer.contrast,    -100, 100)
    set('saturation',  layer.saturation,  -100, 100)
    set('vibrance',    layer.vibrance,    -100, 100)
    set('brightness',  layer.brightness,  -100, 100)
    // Pro-parity tonal + white-balance adjustments (all default to 0).
    set('highlights',  layer.highlights,  -100, 100)
    set('shadows',     layer.shadows,     -100, 100)
    set('whites',      layer.whites,      -100, 100)
    set('blacks',      layer.blacks,      -100, 100)
    set('temperature', layer.temperature, -100, 100)
    set('tint',        layer.tint,        -100, 100)
    // Detail — local-contrast ops (sample the source neighbourhood in GLSL).
    set('texture',     layer.texture,     -100, 100)
    set('dehaze',      layer.dehaze,      -100, 100)

    // Gamma — per-channel power (identity 1.0); different default from the 0.0
    // fields above, so written directly rather than via `set`.
    const gammaLoc = uloc(gl, program, `${prefix}gamma`)
    if (gammaLoc) {
        const g = Number.isFinite(layer.gamma) ? Math.max(0.2, Math.min(2.2, layer.gamma)) : 1.0
        gl.uniform1f(gammaLoc, g)
    }
    // 3-way colour wheels — vec3 offsets (-1..1) on the non-adjust prefix.
    const setWheel = (name, raw) => {
        const loc = uloc(gl, program, `uLayer_${slotIndex}_${name}`)
        if (!loc) return
        const a = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw.x, raw.y, raw.z] : [])
        const cl = (v) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0)
        gl.uniform3f(loc, cl(a[0]), cl(a[1]), cl(a[2]))
    }
    setWheel('wheel_shadows', layer.wheelShadows)
    setWheel('wheel_midtones', layer.wheelMidtones)
    setWheel('wheel_highlights', layer.wheelHighlights)
}

/**
 * Root-cause #1 — Write the per-layer fill-output uniforms: fillMode
 * (0 adjust / 1 fill / 2 erase), fillColor (vec3 0..1), fillStrength
 * (0..1). Declared by `buildLayerAdjustFunction` for every layer. A layer
 * that doesn't set these defaults to adjust mode (0) so behaviour is
 * unchanged from the pre-fillMode era.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @param {object} layer
 * @param {number} slotIndex
 */
const writeLayerFillUniforms = (gl, program, layer, slotIndex) => {
    const prefix = `uLayer_${slotIndex}_`
    const modeLoc = uloc(gl, program, `${prefix}fillMode`)
    if (modeLoc) gl.uniform1f(modeLoc, fillModeToFloat(layer.fillMode))
    const colorLoc = uloc(gl, program, `${prefix}fillColor`)
    if (colorLoc) {
        const c = layer.fillColor || { r: 1, g: 0, b: 0.6 }
        const ch = (v, fb) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fb)
        gl.uniform3f(colorLoc, ch(c.r, 1), ch(c.g, 0), ch(c.b, 0.6))
    }
    const strengthLoc = uloc(gl, program, `${prefix}fillStrength`)
    if (strengthLoc) {
        const s = (typeof layer.fillStrength === 'number' && Number.isFinite(layer.fillStrength))
            ? Math.max(0, Math.min(1, layer.fillStrength))
            : 0.5
        gl.uniform1f(strengthLoc, s)
    }
}

/**
 * Write ALL uniforms for the megashader program in one go. Called by
 * `renderMegashader` after the source texture and kind textures are
 * bound. The function:
 *   1. Writes the chain-wide uniforms (`uImageSize`, `uMaskAlpha`).
 *   2. For each layer, writes the common (opacity/inverted/visible),
 *      kind-specific (luminance thresholds, radial radius, etc.), and
 *      Step 8 adjustment (exposure/contrast/saturation/brightness)
 *      uniforms.
 *   3. Binds each layer's samplers to its allocated texture unit (via
 *      `writeKindSamplers`).
 *
 * Pre-Step 8: this function was MISSING from the file — line 414 of
 * `renderMegashader` called it but it didn't exist, so any actual GL
 * draw would have thrown `writeUniforms is not defined`. The
 * pre-existing latent bug was only masked by the fact that nothing
 * actually exercised the GL path in CI. Step 8 adds the function as
 * part of the per-layer-adjustment work.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @param {import('./mask-types').MaskStack} stack
 * @param {number} globalMaskAlpha   0..1 — UI fader on top of the chain.
 * @param {{ width: number, height: number }} imageSize
 * @param {{ kindUnits: Map<number, number> }} textureBindings
 */
const writeUniforms = (gl, program, stack, renderOpts, imageSize, textureBindings) => {
    const { globalMaskAlpha, globalInvert, maskOverlay, maskView, overlayColor } = renderOpts || {}
    // Chain-wide uniforms.
    const sizeLoc = uloc(gl, program, 'uImageSize')
    if (sizeLoc) gl.uniform2f(sizeLoc, imageSize.width, imageSize.height)
    const maskAlphaLoc = uloc(gl, program, 'uMaskAlpha')
    if (maskAlphaLoc) {
        const a = (typeof globalMaskAlpha === 'number' && Number.isFinite(globalMaskAlpha))
            ? Math.max(0, Math.min(1, globalMaskAlpha))
            : 1
        gl.uniform1f(maskAlphaLoc, a)
    }
    const invertLoc = uloc(gl, program, 'uGlobalInvert')
    if (invertLoc) gl.uniform1f(invertLoc, globalInvert ? 1.0 : 0.0)
    const overlayLoc = uloc(gl, program, 'uMaskOverlay')
    if (overlayLoc) gl.uniform1f(overlayLoc, maskOverlay ? 1.0 : 0.0)
    const viewLoc = uloc(gl, program, 'uMaskView')
    if (viewLoc) gl.uniform1f(viewLoc, maskView === 'bw' ? 1.0 : 0.0)
    const overlayColLoc = uloc(gl, program, 'uMaskOverlayColor')
    if (overlayColLoc) {
        const c = overlayColor || { r: 1, g: 0, b: 0.25 }
        const ch = (v, fb) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fb)
        gl.uniform3f(overlayColLoc, ch(c.r, 1), ch(c.g, 0), ch(c.b, 0.25))
    }

    // Per-layer uniforms. Skip layers that aren't in the chain (the
    // shader always declares all 8 slots' adjust functions, but we only
    // need to set the active ones — the rest will read 0 from uninitialised
    // uniforms, which is fine because the chain never references them).
    if (!stack || !Array.isArray(stack.chain)) return
    for (let i = 0; i < stack.chain.length; i += 1) {
        const layer = stack.chain[i].layer
        if (!layer) continue
        writeLayerCommonUniforms(gl, program, layer, i)
        writeKindUniforms(gl, program, layer, i)
        writeLayerAdjustUniforms(gl, program, layer, i)
        writeLayerFillUniforms(gl, program, layer, i)
        writeKindSamplers(gl, program, layer, i, textureBindings)
        writeCurveUniforms(gl, program, layer, i, textureBindings)
    }
}

/**
 * Bind a cached GL texture for a mask/LUT `key` to the currently-active
 * texture unit, (re)uploading ONLY when the key's data VERSION changed since
 * the last upload. `setMaskTexture` bumps that version on every write (brush
 * stroke, boundary grow, AI mask, curve LUT, undo/redo restore), so a version
 * mismatch is the exact, complete signal that the pixels changed — a match
 * proves they are byte-identical and the cached texture is still correct.
 * A handle is only reused if it belongs to this live context. gl.isTexture was
 * used for that, but it is a synchronous GPU round trip on every bind and
 * stalled behind queued uploads (~190 ms per commit); context loss invalidates
 * every handle at once, so one isContextLost check is equivalent.
 * Returns true if a texture is bound to the active unit.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {string} key
 * @param {*} data            Cached texture source (already resolved by caller).
 * @param {boolean} flipY     UNPACK_FLIP_Y_WEBGL for the upload.
 * @param {GLenum} filter     gl.LINEAR or gl.NEAREST (min+mag).
 * @returns {boolean}
 */
const bindCachedMaskTexture = (gl, key, data, flipY, filter) => {
    const version = getMaskTextureVersion(key)
    const entry = maskGlTextureCache.get(key)
    const live = !gl.isContextLost()
    if (entry && entry.version === version && entry.gl === gl && live) {
        // Reuse: pixels unchanged (version match) and the GL texture is valid.
        // Bind only — no re-upload. Refresh LRU recency (move to tail) so a
        // texture used this frame is never the eviction target.
        gl.bindTexture(gl.TEXTURE_2D, entry.tex)
        maskGlTextureCache.delete(key)
        maskGlTextureCache.set(key, entry)
        return true
    }
    // Miss or stale version → (re)upload. Delete the stale GL texture first.
    if (entry && entry.tex && entry.gl === gl && live) gl.deleteTexture(entry.tex)
    if (entry) { maskGlTextureBytes -= entry.bytes || 0; maskGlTextureCache.delete(key) }
    const tex = gl.createTexture()
    if (!tex) { maskGlTextureCache.delete(key); return false }
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, /** @type {any} */ (data))
    } catch {
        // texImage2D can throw on malformed data (e.g. ImageBitmap without the
        // right colour space). Drop the texture; caller binds the null texture.
        gl.deleteTexture(tex)
        maskGlTextureCache.delete(key)
        return false
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const bytes = Math.max(0, (data?.width || 0) * (data?.height || 0) * 4)
    maskGlTextureCache.set(key, { tex, version, gl, bytes })
    maskGlTextureBytes += bytes
    // Evict least-recently-used orphans beyond the cap. Never evict `key`
    // (just uploaded) or any key already bound this frame — with the cap
    // (64) far above the <=16 textures a frame can bind, the eviction front
    // only holds stale keys from earlier frames.
    const overBudget = () => maskGlTextureCache.size > MAX_MASK_GL_TEXTURES
        || (maskGlTextureBytes > MAX_MASK_GL_BYTES && maskGlTextureCache.size > MIN_KEPT_MASK_GL_TEXTURES)
    if (overBudget()) {
        for (const oldKey of [...maskGlTextureCache.keys()]) {
            if (!overBudget()) break
            if (oldKey === key) continue
            const old = maskGlTextureCache.get(oldKey)
            if (old && old.tex && old.gl === gl && live) gl.deleteTexture(old.tex)
            maskGlTextureBytes -= old?.bytes || 0
            maskGlTextureCache.delete(oldKey)
        }
    }
    return true
}

/**
 * Upload per-layer image textures (semantic masks, depth maps, future
 * kinds) and bind them to unique texture units. Returns a
 * `textureBindings` object the `writeUniforms` consumer uses to wire
 * each layer's sampler to its unit, plus an `ownedTextures` list of
 * `WebGLTexture` handles that MUST be deleted after the draw (per-frame
 * allocation — cheap, and the cache lives in mask-types.js keyed by
 * `maskTextureKey` / `depthMapKey` / `brushTextureKey`).
 *
 * Texture units:
 *   - 0 is reserved for the source image (bound by the caller)
 *   - 1..N are assigned in chain order across all texture-using kinds
 *     (semantic, smartBrush, depth) — the unit pool is shared because
 *     each layer only needs one texture, regardless of its kind
 *   - Layers whose texture is missing (cache miss) are skipped; the
 *     GLSL sampler for that layer is left at unit 0, so the shader
 *     samples the source image. That's a visible bug, but better than
 *     random colour. Callers should ensure the cache is populated
 *     before adding the layer.
 *
 * WebGL2 guarantees at least 16 texture units. With MAX_LAYERS = 8
 * and a one-texture-per-layer policy, we use at most 9 units in
 * practice. If a future kind needs more, the unit allocator will need
 * to wrap or share.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {import('./mask-types').MaskStack} stack
 * @returns {{ kindUnits: Map<number, number>, ownedTextures: WebGLTexture[] }}
 */
/* ─── Multi-pass state targets ──────────────────────────────────────────────
 * A chain longer than MAX_LAYERS_PER_PASS is split into batches. Each batch
 * writes its running (colour, alpha) into a texture that the next batch reads,
 * so the layer count stops being bounded by texture units or uniform slots.
 * Erase coverage is a max over erase layers — order-independent — so it rides
 * in its own texture accumulated with MAX blending.
 */
let stateTargets = null   // { fbo, texA, texB, texE, width, height }

/* Prefix cache. While one layer is being edited, every batch BELOW it renders
 * the same pixels frame after frame. Their combined state is kept in its own
 * texture, so a drag re-runs only the batch holding the edited layer and the
 * batches above it — the cost stops growing with chain length. Only used when
 * the caller passes `sourceVersion` (a promise that the pixels are unchanged).
 */
let prefixCache = null    // { sourceVersion, width, height, boundary, tex, sigs }
let lastBatchSigs = null

/** Everything about a layer that changes its pixels, including texture version. */
const layerSignature = (entry) => {
    const layer = entry.layer || {}
    let version = ''
    for (const key of ['maskTextureKey', 'brushTextureKey', 'depthMapKey', 'curveLutKey']) {
        const id = layer[key]
        if (typeof id === 'string' && id) {
            const data = getMaskTexture(id)
            version += `|${key}:${id}:${data && data.version !== undefined ? data.version : 'x'}`
        }
    }
    return `${entry.op}|${JSON.stringify(layer)}${version}`
}

const batchSignature = (entries) => entries.map(layerSignature).join('~')

/* Suffix fold. The prefix cache makes editing the TOP of a chain cheap; this
 * makes editing any layer cheap. Everything above the edited layer collapses
 * into three per-pixel maps (colour affine, alpha clamped-affine, erase max —
 * see chain-fold.js), rebuilt only when those layers change. A frame is then a
 * single draw: prefix state → edited layer → maps → pixels.
 *
 * Only for interactive-sized renders: the maps cost ~32 bytes/pixel.
 */
/** Fold budget. Three full-size textures live for as long as the user keeps
 *  dragging one layer — an RGBA8 prefix state, an RGBA8 colour map and an
 *  RGBA16F alpha map (the alpha map's offset goes negative, so it cannot be
 *  8-bit) — plus one scratch texture during a rebuild, freed straight after.
 *  At the cap (4K) that is ~130 MB resident. An allocation that fails takes
 *  the fold out of service for the session rather than degrading silently. */
const FOLD_MAX_PIXELS = 8.7e6
let foldCache = null      // { sourceVersion, width, height, hot, prefixSig, suffixSig, ... }
let lastLayerSigs = null
let floatTargetSupport = null
let foldDisabled = false

const supportsFloatTargets = (gl) => {
    if (floatTargetSupport === null) {
        floatTargetSupport = Boolean(gl.getExtension('EXT_color_buffer_float'))
    }
    return floatTargetSupport
}

const makeMapTexture = (gl, w, h, float) => {
    const tex = gl.createTexture()
    if (!tex) return null
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
}

const disposeFoldCache = (gl) => {
    if (!foldCache || !gl) { foldCache = null; return }
    for (const key of ['prefixTex', 'colorTex', 'alphaTex']) {
        const tex = foldCache[key]
        if (tex && gl.isTexture(tex)) gl.deleteTexture(tex)
    }
    foldCache = null
}

/** Index of the single layer that changed since last frame, or -1. */
const findHotLayer = (sigs) => {
    if (!lastLayerSigs || lastLayerSigs.length !== sigs.length) return -1
    let hot = -1
    for (let i = 0; i < sigs.length; i += 1) {
        if (sigs[i] === lastLayerSigs[i]) continue
        if (hot >= 0) return -1     // more than one layer moved: no fold
        hot = i
    }
    return hot
}

let cachedMaxUnits = 0
/** WebGL2 guarantees 16 fragment texture units; most GPUs expose more. */
const maxTextureUnits = (gl) => {
    if (!cachedMaxUnits) cachedMaxUnits = Math.max(8, gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) || 16)
    return cachedMaxUnits
}

const deleteStateTargets = (gl) => {
    disposeFoldCache(gl)
    if (prefixCache && gl && prefixCache.tex && gl.isTexture(prefixCache.tex)) gl.deleteTexture(prefixCache.tex)
    prefixCache = null
    lastBatchSigs = null
    if (!stateTargets || !gl) return
    for (const tex of [stateTargets.texA, stateTargets.texB, stateTargets.texE]) {
        if (tex && gl.isTexture(tex)) gl.deleteTexture(tex)
    }
    if (stateTargets.fbo && gl.isFramebuffer(stateTargets.fbo)) gl.deleteFramebuffer(stateTargets.fbo)
    stateTargets = null
}

const makeStateTexture = (gl, w, h) => {
    const tex = gl.createTexture()
    if (!tex) return null
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    // Sampled texel-for-texel, so NEAREST avoids needless filtering work.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
}

const ensureStateTargets = (gl, w, h) => {
    if (stateTargets && stateTargets.width === w && stateTargets.height === h) return stateTargets
    deleteStateTargets(gl)
    // Create on a scratch unit: binding here on unit 0 would evict the source
    // image the passes are about to sample (first-render-only corruption).
    gl.activeTexture(gl.TEXTURE0 + maxTextureUnits(gl) - 1)
    const fbo = gl.createFramebuffer()
    const texA = makeStateTexture(gl, w, h)
    const texB = makeStateTexture(gl, w, h)
    const texE = makeStateTexture(gl, w, h)
    if (!fbo || !texA || !texB || !texE) {
        deleteStateTargets(gl)
        return null
    }
    stateTargets = { fbo, texA, texB, texE, width: w, height: h }
    return stateTargets
}

/** Texture units a single layer needs: its kind mask, plus its curve LUT. */
const layerUnitCost = (layer) => {
    const kindNeedsTexture = layer
        && ['semantic', 'smartBrush', 'depth', 'lasso', 'brush', 'path'].includes(layer.kind)
    return (kindNeedsTexture ? 1 : 0) + (layer && layer.curveLutKey ? 1 : 0)
}

/**
 * Split a chain into batches that each fit the GPU's texture-unit budget.
 * Units 0–2 are reserved for the source, the incoming state and the erase map;
 * the fold path reserves two more for the suffix maps, hence `reserved`.
 *
 * @returns {Array<Array<{layer: object, op: string}>>}
 */
const planPasses = (gl, chain, limit = MAX_LAYERS_PER_PASS, reserved = 3) => {
    const budget = Math.max(2, maxTextureUnits(gl) - reserved)
    const batches = []
    let current = []
    let used = 0
    for (const entry of chain) {
        const cost = layerUnitCost(entry.layer)
        const wouldExceed = current.length >= limit || used + cost > budget
        if (current.length && wouldExceed) {
            batches.push(current)
            current = []
            used = 0
        }
        current.push(entry)
        used += cost
    }
    if (current.length) batches.push(current)
    return batches.length ? batches : [[]]
}

const bindKindTextures = (gl, stack, firstUnit = 1) => {
    const ownedTextures = []
    const kindUnits = new Map()
    // Per-layer tone-curve LUT units (orthogonal to the kind mask — ANY kind can
    // carry a curve). Keyed slot → texture unit, filled after the kind loop.
    const curveUnits = new Map()
    let nextUnit = firstUnit  // unit 0 is the source image
    let nullUnit = -1 // lazily-allocated 1×1 transparent texture unit

    // Bug #8: a texture-backed layer whose texture is MISSING (cache miss
    // after reload, malformed data, or no key) must NOT leave its sampler
    // bound to unit 0 — that's the source photo, and the layer would sample
    // the photo's luminance as its "mask", corrupting the whole composite.
    // Instead we bind a shared 1×1 transparent (alpha-0) texture so the
    // layer reads 0 and contributes nothing. Allocated once per draw and
    // reused for every miss.
    const ensureNullUnit = () => {
        if (nullUnit >= 0) return nullUnit
        if (nextUnit >= maxTextureUnits(gl)) return -1
        const tex = gl.createTexture()
        if (!tex) return -1
        const unit = nextUnit
        nextUnit += 1
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        ownedTextures.push(tex)
        nullUnit = unit
        return unit
    }

    if (!stack || !Array.isArray(stack.chain)) {
        return { kindUnits, curveUnits, ownedTextures }
    }
    for (let i = 0; i < stack.chain.length; i += 1) {
        const layer = stack.chain[i].layer
        // Only kinds that ship a per-layer image contribute a texture.
        // Each kind has its own field name on the layer object, so we
        // resolve explicitly per kind — using `||` would mix fields if
        // a future refactor renamed one (a kind shouldn't accidentally
        // pick up the wrong key). All three draw from the same module-
        // scoped `maskTextureCache`.
        let cacheKey = null
        if (layer.kind === 'semantic') {
            cacheKey = layer.maskTextureKey
        } else if (layer.kind === 'smartBrush') {
            cacheKey = layer.brushTextureKey
        } else if (layer.kind === 'depth') {
            cacheKey = layer.depthMapKey
        } else if (layer.kind === 'lasso') {
            cacheKey = layer.maskTextureKey
        } else if (layer.kind === 'brush') {
            cacheKey = layer.maskTextureKey
        } else if (layer.kind === 'path') {
            cacheKey = layer.maskTextureKey
        } else {
            continue
        }
        const data = (typeof cacheKey === 'string' && cacheKey) ? getMaskTexture(cacheKey) : undefined
        if (!data) {
            // Bug #8: missing texture → bind the shared null texture so this
            // layer reads alpha 0 instead of corrupting the composite with
            // the source photo on unit 0.
            const u = ensureNullUnit()
            if (u >= 0) kindUnits.set(i, u)
            continue
        }
        gl.activeTexture(gl.TEXTURE0 + nextUnit)
        // Persistent GL texture cache: (re)upload only when this key's data
        // VERSION changed (setMaskTexture bumps it on every write); otherwise
        // reuse the cached GL texture and just bind it. Kind textures are
        // Y-flipped (to match the source's UNPACK_FLIP_Y) and LINEAR-filtered.
        if (!bindCachedMaskTexture(gl, cacheKey, data, true, gl.LINEAR)) {
            // createTexture / texImage2D failed (malformed data) → bind the
            // shared null texture so the layer reads alpha 0 (Bug #8) rather
            // than sampling the source image on unit 0.
            const u = ensureNullUnit()
            if (u >= 0) kindUnits.set(i, u)
            continue
        }
        kindUnits.set(i, nextUnit)
        nextUnit += 1
        if (nextUnit >= maxTextureUnits(gl)) {
            // WebGL2 guarantees at least 16. We stop allocating rather
            // than overwrite an existing unit (each layer needs its own).
            // The next texture-using layer will silently render with a
            // default-bound sampler — visible, but the limit is well
            // past any realistic use case.
            break
        }
    }

    // ── Per-layer tone-curve LUTs ──────────────────────────────────────────
    // A layer with a non-identity curve carries `curveLutKey`; the UI builds a
    // 256×1 RGBA LUT (R/G/B + master in alpha — packLutsRgba) and registers it
    // via setMaskTexture. Upload one texture per such layer to its own unit and
    // record it so writeCurveUniforms can bind the sampler + flip curveOn on.
    for (let i = 0; i < stack.chain.length; i += 1) {
        if (nextUnit >= maxTextureUnits(gl)) break
        const layer = stack.chain[i].layer
        const key = layer && typeof layer.curveLutKey === 'string' ? layer.curveLutKey : null
        if (!key) continue
        const lut = getMaskTexture(key)
        if (!lut) continue
        gl.activeTexture(gl.TEXTURE0 + nextUnit)
        // Same persistent cache as the kind textures. The LUT is data (256×1):
        // no Y-flip, LINEAR so values between the 256 entries interpolate. The
        // key is the stable `curve-<id>`; setMaskTexture bumps its version each
        // time the user edits the curve, forcing a re-upload — otherwise reuse.
        if (!bindCachedMaskTexture(gl, key, lut, false, gl.LINEAR)) continue
        curveUnits.set(i, nextUnit)
        nextUnit += 1
    }

    return { kindUnits, curveUnits, ownedTextures }
}

/**
 * Lazily create the fullscreen-quad VBO + VAO used by every megashader
 * draw. Two triangles covering clip space [-1, 1]², with `aPosition`
 * pinned to attribute location 0 (see `bindAttribLocation` in
 * `getOrCreateProgram`) so the same VAO binds to any compiled program.
 *
 * Bug history: this function was REFERENCED at the draw site
 * (`const { vao } = ensureQuadBuffers(gl)`) but never defined, so the
 * very first real GL draw threw `ReferenceError: ensureQuadBuffers is
 * not defined`. That error propagated out of `applyTo`, was swallowed by
 * the try/catch in `apply-megashader.js`, and the megashader silently
 * rendered nothing — the single biggest reason "masking filters don't
 * work". The identity short-circuit hid it for all-zero-adjustment
 * stacks (which never reached the draw); any real effect crashed here.
 *
 * @param {WebGL2RenderingContext} gl
 * @returns {{ vao: WebGLVertexArrayObject | null, vbo: WebGLBuffer | null }}
 */
const ensureQuadBuffers = (gl) => {
    if (quadVao && quadVbo) return { vao: quadVao, vbo: quadVbo }
    // WebGL1 fallback contexts lack VAOs; the rest of the renderer assumes
    // WebGL2 (it calls gl.bindVertexArray unconditionally), so we guard and
    // bail to the CPU path if VAOs are unavailable.
    if (typeof gl.createVertexArray !== 'function') {
        return { vao: null, vbo: null }
    }
    // Ensure a linked program exists so attribute location 0 is valid for
    // the VAO's vertexAttribPointer call.
    getQuadProgram(gl)

    const verts = new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1,
    ])
    const vbo = gl.createBuffer()
    if (!vbo) return { vao: null, vbo: null }
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW)

    const vao = gl.createVertexArray()
    if (!vao) {
        gl.deleteBuffer(vbo)
        return { vao: null, vbo: null }
    }
    gl.bindVertexArray(vao)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)

    quadVbo = vbo
    quadVao = vao
    return { vao: quadVao, vbo: quadVbo }
}

/**
 * Main entry: render a `MaskStack` over a source 2D canvas and return a
 * 2D canvas containing the result. Always returns a same-sized 2D canvas
 * even if WebGL2 is unavailable (falls back to CPU passthrough).
 *
 * @param {HTMLCanvasElement | OffscreenCanvas} sourceCanvas
 * @param {import('./mask-types').MaskStack} stack
 * @param {{ globalMaskAlpha?: number }} [options]
 * @returns {HTMLCanvasElement}
 */
export const renderMegashader = (sourceCanvas, stack, options = {}) => {
    if (!sourceCanvas || typeof sourceCanvas.width !== 'number') {
        return renderCpuFallback({ width: 1, height: 1 }, stack)
    }

    const compiled = compileMegashader(stack)

    // Step 9 — Identity fast-path. When every layer's per-layer adjustments
    // are exactly 0, the GLSL chain is mathematically identity regardless
    // of how many layers are in the chain or what the boolean composition
    // produces — the colour-side math reduces to `mix(src, src, x) = src`
    // for any x. We can short-circuit and return the source canvas as-is,
    // skipping the WebGL upload / draw / readback / canvas creation.
    //
    // This was previously only triggered for the empty-chain case (the
    // `compiled.passthrough` branch). Now any chain with all-zero
    // adjustments short-circuits, which is the common case for users who
    // haven't touched the Step 8 adjustment sliders.
    //
    // We don't need to gate on globalMaskAlpha: when `runningColor` is
    // identically `srcRgb`, the final `mix(srcRgb, srcRgb, runningAlpha *
    // uMaskAlpha) = srcRgb` regardless of alpha. The mask's strength is
    // a no-op when the colour it would mix in equals the source.
    const overlayOn = options.maskOverlay === true
    if (compiled.passthrough || (!overlayOn && stackHasNoVisibleEffect(stack))) {
        // Root-cause #1: short-circuit only when the stack has NO visible
        // effect at all — no non-zero adjustment, no fill, no erase. A
        // freshly-added selection layer (fill mode) now fails this check
        // and actually renders, instead of returning the untouched source.
        // The "show mask" overlay must visualise the selection even for an
        // all-adjust-zero chain, so it bypasses this short-circuit (unless
        // the chain is genuinely empty → compiled.passthrough).
        // Step 10.3: count identity short-circuits. Distinct from
        // the `compiled.passthrough` branch (empty chain) — both
        // bypass the GL pipeline, so we count them together.
        renderMetrics.identityShortCircuits += 1
        if (typeof sourceCanvas.getContext === 'function' && sourceCanvas instanceof HTMLCanvasElement) {
            return sourceCanvas
        }
        return renderCpuFallback(sourceCanvas, stack)
    }

    const gl = ensureGl()
    if (!gl) return renderCpuFallback(sourceCanvas, stack)

    // Chains longer than one pass are batched: every batch but the last writes
    // its running state to a texture, and the last one composites to pixels.
    const fullChain = (stack && Array.isArray(stack.chain)) ? stack.chain : []
    const batchLimit = Math.max(1, Math.min(MAX_LAYERS_PER_PASS, options.maxLayersPerPass || MAX_LAYERS_PER_PASS))
    const batches = planPasses(gl, fullChain, batchLimit)
    const multiPass = batches.length > 1

    // Suffix fold: when exactly one layer changed since the last frame and every
    // layer above it is affine (see chain-fold.js), collapse those layers into
    // per-pixel maps and render only the edited one. Editing cost then stops
    // depending on WHERE in the chain the user is working.
    const foldW = sourceCanvas.width
    const foldH = sourceCanvas.height
    const layerSigs = multiPass ? fullChain.map(layerSignature) : null
    const hotLayer = layerSigs ? findHotLayer(layerSigs) : -1
    const foldViable = Boolean(
        multiPass
        && hotLayer >= 0
        && options.sourceVersion !== undefined
        && !foldDisabled
        && options.disableFold !== true
        && foldW * foldH <= FOLD_MAX_PIXELS
        && supportsFloatTargets(gl)
        && fullChain.slice(hotLayer + 1).every((e) => isFoldableOp(e.op)),
    )
    if (layerSigs) lastLayerSigs = layerSigs

    const eraseEntries = multiPass
        ? fullChain.filter((e, i) => e.layer && e.layer.fillMode === 'erase' && !(foldViable && i === hotLayer))
        : []
    const finalEntries = foldViable
        ? [fullChain[hotLayer]]
        : (multiPass ? batches[batches.length - 1] : fullChain)
    const finalStack = multiPass ? { chain: finalEntries } : (stack || { chain: [] })
    const activeCompiled = foldViable
        ? compilePass(finalEntries, {
            role: 'final',
            readsPrevState: hotLayer > 0,
            readsErase: eraseEntries.length > 0,
            readsSuffix: true,
        })
        : (multiPass
            ? compilePass(finalEntries, { role: 'final', readsPrevState: true, readsErase: eraseEntries.length > 0 })
            : compiled)

    const program = getOrCreateProgram(activeCompiled)
    if (!program) return renderCpuFallback(sourceCanvas, stack)

    const w = sourceCanvas.width
    const h = sourceCanvas.height
    if (glCanvas.width !== w) glCanvas.width = w
    if (glCanvas.height !== h) glCanvas.height = h
    gl.viewport(0, 0, w, h)

    const imageSize = { width: w, height: h }

    // Bind the source as a 2D texture, reusing the GPU copy when the caller
    // says the pixels have not changed (see sourceTextureCache).
    const sourceVersion = options.sourceVersion
    let sourceEntry = sourceTextureCache.get(sourceCanvas)
    if (sourceEntry && !gl.isTexture(sourceEntry.tex)) sourceEntry = undefined
    const reuseSource = Boolean(
        sourceEntry
        && sourceVersion !== undefined
        && sourceEntry.version === sourceVersion
        && sourceEntry.width === w
        && sourceEntry.height === h,
    )
    let texture = sourceEntry?.tex || null
    if (!texture) {
        texture = gl.createTexture()
        if (!texture) return renderCpuFallback(sourceCanvas, stack)
        sourceEntry = { tex: texture, width: 0, height: 0, version: undefined }
        sourceTextureCache.set(sourceCanvas, sourceEntry)
        liveSourceTextures.add(texture)
    }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    if (!reuseSource) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, /** @type {any} */ (sourceCanvas))
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        sourceEntry.width = w
        sourceEntry.height = h
        sourceEntry.version = sourceVersion
        renderMetrics.sourceUploads += 1
    } else {
        renderMetrics.sourceUploadsSkipped += 1
    }

    // Units 1 and 2 are reserved for the incoming state and the erase map, so
    // batch textures start at 3 whenever the chain is split.
    const PREV_STATE_UNIT = 1
    const ERASE_UNIT = 2
    const SUFFIX_COLOR_UNIT = 3
    const SUFFIX_ALPHA_UNIT = 4
    const kindFirstUnit = multiPass ? (foldViable ? 5 : 3) : 1
    const preOwned = []
    let prevStateTex = null
    let eraseTex = null
    let suffixColorTex = null
    let suffixAlphaTex = null

    if (multiPass) {
        const targets = ensureStateTargets(gl, w, h)
        if (!targets) return renderCpuFallback(sourceCanvas, stack)
        // Re-assert the source on unit 0 after any texture creation above.
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        const { vao: preVao } = ensureQuadBuffers(gl)
        const passRenderOpts = { globalMaskAlpha: 1, globalInvert: false, maskOverlay: false }

        const unitReserve = foldViable ? 5 : 3
        const PREV_MAP_UNIT = PREV_STATE_UNIT
        const drawPass = (entries, passCompiled, targetTex, prevTex, blendMax, prevUniform) => {
            const passProgram = getOrCreateProgram(passCompiled)
            if (!passProgram) return false
            gl.bindFramebuffer(gl.FRAMEBUFFER, targets.fbo)
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetTex, 0)
            gl.viewport(0, 0, w, h)
            gl.useProgram(passProgram)
            const uImageLoc = uloc(gl, passProgram, 'uImage')
            if (uImageLoc) gl.uniform1i(uImageLoc, 0)
            const uMatrixLoc = uloc(gl, passProgram, 'uMatrix')
            if (uMatrixLoc) gl.uniformMatrix4fv(uMatrixLoc, false, IDENTITY_MATRIX)
            if (prevTex) {
                gl.activeTexture(gl.TEXTURE0 + PREV_STATE_UNIT)
                gl.bindTexture(gl.TEXTURE_2D, prevTex)
                // Suffix passes read their running map through uPrevMap instead.
                const uPrev = uloc(gl, passProgram, prevUniform ? 'uPrevMap' : 'uPrevState')
                if (uPrev) gl.uniform1i(uPrev, PREV_STATE_UNIT)
            }
            const passStack = { chain: entries }
            const bindings = bindKindTextures(gl, passStack, kindFirstUnit)
            preOwned.push(...bindings.ownedTextures)
            writeUniforms(gl, passProgram, passStack, passRenderOpts, imageSize, bindings)
            if (blendMax) {
                gl.enable(gl.BLEND)
                gl.blendEquation(gl.MAX)
                gl.blendFunc(gl.ONE, gl.ONE)
            }
            if (preVao) {
                gl.bindVertexArray(preVao)
                gl.drawArrays(gl.TRIANGLES, 0, 6)
                gl.bindVertexArray(null)
            }
            if (blendMax) gl.disable(gl.BLEND)
            return true
        }

        // Erase coverage: max over the erase layers, independent of order.
        if (eraseEntries.length) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, targets.fbo)
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targets.texE, 0)
            gl.viewport(0, 0, w, h)
            gl.clearColor(0, 0, 0, 0)
            gl.clear(gl.COLOR_BUFFER_BIT)
            for (const group of planPasses(gl, eraseEntries, batchLimit, unitReserve)) {
                drawPass(group, compilePass(group, { role: 'erase' }), targets.texE, null, true)
            }
            eraseTex = targets.texE
        }

        if (foldViable) {
            // ── Fold path ──────────────────────────────────────────────────
            // Two cached artefacts: the state BELOW the edited layer, and the
            // maps for everything ABOVE it. Both survive while the user drags.
            const prefixEntries = fullChain.slice(0, hotLayer)
            const suffixEntries = fullChain.slice(hotLayer + 1)
            const prefixSig = prefixEntries.map(layerSignature).join('~')
            const suffixSig = suffixEntries.map(layerSignature).join('~')
            const sameShape = foldCache
                && foldCache.sourceVersion === options.sourceVersion
                && foldCache.width === w
                && foldCache.height === h
                && gl.isTexture(foldCache.colorTex)

            if (!sameShape) {
                disposeFoldCache(gl)
                gl.activeTexture(gl.TEXTURE0 + maxTextureUnits(gl) - 1)
                foldCache = {
                    sourceVersion: options.sourceVersion,
                    width: w,
                    height: h,
                    prefixSig: null,
                    suffixSig: null,
                    prefixTex: makeMapTexture(gl, w, h, false),
                    // The colour map's coefficients are all in 0..1, so RGBA8
                    // holds them; the alpha map's offset is signed and can
                    // exceed 1, so that one has to be float.
                    colorTex: makeMapTexture(gl, w, h, false),
                    alphaTex: makeMapTexture(gl, w, h, true),
                }
                gl.activeTexture(gl.TEXTURE0)
                gl.bindTexture(gl.TEXTURE_2D, texture)
            }

            const cache = foldCache
            if (!cache || !cache.prefixTex || !cache.colorTex || !cache.alphaTex) {
                // Out of texture memory: stop offering the fold for this
                // session and let the batched path serve the frame.
                foldDisabled = true
                disposeFoldCache(gl)
                gl.bindFramebuffer(gl.FRAMEBUFFER, null)
                return renderMegashader(sourceCanvas, stack, options)
            }

            // Prefix: replay the layers below the edited one, once.
            if (cache.prefixSig !== prefixSig) {
                if (prefixEntries.length) {
                    let target = targets.texA
                    let previous = null
                    const prefixBatches = planPasses(gl, prefixEntries, batchLimit, unitReserve)
                    for (let b = 0; b < prefixBatches.length; b += 1) {
                        const last = b === prefixBatches.length - 1
                        const dest = last ? cache.prefixTex : target
                        const passCompiled = compilePass(prefixBatches[b], { role: 'state', readsPrevState: b > 0 })
                        if (!drawPass(prefixBatches[b], passCompiled, dest, previous, false)) {
                            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
                            return renderCpuFallback(sourceCanvas, stack)
                        }
                        previous = dest
                        if (!last) target = target === targets.texA ? targets.texB : targets.texA
                    }
                }
                cache.prefixSig = prefixSig
                renderMetrics.foldPrefixBuilds += 1
            }

            // Suffix maps: compose the layers above the edited one, once.
            if (cache.suffixSig !== suffixSig) {
                const seed = (tex, r, g, b, a) => {
                    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.fbo)
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
                    gl.viewport(0, 0, w, h)
                    gl.clearColor(r, g, b, a)
                    gl.clear(gl.COLOR_BUFFER_BIT)
                }
                // Identity maps: colour C → C (P = 1, Q = 0), alpha A → A.
                seed(cache.colorTex, 0, 0, 0, 1)
                seed(cache.alphaTex, 1, 0, 0, 1)
                const suffixBatches = suffixEntries.length ? planPasses(gl, suffixEntries, batchLimit, unitReserve) : []
                for (const [role, texKey, float] of [
                    ['suffixColor', 'colorTex', false],
                    ['suffixAlpha', 'alphaTex', true],
                ]) {
                    if (!suffixBatches.length) continue
                    // The ping-pong partner only exists for the rebuild, which
                    // happens when the user moves to a different layer — not
                    // on the frames this whole thing is here to make cheap.
                    gl.activeTexture(gl.TEXTURE0 + maxTextureUnits(gl) - 1)
                    let write = makeMapTexture(gl, w, h, float)
                    gl.activeTexture(gl.TEXTURE0)
                    gl.bindTexture(gl.TEXTURE_2D, texture)
                    if (!write) {
                        foldDisabled = true
                        disposeFoldCache(gl)
                        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
                        return renderMegashader(sourceCanvas, stack, options)
                    }
                    let read = cache[texKey]
                    for (const group of suffixBatches) {
                        if (!drawPass(group, compilePass(group, { role }), write, read, false, PREV_MAP_UNIT)) {
                            gl.deleteTexture(write)
                            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
                            return renderCpuFallback(sourceCanvas, stack)
                        }
                        const swap = read
                        read = write
                        write = swap
                    }
                    // `read` now holds the composed map; the other is scratch.
                    cache[texKey] = read
                    gl.deleteTexture(write)
                }
                cache.suffixSig = suffixSig
                renderMetrics.foldSuffixBuilds += 1
            }

            prevStateTex = hotLayer > 0 ? cache.prefixTex : null
            suffixColorTex = cache.colorTex
            suffixAlphaTex = cache.alphaTex
            renderMetrics.foldFrames += 1
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            gl.viewport(0, 0, w, h)
        } else {
        // State batches: every batch but the last, with the prefix cache
        // skipping the ones whose layers have not changed since last frame.
        const sigs = batches.map(batchSignature)
        const cacheable = options.sourceVersion !== undefined
        let startBatch = 0
        let previous = null

        if (cacheable
            && prefixCache
            && prefixCache.sourceVersion === options.sourceVersion
            && prefixCache.width === w
            && prefixCache.height === h
            && prefixCache.boundary <= batches.length - 1
            && prefixCache.sigs.length === prefixCache.boundary
            && prefixCache.sigs.every((sig, i) => sig === sigs[i])
            && gl.isTexture(prefixCache.tex)) {
            startBatch = prefixCache.boundary
            previous = prefixCache.tex
            renderMetrics.prefixHits += 1
        }

        // Which batch changed first? That boundary is worth caching, because a
        // drag keeps touching the same layer.
        let boundary = batches.length - 1
        if (lastBatchSigs && lastBatchSigs.length === sigs.length) {
            const firstChanged = sigs.findIndex((sig, i) => sig !== lastBatchSigs[i])
            boundary = firstChanged < 0 ? batches.length - 1 : Math.min(firstChanged, batches.length - 1)
        }
        lastBatchSigs = sigs

        let prefixTex = prefixCache && gl.isTexture(prefixCache.tex) ? prefixCache.tex : null
        if (cacheable && boundary > 0 && startBatch < boundary && !prefixTex) {
            gl.activeTexture(gl.TEXTURE0 + maxTextureUnits(gl) - 1)
            prefixTex = makeStateTexture(gl, w, h)
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, texture)
        }

        let target = targets.texA
        for (let b = startBatch; b < batches.length - 1; b += 1) {
            const entries = batches[b]
            const passCompiled = compilePass(entries, { role: 'state', readsPrevState: b > 0 })
            // Writing the boundary batch straight into the prefix texture keeps
            // it for the next frame without an extra copy.
            const writeToPrefix = cacheable && prefixTex && b === boundary - 1
            const dest = writeToPrefix ? prefixTex : target
            if (!drawPass(entries, passCompiled, dest, previous, false)) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, null)
                return renderCpuFallback(sourceCanvas, stack)
            }
            previous = dest
            if (writeToPrefix) {
                prefixCache = {
                    sourceVersion: options.sourceVersion,
                    width: w,
                    height: h,
                    boundary,
                    tex: prefixTex,
                    sigs: sigs.slice(0, boundary),
                }
            } else {
                target = target === targets.texA ? targets.texB : targets.texA
            }
        }
        prevStateTex = previous
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, w, h)
        renderMetrics.statePasses += (batches.length - 1 - startBatch) + (eraseEntries.length ? 1 : 0)
        }
    }

    gl.useProgram(program)
    const uImage = uloc(gl, program, 'uImage')
    if (uImage) gl.uniform1i(uImage, 0)
    if (multiPass) {
        if (prevStateTex) {
            gl.activeTexture(gl.TEXTURE0 + PREV_STATE_UNIT)
            gl.bindTexture(gl.TEXTURE_2D, prevStateTex)
            const uPrev = uloc(gl, program, 'uPrevState')
            if (uPrev) gl.uniform1i(uPrev, PREV_STATE_UNIT)
        }
        if (eraseTex) {
            gl.activeTexture(gl.TEXTURE0 + ERASE_UNIT)
            gl.bindTexture(gl.TEXTURE_2D, eraseTex)
            const uErase = uloc(gl, program, 'uEraseMap')
            if (uErase) gl.uniform1i(uErase, ERASE_UNIT)
        }
        if (suffixColorTex) {
            gl.activeTexture(gl.TEXTURE0 + SUFFIX_COLOR_UNIT)
            gl.bindTexture(gl.TEXTURE_2D, suffixColorTex)
            const uSC = uloc(gl, program, 'uSuffixColor')
            if (uSC) gl.uniform1i(uSC, SUFFIX_COLOR_UNIT)
        }
        if (suffixAlphaTex) {
            gl.activeTexture(gl.TEXTURE0 + SUFFIX_ALPHA_UNIT)
            gl.bindTexture(gl.TEXTURE_2D, suffixAlphaTex)
            const uSA = uloc(gl, program, 'uSuffixAlpha')
            if (uSA) gl.uniform1i(uSA, SUFFIX_ALPHA_UNIT)
        }
    }

    // Identity matrix for the fullscreen quad — the megashader applies
    // pixel-space effects, not geometry transforms.
    const uMatrix = uloc(gl, program, 'uMatrix')
    if (uMatrix) {
        gl.uniformMatrix4fv(uMatrix, false, IDENTITY_MATRIX)
    }

    // Upload kind-specific textures (semantic masks, depth maps etc.) and
    // capture the slot → texture-unit mapping. The textures live until the
    // gl.deleteTexture calls below.
    const { kindUnits, curveUnits, ownedTextures } = bindKindTextures(gl, finalStack, kindFirstUnit)

    writeUniforms(
        gl,
        program,
        finalStack,
        {
            globalMaskAlpha: options.globalMaskAlpha ?? 1,
            globalInvert: options.globalInvert === true,
            maskOverlay: options.maskOverlay === true,
            maskView: options.maskView,
            overlayColor: options.overlayColor,
        },
        imageSize,
        { kindUnits, curveUnits },
    )

    // Bind quad + draw.
    const { vao } = ensureQuadBuffers(gl)
    if (vao) {
        gl.bindVertexArray(vao)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        gl.bindVertexArray(null)
    }

    // Copy the result into a 2D canvas. drawImage(glCanvas) runs in the same
    // task as drawArrays, so the drawing buffer is still intact even with
    // preserveDrawingBuffer:false; the browser copies it GPU-side in top-left
    // orientation. The readPixels path costs a 4-bytes-per-pixel buffer plus a
    // JS row flip (~0.5 s and ~200 MB at 24 MP), so it is only the fallback.
    let out
    if (options.reuseOutput) {
        if (!reusableOutput) reusableOutput = document.createElement('canvas')
        out = reusableOutput
    } else {
        out = document.createElement('canvas')
    }
    if (out.width !== w) out.width = w
    if (out.height !== h) out.height = h
    const ctx = out.getContext('2d')
    if (ctx) {
        let copied = false
        try {
            ctx.drawImage(glCanvas, 0, 0)
            copied = true
        } catch { /* fall through to readPixels */ }
        if (!copied) {
            const pixels = new Uint8Array(w * h * 4)
            try {
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
            } catch {
                for (const tex of ownedTextures) gl.deleteTexture(tex)
                return renderCpuFallback(sourceCanvas, stack)
            }
            const imageData = ctx.createImageData(w, h)
            const rowBytes = w * 4
            for (let y = 0; y < h; y += 1) {
                const srcStart = (h - 1 - y) * rowBytes
                const dstStart = y * rowBytes
                imageData.data.set(pixels.subarray(srcStart, srcStart + rowBytes), dstStart)
            }
            ctx.putImageData(imageData, 0, 0)
        }
    }

    // `texture` belongs to sourceTextureCache and is reused next frame.
    for (const tex of ownedTextures) gl.deleteTexture(tex)
    for (const tex of preOwned) gl.deleteTexture(tex)

    // Step 10.3: count successful draws (one per `renderMegashader`
    // call that reached the readback stage). Identity short-circuits
    // are counted separately via `identityShortCircuits`.
    renderMetrics.drawCount += 1
    return out
}

/**
 * CPU fallback path. Used when:
 *   - WebGL2 is unavailable (e.g. very old browser, or `webgl2` is
 *     blocked by the user's privacy settings);
 *   - the shader program fails to link (e.g. a new layer kind produced
 *     invalid GLSL — the renderer logs the link error and falls back);
 *   - `readPixels` throws (the GPU readback failed for some reason).
 *
 * The CPU fallback is a *passthrough*: it returns a 2D canvas that
 * contains a pixel-for-pixel copy of the source. This is intentional —
 * a real CPU-side implementation of the megashader would have to
 * re-port all 7 mask kinds in JavaScript, which is a lot of code for
 * a path that should never run on supported hardware. The user sees
 * their un-masked source image, with the megashader filter acting as
 * a no-op, which is the right behaviour for a degraded render path.
 *
 * Bug history: pre-Step 10, this function was called 6 times in
 * `renderMegashader` but never defined — any fallback path threw a
 * `ReferenceError: renderCpuFallback is not defined`. The bug was
 * latent because `hasMegashaderWebGL2` guards the typical entry point
 * and shaders usually link, so the fallback rarely fires. Step 10
 * adds the missing definition.
 *
 * @param {HTMLCanvasElement | { width: number, height: number }} source
 * @param {import('./mask-types').MaskStack} [stack]
 * @returns {HTMLCanvasElement}
 */
const renderCpuFallback = (source, stack) => {
    if (typeof document === 'undefined') {
        // Non-browser environment: return a minimal stub so callers
        // (tests, SSR) that reach this path get a non-null canvas. The
        // dimensions come from the `source` argument — either the real
        // canvas's width/height, or the synthetic `{ width, height }`
        // shape used in some error branches.
        const out = { width: 1, height: 1, getContext: () => null }
        return /** @type {HTMLCanvasElement} */ (out)
    }
    const out = document.createElement('canvas')
    if (source && typeof source.width === 'number' && typeof source.height === 'number') {
        out.width = source.width
        out.height = source.height
    } else {
        out.width = 1
        out.height = 1
        return out
    }
    // If `source` is a real canvas, drawImage it. Otherwise we have
    // no source pixels to copy, so the fallback canvas is blank.
    if (typeof source.getContext === 'function' && source instanceof HTMLCanvasElement) {
        const ctx = out.getContext('2d')
        if (ctx) {
            try {
                ctx.drawImage(source, 0, 0)
            } catch {
                // drawImage can throw for cross-origin canvases. The
                // best we can do is return a blank canvas; the caller
                // still gets a non-null result.
            }
        }
    }
    return out
}

/**
 * Reset all caches. Called by the Fabric filter on dispose and by tests.
 * Deletes every cached program, the quad program, the quad VBO/VAO, and
 * drops the GL context reference. The next `renderMegashader` call will
 * recreate everything from scratch.
 */
export const disposeRenderer = () => {
    const gl = glContext
    if (gl) {
        for (const program of programCache.values()) gl.deleteProgram(program)
        if (quadProgram) gl.deleteProgram(quadProgram)
        if (quadVbo) gl.deleteBuffer(quadVbo)
        if (quadVao) gl.deleteVertexArray(quadVao)
        for (const entry of maskGlTextureCache.values()) {
            if (entry && entry.tex && gl.isTexture(entry.tex)) gl.deleteTexture(entry.tex)
        }
        for (const tex of liveSourceTextures) {
            if (gl.isTexture(tex)) gl.deleteTexture(tex)
        }
        deleteStateTargets(gl)
    }
    liveSourceTextures.clear()
    reusableOutput = null
    maskGlTextureCache = new Map()
    maskGlTextureBytes = 0
    programCache.clear()
    quadProgram = null
    quadVbo = null
    quadVao = null
    glContext = null
    glCanvas = null
}

// Step 10.3: re-export the metrics helpers so the test panel can
// read and reset them. Re-export (not just `export`) so a future
// barrel change doesn't accidentally shadow them.
export { getRenderMetrics, resetRenderMetrics }
