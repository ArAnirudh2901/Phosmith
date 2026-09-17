// Collage Composer: content-aware layout solvers. Instead of picking a fixed
// template, each family SOLVES a layout for the actual photos (subject boxes,
// calm space, line direction, importance) and every candidate is scored on how
// well it keeps subjects visible, balances visual weight and builds hierarchy.
// Pure: photos are analysis objects (see analyze.js), canvas is { width, height }.

import {
    mulberry32, clamp, rectPoly, polygonArea, polygonCentroid, polygonBBox,
    clipHalfPlane, insetConvex, pointInPolygon, rotatedRect, shuffleInPlace, clipByConvex,
} from './geometry'

export const FAMILIES = [
    { id: 'mosaic', label: 'Mosaic', min: 2, max: 16, blurb: 'Tiles solved so no subject is cropped' },
    { id: 'shards', label: 'Shards', min: 3, max: 14, blurb: 'Organic cells sized by importance' },
    { id: 'strata', label: 'Strata', min: 2, max: 8, blurb: 'Bands that lean with the photos’ lines' },
    { id: 'orbit', label: 'Orbit', min: 3, max: 9, blurb: 'A hero with photos in orbit' },
    { id: 'drift', label: 'Prints', min: 2, max: 12, blurb: 'Loose prints that never hide a subject' },
    { id: 'lens', label: 'Lens', min: 2, max: 6, blurb: 'Photos set into the hero’s empty space' },
    { id: 'silhouette', label: 'Silhouette', min: 2, max: 12, blurb: 'Every photo packed inside a shape: your subject, a word or a symbol', needsContainer: true },
    { id: 'tapestry', label: 'Tapestry', min: 2, max: 12, blurb: 'No borders: photos dissolve into each other along quiet seams' },
]

export const DEFAULT_SPEC = {
    family: 'auto',
    seed: 1,
    hero: null,
    order: null,
    gutter: 0.016,  // × canvas short side
    margin: 0.04,   // × canvas short side
    corner: 0.03,   // × cell short side
    angle: null,    // strata lean in degrees (null = from the photos)
    tilt: 7,        // prints max rotation in degrees
    density: 0.72,  // prints/orbit fill target
    mat: 0.03,      // print border × canvas short side
}

const hashSeed = (...parts) => {
    let h = 2166136261
    for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
    return h >>> 0
}

const frameOf = (canvas, spec) => {
    const W = canvas.width, H = canvas.height, S = Math.min(W, H)
    const m = clamp(spec.margin, 0, 0.2) * S
    return { W, H, S, g: clamp(spec.gutter, 0, 0.08) * S, inner: { x: m, y: m, w: W - 2 * m, h: H - 2 * m } }
}

export const pickHero = (photos, spec) => {
    if (Number.isInteger(spec.hero) && spec.hero >= 0 && spec.hero < photos.length) return spec.hero
    let best = 0
    photos.forEach((p, i) => {
        if (p.weight * (0.6 + 0.4 * p.quality) > photos[best].weight * (0.6 + 0.4 * photos[best].quality)) best = i
    })
    return best
}

const importance = (photos, hero) => photos.map((p, i) => (0.35 + p.weight) * (i === hero ? 1.8 : 1))

// Where to centre the crop: between the subject box centre and the saliency peak.
export const focusTarget = (p) => ({
    x: 0.6 * ((p.box.x0 + p.box.x1) / 2) + 0.4 * p.focus.x,
    y: 0.6 * ((p.box.y0 + p.box.y1) / 2) + 0.4 * p.focus.y,
})

/** Visible window (photo-normalised) when a photo covers a cw×ch cell centred on its focus. */
export const coverWindow = (aspect, cw, ch, focus) => {
    const ca = cw / Math.max(1e-6, ch)
    let vw = 1, vh = 1
    if (ca > aspect) vh = aspect / ca
    else vw = ca / aspect
    const x0 = clamp(focus.x - vw / 2, 0, 1 - vw)
    const y0 = clamp(focus.y - vh / 2, 0, 1 - vh)
    return { x0, y0, x1: x0 + vw, y1: y0 + vh, vw, vh }
}

const boxVisibleFraction = (box, win) => {
    const ix = Math.max(0, Math.min(box.x1, win.x1) - Math.max(box.x0, win.x0))
    const iy = Math.max(0, Math.min(box.y1, win.y1) - Math.max(box.y0, win.y0))
    const area = Math.max(1e-6, (box.x1 - box.x0) * (box.y1 - box.y0))
    return clamp((ix * iy) / area, 0, 1)
}

const orderedByImportance = (imp) => imp.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i)

// Hero first, then each next photo is the closest in average colour, so
// neighbouring cells hand the eye from one palette to the next.
export const colorFlowOrder = (photos, hero) => {
    const col = (p) => (p.mean ? [p.mean.r, p.mean.g, p.mean.b] : [0.5, 0.5, 0.5])
    const chain = [hero]
    const left = new Set(photos.map((_, i) => i).filter((i) => i !== hero))
    while (left.size) {
        const last = col(photos[chain[chain.length - 1]])
        let best = null, bestD = Infinity
        for (const i of left) {
            const c = col(photos[i])
            const d = (c[0] - last[0]) ** 2 + (c[1] - last[1]) ** 2 + (c[2] - last[2]) ** 2
            if (d < bestD) { bestD = d; best = i }
        }
        chain.push(best)
        left.delete(best)
    }
    return chain
}

/* ── Mosaic: slicing-tree tiling where each leaf aspect keeps its subject whole ── */

const safeAspectRange = (p) => [p.aspect * Math.max(0.05, p.box.x1 - p.box.x0), p.aspect / Math.max(0.05, p.box.y1 - p.box.y0)]

