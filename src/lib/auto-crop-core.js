// On-device port of the segment service's /crop/auto strategies
// (services/segment/main.py). Pure: typed arrays in, boxes out, so the
// fallback stays numerically in step with the server and is unit-testable.
// Boxes are [x, y, w, h] in the analysed image's pixels.

export const CROP_SUBJECT_PADDING = 0.08
export const CROP_SUBJECT_TARGET_FRAC = 0.62
export const CROP_SCENE_SPREAD = 0.45
export const CROP_SCENE_BIAS = 0.35
export const CROP_CONTENT_TRIM_THRESH = 16
export const CROP_CONTENT_MIN_FRAC = 0.2
export const CROP_DEPTH_FOREGROUND_PCT = 0.45
export const CROP_THIRDS_SNAP = 0.65

const round4 = (v) => Math.round(v * 1e4) / 1e4
const aspectLabel = (a) => `${a.toFixed(3)}:1`

export const clipBox = ([x, y, w, h], W, H) => {
    const cx = Math.max(0, Math.min(W - 1, x))
    const cy = Math.max(0, Math.min(H - 1, y))
    const cw = Math.max(1, Math.min(W - cx, w))
    const ch = Math.max(1, Math.min(H - cy, h))
    return [Math.round(cx), Math.round(cy), Math.round(cw), Math.round(ch)]
}

/** Tight bbox + centroid + area of mask pixels where `test(value)` holds. */
export const maskStats = (mask, W, H, test = (v) => v > 127) => {
    let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0, sx = 0, sy = 0
    for (let y = 0; y < H; y += 1) {
        const row = y * W
        for (let x = 0; x < W; x += 1) {
            if (!test(mask[row + x])) continue
            n += 1; sx += x; sy += y
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
        }
    }
    if (!n) return null
    return { bbox: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], centroid: [sx / n, sy / n], area: n }
}

const expandBox = ([x, y, w, h], W, H, padFrac) => {
    const pad = Math.max(0, padFrac) * Math.min(w, h)
    return clipBox([x - pad, y - pad, w + 2 * pad, h + 2 * pad], W, H)
}

/** Grow `box` to `aspect` (never cropping it) then shift inside the image toward `anchor`. */
export const fitAspect = (box, aspect, W, H, anchor = null) => {
    const [x, y, w, h] = box
    let nw = w, nh = h
    if (aspect >= w / h) nw = h * aspect
    else nh = w / aspect
    const scale = Math.min(1, W / nw, H / nh)
    nw *= scale
    nh *= scale
    const ax = anchor ? anchor[0] : x + w / 2
    const ay = anchor ? anchor[1] : y + h / 2
    let nx = ax - nw / 2
    let ny = ay - nh / 2
    if (nx < 0) nx = 0
    if (ny < 0) ny = 0
    if (nx + nw > W) nx = W - nw
    if (ny + nh > H) ny = H - nh
    return clipBox([nx, ny, nw, nh], W, H)
}

/** Crop centre giving lead room toward open space without cutting the subject. */
export const composeAnchor = ([cx, cy], [bx, by, bw, bh], cropW, cropH, W, H, snap = CROP_THIRDS_SNAP) => {
    const s = Math.max(0, Math.min(1, snap))
    const axis = (c, b0, bdim, cdim, dim, strength) => {
        const third = b0 + bdim / 2 < dim / 2 ? 1 / 3 : 2 / 3
        let a = c + (0.5 - third) * cdim * strength
        const margin = 0.04 * cdim
        if (cdim >= bdim + 2 * margin) {
            a = Math.min(Math.max(a, b0 + bdim + margin - cdim / 2), b0 - margin + cdim / 2)
        } else {
            a = b0 + bdim / 2
        }
        return cdim <= dim ? Math.min(Math.max(a, cdim / 2), dim - cdim / 2) : dim / 2
    }
    return [axis(cx, bx, bw, cropW, W, s), axis(cy, by, bh, cropH, H, s * 0.5)]
}

