/**
 * Megashader benchmark — synthetic mask chains timed at a chosen resolution.
 *
 * Loaded lazily (never part of the editor chunk) through
 * `window.__phosmith.megashaderBench(...)`. Numbers from here describe the
 * RENDERER only: no React, no Fabric, no DOM compositing, so a change in the
 * shader pipeline shows up undiluted.
 *
 * Each timed frame mutates one layer's exposure and re-renders, which is what
 * dragging a slider does. A 1×1 readback after every render forces the GPU to
 * finish before the clock stops.
 */

import { renderMegashader } from './megashader-renderer'
import { getRenderMetrics, resetRenderMetrics } from './megashader-renderer'
import { colorLayer, linearLayer, luminanceLayer, radialLayer } from './mask-types'

const PRESET_SIZES = {
    '4k': { width: 3840, height: 2160 },
    '1080p': { width: 1920, height: 1080 },
    '720p': { width: 1280, height: 720 },
    '12mp': { width: 4240, height: 2832 },
}

/** Deterministic pseudo-random so every run builds the same chain. */
const rng = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
}

/** Source photo stand-in: smooth gradient plus blocks, so grades are visible. */
const makeSource = (width, height) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    const grad = ctx.createLinearGradient(0, 0, width, height)
    grad.addColorStop(0, '#1b3a5c')
    grad.addColorStop(0.5, '#c8763a')
    grad.addColorStop(1, '#e8e2d5')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, width, height)
    const rand = rng(7)
    for (let i = 0; i < 400; i += 1) {
        ctx.fillStyle = `rgba(${Math.round(rand() * 255)},${Math.round(rand() * 255)},${Math.round(rand() * 255)},0.25)`
        ctx.fillRect(rand() * width, rand() * height, rand() * width * 0.12, rand() * height * 0.12)
    }
    return canvas
}

const GRADE = { exposure: 0.18, contrast: 6, saturation: 8, fillMode: 'adjust' }

/** One layer of `kind`, placed so layers overlap without being identical. */
const makeLayer = (kind, i, imageSize, rand) => {
    const base = { imageSize, label: `bench-${kind}-${i}` }
    if (kind === 'radial') {
        return {
            ...radialLayer({
                ...base,
                center: { x: imageSize.width * (0.15 + 0.7 * rand()), y: imageSize.height * (0.15 + 0.7 * rand()) },
                radius: { x: imageSize.width * 0.22, y: imageSize.height * 0.22 },
                feather: 0.4,
            }),
            ...GRADE,
        }
    }
    if (kind === 'linear') {
        return {
            ...linearLayer({
                ...base,
                p1: { x: imageSize.width * rand(), y: imageSize.height * rand() },
                p2: { x: imageSize.width * rand(), y: imageSize.height * rand() },
            }),
            ...GRADE,
        }
    }
    if (kind === 'color') {
        return {
            ...colorLayer({ ...base, target: { h: rand() * 360, s: 0.5 + 0.4 * rand(), b: 0.5 + 0.4 * rand() }, tolerance: 0.2 }),
            ...GRADE,
        }
    }
    return { ...luminanceLayer({ ...base, min: 0.15 + 0.3 * rand(), max: 0.7 + 0.25 * rand(), softness: 0.15 }), ...GRADE }
}

/**
 * A chain of `count` layers cycling through `kinds`, first op forced to
 * `replace` by the compiler, the rest alternating so the blend maths is
 * exercised rather than a single op repeated.
 */
export const makeBenchStack = (count, { width, height, kinds = ['radial', 'linear', 'luminance', 'color'], seed = 11 } = {}) => {
    const rand = rng(seed)
    const imageSize = { width, height }
    const ops = ['add', 'screen', 'intersect', 'lighten', 'darken', 'subtract']
    const chain = []
    for (let i = 0; i < count; i += 1) {
        chain.push({
            layer: makeLayer(kinds[i % kinds.length], i, imageSize, rand),
            op: i === 0 ? 'replace' : ops[i % ops.length],
        })
    }
    return { chain }
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]

/**
 * Time `frames` renders as a batch: the GPU pipelines the work, so one sync at
 * the end divided by the frame count is the real per-frame throughput. Timing
 * each render with its own readback would instead measure a stalled pipeline.
 * `cpuMs` is the main-thread submit cost per frame, measured separately.
 */
