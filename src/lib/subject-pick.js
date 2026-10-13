/**
 * subject-pick — which SlimSAM answer is "the subject" (Select Subject).
 *
 * SlimSAM answers prompts; it has no notion of a main subject. Select Subject
 * prompts it many ways (a saliency box, the box with seed points, the seeds
 * alone, a 6×6 grid; three candidates each) and keeps the candidate that best
 * fits four photographic priors, scored on the 256-px decoder grid:
 *   - SAM is confident in it;
 *   - it does not run along the frame — Zhu et al.'s boundary connectivity,
 *     border length over √area (the background is what the frame cuts through);
 *   - it carries detail — mean gradient inside against the frame's (a sky, a
 *     wall and a defocused background are smooth);
 *   - it is whole (bigger beats a part) and near the centre.
 *
 * Fitted on five photos against hand-boxed ground truth, scored exactly as
 * here (binary masks on the decoder grid), and chosen where every one-step
 * change of any parameter still picks a good mask on all five, not at the
 * single best point.
 *
 * Then `growToWhole`: the border prior prefers a part (a cat's face) over a
 * subject that fills the frame and runs off it (the whole cat). SAM is surer
 * of the whole, so a confident answer that contains the winner replaces it,
 * unless our box cut it or it hugs the frame's border like background.
 *
 * Pure: plain arrays in, numbers out. The prompts come from a border-prior
 * saliency (`subjectPrompts`): distance from the frame-border colour palette.
 */

export const SUBJECT_PICK = Object.freeze({
    sigma: 0.75,     // boundary connectivity falloff
    samPow: 3,
    areaPow: 0.33,
    detailPow: 0.75,
    centre: 0.35,    // centre prior width, in frame units
    minArea: 0.005,
    maxArea: 0.85,
    wholeContain: 0.9,  // share of the winner the whole must cover
    wholeSlack: 0.01,   // SAM may be this much less sure of the whole
    wholeBorder: 0.5,   // max border share / area share; background runs > 1
})

const BORDER = 2     // px of each frame edge that samples the background palette
const PALETTE = 6    // background colours (k-means)
const MASS = 0.86    // share of saliency the prompt box must hold

const toLab = (r, g, b) => {
    const lin = (c) => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92 }
    const R = lin(r), G = lin(g), B = lin(b)
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
    const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047)
    const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B)
    const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883)
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

/**
 * Border-prior saliency → the prompt box and seeds, in the small frame's px.
 * @param {Uint8ClampedArray} rgba  w×h RGBA
 * @returns {{ box: number[], seeds: number[][], saliency: Float32Array }}
 */
export const subjectPrompts = (rgba, w, h) => {
    const n = w * h
    const lab = new Float32Array(n * 3)
    for (let p = 0; p < n; p += 1) {
        const [L, A, B] = toLab(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2])
        lab[p * 3] = L; lab[p * 3 + 1] = A; lab[p * 3 + 2] = B
    }
    const border = []
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            if (y < BORDER || y >= h - BORDER || x < BORDER || x >= w - BORDER) border.push(y * w + x)
        }
    }
    // k-means over the border colours; evenly spaced starts keep it deterministic.
    const k = Math.min(PALETTE, border.length)
    const centres = Array.from({ length: k }, (_, j) => {
        const p = border[Math.floor(((j + 0.5) / k) * border.length)]
        return [lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2]]
    })
    const d2 = (p, c) => (lab[p * 3] - c[0]) ** 2 + (lab[p * 3 + 1] - c[1]) ** 2 + (lab[p * 3 + 2] - c[2]) ** 2
    for (let it = 0; it < 10; it += 1) {
        const sum = centres.map(() => [0, 0, 0, 0])
        for (const p of border) {
            let best = 0
            for (let j = 1; j < k; j += 1) if (d2(p, centres[j]) < d2(p, centres[best])) best = j
            sum[best][0] += lab[p * 3]; sum[best][1] += lab[p * 3 + 1]; sum[best][2] += lab[p * 3 + 2]; sum[best][3] += 1
        }
        sum.forEach((s, j) => { if (s[3]) centres[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]] })
    }
    const sal = new Float32Array(n)
    for (let p = 0; p < n; p += 1) {
        let m = Infinity
        for (const c of centres) m = Math.min(m, d2(p, c))
        const r = Math.hypot((p % w) / w - 0.5, Math.floor(p / w) / h - 0.5)
        sal[p] = Math.sqrt(m) * (1 - 0.5 * Math.min(1, r * 1.6))
    }
    const sorted = Float32Array.from(sal).sort()
    const p99 = sorted[Math.floor(0.99 * (n - 1))] || 1
    for (let p = 0; p < n; p += 1) sal[p] = Math.min(1, sal[p] / p99)

    // Smallest interval per axis holding MASS of the saliency.
    const interval = (marginal) => {
        const target = MASS * marginal.reduce((a, b) => a + b, 0)
        let best = [0, marginal.length - 1], bestLen = marginal.length + 1, lo = 0, acc = 0
        for (let hi = 0; hi < marginal.length; hi += 1) {
            acc += marginal[hi]
            while (acc - marginal[lo] >= target) { acc -= marginal[lo]; lo += 1 }
            if (acc >= target && hi - lo < bestLen) { bestLen = hi - lo; best = [lo, hi] }
        }
        return best
    }
    const cols = new Array(w).fill(0)
    const rows = new Array(h).fill(0)
    for (let p = 0; p < n; p += 1) { cols[p % w] += sal[p]; rows[Math.floor(p / w)] += sal[p] }
    const [x0, x1] = interval(cols)
    const [y0, y1] = interval(rows)
    const box = [Math.max(0, x0 - 0.02 * w), Math.max(0, y0 - 0.02 * h), Math.min(w, x1 + 1 + 0.02 * w), Math.min(h, y1 + 1 + 0.02 * h)]
    let mx = 0, my = 0, mass = 0, peak = -1, px = (x0 + x1) / 2, py = (y0 + y1) / 2
    for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
            const v = sal[y * w + x]
            mx += x * v; my += y * v; mass += v
            if (v > peak) { peak = v; px = x; py = y }
        }
    }
    const seeds = [
        ...(mass > 0 ? [[mx / mass + 0.5, my / mass + 0.5]] : []),
        [px + 0.5, py + 0.5],
        [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
    ]
    return { box, seeds, saliency: sal }
}