const leafCost = (p, w, h) => {
    const c = w / Math.max(1e-6, h)
    const [lo, hi] = safeAspectRange(p)
    let cost = 0
    if (c < lo) cost += Math.log(lo / c) ** 2 * 5
    if (c > hi) cost += Math.log(c / hi) ** 2 * 5
    cost += Math.log(c / p.aspect) ** 2 * 0.3
    if (c > 3 || c < 1 / 3) cost += 3
    return cost
}

const mosaic = (photos, canvas, spec, rand) => {
    const { inner, g } = frameOf(canvas, spec)
    const hero = pickHero(photos, spec)
    const imp = importance(photos, hero)
    const base = Array.isArray(spec.order) && spec.order.length === photos.length ? spec.order.slice() : colorFlowOrder(photos, hero)
    const trials = photos.length <= 8 ? 700 : 350
    let best = null

    const split = (items, r, out) => {
        if (items.length === 1) {
            out.push({ index: items[0], kind: 'rect', x: r.x, y: r.y, w: r.w, h: r.h })
            return leafCost(photos[items[0]], r.w, r.h) * (0.6 + imp[items[0]])
        }
        const k = 1 + Math.floor(rand() * (items.length - 1))
        const a = items.slice(0, k)
        const b = items.slice(k)
        const wa = a.reduce((s, i) => s + imp[i], 0)
        const t = wa / (wa + b.reduce((s, i) => s + imp[i], 0))
        const vertical = r.w >= r.h ? rand() < 0.75 : rand() < 0.25
        if (vertical) {
            const w1 = (r.w - g) * t
            return split(a, { x: r.x, y: r.y, w: w1, h: r.h }, out)
                + split(b, { x: r.x + w1 + g, y: r.y, w: r.w - g - w1, h: r.h }, out)
        }
        const h1 = (r.h - g) * t
        return split(a, { x: r.x, y: r.y, w: r.w, h: h1 }, out)
            + split(b, { x: r.x, y: r.y + h1 + g, w: r.w, h: r.h - g - h1 }, out)
    }

    for (let trial = 0; trial < trials; trial += 1) {
        const items = trial === 0 ? base.slice() : shuffleInPlace(base.slice(), rand)
        const cells = []
        let cost = split(items, inner, cells)
        const heroCell = cells.find((c) => c.index === hero)
        if (heroCell && cells.some((c) => c.w * c.h > heroCell.w * heroCell.h * 1.02)) cost += 2
        if (!best || cost < best.cost) best = { cost, cells }
    }
    const corner = clamp(spec.corner, 0, 0.5)
    return { cells: best.cells.map((c) => ({ ...c, radius: corner, z: 0 })), hero }
}

/* ── Shards: capacity-constrained power diagram (weighted Voronoi) ── */

const powerCell = (i, sites, weights, innerPoly) => {
    let poly = innerPoly
    const pi = sites[i]
    for (let j = 0; j < sites.length && poly.length >= 3; j += 1) {
        if (j === i) continue
        const pj = sites[j]
        poly = clipHalfPlane(
            poly,
            2 * (pj.x - pi.x),
            2 * (pj.y - pi.y),
            (pj.x * pj.x + pj.y * pj.y - weights[j]) - (pi.x * pi.x + pi.y * pi.y - weights[i]),
        )
    }
    return poly
}

const shards = (photos, canvas, spec, rand) => {
    const { inner, g } = frameOf(canvas, spec)
    const n = photos.length
    const hero = pickHero(photos, spec)
    const imp = importance(photos, hero)
    const innerPoly = rectPoly(inner.x, inner.y, inner.w, inner.h)
    const total = imp.reduce((s, v) => s + v, 0)
    const areaTotal = inner.w * inner.h
    const targets = imp.map((v) => (v / total) * areaTotal)

    const golden = [[0.382, 0.382], [0.618, 0.382], [0.382, 0.618], [0.618, 0.618]][Math.floor(rand() * 4)]
    const sites = []
    sites[hero] = { x: inner.x + inner.w * golden[0], y: inner.y + inner.h * golden[1] }
    for (let i = 0; i < n; i += 1) {
        if (i === hero) continue
        let bestPt = null, bestD = -1
        for (let c = 0; c < 14; c += 1) {
            const pt = { x: inner.x + rand() * inner.w, y: inner.y + rand() * inner.h }
            const d = Math.min(...sites.filter(Boolean).map((s) => Math.hypot(s.x - pt.x, s.y - pt.y)))
            if (d > bestD) { bestD = d; bestPt = pt }
        }
        sites[i] = bestPt
    }
    const weights = new Array(n).fill(0)
    const D2 = areaTotal / n
    let polys = []
    for (let iter = 0; iter < 60; iter += 1) {
        polys = sites.map((_, i) => powerCell(i, sites, weights, innerPoly))
        for (let i = 0; i < n; i += 1) {
            const poly = polys[i]
            const area = poly.length >= 3 ? Math.abs(polygonArea(poly)) : 0
            if (area < 1) { weights[i] += 0.3 * D2; continue }
            weights[i] += clamp(0.4 * D2 * (targets[i] / area - 1), -0.5 * D2, 0.5 * D2)
            const c = polygonCentroid(poly)
            // Partial relaxation keeps the cells irregular (full Lloyd converges to near-rectangles).
            sites[i] = { x: sites[i].x + (c.x - sites[i].x) * 0.28, y: sites[i].y + (c.y - sites[i].y) * 0.28 }
        }
        const mean = weights.reduce((s, v) => s + v, 0) / n
        for (let i = 0; i < n; i += 1) weights[i] -= mean
    }
    const cells = polys.map((poly, index) => {
        const inset = poly.length >= 3 ? (insetConvex(poly, g / 2) || poly) : rectPoly(inner.x, inner.y, 1, 1)
        const bb = polygonBBox(inset)
        return { index, kind: 'poly', points: inset, x: bb.x, y: bb.y, w: bb.w, h: bb.h, z: 0 }
    })
    return { cells, hero }
}