export const computeAspectCrop = (W, H, aspect, centroid = null) => {
    if (!(W > 0 && H > 0 && aspect > 0)) return null
    let nw, nh
    if (aspect >= W / H) { nw = W; nh = W / aspect } else { nh = H; nw = H * aspect }
    const [cx, cy] = centroid || [W / 2, H / 2]
    const box = fitAspect(clipBox([cx - nw / 2, cy - nh / 2, nw, nh], W, H), aspect, W, H, [cx, cy])
    return {
        box,
        score: 0.5,
        aspect_ratio: round4(box[2] / box[3]),
        rationale: `max-area fit to ${aspectLabel(aspect)} around ${centroid ? 'subject' : 'centre'}`,
    }
}

/**
 * Composition around a subject matte (uint8 0..255, W×H). `hasSubject` false
 * mirrors the server's saliency-matte path: a sprawling matte composes the scene.
 */
export const computeSubjectCrop = (mask, W, H, { aspect = null, targetFrac = CROP_SUBJECT_TARGET_FRAC, hasSubject = false } = {}) => {
    const stats = mask ? maskStats(mask, W, H) : null
    if (!stats) return null
    const [cx, cy] = stats.centroid
    const [bx, by, bw, bh] = stats.bbox
    const frameArea = W * H || 1
    const spread = (bw * bh) / frameArea
    const coverage = round4(stats.area / frameArea)

    if (!hasSubject && spread >= CROP_SCENE_SPREAD) {
        const bias = Math.max(0, Math.min(1, CROP_SCENE_BIAS))
        const box = aspect
            ? computeAspectCrop(W, H, aspect, [cx * bias + (W / 2) * (1 - bias), cy * bias + (H / 2) * (1 - bias)]).box
            : [0, 0, W, H]
        return {
            box,
            score: round4(Math.min(1, 0.45 + 0.2 * (1 - Math.abs(spread - 0.6)))),
            aspect_ratio: round4(box[2] / box[3]),
            rationale: `scene composition (no distinct subject)${aspect ? `, fitted to ${aspectLabel(aspect)}` : ''}`,
            centroid: [Math.round(cx * 10) / 10, Math.round(cy * 10) / 10],
            subject_coverage: coverage,
            already_tight: (box[2] * box[3]) / frameArea >= 0.92,
        }
    }

    const f = Math.max(0.2, Math.min(0.95, targetFrac))
    let cropW = Math.min(W, bw / f)
    let cropH = Math.min(H, bh / f)
    if (aspect) {
        const fitted = fitAspect(clipBox([bx, by, cropW, cropH], W, H), aspect, W, H)
        cropW = fitted[2]
        cropH = fitted[3]
    }
    const [ax, ay] = composeAnchor([cx, cy], [bx, by, bw, bh], cropW, cropH, W, H)
    const box = clipBox([ax - cropW / 2, ay - cropH / 2, cropW, cropH], W, H)
    const cropArea = box[2] * box[3]
    const cropFrame = cropArea / frameArea
    const share = cropArea > 0 ? stats.area / cropArea : 0
    return {
        box,
        score: round4(Math.min(1, 0.55 + 0.25 * (1 - Math.abs(share - f)) + 0.2 * (1 - cropFrame))),
        aspect_ratio: round4(box[2] / box[3]),
        rationale: `composed around subject (~${Math.round(f * 100)}% frame share, lead-room placed)${aspect ? `, fitted to ${aspectLabel(aspect)}` : ''}`,
        centroid: [Math.round(cx * 10) / 10, Math.round(cy * 10) / 10],
        subject_coverage: coverage,
        already_tight: cropFrame >= 0.92,
    }
}

