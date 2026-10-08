/**
 * Exemplar inpainting — fill a hole with texture copied from the rest of the
 * picture. The method behind Photoshop's Content-Aware Fill: Wexler, Shechtman
 * & Irani's space-time completion (2007), with the nearest-neighbour field found
 * by PatchMatch (Barnes et al. 2009).
 *
 *  1. Pyramid, coarse to fine. At the coarsest level the hole starts as a
 *     diffusion fill (onion peel from the edge in).
 *  2. Each iteration: PatchMatch finds, for every patch that touches the hole,
 *     the most similar patch lying wholly in the known region (propagation from
 *     the neighbours' matches + a shrinking random search); then every hole pixel
 *     becomes the weighted vote of the matches covering it. A vote counts more
 *     the better its match AND the nearer its patch is to the hole's edge
 *     (Wexler's γ^-distance): patches deep in the hole compare one smooth guess
 *     with another and, unweighted, outvote the edge and smear the fill flat.
 *  3. The field is upsampled to the next level and the level is rebuilt by a
 *     vote through it BEFORE searching — searching against the blocky upsampled
 *     guess picks blurry sources. Levels above `maxWorkSide` get one short
 *     refinement, not a full search.
 *  4. Seamless blend: the edge mismatch (known neighbour − fill) is spread
 *     through the hole as a harmonic membrane and added, so the copied texture
 *     takes the surrounding tone.
 *
 * This is the on-device fallback for the object remover when the LaMa service
 * is not running; it needs no model. It yields every few milliseconds so the
 * page keeps animating while it works.
 *
 * Pure: RGBA bytes in, RGBA bytes out. No DOM.
 */

const R = 3 // patch radius: 7×7 patches
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

const makeRng = (seed) => {
    let s = seed >>> 0 || 1
    return () => {
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        return (s >>> 0) / 4294967296
    }
}

// Give the page a turn: scheduler.yield where it exists, else a message (no
// 4 ms timer clamp), else a timer (Node/Bun).
const yieldNow = () => {
    if (typeof globalThis.scheduler?.yield === 'function') return globalThis.scheduler.yield()
    if (typeof window !== 'undefined' && typeof MessageChannel !== 'undefined') {
        return new Promise((resolve) => {
            const ch = new MessageChannel()
            ch.port1.onmessage = () => { ch.port1.close(); resolve() }
            ch.port2.postMessage(0)
        })
    }
    return new Promise((resolve) => setTimeout(resolve, 0))
}

// 2× box downsample of RGB and a conservative (any-child) hole.
const downsample = (level) => {
    const { w, h, img, hole } = level
    const W = Math.max(1, w >> 1), H = Math.max(1, h >> 1)
    const out = new Float32Array(W * H * 3)
    const outHole = new Uint8Array(W * H)
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            let r = 0, g = 0, b = 0, n = 0, anyHole = 0
            for (let dy = 0; dy < 2; dy += 1) {
                const sy = Math.min(h - 1, 2 * y + dy)
                for (let dx = 0; dx < 2; dx += 1) {
                    const sx = Math.min(w - 1, 2 * x + dx)
                    const p = sy * w + sx
                    if (hole[p]) { anyHole = 1; continue }
                    r += img[p * 3]; g += img[p * 3 + 1]; b += img[p * 3 + 2]; n += 1
                }
            }
            const q = y * W + x
            outHole[q] = anyHole
            if (n) { out[q * 3] = r / n; out[q * 3 + 1] = g / n; out[q * 3 + 2] = b / n }
        }
    }
    return { w: W, h: H, img: out, hole: outHole }
}