/* ── Strata: slanted bands leaning with the photos' dominant lines ── */

const strataBands = (photos, indices, rect, spec, rand, imp, g, landscape) => {
    const k = indices.length
    let tilt = spec.angle
    if (!Number.isFinite(tilt)) {
        const strength = indices.reduce((s, i) => s + photos[i].lineStrength, 0) / k
        const lean = indices.reduce((s, i) => s + photos[i].lineAngle * photos[i].lineStrength, 0)
        const sign = Math.abs(lean) < 1 ? (rand() < 0.5 ? -1 : 1) : Math.sign(lean)
        tilt = sign * (12 + 16 * clamp(strength, 0, 1))
    }
    tilt = clamp(tilt, -35, 35)
    const phi = ((landscape ? 0 : 90) + tilt) * (Math.PI / 180)
    const nx = Math.cos(phi), ny = Math.sin(phi)
    const poly = rectPoly(rect.x, rect.y, rect.w, rect.h)
    const proj = poly.map((p) => p.x * nx + p.y * ny)
    const tmin = Math.min(...proj), tmax = Math.max(...proj)
    // Colour-flow chain from the most important photo, placed centre-out: 3 1 0 2 4
    const anchor = indices.slice().sort((a, b) => imp[b] - imp[a])[0]
    const sorted = colorFlowOrder(photos, anchor).filter((i) => indices.includes(i))
    const seq = []
    sorted.forEach((idx, i) => { if (i % 2 === 0) seq.push(idx); else seq.unshift(idx) })
    const targetArea = seq.map((i) => imp[i])
    const tsum = targetArea.reduce((s, v) => s + v, 0)
    let lens = targetArea.map((v) => (v / tsum) * (tmax - tmin - g * (k - 1)))
    let bands = []
    for (let iter = 0; iter < 8; iter += 1) {
        bands = []
        let t = tmin
        for (let i = 0; i < k; i += 1) {
            const a = t, b = t + lens[i]
            let band = clipHalfPlane(poly, -nx, -ny, -a)
            band = clipHalfPlane(band, nx, ny, b)
            bands.push(band)
            t = b + g
        }
        const areas = bands.map((b) => (b.length >= 3 ? Math.abs(polygonArea(b)) : 1))
        const areaSum = areas.reduce((s, v) => s + v, 0)
        lens = lens.map((l, i) => l * clamp(Math.sqrt(((targetArea[i] / tsum) * areaSum) / areas[i]), 0.7, 1.4))
        const scale = (tmax - tmin - g * (k - 1)) / lens.reduce((s, v) => s + v, 0)
        lens = lens.map((l) => l * scale)
    }
    return bands.map((points, i) => {
        const bb = polygonBBox(points)
        return { index: seq[i], kind: 'poly', points, x: bb.x, y: bb.y, w: bb.w, h: bb.h, z: 0 }
    })
}

const strata = (photos, canvas, spec, rand) => {
    const { inner, g } = frameOf(canvas, spec)
    const hero = pickHero(photos, spec)
    const imp = importance(photos, hero)
    const landscape = inner.w >= inner.h
    const all = photos.map((_, i) => i)
    if (photos.length <= 5) return { cells: strataBands(photos, all, inner, spec, rand, imp, g, landscape), hero }
    // Two tiers across the short axis; hero tier gets more room.
    const byImp = orderedByImportance(imp)
    const a = byImp.filter((_, i) => i % 2 === 0)
    const b = byImp.filter((_, i) => i % 2 === 1)
    const sa = a.reduce((s, i) => s + imp[i], 0), sb = b.reduce((s, i) => s + imp[i], 0)
    const t = sa / (sa + sb)
    const tiers = landscape
        ? [{ x: inner.x, y: inner.y, w: inner.w, h: (inner.h - g) * t }, { x: inner.x, y: inner.y + (inner.h - g) * t + g, w: inner.w, h: (inner.h - g) * (1 - t) }]
        : [{ x: inner.x, y: inner.y, w: (inner.w - g) * t, h: inner.h }, { x: inner.x + (inner.w - g) * t + g, y: inner.y, w: (inner.w - g) * (1 - t), h: inner.h }]
    return {
        cells: [
            ...strataBands(photos, a, tiers[0], spec, rand, imp, g, landscape),
            ...strataBands(photos, b, tiers[1], { ...spec, angle: Number.isFinite(spec.angle) ? -spec.angle : null }, rand, imp, g, landscape),
        ],
        hero,
    }
}

/* ── Orbit: hero disc with satellites relaxed around it ── */

