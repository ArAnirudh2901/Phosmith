// Visual preview of the Pixel Stretch engine on real photos. Bundled by
// scripts/preview-stretch.mjs; nothing here ships in the app.

import {
    DEFAULT_STRETCH,
    clampStretchParams,
    makeSampleCanvas,
    renderPixelStretch,
    renderSubjectOverlay,
    createDefaultWarpGrid,
    getWarpRest,
    applyWarpPreset,
    createDefaultFlowPath,
    applyFlowPreset,
    analyzeStretchPlan,
    createFlowPathFromPoints,
} from '../../src/lib/pixel-stretch.js'

import { isRawFile, resolveSourceFile } from '../../src/lib/raw-preview.js'

const loadImage = (src) => new Promise((resolve, reject) => {
    const el = new Image()
    el.crossOrigin = 'anonymous'
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error(`load failed: ${src}`))
    el.src = src
})

let lastPlan = null
const cache = new Map()
// RAW containers go through the production intake, so the harness sees exactly
// the pixels the editor would: container → embedded preview → orientation baked.
const getPhoto = async (name) => {
    if (cache.has(name)) return cache.get(name)
    let url = `/photos/${name}`
    if (isRawFile({ name })) {
        const blob = await fetch(url).then((r) => r.blob())
        const resolved = await resolveSourceFile(new File([blob], name, { type: '' }))
        url = URL.createObjectURL(resolved.file || resolved.blob || resolved)
    }
    const el = await loadImage(url)
    cache.set(name, el)
    return el
}

const buildParams = (spec, sample) => {
    let base = { ...DEFAULT_STRETCH, ...(spec.params || {}) }
    if (spec.auto) {
        const plan = analyzeStretchPlan(sample)
        if (plan) {
            const { region, reasoning, flowPath, flowWidth, ...rest } = plan
            const fp = Array.isArray(flowPath) && flowPath.length >= 2
                ? createFlowPathFromPoints(flowPath, flowWidth ? { width: flowWidth } : {})
                : null
            base = { ...base, ...rest, band: region, flowPath: spec.noFlow ? null : fp, ...(spec.params || {}) }
            lastPlan = { ...rest, band: region, flow: fp ? fp.anchors.length : 0, reasoning }
        }
    }
    let p = clampStretchParams(base)
    if (spec.warpPreset) {
        const r = applyWarpPreset(p, spec.warpPreset, spec.warpAmount == null ? 1 : spec.warpAmount, spec.warpRows, spec.warpCols)
        p = { ...p, warpGrid: r.grid, warpRest: r.rest }
    }
    if (spec.flowPreset) p = { ...p, flowPath: applyFlowPreset(p, spec.flowPreset) }
    if (spec.defaultFlow) p = { ...p, flowPath: createDefaultFlowPath(p, spec.flowAnchors || 4) }
    if (spec.defaultWarp) p = { ...p, warpGrid: createDefaultWarpGrid(p, spec.warpRows, spec.warpCols), warpRest: getWarpRest(p) }
    if (spec.warpDrag) {
        const grid = (p.warpGrid || createDefaultWarpGrid(p)).map((row) => row.map((pt) => ({ ...pt })))
        for (const d of spec.warpDrag) {
            const pt = grid[d.r] && grid[d.r][d.c]
            if (pt) { pt.x += d.dx || 0; pt.y += d.dy || 0 }
        }
        p = { ...p, warpGrid: grid }
    }
    return clampStretchParams(p)
}

const shot = async (spec) => {
    const img = await getPhoto(spec.photo)
    const long = spec.long || 900
    const scale = long / Math.max(img.naturalWidth, img.naturalHeight)
    const W = Math.round(img.naturalWidth * scale)
    const H = Math.round(img.naturalHeight * scale)
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')
    const sample = makeSampleCanvas(img, W, H)
    // `bg` paints a known colour under the ribbon instead of the photo: any of it
    // still visible inside the ribbon body is opacity the ribbon lost.
    if (spec.bg) { ctx.fillStyle = spec.bg; ctx.fillRect(0, 0, W, H) }
    else ctx.drawImage(sample, 0, 0)
    lastPlan = null
    const p = buildParams(spec, sample)
    const t0 = performance.now()
    const ok = renderPixelStretch(ctx, sample, p, W, H, { quality: spec.quality || 'max' })
    if (spec.subjectOverlay) renderSubjectOverlay(ctx, sample, p, W, H)
    const ms = performance.now() - t0
    // Count how much of the probe colour survives where the ribbon drew.
    let bleed = null
    if (spec.bg === '#ff00ff') {
        const d = ctx.getImageData(0, 0, W, H).data
        let exact = 0, total = 0
        for (let i = 0; i < d.length; i += 4) {
            total += 1
            if (d[i] > 240 && d[i + 1] < 16 && d[i + 2] > 240) exact += 1
        }
        bleed = { magentaFraction: +(exact / total).toFixed(4) }
    }
    return { ok, ms: Math.round(ms), bleed, W, H, plan: lastPlan, canvas: c, png: spec.noPng ? null : c.toDataURL('image/png') }
}


// One labelled contact sheet from many specs, so a whole sweep can be judged in
// a single look instead of a file per frame.
const sheet = async (specs, cols = 3, cell = 460) => {
    const shots = []
    for (const spec of specs) shots.push({ spec, r: await shot({ ...spec, noPng: true }) })
    const rows = Math.ceil(shots.length / cols)
    const ch = Math.round(cell * (shots[0].r.H / shots[0].r.W))
    const pad = 22
    const out = document.createElement('canvas')
    out.width = cols * (cell + 6)
    out.height = rows * (ch + pad + 6)
    const o = out.getContext('2d')
    o.fillStyle = '#111'
    o.fillRect(0, 0, out.width, out.height)
    shots.forEach(({ spec, r }, i) => {
        const x = (i % cols) * (cell + 6) + 3
        const y = Math.floor(i / cols) * (ch + pad + 6) + 3
        o.drawImage(r.canvas, x, y, cell, ch)
        o.fillStyle = '#eee'
        o.font = '13px monospace'
        o.fillText(`${spec.name}  ${r.ms}ms${r.ok ? '' : '  NOTHING DRAWN'}`, x + 4, y + ch + 15)
    })
    return { png: out.toDataURL('image/png'), plans: shots.map((s) => ({ name: s.spec.name, ok: s.r.ok, ms: s.r.ms, plan: s.r.plan })) }
}

window.__stretch = { ready: true, shot, sheet }