// Holes start as a diffusion of their rim: repeatedly give every hole pixel
// with known neighbours their mean, from the edge inward.
const onionFill = (level) => {
    const { w, h, img, hole } = level
    const known = new Uint8Array(w * h)
    for (let p = 0; p < w * h; p += 1) known[p] = hole[p] ? 0 : 1
    let frontier = []
    for (let p = 0; p < w * h; p += 1) if (!known[p]) frontier.push(p)
    while (frontier.length) {
        const next = []
        const fill = []
        for (const p of frontier) {
            const x = p % w, y = (p / w) | 0
            let r = 0, g = 0, b = 0, n = 0
            for (let dy = -1; dy <= 1; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    const nx = x + dx, ny = y + dy
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
                    const q = ny * w + nx
                    if (!known[q]) continue
                    r += img[q * 3]; g += img[q * 3 + 1]; b += img[q * 3 + 2]; n += 1
                }
            }
            if (n) fill.push(p, r / n, g / n, b / n)
            else next.push(p)
        }
        if (!fill.length) break // nothing known at all
        for (let i = 0; i < fill.length; i += 4) {
            const p = fill[i]
            img[p * 3] = fill[i + 1]; img[p * 3 + 1] = fill[i + 2]; img[p * 3 + 2] = fill[i + 3]
            known[p] = 1
        }
        frontier = next
    }
}

// Patch centres usable as sources (patch wholly inside and clear of the hole)
// and as targets (patch overlaps the hole). Centres keep R from the border.
const classify = (level) => {
    const { w, h, hole } = level
    const S = new Int32Array((w + 1) * (h + 1)) // integral of hole
    for (let y = 0; y < h; y += 1) {
        let row = 0
        for (let x = 0; x < w; x += 1) {
            row += hole[y * w + x]
            S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row
        }
    }
    const count = (x0, y0, x1, y1) => S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0]
    const valid = new Uint8Array(w * h)
    const targets = []
    const sources = []
    for (let y = R; y < h - R; y += 1) {
        for (let x = R; x < w - R; x += 1) {
            const c = count(x - R, y - R, x + R + 1, y + R + 1)
            const p = y * w + x
            if (c === 0) { valid[p] = 1; sources.push(p) } else targets.push(p)
        }
    }
    // Chamfer distance of each pixel to the known region (0 outside the hole).
    const depth = new Float32Array(w * h)
    const INF = 1e9
    for (let i = 0; i < w * h; i += 1) depth[i] = hole[i] ? INF : 0
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
        const i = y * w + x; if (!depth[i]) continue
        if (x > 0) depth[i] = Math.min(depth[i], depth[i - 1] + 1)
        if (y > 0) depth[i] = Math.min(depth[i], depth[i - w] + 1)
        if (x > 0 && y > 0) depth[i] = Math.min(depth[i], depth[i - w - 1] + 1.414)
        if (x < w - 1 && y > 0) depth[i] = Math.min(depth[i], depth[i - w + 1] + 1.414)
    }
    for (let y = h - 1; y >= 0; y -= 1) for (let x = w - 1; x >= 0; x -= 1) {
        const i = y * w + x; if (!depth[i]) continue
        if (x < w - 1) depth[i] = Math.min(depth[i], depth[i + 1] + 1)
        if (y < h - 1) depth[i] = Math.min(depth[i], depth[i + w] + 1)
        if (x < w - 1 && y < h - 1) depth[i] = Math.min(depth[i], depth[i + w + 1] + 1.414)
        if (x > 0 && y < h - 1) depth[i] = Math.min(depth[i], depth[i + w - 1] + 1.414)
    }
    level.depth = depth
    level.valid = valid
    level.targets = Int32Array.from(targets)
    level.sources = Int32Array.from(sources)
}

const patchDist = (img, w, p, q, cap) => {
    let d = 0
    for (let dy = -R; dy <= R; dy += 1) {
        let a = (p + dy * w - R) * 3
        let b = (q + dy * w - R) * 3
        for (let k = 0; k < (2 * R + 1) * 3; k += 1) {
            const e = img[a + k] - img[b + k]
            d += e * e
        }
        if (d > cap) return d
    }
    return d
}

const randomSource = (level, rng) => level.sources[(rng() * level.sources.length) | 0]