const orbit = (photos, canvas, spec, rand) => {
    const { inner, g } = frameOf(canvas, spec)
    const n = photos.length
    const hero = pickHero(photos, spec)
    const imp = importance(photos, hero)
    const S = Math.min(inner.w, inner.h)
    const density = clamp(spec.density, 0.4, 1)
    const heroR = S * (0.25 + 0.08 * density)
    const spots = inner.w >= inner.h
        ? [[0.5, 0.5], [0.42, 0.5], [0.58, 0.5]]
        : [[0.5, 0.5], [0.5, 0.44], [0.5, 0.56]]
    const spot = spots[Math.floor(rand() * spots.length)]
    const center = { x: inner.x + inner.w * spot[0], y: inner.y + inner.h * spot[1] }
    const others = orderedByImportance(imp).filter((i) => i !== hero)
    const maxImp = Math.max(...others.map((i) => imp[i]))
    const crowd = Math.sqrt(Math.min(1, 5.5 / Math.max(1, others.length)))
    const radii = []
    radii[hero] = heroR
    others.forEach((i) => { radii[i] = S * (0.08 + 0.1 * Math.sqrt(imp[i] / maxImp)) * (0.8 + 0.35 * density) * crowd })
    const ex = clamp(inner.w / inner.h, 1, 1.7), ey = clamp(inner.h / inner.w, 1, 1.7)
    const pos = []
    pos[hero] = { ...center }
    let ang = rand() * Math.PI * 2
    const ringMean = heroR + g + others.reduce((s, i) => s + radii[i], 0) / others.length
    others.forEach((i, k) => {
        const d = heroR + g * 2 + radii[i]
        pos[i] = { x: center.x + Math.cos(ang) * d * ex, y: center.y + Math.sin(ang) * d * ey }
        const next = others[k + 1]
        ang += next === undefined ? 0 : (radii[i] + radii[next] + g * 2) / ringMean + (rand() - 0.5) * 0.25
    })
    const keepIn = (i) => {
        pos[i].x = clamp(pos[i].x, inner.x + radii[i], inner.x + inner.w - radii[i])
        pos[i].y = clamp(pos[i].y, inner.y + radii[i], inner.y + inner.h - radii[i])
    }
    for (let iter = 0; iter < 120; iter += 1) {
        for (let i = 0; i < n; i += 1) {
            for (let j = i + 1; j < n; j += 1) {
                const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y
                const d = Math.hypot(dx, dy) || 1e-3
                const min = radii[i] + radii[j] + g
                if (d >= min) continue
                const push = (min - d) / 2
                const wi = i === hero ? 0.12 : 1, wj = j === hero ? 0.12 : 1
                pos[i].x -= (dx / d) * push * wi; pos[i].y -= (dy / d) * push * wi
                pos[j].x += (dx / d) * push * wj; pos[j].y += (dy / d) * push * wj
            }
        }
        for (let i = 0; i < n; i += 1) keepIn(i)
    }
    const cells = photos.map((_, i) => ({
        index: i, kind: 'ellipse', x: pos[i].x - radii[i], y: pos[i].y - radii[i], w: radii[i] * 2, h: radii[i] * 2, z: i === hero ? 0 : 1,
    }))
    return { cells, hero }
}

/* ── Prints: rotated full-frame prints annealed so none hides another's subject ── */

const printFootprint = (c) => rotatedRect(c.cx, c.cy, c.w + 2 * c.mat, c.h + 2 * c.mat, c.angle)

const subjectSamples = (p, c) => {
    const pts = []
    const r = (c.angle * Math.PI) / 180, co = Math.cos(r), si = Math.sin(r)
    for (let a = 0; a < 3; a += 1) for (let b = 0; b < 3; b += 1) {
        const u = p.box.x0 + ((a + 0.5) / 3) * (p.box.x1 - p.box.x0) - 0.5
        const v = p.box.y0 + ((b + 0.5) / 3) * (p.box.y1 - p.box.y0) - 0.5
        const lx = u * c.w, ly = v * c.h
        pts.push({ x: c.cx + lx * co - ly * si, y: c.cy + lx * si + ly * co })
    }
    return pts
}

const drift = (photos, canvas, spec, rand) => {
    const { inner, S } = frameOf(canvas, spec)
    const n = photos.length
    const hero = pickHero(photos, spec)
    const imp = importance(photos, hero)
    const fill = clamp(spec.density, 0.4, 0.95)
    const mat = clamp(spec.mat, 0, 0.08) * S
    const tilt = clamp(spec.tilt, 0, 20)
    const total = imp.reduce((s, v) => s + v, 0)
    const areaAll = inner.w * inner.h * fill * 0.92
    const zOrder = orderedByImportance(imp).reverse()
    const cells = photos.map((p, i) => {
        const a = (imp[i] / total) * areaAll
        let w = Math.sqrt(a * p.aspect), h = Math.sqrt(a / p.aspect)
        const fit = Math.min(1, (inner.w * 0.62 - 2 * mat) / w, (inner.h * 0.62 - 2 * mat) / h)
        w *= fit; h *= fit
        return { index: i, kind: 'print', w, h, mat, angle: (rand() * 2 - 1) * tilt * (i === hero ? 0.35 : 1), z: zOrder.indexOf(i), cx: 0, cy: 0 }
    })
    const cols = Math.ceil(Math.sqrt(n * (inner.w / inner.h)))
    const rows = Math.ceil(n / cols)
    const slots = shuffleInPlace(Array.from({ length: cols * rows }, (_, k) => k), rand)
    cells.forEach((c, k) => {
        const slot = c.index === hero ? Math.floor((rows / 2)) * cols + Math.floor(cols / 2) : slots[k]
        c.cx = inner.x + ((slot % cols) + 0.5 + (rand() - 0.5) * 0.4) * (inner.w / cols)
        c.cy = inner.y + (Math.floor(slot / cols) + 0.5 + (rand() - 0.5) * 0.4) * (inner.h / rows)
    })
    const innerPoly = rectPoly(inner.x, inner.y, inner.w, inner.h)
    const cost = () => {
        let occl = 0, bounds = 0
        const foot = cells.map(printFootprint)
        cells.forEach((c, i) => {
            for (const pt of foot[i]) {
                if (pointInPolygon(pt, innerPoly)) continue
                const dx = Math.max(inner.x - pt.x, 0, pt.x - inner.x - inner.w)
                const dy = Math.max(inner.y - pt.y, 0, pt.y - inner.y - inner.h)
                bounds += 1 + (dx + dy) / (S * 0.05)
            }
            const samples = subjectSamples(photos[c.index], c)
            cells.forEach((d, j) => {
                if (d.z <= c.z) return
                let hit = 0
                for (const pt of samples) if (pointInPolygon(pt, foot[j])) hit += 1
                occl += (hit / samples.length) * imp[c.index]
            })
        })
        let covered = 0
        const G = 14
        for (let gy = 0; gy < G; gy += 1) for (let gx = 0; gx < G; gx += 1) {
            const pt = { x: inner.x + ((gx + 0.5) / G) * inner.w, y: inner.y + ((gy + 0.5) / G) * inner.h }
            if (foot.some((f) => pointInPolygon(pt, f))) covered += 1
        }
        const cover = covered / (G * G)
        let wx = 0, wy = 0, ws = 0
        cells.forEach((c) => { const a = c.w * c.h * imp[c.index]; wx += c.cx * a; wy += c.cy * a; ws += a })
        const bal = Math.hypot(wx / ws / canvas.width - 0.5, wy / ws / canvas.height - 0.5)
        return occl * 6 + bounds * 4 + (fill - cover) ** 2 * 8 + bal * bal * 10
    }
    let current = cost()
    let T = 1
    const iters = 700 + n * 60
    for (let it = 0; it < iters; it += 1) {
        const c = cells[Math.floor(rand() * n)]
        const prev = { cx: c.cx, cy: c.cy, angle: c.angle }
        const step = S * 0.12 * T
        c.cx += (rand() * 2 - 1) * step
        c.cy += (rand() * 2 - 1) * step
        if (rand() < 0.2) c.angle = clamp(c.angle + (rand() * 2 - 1) * 3, -tilt, tilt)
        const next = cost()
        if (next <= current || rand() < Math.exp((current - next) / Math.max(1e-3, T * 0.4))) current = next
        else Object.assign(c, prev)
        T = Math.max(0.02, T * 0.995)
    }
    return {
        cells: cells.map((c) => {
            const bb = polygonBBox(printFootprint(c))
            return { ...c, x: bb.x, y: bb.y, bw: bb.w, bh: bb.h }
        }),
        hero,
    }
}