/** Trim near-solid borders (mats, letterboxes) from RGBA pixels. */
export const computeContentFillCrop = (rgba, W, H, { aspect = null, thresh = CROP_CONTENT_TRIM_THRESH, minFrac = CROP_CONTENT_MIN_FRAC } = {}) => {
    if (!rgba || W < 16 || H < 16) return null
    const ring = Math.max(2, Math.floor(0.02 * Math.min(W, H)))
    const rs = [], gs = [], bs = []
    const sample = (x, y) => {
        const i = (y * W + x) * 4
        rs.push(rgba[i]); gs.push(rgba[i + 1]); bs.push(rgba[i + 2])
    }
    for (let y = 0; y < H; y += 1) {
        const edgeRow = y < ring || y >= H - ring
        for (let x = 0; x < W; x += 1) {
            if (edgeRow || x < ring || x >= W - ring) sample(x, y)
        }
    }
    const median = (arr) => {
        const hist = new Uint32Array(256)
        for (const v of arr) hist[v] += 1
        let acc = 0
        for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc * 2 >= arr.length) return v }
        return 0
    }
    const bg = [median(rs), median(gs), median(bs)]

    const colCount = new Uint32Array(W)
    const rowCount = new Uint32Array(H)
    let any = false
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            const i = (y * W + x) * 4
            const d = Math.max(Math.abs(rgba[i] - bg[0]), Math.abs(rgba[i + 1] - bg[1]), Math.abs(rgba[i + 2] - bg[2]))
            if (d > thresh) { colCount[x] += 1; rowCount[y] += 1; any = true }
        }
    }
    if (!any) return null
    const colMin = Math.max(2, Math.floor(H / 200))
    const rowMin = Math.max(2, Math.floor(W / 200))
    let x0 = 0, x1 = W - 1, y0 = 0, y1 = H - 1
    while (x0 < W && colCount[x0] <= colMin) x0 += 1
    while (x1 >= 0 && colCount[x1] <= colMin) x1 -= 1
    while (y0 < H && rowCount[y0] <= rowMin) y0 += 1
    while (y1 >= 0 && rowCount[y1] <= rowMin) y1 -= 1
    if (x1 <= x0 || y1 <= y0) return null

    let box = [x0, y0, x1 - x0 + 1, y1 - y0 + 1]
    if ((box[2] * box[3]) / (W * H) < minFrac) return null
    if (aspect) box = fitAspect(box, aspect, W, H, [(x0 + x1) / 2, (y0 + y1) / 2])
    box = clipBox(box, W, H)
    const trimmed = 1 - (box[2] * box[3]) / (W * H)
    return {
        box,
        score: round4(Math.min(1, 0.4 + 0.6 * trimmed)),
        aspect_ratio: round4(box[2] / box[3]),
        rationale: `trimmed ${Math.round(trimmed * 100)}% near-solid border (Δ>${thresh})`,
        already_tight: trimmed < 0.08,
    }
}

/** Nearest `pct` of pixels by depth (uint8, white = near), padded. */
export const computeDepthCrop = (depth, W, H, { aspect = null, pct = CROP_DEPTH_FOREGROUND_PCT, padding = CROP_SUBJECT_PADDING } = {}) => {
    if (!depth || !W || !H) return null
    const hist = new Uint32Array(256)
    for (let i = 0; i < W * H; i += 1) hist[depth[i]] += 1
    // numpy quantile(1 - pct): value below which (1 - pct) of pixels fall.
    const target = (1 - pct) * (W * H - 1)
    let acc = 0, cutoff = 255
    for (let v = 0; v < 256; v += 1) {
        acc += hist[v]
        if (acc - 1 >= target) { cutoff = v; break }
    }
    const threshold = Math.max(1, cutoff)
    const stats = maskStats(depth, W, H, (v) => v >= threshold)
    if (!stats) return null
    const padded = expandBox(stats.bbox, W, H, padding)
    const box = aspect ? fitAspect(padded, aspect, W, H, stats.centroid) : padded
    const frameArea = W * H
    return {
        box,
        score: round4(Math.min(1, 0.45 + 0.55 * (stats.area / frameArea))),
        aspect_ratio: round4(box[2] / box[3]),
        rationale: `top ${Math.round(pct * 100)}% depth percentile padded ${Math.round(padding * 100)}%`,
        already_tight: (box[2] * box[3]) / frameArea >= 0.92,
    }
}

const PREFERENCE = ['subject', 'depth', 'content', 'aspect']
export const recommendCrop = (crops) => {
    let best = null
    for (const key of PREFERENCE) {
        const c = crops?.[key]
        if (c && (!best || (c.score || 0) > (crops[best].score || 0))) best = key
    }
    return best
}

