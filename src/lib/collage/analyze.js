// Photo understanding for the collage Composer, computed on-device at thumbnail
// scale: where the subject is (saliency), where the calm/empty space is, the
// palette, tone, sharpness and the dominant line direction. Layout solvers use
// it so no generated composition crops a subject. `analyzePixels` is DOM-free.

import { boxBlur } from '../mask-grow-core'

export const ANALYSIS_EDGE = 192

const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`

const normalize = (arr) => {
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < arr.length; i += 1) { if (arr[i] < lo) lo = arr[i]; if (arr[i] > hi) hi = arr[i] }
    const span = hi - lo || 1
    for (let i = 0; i < arr.length; i += 1) arr[i] = (arr[i] - lo) / span
    return arr
}

// Mass interval [from, to] of a 1D distribution (fractions of total).
const massInterval = (marg, from, to) => {
    const total = marg.reduce((s, v) => s + v, 0) || 1
    let acc = 0, lo = 0, hi = marg.length - 1, loSet = false
    for (let i = 0; i < marg.length; i += 1) {
        acc += marg[i]
        if (!loSet && acc >= total * from) { lo = i; loSet = true }
        if (acc >= total * to) { hi = i; break }
    }
    return [lo, hi]
}

// Palette via a few k-means iterations over a pixel sample (deterministic init).
const kmeansPalette = (rgba, n, k = 5) => {
    const step = Math.max(1, Math.floor(n / 2400))
    const samples = []
    for (let p = 0; p < n; p += step) {
        const i = p * 4
        samples.push([rgba[i], rgba[i + 1], rgba[i + 2]])
    }
    samples.sort((a, b) => (a[0] * 0.3 + a[1] * 0.59 + a[2] * 0.11) - (b[0] * 0.3 + b[1] * 0.59 + b[2] * 0.11))
    const centers = Array.from({ length: k }, (_, i) => samples[Math.floor(((i + 0.5) / k) * samples.length)].slice())
    const counts = new Array(k).fill(0)
    for (let iter = 0; iter < 10; iter += 1) {
        const sums = centers.map(() => [0, 0, 0])
        counts.fill(0)
        for (const s of samples) {
            let best = 0, bestD = Infinity
            for (let c = 0; c < k; c += 1) {
                const d = (s[0] - centers[c][0]) ** 2 + (s[1] - centers[c][1]) ** 2 + (s[2] - centers[c][2]) ** 2
                if (d < bestD) { bestD = d; best = c }
            }
            sums[best][0] += s[0]; sums[best][1] += s[1]; sums[best][2] += s[2]
            counts[best] += 1
        }
        for (let c = 0; c < k; c += 1) {
            if (counts[c]) centers[c] = sums[c].map((v) => v / counts[c])
        }
    }
    return centers
        .map((c, i) => ({ hex: toHex(...c), rgb: c.map(Math.round), weight: counts[i] / samples.length, l: (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 }))
        .filter((c) => c.weight > 0)
        .sort((a, b) => b.weight - a.weight)
}

/**
 * @param {Uint8ClampedArray} rgba
 * @param {number} w
 * @param {number} h
 * @returns {object} analysis (all geometry normalised 0..1 in photo space)
 */
export const analyzePixels = (rgba, w, h) => {
    const n = w * h
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n)
    let mL = 0, mA = 0, mB = 0, mR = 0, mG = 0, mBl = 0
    let rgS = 0, ybS = 0, rgS2 = 0, ybS2 = 0
    for (let p = 0, i = 0; p < n; p += 1, i += 4) {
        const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255
        L[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b
        A[p] = r - g
        B[p] = 0.5 * (r + g) - b
        mL += L[p]; mA += A[p]; mB += B[p]; mR += r; mG += g; mBl += b
        rgS += A[p]; ybS += B[p]; rgS2 += A[p] * A[p]; ybS2 += B[p] * B[p]
    }
    mL /= n; mA /= n; mB /= n; mR /= n; mG /= n; mBl /= n

    // Frequency-tuned saliency (distance of the blurred pixel from the image mean).
    const r2 = Math.max(1, Math.round(Math.max(w, h) / 64))
    const Lb = boxBlur(L, w, h, r2), Ab = boxBlur(A, w, h, r2), Bb = boxBlur(B, w, h, r2)
    const ft = new Float32Array(n)
    for (let p = 0; p < n; p += 1) ft[p] = (Lb[p] - mL) ** 2 + (Ab[p] - mA) ** 2 + (Bb[p] - mB) ** 2

    // Sobel edges + structure tensor (dominant line direction), Laplacian (sharpness).
    const edge = new Float32Array(n)
    let jxx = 0, jyy = 0, jxy = 0, lapSum = 0, lapSq = 0, lapN = 0, lSq = 0
    for (let p = 0; p < n; p += 1) lSq += (L[p] - mL) ** 2
    for (let y = 1; y < h - 1; y += 1) {
        for (let x = 1; x < w - 1; x += 1) {
            const p = y * w + x
            const gx = (L[p - w + 1] + 2 * L[p + 1] + L[p + w + 1]) - (L[p - w - 1] + 2 * L[p - 1] + L[p + w - 1])
            const gy = (L[p + w - 1] + 2 * L[p + w] + L[p + w + 1]) - (L[p - w - 1] + 2 * L[p - w] + L[p - w + 1])
            edge[p] = Math.hypot(gx, gy)
            jxx += gx * gx; jyy += gy * gy; jxy += gx * gy
            const lap = L[p - w] + L[p + w] + L[p - 1] + L[p + 1] - 4 * L[p]
            lapSum += lap; lapSq += lap * lap; lapN += 1
        }
    }
    const edgeB = boxBlur(edge, w, h, Math.max(1, r2))
    normalize(ft)
    normalize(edgeB)

    // Combined saliency with a soft centre prior.
    const S = new Float32Array(n)
    let sMean = 0
    for (let y = 0; y < h; y += 1) {
        const dy = (y + 0.5) / h - 0.5
        for (let x = 0; x < w; x += 1) {
            const dx = (x + 0.5) / w - 0.5
            const prior = Math.exp(-(dx * dx + dy * dy) / (2 * 0.32 * 0.32))
            const p = y * w + x
            S[p] = (0.62 * ft[p] + 0.38 * edgeB[p]) * (0.45 + 0.55 * prior)
            sMean += S[p]
        }
    }
    sMean /= n

    // Peaks only (above-mean energy) define the subject box and focus point.
    const margX = new Float64Array(w), margY = new Float64Array(h)
    let fx = 0, fy = 0, fm = 0
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const v = Math.max(0, S[y * w + x] - sMean)
            margX[x] += v; margY[y] += v
            fx += v * (x + 0.5); fy += v * (y + 0.5); fm += v
        }
    }
    const [bx0, bx1] = massInterval(margX, 0.08, 0.92)
    const [by0, by1] = massInterval(margY, 0.08, 0.92)
    const box = { x0: bx0 / w, y0: by0 / h, x1: (bx1 + 1) / w, y1: (by1 + 1) / h }
    const focus = fm > 0 ? { x: fx / fm / w, y: fy / fm / h } : { x: 0.5, y: 0.5 }
    const boxArea = (box.x1 - box.x0) * (box.y1 - box.y0)

    // Calm space: 8×8 grid of low saliency + low edge energy; largest calm rectangle.
    const G = 8
    const busy = new Float32Array(G * G)
    for (let gy = 0; gy < G; gy += 1) {
        for (let gx = 0; gx < G; gx += 1) {
            let s = 0, c = 0
            const x0 = Math.floor((gx / G) * w), x1 = Math.floor(((gx + 1) / G) * w)
            const y0 = Math.floor((gy / G) * h), y1 = Math.floor(((gy + 1) / G) * h)
            for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const p = y * w + x; s += S[p] + 0.6 * edgeB[p]; c += 1 }
            busy[gy * G + gx] = c ? s / c : 0
        }
    }
    const sorted = Array.from(busy).sort((a, b) => a - b)
    const calmT = sorted[Math.floor(sorted.length * 0.4)]
    const calmCell = (gx, gy) => busy[gy * G + gx] <= calmT
    let best = { area: 0, x0: 0, y0: 0, x1: 0, y1: 0 }
    for (let y0 = 0; y0 < G; y0 += 1) for (let x0 = 0; x0 < G; x0 += 1) {
        for (let y1 = y0; y1 < G; y1 += 1) for (let x1 = x0; x1 < G; x1 += 1) {
            const area = (x1 - x0 + 1) * (y1 - y0 + 1)
            if (area <= best.area) continue
            let ok = true
            for (let yy = y0; yy <= y1 && ok; yy += 1) for (let xx = x0; xx <= x1 && ok; xx += 1) ok = calmCell(xx, yy)
            if (ok) best = { area, x0, y0, x1, y1 }
        }
    }
    const calm = { x0: best.x0 / G, y0: best.y0 / G, x1: (best.x1 + 1) / G, y1: (best.y1 + 1) / G, area: best.area / (G * G) }
    let calmL = 0, calmR = 0
    for (let gy = 0; gy < G; gy += 1) for (let gx = 0; gx < G; gx += 1) {
        if (!calmCell(gx, gy)) continue
        if ((gx + 0.5) / G < focus.x) calmL += 1
        else calmR += 1
    }

    const lapVar = lapN ? lapSq / lapN - (lapSum / lapN) ** 2 : 0
    const contrast = Math.sqrt(lSq / n)
    const rgMean = rgS / n, ybMean = ybS / n
    const colorfulness = Math.sqrt(Math.max(0, rgS2 / n - rgMean ** 2) + Math.max(0, ybS2 / n - ybMean ** 2)) + 0.3 * Math.hypot(rgMean, ybMean)
    const coherence = (jxx + jyy) > 0 ? Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / (jxx + jyy) : 0
    // Gradient orientation is perpendicular to the dominant lines.
    let lineAngle = (0.5 * Math.atan2(2 * jxy, jxx - jyy) * 180) / Math.PI + 90
    if (lineAngle > 90) lineAngle -= 180

    const sharpness = 1 - Math.exp(-lapVar * 900)
    const concentration = Math.max(0, Math.min(1, 1 - boxArea))
    const quality = Math.max(0, Math.min(1,
        0.35 * sharpness + 0.25 * Math.min(1, contrast / 0.24) + 0.2 * Math.min(1, colorfulness / 0.35) + 0.2 * concentration))

    return {
        box,
        focus,
        concentration,
        calm,
        openSide: calmL > calmR ? 'left' : 'right',
        palette: kmeansPalette(rgba, n),
        mean: { r: mR, g: mG, b: mBl },
        luminance: mL,
        contrast,
        colorfulness,
        warmth: mR - mBl,
        sharpness,
        lineAngle,
        lineStrength: coherence,
        quality,
        weight: 0.5 * quality + 0.35 * concentration + 0.15 * Math.min(1, colorfulness / 0.35),
    }
}

const cache = new WeakMap()

/** Analyse a drawable (img / canvas / bitmap). Cached per element. */
export const analyzeElement = (el, naturalW, naturalH) => {
    if (!el) return null
    const nw = naturalW || el.naturalWidth || el.width
    const nh = naturalH || el.naturalHeight || el.height
    if (!nw || !nh) return null
    const hit = cache.get(el)
    if (hit && hit.nw === nw && hit.nh === nh) return hit.result
    const scale = Math.min(1, ANALYSIS_EDGE / Math.max(nw, nh))
    const w = Math.max(8, Math.round(nw * scale))
    const h = Math.max(8, Math.round(nh * scale))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(el, 0, 0, w, h)
    let data
    try { data = ctx.getImageData(0, 0, w, h).data } catch { return null }
    const result = { ...analyzePixels(data, w, h), aspect: nw / nh, thumb: c, pixels: data, tw: w, th: h }
    cache.set(el, { nw, nh, result })
    return result
}