/* ── Lens: hero full-bleed, other photos set into its calm space ── */

const lens = (photos, canvas, spec) => {
    const { inner, g, S } = frameOf(canvas, spec)
    const hero = pickHero(photos, spec)
    const imp = importance(photos, hero)
    const hp = photos[hero]
    const win = coverWindow(hp.aspect, inner.w, inner.h, focusTarget(hp))
    const toCanvas = (u, v) => ({
        x: inner.x + ((u - win.x0) / win.vw) * inner.w,
        y: inner.y + ((v - win.y0) / win.vh) * inner.h,
    })
    const a = toCanvas(hp.calm.x0, hp.calm.y0)
    const b = toCanvas(hp.calm.x1, hp.calm.y1)
    let zone = {
        x: clamp(Math.min(a.x, b.x), inner.x, inner.x + inner.w),
        y: clamp(Math.min(a.y, b.y), inner.y, inner.y + inner.h),
    }
    zone.w = clamp(Math.max(a.x, b.x), inner.x, inner.x + inner.w) - zone.x
    zone.h = clamp(Math.max(a.y, b.y), inner.y, inner.y + inner.h) - zone.y
    if (zone.w * zone.h < inner.w * inner.h * 0.14) {
        const side = hp.openSide === 'left' ? 'left' : 'right'
        const w = inner.w * 0.36
        zone = { x: side === 'left' ? inner.x : inner.x + inner.w - w, y: inner.y, w, h: inner.h }
    }
    const pad = Math.max(g, S * 0.03)
    zone = { x: zone.x + pad, y: zone.y + pad, w: Math.max(10, zone.w - 2 * pad), h: Math.max(10, zone.h - 2 * pad) }
    const insets = orderedByImportance(imp).filter((i) => i !== hero)
    const k = insets.length
    let bestGrid = null
    for (let cols = 1; cols <= k; cols += 1) {
        const rows = Math.ceil(k / cols)
        const cw = (zone.w - g * (cols - 1)) / cols
        const ch = (zone.h - g * (rows - 1)) / rows
        if (cw <= 4 || ch <= 4) continue
        const cost = insets.reduce((s, i) => s + leafCost(photos[i], cw, ch), 0) + (cols * rows - k) * 0.4
        if (!bestGrid || cost < bestGrid.cost) bestGrid = { cols, rows, cw, ch, cost }
    }
    const { cols, rows, cw, ch } = bestGrid || { cols: 1, rows: k, cw: zone.w, ch: zone.h / k }
    // Shrink insets a touch so the hero still reads around them.
    const shrink = 0.9
    const cells = [{ index: hero, kind: 'rect', x: inner.x, y: inner.y, w: inner.w, h: inner.h, radius: clamp(spec.corner, 0, 0.5) * 0.5, z: 0 }]
    insets.forEach((idx, n) => {
        const col = n % cols, row = Math.floor(n / cols)
        const w = cw * shrink, h = ch * shrink
        const x = zone.x + col * (cw + g) + (cw - w) / 2
        const y = zone.y + row * (ch + g) + (ch - h) / 2
        cells.push({ index: idx, kind: 'rect', x, y, w, h, radius: Math.max(0.06, clamp(spec.corner, 0, 0.5)), z: 1 + n, inset: true })
    })
    return { cells, hero }
}


/* ── Silhouette: weighted cells packed inside a shape (subject outline, word, symbol) ── */

const piecesArea = (pieces) => pieces.reduce((s, p) => s + Math.abs(polygonArea(p)), 0)

const piecesCentroid = (pieces) => {
    let cx = 0, cy = 0, a = 0
    for (const p of pieces) {
        const pa = Math.abs(polygonArea(p))
        const c = polygonCentroid(p)
        cx += c.x * pa; cy += c.y * pa; a += pa
    }
    return a > 0 ? { x: cx / a, y: cy / a } : null
}