async function search(level, { iterations, maxRadius, rng, tick }) {
    const { w, h, img, valid, targets } = level
    const nnf = level.nnf
    const dist = level.dist
    for (let t = 0; t < targets.length; t += 1) dist[targets[t]] = patchDist(img, w, targets[t], nnf[targets[t]], Infinity)
    for (let it = 0; it < iterations; it += 1) {
        const forward = it % 2 === 0
        const step = forward ? 1 : -1
        for (let i = 0; i < targets.length; i += 1) {
            const p = targets[forward ? i : targets.length - 1 - i]
            let best = nnf[p]
            let bestD = dist[p]
            const px = p % w
            // Propagation: a neighbour's match, shifted by one.
            for (const off of [step, step * w]) {
                const n = p - off
                if (n < 0 || n >= w * h || (off === step && (n % w) !== px - step)) continue
                const cand = nnf[n] + off
                if (cand >= 0 && cand < w * h && valid[cand] && cand !== best) {
                    const d = patchDist(img, w, p, cand, bestD)
                    if (d < bestD) { best = cand; bestD = d }
                }
            }
            // Random search around the current best, halving the window.
            const bx = best % w, by = (best / w) | 0
            for (let r = maxRadius; r >= 1; r >>= 1) {
                const cx = Math.min(w - 1 - R, Math.max(R, bx + Math.round((rng() * 2 - 1) * r)))
                const cy = Math.min(h - 1 - R, Math.max(R, by + Math.round((rng() * 2 - 1) * r)))
                const cand = cy * w + cx
                if (!valid[cand] || cand === best) continue
                const d = patchDist(img, w, p, cand, bestD)
                if (d < bestD) { best = cand; bestD = d }
            }
            nnf[p] = best
            dist[p] = bestD
            if ((i & 255) === 0) await tick()
        }
    }
}

// Every hole pixel = weighted vote of the matches covering it: similar matches
// and matches near the hole's edge count more (GAMMA per pixel of depth).
const GAMMA = 1.3

async function vote(level, tick) {
    const { w, img, hole, targets, nnf, dist, depth } = level
    const acc = new Float32Array(w * level.h * 3)
    const wsum = new Float32Array(w * level.h)
    // Similarity scale: the 75th percentile of match distance (Wexler).
    const sample = []
    for (let i = 0; i < targets.length; i += Math.max(1, (targets.length / 512) | 0)) sample.push(dist[targets[i]])
    sample.sort((a, b) => a - b)
    const sigma2 = Math.max(1e-6, sample[Math.floor(sample.length * 0.75)] || 1)
    for (let i = 0; i < targets.length; i += 1) {
        const p = targets[i]
        const q = nnf[p]
        const wt = (Math.exp(-dist[p] / sigma2) + 1e-9) * Math.pow(GAMMA, -depth[p])
        for (let dy = -R; dy <= R; dy += 1) {
            for (let dx = -R; dx <= R; dx += 1) {
                const x = p + dy * w + dx
                if (!hole[x]) continue
                const s = q + dy * w + dx
                acc[x * 3] += wt * img[s * 3]
                acc[x * 3 + 1] += wt * img[s * 3 + 1]
                acc[x * 3 + 2] += wt * img[s * 3 + 2]
                wsum[x] += wt
            }
        }
        if ((i & 1023) === 0) await tick()
    }
    for (let x = 0; x < hole.length; x += 1) {
        if (!hole[x] || !wsum[x]) continue
        img[x * 3] = acc[x * 3] / wsum[x]
        img[x * 3 + 1] = acc[x * 3 + 1] / wsum[x]
        img[x * 3 + 2] = acc[x * 3 + 2] / wsum[x]
    }
}