const timeChain = (source, stack, frames, renderOpts) => {
    const target = stack.chain[stack.chain.length - 1]?.layer
    const cpu = []
    let out = null
    const t0 = performance.now()
    for (let i = 0; i < frames; i += 1) {
        if (target) target.exposure = 0.18 + 0.12 * Math.sin(i / 4)
        const c0 = performance.now()
        out = renderMegashader(source, stack, renderOpts)
        cpu.push(performance.now() - c0)
    }
    // One sync for the whole batch: forces every queued frame to land.
    out.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 1, 1)
    const totalMs = performance.now() - t0
    cpu.sort((a, b) => a - b)
    const meanCpu = cpu.reduce((a, b) => a + b, 0) / cpu.length
    return {
        frames,
        meanMs: +(totalMs / frames).toFixed(2),
        cpuMeanMs: +meanCpu.toFixed(2),
        cpuP95Ms: +percentile(cpu, 0.95).toFixed(2),
        fps: +(1000 / (totalMs / frames)).toFixed(1),
    }
}

/**
 * @param {{ size?: keyof typeof PRESET_SIZES | {width:number,height:number},
 *           counts?: number[], frames?: number, warmup?: number,
 *           kinds?: string[] }} [opts]
 * @returns {Promise<object>} one row per layer count
 */
export const megashaderBench = async ({
    size = '4k',
    counts = [1, 2, 4, 8],
    frames = 30,
    warmup = 5,
    kinds,
    cacheSource = true,
    reuseOutput = true,
} = {}) => {
    // Both reuse paths are toggleable: reusing a GPU resource that the previous
    // frame is still reading can serialise the driver, so each is measured.
    const renderOpts = {
        ...(cacheSource ? { sourceVersion: 'bench-static' } : {}),
        ...(reuseOutput ? { reuseOutput: true } : {}),
    }
    const { width, height } = typeof size === 'string' ? (PRESET_SIZES[size] || PRESET_SIZES['4k']) : size
    const source = makeSource(width, height)
    const rows = {}
    for (const count of counts) {
        const stack = makeBenchStack(count, { width, height, kinds })
        resetRenderMetrics()
        const cold0 = performance.now()
        const first = renderMegashader(source, stack, renderOpts)
        first.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 1, 1)
        const coldMs = +(performance.now() - cold0).toFixed(2)
        for (let i = 0; i < warmup; i += 1) renderMegashader(source, stack, renderOpts)
        const timing = timeChain(source, stack, frames, renderOpts)
        const metrics = getRenderMetrics()
        rows[count] = {
            layers: count,
            coldMs,
            compileMs: +(metrics.totalCompileMs || 0).toFixed(2),
            uploads: metrics.sourceUploads,
            uploadsSkipped: metrics.sourceUploadsSkipped,
            statePasses: metrics.statePasses,
            prefixHits: metrics.prefixHits,
            ...timing,
            mpixPerSec: +(((width * height) / 1e6) / (timing.meanMs / 1000)).toFixed(1),
        }
        // Let the GPU and GC settle so the next row starts from a clean slate.
        await new Promise((r) => setTimeout(r, 400))
    }
    return { size: `${width}×${height}`, opts: { cacheSource, reuseOutput }, megapixels: +((width * height) / 1e6).toFixed(1), rows }
}

/**
 * Correctness gate for the batched path: render the same chain as one pass and
 * as several small batches, then compare pixels. Both must agree to within the
 * 8-bit rounding of the intermediate state texture.
 *
 * @param {{ size?: {width:number,height:number}, layers?: number, batch?: number }} [opts]
 */
export const megashaderParity = async ({ size = { width: 512, height: 512 }, layers = 6, batch = 2 } = {}) => {
    const { width, height } = size
    const source = makeSource(width, height)
    const stack = makeBenchStack(layers, { width, height })
    const single = renderMegashader(source, stack, { maxLayersPerPass: 64 })
    const singlePixels = single.getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, width, height).data.slice()
    const batched = renderMegashader(source, stack, { maxLayersPerPass: batch })
    const batchedPixels = batched.getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, width, height).data
    let maxDiff = 0
    let diffCount = 0
    for (let i = 0; i < singlePixels.length; i += 1) {
        const d = Math.abs(singlePixels[i] - batchedPixels[i])
        if (d > maxDiff) maxDiff = d
        if (d > 2) diffCount += 1
    }
    return { layers, batch, pixels: singlePixels.length / 4, maxDiff, pixelsOver2: diffCount }
}

export default megashaderBench