const silhouette = (photos, canvas, spec, rand) => {
    const shape = spec.container
    if (!shape?.polygons?.length) return mosaic(photos, canvas, spec, rand)
    const { inner, g } = frameOf(canvas, spec)
    const n = photos.length
    const hero = pickHero(photos, spec)
    const imp = importance(photos, hero)
    const aspect = clamp(Number(shape.aspect) || 1, 0.1, 10)
    const bw = Math.min(inner.w, inner.h * aspect), bh = bw / aspect
    const bx = inner.x + (inner.w - bw) / 2, by = inner.y + (inner.h - bh) / 2
    const container = shape.polygons
        .map((poly) => poly.map((p) => ({ x: bx + p.x * bw, y: by + p.y * bh })))
        .filter((poly) => poly.length >= 3 && Math.abs(polygonArea(poly)) > 4)
    if (!container.length) return mosaic(photos, canvas, spec, rand)
    const areaTotal = container.reduce((s, poly) => s + Math.abs(polygonArea(poly)), 0)
    const total = imp.reduce((s, v) => s + v, 0)
    const targets = imp.map((v) => (v / total) * areaTotal)
    const boxPoly = rectPoly(bx, by, bw, bh)
    const inside = (pt) => container.some((poly) => pointInPolygon(pt, poly))
    const sample = () => {
        for (let k = 0; k < 300; k += 1) {
            const pt = { x: bx + rand() * bw, y: by + rand() * bh }
            if (inside(pt)) return pt
        }
        return { x: bx + bw / 2, y: by + bh / 2 }
    }
    const order = [hero, ...orderedByImportance(imp).filter((i) => i !== hero)]
    const sites = []
    for (const i of order) {
        let bestPt = null, bestD = -1
        for (let c = 0; c < 20; c += 1) {
            const pt = sample()
            const placed = sites.filter(Boolean)
            const d = placed.length ? Math.min(...placed.map((q) => Math.hypot(q.x - pt.x, q.y - pt.y))) : Math.hypot(pt.x - (bx + bw / 2), pt.y - (by + bh / 2)) * -1
            if (d > bestD || bestPt === null) { bestD = d; bestPt = pt }
        }
        sites[i] = bestPt
    }
    const weights = new Array(n).fill(0)
    const D2 = areaTotal / n
    const piecesFor = (i, clipCell) => (clipCell.length >= 3
        ? container.map((poly) => clipByConvex(poly, clipCell)).filter((p) => p.length >= 3 && Math.abs(polygonArea(p)) > 1)
        : [])
    for (let iter = 0; iter < 70; iter += 1) {
        for (let i = 0; i < n; i += 1) {
            const pieces = piecesFor(i, powerCell(i, sites, weights, boxPoly))
            const area = piecesArea(pieces)
            if (area < 1) { weights[i] += 0.35 * D2; continue }
            weights[i] += clamp(0.4 * D2 * (targets[i] / area - 1), -0.5 * D2, 0.5 * D2)
            const c = piecesCentroid(pieces)
            if (c) {
                const next = { x: sites[i].x + (c.x - sites[i].x) * 0.3, y: sites[i].y + (c.y - sites[i].y) * 0.3 }
                if (inside(next)) sites[i] = next
            }
        }
        const mean = weights.reduce((s, v) => s + v, 0) / n
        for (let i = 0; i < n; i += 1) weights[i] -= mean
    }
    const cells = photos.map((_, i) => {
        const raw = powerCell(i, sites, weights, boxPoly)
        const cell = raw.length >= 3 ? (insetConvex(raw, g / 2) || raw) : raw
        const pieces = piecesFor(i, cell)
        const bb = polygonBBox(pieces.flat().length ? pieces.flat() : rectPoly(sites[i].x, sites[i].y, 1, 1))
        return { index: i, kind: 'multi', pieces, x: bb.x, y: bb.y, w: Math.max(1, bb.w), h: Math.max(1, bb.h), z: 0 }
    })
    return { cells, hero, container }
}

/* ── Tapestry: gutterless tiling whose seams wander along low-contrast paths ── */

const photoColorAt = (p, cell, x, y) => {
    if (!p.pixels || !p.tw) return null
    const win = coverWindow(p.aspect, cell.w, cell.h, focusTarget(p))
    const u = clamp(win.x0 + ((x - cell.x) / cell.w) * win.vw, 0, 0.9999)
    const v = clamp(win.y0 + ((y - cell.y) / cell.h) * win.vh, 0, 0.9999)
    const i = (Math.floor(v * p.th) * p.tw + Math.floor(u * p.tw)) * 4
    return [p.pixels[i], p.pixels[i + 1], p.pixels[i + 2]]
}

