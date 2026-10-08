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
    createStretchBuffer,
    matteToAlphaCanvas,
    snapMatteToEdges,
    renderStretchLayer,
    suggestWrapAt,
} from '../../src/lib/pixel-stretch.js'

import { isRawFile, resolveSourceFile } from '../../src/lib/raw-preview.js'
import { extendMatteToBox, fetchAutoHint, findSubjectMatte, matteFromDecision, planAutoStretch } from '../../src/lib/stretch-auto.js'

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

const buildParams = (spec, sample, W = 1, H = 1) => {
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
        const r = applyWarpPreset(p, spec.warpPreset, spec.warpAmount == null ? 1 : spec.warpAmount, W, H)
        p = { ...p, warpGrid: r.grid, warpRest: r.rest, warpModel: 'stretch' }
    }
    if (spec.flowPreset) p = { ...p, flowPath: applyFlowPreset(p, spec.flowPreset) }
    if (spec.defaultFlow) p = { ...p, flowPath: createDefaultFlowPath(p, spec.flowAnchors || 4) }
    if (spec.defaultWarp) p = { ...p, warpGrid: createDefaultWarpGrid(p, spec.warpRows, spec.warpCols, W, H), warpRest: getWarpRest(p) }
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
    const p = buildParams(spec, sample, W, H)
    globalThis.__phosmithStretchNoGL = Boolean(spec.noGL)
    const t0 = performance.now()
    let ok
    if (spec.autoPlan) {
        // The real Auto Stretch: SlimSAM on a ≤1024px copy, then the shared planner.
        const s = Math.min(1, 1024 / Math.max(W, H))
        const small = makeSampleCanvas(img, Math.round(W * s), Math.round(H * s))
        // The callers' order: measure, let Gemini decide, recover what it saw.
        let matte = spec.noSubject ? null : await findSubjectMatte(small, { hint: spec.hint || null })
        const coarse = spec.coarse ? await (await import('../../src/lib/client-ai.js')).clientSubjectMask(small, { width: small.width, height: small.height }) : null
        let hint = spec.hint || null
        if (spec.gemini) {
            const asked = await fetchAutoHint(sample)
            hint = asked.hint
            if (!hint) console.warn('gemini:', asked.reason)
            // Gemini's box and points re-prompt SlimSAM; its answer wins when it is a
        // subject at all, else the device matte is extended to Gemini's box.
        const decided = await matteFromDecision(small, hint)
        if (decided) matte = decided
        else if (hint?.subject) matte = matte ? await extendMatteToBox(small, matte, hint.subject) : await findSubjectMatte(small, { hint: hint })
        }
        if (coarse) matte = coarse
        const plan = planAutoStretch({ sample, matte, hint, prefer: spec.prefer || null })
        const layer = createStretchBuffer(W, H)
        ok = Boolean(plan) && renderStretchLayer(layer.getContext('2d'), sample, plan.params, W, H, {
            quality: 'max',
            // `coarse` reproduces the old pipeline: raw SlimSAM, 0.6% feather, plain upscale.
            alpha: matte && plan.coverage > 0
                ? (spec.coarse ? matteToAlphaCanvas(matte, W, H, 0.006 * Math.min(W, H)) : matteToAlphaCanvas(matte, W, H, 0.002 * Math.min(W, H), sample))
                : null,
            coverage: plan?.coverage || 0,
            wrapAt: plan?.wrapAt ?? null,
        })
        ctx.drawImage(layer, 0, 0)
        if (spec.matteOnly && matte) {
            // The matte itself over a dimmed photo: edges compare directly.
            ctx.globalAlpha = 1
            ctx.drawImage(sample, 0, 0)
            ctx.fillStyle = 'rgba(0,0,0,0.6)'
            ctx.fillRect(0, 0, W, H)
            ctx.drawImage(matteToAlphaCanvas(matte, W, H, 0), 0, 0)
        } else if (spec.showMatte && matte) {
            // Red tint where the detector put the subject, to judge the matte itself.
            const tint = matteToAlphaCanvas(matte, W, H, 0)
            const t = tint.getContext('2d')
            t.globalCompositeOperation = 'source-in'
            t.fillStyle = 'rgba(255,0,0,0.45)'
            t.fillRect(0, 0, W, H)
            ctx.drawImage(tint, 0, 0)
        }
        lastPlan = plan && { by: plan.decidedBy, gemini: hint && { edge: hint.edge, look: hint.look, bend: hint.bend, amount: hint.amount, placement: hint.placement, sample: hint.sample }, subject: plan.subject, look: plan.look, edge: plan.edge, amount: +plan.amount.toFixed(2), coverage: plan.coverage, wrapAt: plan.wrapAt, band: plan.params.band, why: plan.reasoning }
    } else if (spec.behind && p.polygon) {
        // Same as the bake: ribbon on its own layer, the lasso knocked back out,
        // and for a wrap the later part of the ribbon drawn back over it.
        const layer = createStretchBuffer(W, H)
        const lctx = layer.getContext('2d')
        const matte = createStretchBuffer(W, H)
        const m = matte.getContext('2d')
        m.fillStyle = '#000'; m.fillRect(0, 0, W, H); m.fillStyle = '#fff'
        m.beginPath()
        p.polygon.forEach((pt, i) => (i ? m.lineTo(pt.x * W, pt.y * H) : m.moveTo(pt.x * W, pt.y * H)))
        m.closePath(); m.fill()
        if (spec.snap) snapMatteToEdges(matte, sample)
        const wrapAt = spec.wrap === 'auto' ? suggestWrapAt(p, matte, W, H).wrapAt : (Number.isFinite(spec.wrap) ? spec.wrap : null)
        ok = renderStretchLayer(lctx, sample, p, W, H, {
            quality: spec.quality || 'max',
            alpha: matteToAlphaCanvas(matte, W, H, 0.006 * Math.min(W, H)),
            coverage: spec.coverage ?? 1,
            wrapAt,
        })
        lastPlan = { wrapAt }
        ctx.drawImage(layer, 0, 0)
    } else ok = renderPixelStretch(ctx, sample, p, W, H, { quality: spec.quality || 'max' })
    if (spec.subjectOverlay) renderSubjectOverlay(ctx, sample, p, W, H)
    // Canvas2D defers work until a readback; one pixel forces it inside the timing.
    ctx.getImageData(0, 0, 1, 1)
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