/* ─── Analysis-driven subject composition ──────────────────────────────────
 * The photo is read first (Gemini vision via /api/ai/crop-analyze, or the
 * heuristic analysis below), subject edges are tightened with the on-device
 * matte, then scene-specific rules place the crop. `analysis` uses normalised
 * boxes {x0,y0,x1,y1} as produced by validateCropAnalysis.
 */

// Share of the crop the kept region should span, per scene.
const SCENE_FRAME_SHARE = {
    portrait: 0.58, group: 0.82, animal: 0.6, product: 0.6, food: 0.7, vehicle: 0.66,
    action: 0.55, architecture: 0.86, interior: 0.9, landscape: 1, document: 0.97, other: 0.64,
}
const CENTRED_SCENES = new Set(['product', 'food', 'architecture', 'document', 'group'])
const EYE_SCENES = new Set(['portrait', 'group', 'animal', 'action', 'other'])
const SCENE_NAMES = {
    portrait: 'Portrait', group: 'Group', animal: 'Animal', product: 'Product', food: 'Food',
    vehicle: 'Vehicle', action: 'Action', architecture: 'Architecture', interior: 'Interior',
    landscape: 'Scene', document: 'Document', other: 'Subject',
}
const MIN_CROP_AREA_FRAC = 0.28
const KEEP_MARGIN_FRAC = 0.035

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const toPx = (b, W, H) => ({ x0: b.x0 * W, y0: b.y0 * H, x1: b.x1 * W, y1: b.y1 * H })
const union = (a, b) => (a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { ...b })
const rectArea = (r) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0)

/** Tighten (≤15%/side) or extend (≤12% of size) a model box to the matte's real edges. */
export const refineBoxWithMatte = (box, mask, W, H) => {
    if (!mask) return box
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0
    const pad = 0.12 * Math.max(bw, bh)
    const ex0 = Math.max(0, Math.floor(box.x0 - pad)), ex1 = Math.min(W, Math.ceil(box.x1 + pad))
    const ey0 = Math.max(0, Math.floor(box.y0 - pad)), ey1 = Math.min(H, Math.ceil(box.y1 + pad))
    let mx0 = W, my0 = H, mx1 = -1, my1 = -1
    for (let y = ey0; y < ey1; y += 1) {
        const row = y * W
        for (let x = ex0; x < ex1; x += 1) {
            if (mask[row + x] <= 127) continue
            if (x < mx0) mx0 = x
            if (x > mx1) mx1 = x
            if (y < my0) my0 = y
            if (y > my1) my1 = y
        }
    }
    if (mx1 < 0) return box
    const m = { x0: mx0, y0: my0, x1: mx1 + 1, y1: my1 + 1 }
    const ratio = rectArea(m) / Math.max(1, rectArea(box))
    // The matte found something else (background blob or a sliver): trust the model.
    if (ratio < 0.3 || ratio > 2.2) return box
    return {
        x0: clamp(m.x0, box.x0 - pad, box.x0 + 0.15 * bw),
        y0: clamp(m.y0, box.y0 - pad, box.y0 + 0.15 * bh),
        x1: clamp(m.x1, box.x1 - 0.15 * bw, box.x1 + pad),
        y1: clamp(m.y1, box.y1 - 0.15 * bh, box.y1 + pad),
    }
}

/** Row of a clear horizontal horizon in a luma thumbnail (0..255), as 0..1, or null. */
export const detectHorizon = (luma, w, h) => {
    if (!luma || w < 16 || h < 16) return null
    const rowMean = new Float32Array(h)
    for (let y = 0; y < h; y += 1) {
        let s = 0
        for (let x = 0; x < w; x += 1) s += luma[y * w + x]
        rowMean[y] = s / w / 255
    }
    const grad = (arr, y) => Math.abs((arr[Math.min(h - 1, y + 2)] - arr[Math.max(0, y - 2)]))
    const lo = Math.floor(0.12 * h), hi = Math.ceil(0.88 * h)
    let peakY = -1, peak = 0
    for (let y = lo; y < hi; y += 1) {
        const g = grad(rowMean, y)
        if (g > peak) { peak = g; peakY = y }
    }
    if (peakY < 0 || peak < 0.06) return null
    // A real horizon runs across the frame: most column bands agree on its row.
    const bands = 8, tol = Math.max(2, Math.round(0.07 * h))
    let agree = 0
    for (let b = 0; b < bands; b += 1) {
        const bx0 = Math.floor((b * w) / bands), bx1 = Math.floor(((b + 1) * w) / bands)
        const col = new Float32Array(h)
        for (let y = 0; y < h; y += 1) {
            let s = 0
            for (let x = bx0; x < bx1; x += 1) s += luma[y * w + x]
            col[y] = s / Math.max(1, bx1 - bx0) / 255
        }
        let by = -1, bg = 0
        for (let y = Math.max(lo, peakY - 3 * tol); y < Math.min(hi, peakY + 3 * tol); y += 1) {
            const g = grad(col, y)
            if (g > bg) { bg = g; by = y }
        }
        if (by >= 0 && Math.abs(by - peakY) <= tol && bg >= 0.04) agree += 1
    }
    return agree >= 6 ? peakY / h : null
}