const tapestry = (photos, canvas, spec, rand) => {
    const base = mosaic(photos, canvas, { ...spec, gutter: 0, margin: Math.min(spec.margin, 0.02) }, rand)
    const S = Math.min(canvas.width, canvas.height)
    const band = S * clamp(Number(spec.blend) || 0.07, 0.02, 0.14)
    const cells = base.cells.map((c, z) => ({ ...c, radius: 0, z, core: { x: c.x, y: c.y, w: c.w, h: c.h }, ramps: [] }))
    const eps = Math.max(1, S * 0.002)
    const pairs = []
    for (const a of cells) {
        for (const b of cells) {
            if (a === b) continue
            const oy = Math.min(a.core.y + a.core.h, b.core.y + b.core.h) - Math.max(a.core.y, b.core.y)
            const ox = Math.min(a.core.x + a.core.w, b.core.x + b.core.w) - Math.max(a.core.x, b.core.x)
            if (Math.abs(a.core.x + a.core.w - b.core.x) < eps && oy > band) pairs.push({ axis: 'x', first: a, second: b, at: b.core.x, from: Math.max(a.core.y, b.core.y), to: Math.min(a.core.y + a.core.h, b.core.y + b.core.h) })
            if (Math.abs(a.core.y + a.core.h - b.core.y) < eps && ox > band) pairs.push({ axis: 'y', first: a, second: b, at: b.core.y, from: Math.max(a.core.x, b.core.x), to: Math.min(a.core.x + a.core.w, b.core.x + b.core.w) })
        }
    }
    // Expand both sides into the shared band.
    const grow = (cell, side, d) => {
        if (side === 'left') { cell.x -= d; cell.w += d }
        if (side === 'right') cell.w += d
        if (side === 'top') { cell.y -= d; cell.h += d }
        if (side === 'bottom') cell.h += d
    }
    for (const pr of pairs) {
        grow(pr.first, pr.axis === 'x' ? 'right' : 'bottom', band / 2)
        grow(pr.second, pr.axis === 'x' ? 'left' : 'top', band / 2)
    }
    const width = band * 0.55
    const R = 20, C = 9
    for (const pr of pairs) {
        const upper = pr.first.z > pr.second.z ? pr.first : pr.second
        const lower = upper === pr.first ? pr.second : pr.first
        const pu = photos[upper.index], pl = photos[lower.index]
        const lo = pr.at - band / 2 + width / 2, hi = pr.at + band / 2 - width / 2
        const cost = []
        for (let r = 0; r < R; r += 1) {
            const t = pr.from + ((r + 0.5) / R) * (pr.to - pr.from)
            const row = []
            for (let c = 0; c < C; c += 1) {
                const s = lo + (c / (C - 1)) * (hi - lo)
                const x = pr.axis === 'x' ? s : t
                const y = pr.axis === 'x' ? t : s
                const cu = photoColorAt(pu, upper, x, y), cl = photoColorAt(pl, lower, x, y)
                row.push(cu && cl ? Math.abs(cu[0] - cl[0]) + Math.abs(cu[1] - cl[1]) + Math.abs(cu[2] - cl[2]) : Math.abs(c - (C - 1) / 2))
            }
            cost.push(row)
        }
        // DP seam: one column per row, moving at most one column between rows.
        const acc = cost.map((row) => row.slice())
        const from = cost.map((row) => row.map(() => 0))
        for (let r = 1; r < R; r += 1) {
            for (let c = 0; c < C; c += 1) {
                let bestC = c
                for (const d of [-1, 1]) if (c + d >= 0 && c + d < C && acc[r - 1][c + d] < acc[r - 1][bestC]) bestC = c + d
                acc[r][c] += acc[r - 1][bestC]
                from[r][c] = bestC
            }
        }
        let cEnd = 0
        for (let c = 1; c < C; c += 1) if (acc[R - 1][c] < acc[R - 1][cEnd]) cEnd = c
        const seam = new Array(R)
        for (let r = R - 1; r >= 0; r -= 1) { seam[r] = lo + (cEnd / (C - 1)) * (hi - lo); cEnd = from[r][cEnd] }
        // Upper photo fades in toward its own side of the seam.
        upper.ramps.push({ axis: pr.axis, from: pr.from, to: pr.to, seam, width, towardPositive: upper === pr.second })
    }
    // Rasterise each cell's alpha (≤128 px on the long side).
    for (const cell of cells) {
        if (!cell.ramps.length) continue
        const k = 128 / Math.max(cell.w, cell.h)
        const mw = Math.max(4, Math.round(cell.w * k)), mh = Math.max(4, Math.round(cell.h * k))
        const data = new Uint8ClampedArray(mw * mh).fill(255)
        for (let yy = 0; yy < mh; yy += 1) {
            for (let xx = 0; xx < mw; xx += 1) {
                const x = cell.x + ((xx + 0.5) / mw) * cell.w
                const y = cell.y + ((yy + 0.5) / mh) * cell.h
                let a = 1
                for (const rp of cell.ramps) {
                    const along = rp.axis === 'x' ? y : x
                    const across = rp.axis === 'x' ? x : y
                    const t = clamp((along - rp.from) / Math.max(1, rp.to - rp.from), 0, 0.9999)
                    const seamAt = rp.seam[Math.floor(t * rp.seam.length)]
                    let v = clamp((across - (seamAt - rp.width / 2)) / rp.width, 0, 1)
                    v = v * v * (3 - 2 * v)
                    a *= rp.towardPositive ? v : 1 - v
                }
                data[yy * mw + xx] = Math.round(a * 255)
            }
        }
        cell.mask = { w: mw, h: mh, data }
    }
    return { cells: cells.map((c) => { const out = { ...c }; delete out.ramps; return out }), hero: base.hero }
}

const SOLVERS = { mosaic, shards, strata, orbit, drift, lens, silhouette, tapestry }

/* ── Scoring ── */

const cellArea = (c) => {
    if (c.kind === 'multi') return piecesArea(c.pieces)
    if (c.kind === 'poly') return Math.abs(polygonArea(c.points))
    if (c.kind === 'ellipse') return (Math.PI / 4) * c.w * c.h
    return c.w * c.h
}

const cellContains = (c, pt) => {
    if (c.kind === 'multi') return c.pieces.some((p) => pointInPolygon(pt, p))
    if (c.kind === 'poly') return pointInPolygon(pt, c.points)
    if (c.kind === 'ellipse') {
        const rx = c.w / 2, ry = c.h / 2
        return ((pt.x - c.x - rx) / rx) ** 2 + ((pt.y - c.y - ry) / ry) ** 2 <= 1
    }
    if (c.kind === 'print') return pointInPolygon(pt, printFootprint(c))
    return pt.x >= c.x && pt.x <= c.x + c.w && pt.y >= c.y && pt.y <= c.y + c.h
}

const cellCenter = (c) => (c.kind === 'print' ? { x: c.cx, y: c.cy } : c.kind === 'poly' ? polygonCentroid(c.points) : { x: c.x + c.w / 2, y: c.y + c.h / 2 })

const FILL_TARGET = { mosaic: 0.9, shards: 0.9, strata: 0.88, orbit: 0.5, drift: 0.7, lens: 0.95, silhouette: 0.5, tapestry: 0.97 }