// Carry the coarse fill and field up one level.
const upsampleInto = (fine, coarse, rng) => {
    const { w, h, img, hole } = fine
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const p = y * w + x
            if (!hole[p]) continue
            const cx = Math.min(coarse.w - 1, x >> 1), cy = Math.min(coarse.h - 1, y >> 1)
            const c = cy * coarse.w + cx
            img[p * 3] = coarse.img[c * 3]; img[p * 3 + 1] = coarse.img[c * 3 + 1]; img[p * 3 + 2] = coarse.img[c * 3 + 2]
        }
    }
    fine.nnf = new Int32Array(w * h)
    fine.dist = new Float32Array(w * h)
    for (const p of fine.targets) {
        const x = p % w, y = (p / w) | 0
        const cx = Math.min(coarse.w - 1, x >> 1), cy = Math.min(coarse.h - 1, y >> 1)
        const cq = coarse.nnf[cy * coarse.w + cx]
        let cand = -1
        if (cq >= 0) {
            const qx = 2 * (cq % coarse.w) + (x & 1), qy = 2 * ((cq / coarse.w) | 0) + (y & 1)
            if (qx >= R && qy >= R && qx < w - R && qy < h - R) cand = qy * w + qx
        }
        fine.nnf[p] = cand >= 0 && fine.valid[cand] ? cand : randomSource(fine, rng)
    }
}

// Seamless blend: the fill keeps its texture but its tone is pulled to the
// surroundings — the edge error (known neighbour − fill) is spread through the
// hole as a harmonic membrane (Laplace, solved on a coarse grid) and added.
const membraneBlend = async (img, w, h, hole, tick) => {
    let x0 = w, y0 = h, x1 = -1, y1 = -1
    for (let p = 0; p < w * h; p += 1) if (hole[p]) { const x = p % w, y = (p / w) | 0; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y }
    if (x1 < x0) return
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1
    const s = Math.min(1, 96 / Math.max(bw, bh))
    const gw = Math.max(2, Math.ceil(bw * s)), gh = Math.max(2, Math.ceil(bh * s))
    const sum = new Float32Array(gw * gh * 3), cnt = new Float32Array(gw * gh), inHole = new Uint8Array(gw * gh)
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
        const p = y * w + x
        if (!hole[p]) continue
        const g = Math.min(gh - 1, ((y - y0) * s) | 0) * gw + Math.min(gw - 1, ((x - x0) * s) | 0)
        inHole[g] = 1
        let r = 0, gg = 0, b = 0, n = 0
        for (const q of [p - 1, p + 1, p - w, p + w]) {
            if (q < 0 || q >= w * h || hole[q]) continue
            r += img[q * 3]; gg += img[q * 3 + 1]; b += img[q * 3 + 2]; n += 1
        }
        if (!n) continue
        sum[g * 3] += r / n - img[p * 3]; sum[g * 3 + 1] += gg / n - img[p * 3 + 1]; sum[g * 3 + 2] += b / n - img[p * 3 + 2]
        cnt[g] += 1
    }
    const c = new Float32Array(gw * gh * 3)
    const fixed = new Uint8Array(gw * gh)
    for (let g = 0; g < gw * gh; g += 1) if (cnt[g]) { fixed[g] = 1; for (let k = 0; k < 3; k += 1) c[g * 3 + k] = sum[g * 3 + k] / cnt[g] }
    for (let it = 0; it < 400; it += 1) {
        if ((it & 15) === 0) await tick()
        for (let y = 0; y < gh; y += 1) for (let x = 0; x < gw; x += 1) {
            const g = y * gw + x
            if (fixed[g] || !inHole[g]) continue
            let n = 0, a0 = 0, a1 = 0, a2 = 0
            for (const q of [x > 0 ? g - 1 : -1, x < gw - 1 ? g + 1 : -1, y > 0 ? g - gw : -1, y < gh - 1 ? g + gw : -1]) {
                if (q < 0 || !inHole[q]) continue
                a0 += c[q * 3]; a1 += c[q * 3 + 1]; a2 += c[q * 3 + 2]; n += 1
            }
            if (n) { c[g * 3] = a0 / n; c[g * 3 + 1] = a1 / n; c[g * 3 + 2] = a2 / n }
        }
    }
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
        const p = y * w + x
        if (!hole[p]) continue
        const fx = Math.min(gw - 1, Math.max(0, (x - x0) * s - 0.5)), fy = Math.min(gh - 1, Math.max(0, (y - y0) * s - 0.5))
        const ix = Math.min(gw - 2, fx | 0), iy = Math.min(gh - 2, fy | 0), u = fx - ix, v = fy - iy
        for (let k = 0; k < 3; k += 1) {
            const a = c[(iy * gw + ix) * 3 + k], b = c[(iy * gw + ix + 1) * 3 + k], cc = c[((iy + 1) * gw + ix) * 3 + k], d = c[((iy + 1) * gw + ix + 1) * 3 + k]
            img[p * 3 + k] += (a * (1 - u) + b * u) * (1 - v) + (cc * (1 - u) + d * u) * v
        }
    }
}