/** Left-right mirror similarity of a luma thumbnail, 0 (none) .. 1 (perfect). */
export const mirrorSymmetry = (luma, w, h) => {
    if (!luma || w < 8 || h < 8) return 0
    let diff = 0
    const half = Math.floor(w / 2)
    for (let y = 0; y < h; y += 1) {
        const row = y * w
        for (let x = 0; x < half; x += 1) diff += Math.abs(luma[row + x] - luma[row + w - 1 - x])
    }
    return clamp(1 - diff / (half * h * 255) / 0.25, 0, 1)
}

// Busier side of a horizon = the side worth giving room to.
const horizonEmphasis = (luma, w, h, hy) => {
    const cut = Math.round(hy * h)
    const energy = (y0, y1) => {
        let e = 0, n = 0
        for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y += 1) {
            for (let x = 1; x < w - 1; x += 1) {
                const i = y * w + x
                e += Math.abs(luma[i + 1] - luma[i - 1]) + Math.abs(luma[i + w] - luma[i - w])
                n += 1
            }
        }
        return n ? e / n : 0
    }
    const above = energy(0, cut - 2), below = energy(cut + 2, h)
    if (above > below * 1.3) return 'sky'
    if (below > above * 1.3) return 'ground'
    return 'balanced'
}

/**
 * Analysis without a vision model: matte for the subject, saliency open side for
 * facing, row profile for a horizon, mirror test for symmetry.
 * @param {{ W:number, H:number, mask?:Uint8Array, openSide?:'left'|'right', luma?:Uint8Array, lw?:number, lh?:number }} input
 */
export const heuristicCropAnalysis = ({ W, H, mask = null, openSide = null, luma = null, lw = 0, lh = 0 }) => {
    const stats = mask ? maskStats(mask, W, H) : null
    const coverage = stats ? stats.area / (W * H) : 0
    const spread = stats ? (stats.bbox[2] * stats.bbox[3]) / (W * H) : 1
    const distinct = Boolean(stats) && coverage >= 0.01 && coverage <= 0.6 && spread < 0.5
    const horizon = luma ? detectHorizon(luma, lw, lh) : null
    const symmetryScore = luma ? mirrorSymmetry(luma, lw, lh) : 0
    const subjects = []
    if (distinct) {
        const [x, y, bw, bh] = stats.bbox
        const cx = (x + bw / 2) / W
        // Photographers leave room in front of the subject: an off-centre subject faces the open side.
        const facing = Math.abs(cx - 0.5) < 0.08 ? 'none' : (cx < 0.5 ? 'right' : 'left')
        subjects.push({
            label: 'subject',
            box: { x0: x / W, y0: y / H, x1: (x + bw) / W, y1: (y + bh) / H },
            importance: 1,
            facing: facing === 'none' && openSide ? 'none' : facing,
        })
    }
    return {
        scene: distinct ? 'other' : 'landscape',
        hasDistinctSubject: distinct,
        subjects,
        mustKeep: [],
        eyeLine: null,
        horizon,
        emphasis: horizon != null && luma ? horizonEmphasis(luma, lw, lh, horizon) : 'none',
        symmetric: symmetryScore >= 0.8,
        symmetryAxis: symmetryScore >= 0.8 ? 0.5 : null,
        clutterEdges: [],
        suggestedAspect: 'original',
        intent: '',
    }
}