/** Sobel gradient magnitude of luma, w×h, for the detail cue. */
export const gradientMagnitude = (rgba, w, h) => {
    const lum = new Float32Array(w * h)
    for (let p = 0; p < w * h; p += 1) lum[p] = 0.299 * rgba[p * 4] + 0.587 * rgba[p * 4 + 1] + 0.114 * rgba[p * 4 + 2]
    const at = (x, y) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]
    const mag = new Float32Array(w * h)
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)
            const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)
            mag[y * w + x] = Math.hypot(gx, gy)
        }
    }
    return mag
}

/**
 * How subject-like one candidate is; -1 when it cannot be the subject.
 * @param {{ bits: Uint8Array, w: number, h: number, sam: number }} cand  bits on the w×h grid
 * @param {Float32Array} grad  gradientMagnitude at the same w×h
 * @param {number} gradMean   mean of `grad`
 */
export const scoreSubjectCandidate = ({ bits, w, h, sam }, grad, gradMean, opts = SUBJECT_PICK) => {
    let area = 0, edge = 0, detail = 0, sx = 0, sy = 0
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const p = y * w + x
            if (!bits[p]) continue
            area += 1
            sx += x; sy += y
            detail += grad[p]
            // Border rows and columns; a corner counts for both, as in the fit.
            if (y === 0) edge += 1
            if (y === h - 1) edge += 1
            if (x === 0) edge += 1
            if (x === w - 1) edge += 1
        }
    }
    const frac = area / (w * h)
    if (!(frac >= opts.minArea && frac <= opts.maxArea)) return { score: -1, area: frac }
    const bc = edge / Math.sqrt(area)
    const richness = gradMean > 0 ? detail / area / gradMean : 1
    const dist = Math.hypot(sx / area / w - 0.5, sy / area / h - 0.5)
    const score = confidence(sam) ** opts.samPow
        * Math.exp(-(bc ** 2) / (2 * opts.sigma ** 2))
        * frac ** opts.areaPow
        * richness ** opts.detailPow
        * Math.exp(-(dist ** 2) / (2 * opts.centre ** 2))
    // Share of the frame's border over share of its area: ~1 for a region spread evenly.
    const borderRatio = edge / (2 * (w + h)) / frac
    return { score, area: frac, bc, borderRatio, detail: richness, dist }
}

const confidence = (sam) => (Number.isFinite(Number(sam)) ? Math.max(0, Number(sam)) : 0)

/**
 * The whole the winner is part of, or the winner.
 * @param {{ bits: Uint8Array, sam: number, area: number }} winner
 * @param {Iterable<{ bits: Uint8Array, sam: number, area: number, score: number, borderRatio: number, boxed?: boolean }>} cands
 *   scored candidates; `bits` is read only after the cheap tests (it may be a getter); `boxed` = from a box prompt
 */
export const growToWhole = (winner, cands, opts = SUBJECT_PICK) => {
    const floor = confidence(winner.sam) - opts.wholeSlack
    let wb = null, n = 0, best = winner
    for (const c of cands) {
        // A box answer may stop at our box, not at the object's edge.
        if (c === winner || c.boxed || !(c.score > 0) || !(c.area > winner.area)) continue
        if (!(c.borderRatio <= opts.wholeBorder) || !(confidence(c.sam) >= floor)) continue
        if (best !== winner && !(confidence(c.sam) > confidence(best.sam))) continue
        if (!wb) {
            wb = winner.bits
            for (let p = 0; p < wb.length; p += 1) n += wb[p]
        }
        const cb = c.bits
        let inside = 0
        for (let p = 0; p < wb.length; p += 1) if (wb[p] && cb[p]) inside += 1
        if (n > 0 && inside >= opts.wholeContain * n) best = c
    }
    return best
}