/**
 * Fill `hole` (1 = fill) in an RGBA image. Returns a new RGBA buffer; known
 * pixels are copied through untouched. Returns null when there is nothing to
 * copy from (the hole leaves no whole 7×7 patch of known picture).
 *
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} hole
 * @param {{ maxWorkSide?: number, sliceMs?: number, seed?: number, signal?: AbortSignal }} [opts]
 */
export async function patchInpaint(rgba, width, height, hole, { maxWorkSide = 400, sliceMs = 10, seed = 7, signal } = {}) {
    const n = width * height
    const img = new Float32Array(n * 3)
    let holes = 0
    for (let p = 0; p < n; p += 1) {
        img[p * 3] = rgba[p * 4]; img[p * 3 + 1] = rgba[p * 4 + 1]; img[p * 3 + 2] = rgba[p * 4 + 2]
        if (hole[p]) holes += 1
    }
    const out = new Uint8ClampedArray(rgba)
    if (!holes) return out

    let sliceEnd = now() + sliceMs
    const tick = async () => {
        if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
        if (now() < sliceEnd) return
        await yieldNow()
        sliceEnd = now() + sliceMs
    }

    const levels = [{ w: width, h: height, img, hole: Uint8Array.from(hole, (v) => (v ? 1 : 0)) }]
    while (Math.max(levels.at(-1).w, levels.at(-1).h) > 48) {
        const next = downsample(levels.at(-1))
        classify(next)
        if (!next.sources.length) break
        levels.push(next)
    }
    classify(levels[0])
    if (!levels[0].sources.length) return null
    if (!levels.at(-1).valid) classify(levels.at(-1))

    const rng = makeRng(seed)
    const coarsest = levels.at(-1)
    onionFill(coarsest)
    coarsest.nnf = new Int32Array(coarsest.w * coarsest.h)
    coarsest.dist = new Float32Array(coarsest.w * coarsest.h)
    for (const p of coarsest.targets) coarsest.nnf[p] = randomSource(coarsest, rng)

    for (let i = levels.length - 1; i >= 0; i -= 1) {
        const level = levels[i]
        if (i < levels.length - 1) upsampleInto(level, levels[i + 1], rng)
        if (!level.targets.length) continue
        if (i < levels.length - 1) {
            // Rebuild this level through the upsampled field first.
            for (const p of level.targets) level.dist[p] = patchDist(level.img, level.w, p, level.nnf[p], Infinity)
            await vote(level, tick)
        }
        const side = Math.max(level.w, level.h)
        const full = side <= maxWorkSide
        // Coarse levels decide the structure; fine ones only sharpen it.
        const rounds = full ? (i === levels.length - 1 ? 6 : 4) : 1
        for (let round = 0; round < rounds; round += 1) {
            await search(level, { iterations: full ? 2 : 1, maxRadius: full ? side : 8, rng, tick })
            await vote(level, tick)
        }
    }

    await membraneBlend(img, width, height, hole, tick)
    for (let p = 0; p < n; p += 1) {
        if (!hole[p]) continue
        out[p * 4] = img[p * 3]; out[p * 4 + 1] = img[p * 3 + 1]; out[p * 4 + 2] = img[p * 3 + 2]
        out[p * 4 + 3] = 255
    }
    return out
}