const maxAspectBox = (W, H, ar) => (ar >= W / H ? { w: W, h: W / ar } : { w: H * ar, h: H })

// Keep [lo, hi] inside the crop along one axis, then keep the crop in the image.
const placeAxis = (anchor, size, keepLo, keepHi, margin, dim) => {
    let a = anchor
    let compromised = false
    const lo = keepHi + margin - size / 2
    const hi = keepLo - margin + size / 2
    if (lo <= hi) a = clamp(a, lo, hi)
    else { a = (keepLo + keepHi) / 2; compromised = keepHi - keepLo > size }
    a = size <= dim ? clamp(a, size / 2, dim - size / 2) : dim / 2
    return { a, compromised }
}

const shiftFromClutter = (anchor, size, dim, awayFromLow, awayFromHigh) => {
    if (awayFromLow === awayFromHigh) return anchor
    const extreme = awayFromLow ? dim - size / 2 : size / 2
    return anchor + 0.5 * (extreme - anchor)
}

/**
 * Compose a crop from a photo analysis.
 * @param {{ W:number, H:number, aspect?:number|null, analysis:object, mask?:Uint8Array|null, source?:string }} input
 */
export const composeAnalyzedCrop = ({ W, H, aspect = null, analysis, mask = null, source = 'heuristic' }) => {
    if (!(W > 0 && H > 0) || !analysis) return null
    const a = analysis
    const ar = aspect > 0 ? aspect : (() => {
        if (!a.suggestedAspect || a.suggestedAspect === 'original') return W / H
        const [p, q] = a.suggestedAspect.split(':').map(Number)
        return p > 0 && q > 0 ? p / q : W / H
    })()
    const max = maxAspectBox(W, H, ar)
    const notes = []
    const clutter = new Set(a.clutterEdges || [])

    const top = a.subjects?.[0]
    const cutoff = a.scene === 'group' ? 0.35 : Math.max(0.5, (top?.importance || 0) * 0.7)
    const primary = (a.subjects || []).filter((s, i) => i === 0 || s.importance >= cutoff)
    const subjectBoxes = primary.map((s) => refineBoxWithMatte(toPx(s.box, W, H), mask, W, H))
    let keep = null
    for (const b of subjectBoxes) keep = union(keep, b)
    const keepLabels = []
    for (const k of a.mustKeep || []) {
        keep = union(keep, toPx(k.box, W, H))
        if (keepLabels.length < 3 && !keepLabels.includes(k.label)) keepLabels.push(k.label)
    }

    const sceneMode = !a.hasDistinctSubject || !subjectBoxes.length
    let cw, ch
    if (sceneMode) {
        cw = max.w
        ch = max.h
    } else {
        const f = SCENE_FRAME_SHARE[a.scene] || SCENE_FRAME_SHARE.other
        const kw = keep.x1 - keep.x0, kh = keep.y1 - keep.y0
        cw = kw / f
        ch = kh / f
        if (cw / ch < ar) cw = ch * ar
        else ch = cw / ar
        // Never zoom so far that the crop turns into a low-res fragment.
        const minArea = MIN_CROP_AREA_FRAC * max.w * max.h
        if (cw * ch < minArea) {
            const s = Math.sqrt(minArea / (cw * ch))
            cw *= s
            ch *= s
        }
        // The kept region plus margins must fit.
        const m0 = KEEP_MARGIN_FRAC * Math.min(cw, ch)
        const need = Math.max((kw + 2 * m0) / cw, (kh + 2 * m0) / ch, 1)
        cw *= need
        ch *= need
        const fit = Math.min(1, max.w / cw, max.h / ch)
        cw *= fit
        ch *= fit
    }
    const margin = KEEP_MARGIN_FRAC * Math.min(cw, ch)

    // ── horizontal anchor ──
    let ax
    const subjectCx = subjectBoxes.length ? (subjectBoxes[0].x0 + subjectBoxes[0].x1) / 2 : W / 2
    const facing = top?.facing
    if (a.symmetric && a.symmetryAxis != null) {
        ax = a.symmetryAxis * W
        notes.push('centred on the symmetry axis')
    } else if (sceneMode) {
        ax = keep ? (keep.x0 + keep.x1) / 2 : W / 2
    } else if ((facing === 'left' || facing === 'right') && !CENTRED_SCENES.has(a.scene)) {
        ax = subjectCx + (facing === 'right' ? 1 / 6 : -1 / 6) * cw
        notes.push('room on the side the subject faces')
    } else if (CENTRED_SCENES.has(a.scene) || Math.abs(subjectCx / W - 0.5) < 0.08) {
        ax = (keep.x0 + keep.x1) / 2
        notes.push('centred on the subject')
    } else {
        // Facing unknown: keep the photographer's side, gently pulled to its third.
        ax = subjectCx + (subjectCx < W / 2 ? 1 / 6 : -1 / 6) * cw * 0.5
        notes.push('subject on its third')
    }

    // ── vertical anchor ──
    let ay
    if (!sceneMode && a.eyeLine != null && EYE_SCENES.has(a.scene)) {
        ay = a.eyeLine * H + ch / 6
        notes.push('eyes on the upper third')
    } else if (a.horizon != null && (sceneMode || (keep && keep.y1 - keep.y0 < 0.4 * ch))) {
        const hy = a.horizon * H
        const third = a.emphasis === 'sky' ? 2 / 3 : a.emphasis === 'ground' ? 1 / 3 : (a.horizon < 0.5 ? 1 / 3 : 2 / 3)
        ay = hy + (0.5 - third) * ch
        notes.push(`horizon on the ${third < 0.5 ? 'upper' : 'lower'} third`)
    } else if (keep) {
        // Optical centre sits slightly above the geometric one.
        ay = (keep.y0 + keep.y1) / 2 + 0.04 * ch
    } else {
        ay = H / 2
    }

    ax = shiftFromClutter(ax, cw, W, clutter.has('left'), clutter.has('right'))
    ay = shiftFromClutter(ay, ch, H, clutter.has('top'), clutter.has('bottom'))
    const trimmedEdges = [...clutter].filter((e) => ((e === 'left' || e === 'right') ? cw < W - 1 : ch < H - 1))
    if (trimmedEdges.length) notes.push(`trimmed the distracting ${trimmedEdges.join(' and ')} edge${trimmedEdges.length > 1 ? 's' : ''}`)

    const px = keep ? placeAxis(ax, cw, keep.x0, keep.x1, margin, W) : { a: clamp(ax, cw / 2, W - cw / 2), compromised: false }
    const py = keep ? placeAxis(ay, ch, keep.y0, keep.y1, margin, H) : { a: clamp(ay, ch / 2, H - ch / 2), compromised: false }
    if (px.compromised || py.compromised) notes.push("the ratio can't hold everything, so the trim is balanced")
    if (keepLabels.length) notes.push(`kept ${keepLabels.join(', ')}`)

    const box = clipBox([px.a - cw / 2, py.a - ch / 2, cw, ch], W, H)
    const frameArea = W * H
    const cropFrame = (box[2] * box[3]) / frameArea
    const confidence = source === 'gemini' ? 1 : 0.5
    const score = sceneMode
        ? round4(0.5 + 0.1 * confidence)
        : round4(Math.min(1, 0.62 + 0.18 * confidence + 0.2 * (1 - cropFrame)))
    const label = SCENE_NAMES[a.scene] || 'Subject'
    return {
        box,
        score,
        aspect_ratio: round4(box[2] / box[3]),
        rationale: [sceneMode ? `${label} composition` : label, ...notes].join(' · '),
        scene: a.scene,
        intent: a.intent || '',
        analysis_source: source,
        subjects: primary.map((s, i) => ({ label: s.label, facing: s.facing, box: subjectBoxes[i].x0 != null ? [subjectBoxes[i].x0, subjectBoxes[i].y0, subjectBoxes[i].x1 - subjectBoxes[i].x0, subjectBoxes[i].y1 - subjectBoxes[i].y0].map(Math.round) : null })),
        already_tight: cropFrame >= 0.92,
        compromised: px.compromised || py.compromised,
    }
}