export const scoreLayout = (layout, photos, canvas) => {
    const { cells, family, hero } = layout
    const hi = importance(photos, hero)
    let safe = 0, isum = 0
    for (const c of cells) {
        const p = photos[c.index]
        let vis
        if (c.kind === 'print') {
            const samples = subjectSamples(p, c)
            const blockers = cells.filter((d) => d.kind === 'print' && d.z > c.z).map(printFootprint)
            vis = samples.filter((pt) => !blockers.some((f) => pointInPolygon(pt, f))).length / samples.length
        } else {
            const win = coverWindow(p.aspect, c.w, c.h, focusTarget(p))
            const shape = c.kind === 'poly' || c.kind === 'multi' ? 0.55 + 0.45 * (cellArea(c) / Math.max(1, c.w * c.h)) : c.kind === 'ellipse' ? 0.9 : 1
            vis = boxVisibleFraction(p.box, win) * shape
            // Insets cover part of the hero; charge any overlap with its subject.
            if (c.index === hero && family === 'lens') {
                const sub = { x0: c.x + ((p.box.x0 - win.x0) / win.vw) * c.w, x1: c.x + ((p.box.x1 - win.x0) / win.vw) * c.w, y0: c.y + ((p.box.y0 - win.y0) / win.vh) * c.h, y1: c.y + ((p.box.y1 - win.y0) / win.vh) * c.h }
                let hit = 0, tot = 0
                for (let a = 0; a < 4; a += 1) for (let b = 0; b < 4; b += 1) {
                    const pt = { x: sub.x0 + ((a + 0.5) / 4) * (sub.x1 - sub.x0), y: sub.y0 + ((b + 0.5) / 4) * (sub.y1 - sub.y0) }
                    tot += 1
                    if (cells.some((d) => d.inset && cellContains(d, pt))) hit += 1
                }
                vis *= 1 - hit / tot
            }
        }
        safe += vis * hi[c.index]
        isum += hi[c.index]
    }
    safe /= isum || 1

    let wx = 0, wy = 0, ws = 0
    for (const c of cells) {
        const a = cellArea(c) * hi[c.index]
        const ctr = cellCenter(c)
        wx += ctr.x * a; wy += ctr.y * a; ws += a
    }
    const balance = clamp(1 - Math.hypot(wx / ws / canvas.width - 0.5, wy / ws / canvas.height - 0.5) / 0.25, 0, 1)

    const areas = cells.map((c) => (c.kind === 'print' ? c.w * c.h : cellArea(c)))
    const heroCell = cells.findIndex((c) => c.index === hero)
    const hierarchy = heroCell < 0 ? 0 : clamp(areas[heroCell] / Math.max(...areas), 0, 1)

    let covered = 0
    const G = 20
    for (let gy = 0; gy < G; gy += 1) for (let gx = 0; gx < G; gx += 1) {
        const pt = { x: ((gx + 0.5) / G) * canvas.width, y: ((gy + 0.5) / G) * canvas.height }
        if (cells.some((c) => cellContains(c, pt))) covered += 1
    }
    const fill = covered / (G * G)
    const fillScore = clamp(1 - Math.abs(fill - (FILL_TARGET[family] ?? 0.85)) * 2.5, 0, 1)

    const mean = areas.reduce((s, v) => s + v, 0) / areas.length
    const cv = Math.sqrt(areas.reduce((s, v) => s + (v - mean) ** 2, 0) / areas.length) / (mean || 1)
    const variety = cells.length < 3 ? 0.8 : clamp(1 - Math.abs(cv - 0.45) / 0.45, 0, 1)

    const total = 0.42 * safe + 0.18 * balance + 0.14 * hierarchy + 0.14 * fillScore + 0.12 * variety
    return { total, safe, balance, hierarchy, fill, variety }
}

/** One layout for an explicit family + seed. */
export const composeLayout = (photos, canvas, specIn = {}) => {
    const spec = { ...DEFAULT_SPEC, ...specIn }
    const fam = SOLVERS[spec.family] ? spec.family : 'mosaic'
    const rand = mulberry32(hashSeed(spec.seed, fam, photos.length))
    const { cells, hero } = SOLVERS[fam](photos, canvas, spec, rand)
    const layout = { id: `${fam}-${spec.seed}`, family: fam, seed: spec.seed, spec: { ...spec, container: undefined }, cells, hero, canvas: { width: canvas.width, height: canvas.height } }
    layout.metrics = scoreLayout(layout, photos, canvas)
    layout.score = layout.metrics.total
    return layout
}

/**
 * Ranked, family-diverse candidates. A specific `spec.family` yields seed
 * variations of that family; 'auto' explores every family that fits the count.
 */
export const composeCandidates = (photos, canvas, specIn = {}, { perFamily = 3, limit = 6 } = {}) => {
    const n = photos.length
    if (n < 2) return []
    const spec = { ...DEFAULT_SPEC, ...specIn }
    const families = spec.family && spec.family !== 'auto' && SOLVERS[spec.family]
        ? [spec.family]
        : FAMILIES.filter((f) => n >= f.min && n <= f.max && (!f.needsContainer || spec.container?.polygons?.length)).map((f) => f.id)
    const tries = families.length === 1 ? Math.max(limit, perFamily) : perFamily
    const all = []
    for (const family of families) {
        for (let k = 0; k < tries; k += 1) {
            all.push(composeLayout(photos, canvas, { ...spec, family, seed: hashSeed(spec.seed, family, k) % 100000 }))
        }
    }
    all.sort((a, b) => b.score - a.score)
    const picked = []
    const seen = new Set()
    for (const l of all) {
        if (picked.length >= limit) break
        if (families.length > 1 && seen.has(l.family)) continue
        seen.add(l.family)
        picked.push(l)
    }
    for (const l of all) {
        if (picked.length >= limit) break
        if (!picked.includes(l)) picked.push(l)
    }
    return picked.sort((a, b) => b.score - a.score)
}
