#!/usr/bin/env bun
/**
 * Invariants for the classical-CV core (src/lib/cv/*) — no browser, no GPU, no
 * model. Each algorithm is checked against a reference that cannot be wrong:
 * brute-force box means, brute-force O(N²) distance, and synthetic edges whose
 * blur σ is known exactly because the harness produced it.
 *
 * Usage: bun scripts/verify-cv.mjs
 */
import { boxMean, gaussianBlur, integralImage, makePlane, mapPlane, resamplePlane, upsamplePlane } from '../src/lib/cv/box-filter.js'
import { detailSplit, fastGuidedCoefficients, fastGuidedFilter, guidedFilter, propagateSparse, refineMatte } from '../src/lib/cv/guided-filter.js'
import { distanceRamp, distanceTransform, signedDistanceTransform, squaredDistanceTransform } from '../src/lib/cv/distance-transform.js'
import { defocusCoverage, defocusMap, gradientMagnitude, sparseDefocus } from '../src/lib/cv/defocus-map.js'
import { combine, fromDefocus, fromDepth, fromGroundPlane, fromLinear, fromMatte, fromRadial, refocus } from '../src/lib/cv/coc.js'

let failures = 0
let checks = 0
const check = (ok, name, detail) => {
    checks += 1
    if (!ok) failures += 1
    console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  (${detail})` : ''}`)
}

const rng = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
}

const planeFrom = (w, h, fn) => {
    const p = makePlane(w, h)
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) p.data[y * w + x] = fn(x, y)
    return p
}

const maxAbsDiff = (a, b) => {
    let m = 0
    for (let i = 0; i < a.data.length; i += 1) m = Math.max(m, Math.abs(a.data[i] - b.data[i]))
    return m
}

// ── 1. box mean vs brute force ──────────────────────────────────────────────
{
    const rand = rng(7)
    const p = planeFrom(37, 23, () => rand())
    for (const r of [0, 1, 3, 8, 40]) {
        const fast = boxMean(p, r)
        const slow = makePlane(p.width, p.height)
        for (let y = 0; y < p.height; y += 1) {
            for (let x = 0; x < p.width; x += 1) {
                let sum = 0
                let n = 0
                for (let yy = Math.max(0, y - r); yy <= Math.min(p.height - 1, y + r); yy += 1) {
                    for (let xx = Math.max(0, x - r); xx <= Math.min(p.width - 1, x + r); xx += 1) {
                        sum += p.data[yy * p.width + xx]
                        n += 1
                    }
                }
                slow.data[y * p.width + x] = sum / n
            }
        }
        check(maxAbsDiff(fast, slow) < 1e-5, `box mean r=${r} matches brute force`, `max diff ${maxAbsDiff(fast, slow).toExponential(2)}`)
    }
    const flat = makePlane(16, 16, 0.42)
    check(Math.abs(boxMean(flat, 5).data[0] - 0.42) < 1e-6, 'a flat plane survives the box mean unchanged (border areas included)')
    const { sum, stride } = integralImage(planeFrom(4, 4, () => 1))
    check(sum[4 * stride + 4] === 16, 'the integral image totals the whole plane', `${sum[4 * stride + 4]}`)
}

// ── 2. resample / upsample ─────────────────────────────────────────────────
{
    const p = planeFrom(64, 64, (x) => (x < 32 ? 0 : 1))
    const small = resamplePlane(p, 16, 16)
    check(small.width === 16 && Math.abs(small.data[0] - 0) < 1e-6 && Math.abs(small.data[15] - 1) < 1e-6,
        'downsampling area-averages instead of point-sampling')
    const back = upsamplePlane(small, 64, 64)
    check(back.width === 64 && back.data[0] < 0.01 && back.data[63] > 0.99, 'bilinear upsample restores the extremes')
    let monotonic = true
    for (let x = 1; x < 64; x += 1) if (back.data[x] < back.data[x - 1] - 1e-6) monotonic = false
    check(monotonic, 'the upsampled ramp never goes backwards (no half-pixel shift artefacts)')
    const identity = resamplePlane(p, 64, 64)
    check(maxAbsDiff(identity, p) === 0, 'resampling to the same size is a copy')
}

// ── 3. gaussian blur ───────────────────────────────────────────────────────
{
    const impulse = makePlane(41, 41)
    impulse.data[20 * 41 + 20] = 1
    const blurred = gaussianBlur(impulse, 3)
    let total = 0
    for (const v of blurred.data) total += v
    check(Math.abs(total - 1) < 1e-3, 'the gaussian kernel conserves energy', `sum ${total.toFixed(5)}`)
    check(blurred.data[20 * 41 + 20] > blurred.data[20 * 41 + 25], 'and falls off away from the impulse')
    check(maxAbsDiff(gaussianBlur(impulse, 0), impulse) === 0, 'σ = 0 is a no-op')
}

// ── 4. guided filter: the linear model, edges, and the fast variant ────────
{
    const rand = rng(11)
    const step = planeFrom(96, 96, (x) => (x < 48 ? 0.15 : 0.85))
    const noisy = mapPlane(step, (v) => Math.max(0, Math.min(1, v + (rand() - 0.5) * 0.12)))

    // Self-guided: noise goes, the edge stays.
    // Denoising is the large-eps regime: eps has to exceed the noise variance or
    // the filter is right to preserve what it sees.
    const smoothed = guidedFilter(noisy, noisy, { radius: 6, eps: 1e-2 })
    const noiseBefore = (() => {
        let s = 0
        for (let y = 20; y < 76; y += 1) for (let x = 5; x < 40; x += 1) s += Math.abs(noisy.data[y * 96 + x] - 0.15)
        return s
    })()
    const noiseAfter = (() => {
        let s = 0
        for (let y = 20; y < 76; y += 1) for (let x = 5; x < 40; x += 1) s += Math.abs(smoothed.data[y * 96 + x] - 0.15)
        return s
    })()
    check(noiseAfter < noiseBefore * 0.45, 'the guided filter removes noise in flat regions', `${(noiseAfter / noiseBefore).toFixed(3)}× residual`)
    const edgeBefore = step.data[48 * 96 + 48] - step.data[48 * 96 + 47]
    const edgeAfter = smoothed.data[48 * 96 + 70] - smoothed.data[48 * 96 + 26]
    check(edgeAfter > edgeBefore * 0.9, 'and keeps the edge it was guided by', `${edgeAfter.toFixed(3)} vs ${edgeBefore.toFixed(3)}`)

    // A guide with a hard edge must transfer it to a soft input — the matte case.
    const softMask = planeFrom(96, 96, (x) => Math.max(0, Math.min(1, (x - 30) / 36)))
    const transferred = guidedFilter(step, softMask, { radius: 8, eps: 1e-4 })
    const gradientAtEdge = Math.abs(transferred.data[48 * 96 + 49] - transferred.data[48 * 96 + 47])
    const gradientAway = Math.abs(transferred.data[48 * 96 + 20] - transferred.data[48 * 96 + 18])
    check(gradientAtEdge > gradientAway * 2, 'a soft mask snaps to the guide\'s edge', `${gradientAtEdge.toFixed(4)} vs ${gradientAway.toFixed(4)}`)

    // Fast variant tracks the exact one.
    const exact = guidedFilter(step, softMask, { radius: 8, eps: 1e-4 })
    const fast = fastGuidedFilter(step, softMask, { radius: 8, eps: 1e-4, subsample: 4 })
    let mae = 0
    for (let i = 0; i < exact.data.length; i += 1) mae += Math.abs(exact.data[i] - fast.data[i])
    mae /= exact.data.length
    check(mae < 0.03, 'the fast guided filter tracks the exact one', `mean abs error ${mae.toFixed(4)}`)
    const coeffs = fastGuidedCoefficients(step, softMask, { radius: 8, eps: 1e-4, subsample: 4 })
    check(coeffs.scale === 4 && coeffs.a.width < step.width, 'it returns low-resolution coefficients for the shader path',
        `${coeffs.a.width}×${coeffs.a.height} at 1/${coeffs.scale}`)
    check(fastGuidedCoefficients(step, softMask, { subsample: 1 }).scale === 1, 'subsample 1 falls back to the exact coefficients')

    // eps decides whether a window counts as structure. At eps → ∞ the fit has no
    // slope left, so the output is a box mean and the edge spreads over the window.
    const width10to90 = (plane) => {
        const row = 48 * 96
        let lo = 0
        let hi = 95
        for (let x = 0; x < 96; x += 1) if (plane.data[row + x] < 0.22) lo = x
        for (let x = 95; x >= 0; x -= 1) if (plane.data[row + x] > 0.78) hi = x
        return hi - lo
    }
    const tightEps = guidedFilter(step, step, { radius: 6, eps: 1e-6 })
    const looseEps = guidedFilter(step, step, { radius: 6, eps: 1 })
    check(width10to90(looseEps) > width10to90(tightEps) + 4,
        'a large eps collapses the filter to a plain mean, as the paper says it should',
        `edge spreads ${width10to90(tightEps)}px → ${width10to90(looseEps)}px`)
}

// ── 5. matte refinement, detail split, sparse propagation ─────────────────
{
    const guide = planeFrom(64, 64, (x) => (x < 32 ? 0.2 : 0.8))
    const matte = planeFrom(64, 64, (x) => (x < 28 ? 1 : x > 36 ? 0 : (36 - x) / 8))
    const refined = refineMatte(matte, guide, { radius: 6, eps: 1e-4, subsample: 2 })
    let inRange = true
    for (const v of refined.data) if (v < 0 || v > 1) inRange = false
    check(inRange, 'a refined matte stays inside 0..1')
    check(refined.data[32 * 64 + 10] > 0.8 && refined.data[32 * 64 + 55] < 0.2, 'and keeps its two sides')
    const feathered = refineMatte(matte, guide, { radius: 6, feather: 0.8 })
    const spread = (p) => Math.abs(p.data[32 * 64 + 10] - p.data[32 * 64 + 55])
    check(spread(feathered) < spread(refined), 'feather softens the transition instead of sharpening it',
        `${spread(feathered).toFixed(3)} vs ${spread(refined).toFixed(3)}`)

    const texture = planeFrom(64, 64, (x, y) => 0.5 + 0.08 * Math.sin(x * 1.1) * Math.cos(y * 0.9))
    // Structure's regime: eps above the texture's own variance, so fine texture
    // lands in the detail layer instead of being preserved in the base.
    const { base, detail } = detailSplit(texture, { radius: 6, eps: 1e-2, subsample: 1 })
    let baseRange = 0
    let detailRange = 0
    for (let i = 0; i < base.data.length; i += 1) {
        baseRange = Math.max(baseRange, Math.abs(base.data[i] - 0.5))
        detailRange = Math.max(detailRange, Math.abs(detail.data[i]))
    }
    check(detailRange > baseRange * 0.8, 'the detail split puts the fine texture in the detail layer, not the base',
        `detail ${detailRange.toFixed(3)} vs base ${baseRange.toFixed(3)}`)
    let sums = 0
    for (let i = 0; i < base.data.length; i += 1) sums = Math.max(sums, Math.abs(base.data[i] + detail.data[i] - texture.data[i]))
    check(sums < 1e-5, 'base + detail reconstructs the input exactly', `max diff ${sums.toExponential(2)}`)

    const values = makePlane(64, 64)
    const weights = makePlane(64, 64)
    for (let y = 0; y < 64; y += 1) {
        values.data[y * 64 + 10] = 0.25
        weights.data[y * 64 + 10] = 1
        values.data[y * 64 + 54] = 0.75
        weights.data[y * 64 + 54] = 1
    }
    const spreadOut = propagateSparse(values, weights, guide, { radius: 12, eps: 1e-3, subsample: 1 })
    check(spreadOut.data[32 * 64 + 20] > 0.15 && spreadOut.data[32 * 64 + 45] > 0.4,
        'sparse values propagate into the gaps between them',
        `${spreadOut.data[32 * 64 + 20].toFixed(3)} / ${spreadOut.data[32 * 64 + 45].toFixed(3)}`)
    const empty = propagateSparse(makePlane(32, 32), makePlane(32, 32), makePlane(32, 32), { subsample: 1 })
    check(empty.data.every((v) => v === 0), 'nothing to propagate yields zeros, not NaN')
}

// ── 6. distance transform vs brute force ──────────────────────────────────
{
    const rand = rng(23)
    const mask = planeFrom(48, 40, () => (rand() < 0.04 ? 1 : 0))
    const fast = squaredDistanceTransform(mask)
    const slow = makePlane(mask.width, mask.height)
    const seeds = []
    for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) if (mask.data[y * mask.width + x] >= 0.5) seeds.push([x, y])
    for (let y = 0; y < mask.height; y += 1) {
        for (let x = 0; x < mask.width; x += 1) {
            let best = Infinity
            for (const [sx, sy] of seeds) best = Math.min(best, (x - sx) ** 2 + (y - sy) ** 2)
            slow.data[y * mask.width + x] = best
        }
    }
    check(maxAbsDiff(fast, slow) < 1e-6, 'the distance transform is EXACT against brute force',
        `max diff ${maxAbsDiff(fast, slow)}`)

    const disc = planeFrom(64, 64, (x, y) => (Math.hypot(x - 32, y - 32) < 12 ? 1 : 0))
    const euclid = distanceTransform(disc)
    check(Math.abs(euclid.data[32 * 64 + 52] - 8) < 1.5, 'euclidean distance reads in pixels',
        `${euclid.data[32 * 64 + 52].toFixed(2)} px at 20 px from the centre of a r=12 disc`)
    const signed = signedDistanceTransform(disc)
    check(signed.data[32 * 64 + 32] < 0 && signed.data[32 * 64 + 60] > 0, 'the signed variant is negative inside, positive outside',
        `${signed.data[32 * 64 + 32].toFixed(1)} / ${signed.data[32 * 64 + 60].toFixed(1)}`)

    const ramp = distanceRamp(disc, { reach: 16, gamma: 1 })
    check(ramp.data[32 * 64 + 32] === 0, 'the ramp is zero inside the mask')
    check(ramp.data[32 * 64 + 48] > 0.1 && ramp.data[32 * 64 + 48] < 1, 'rises across the reach')
    check(ramp.data[32 * 64 + 63] === 1, 'and saturates past it')
    const steep = distanceRamp(disc, { reach: 16, gamma: 2.5 })
    check(steep.data[32 * 64 + 46] < ramp.data[32 * 64 + 46], 'gamma above 1 holds the near field sharper for longer')
    const emptyMask = makePlane(16, 16)
    const emptyRamp = distanceRamp(emptyMask, { reach: 8 })
    check(emptyRamp.data.every((v) => v === 1), 'with nothing masked, everything is far away (no NaN)')
}

// ── 7. defocus estimation recovers a KNOWN sigma ───────────────────────────
{
    const sharpEdge = planeFrom(128, 128, (x) => (x < 64 ? 0.15 : 0.85))
    for (const trueSigma of [1, 2, 4]) {
        const blurred = gaussianBlur(sharpEdge, trueSigma)
        const { sigma } = sparseDefocus(blurred, { edgeThreshold: 0.005, sigmaMax: 16 })
        // Read it ON the edge: the flanks of a blurred step carry a different
        // gradient ratio and are not what the model describes.
        const estimate = sigma.data[64 * 128 + 64]
        const error = Math.abs(estimate - trueSigma) / trueSigma
        check(error < 0.2, `defocus estimate recovers σ = ${trueSigma} from the gradient ratio`,
            `estimated ${estimate.toFixed(2)} (${(error * 100).toFixed(0)}% error)`)
    }

    // Ordering is what the effect actually needs: blurrier must read as blurrier.
    const twoZones = planeFrom(160, 64, (x, y) => {
        const base = Math.sin(x * 0.7) > 0 ? 0.8 : 0.2
        return base + (y % 17 === 0 ? 0.05 : 0)
    })
    const left = gaussianBlur(twoZones, 0.4)
    const right = gaussianBlur(twoZones, 4)
    const stitched = makePlane(160, 64)
    for (let y = 0; y < 64; y += 1) {
        for (let x = 0; x < 160; x += 1) {
            stitched.data[y * 160 + x] = x < 80 ? left.data[y * 160 + x] : right.data[y * 160 + x]
        }
    }
    const { map, usable } = defocusMap(stitched, { edgeThreshold: 0.01, radius: 20, subsample: 1 })
    check(usable, 'a textured frame yields a usable defocus map')
    let sharpSide = 0
    let softSide = 0
    for (let y = 8; y < 56; y += 1) {
        for (let x = 10; x < 70; x += 1) sharpSide += map.data[y * 160 + x]
        for (let x = 90; x < 150; x += 1) softSide += map.data[y * 160 + x]
    }
    check(softSide > sharpSide, 'the blurred half reads as more defocused than the sharp half',
        `${(softSide / 2880).toFixed(3)} vs ${(sharpSide / 2880).toFixed(3)}`)

    const flat = makePlane(64, 64, 0.5)
    const flatResult = defocusMap(flat, { subsample: 1 })
    check(!flatResult.usable && flatResult.map.data.every((v) => v === 0),
        'a frame with no edges reports "no information" instead of amplifying noise')
    const { confidence } = sparseDefocus(gaussianBlur(sharpEdge, 2), { edgeThreshold: 0.005 })
    const coverage = defocusCoverage(confidence)
    check(coverage > 0 && coverage < 0.5, 'coverage reports the fraction of pixels carrying an estimate',
        `${(coverage * 100).toFixed(1)}%`)
    const grad = gradientMagnitude(sharpEdge)
    check(grad.data[64 * 128 + 64] > 0.3 && grad.data[64 * 128 + 10] < 1e-6, 'the gradient fires on the edge and nowhere else')
}

// ── 8. CoC sources ────────────────────────────────────────────────────────
{
    const depth = planeFrom(32, 32, (x) => x / 31)     // 0 far … 1 near
    const focused = fromDepth(depth, { focus: 0.5, aperture: 1, nearBias: 1 })
    check(focused.data[16 * 32 + 16] < 0.1, 'at the focus plane the CoC is ~0', `${focused.data[16 * 32 + 16].toFixed(3)}`)
    check(focused.data[16 * 32 + 0] > 0.8 && focused.data[16 * 32 + 31] > 0.8, 'and rises on both sides of it')
    const mild = fromDepth(depth, { focus: 0.5, aperture: 0.6, nearBias: 1 })
    const biased = fromDepth(depth, { focus: 0.5, aperture: 0.6, nearBias: 2 })
    check(biased.data[16 * 32 + 31] > mild.data[16 * 32 + 31], 'nearBias blurs the foreground harder, as a real lens does',
        `${biased.data[16 * 32 + 31].toFixed(3)} vs ${mild.data[16 * 32 + 31].toFixed(3)}`)
    let monotonic = true
    for (let x = 17; x < 32; x += 1) {
        if (focused.data[16 * 32 + x] < focused.data[16 * 32 + x - 1] - 1e-6) monotonic = false
    }
    check(monotonic, 'CoC grows monotonically with distance from focus')

    const matte = planeFrom(64, 64, (x, y) => (Math.hypot(x - 32, y - 32) < 14 ? 1 : 0))
    const portrait = fromMatte(matte, { reach: 0.4, gamma: 1.2, aperture: 1 })
    check(portrait.data[32 * 64 + 32] === 0, 'the subject stays sharp under matte DoF')
    check(portrait.data[32 * 64 + 50] > 0.05, 'the background blurs with distance from the silhouette',
        `${portrait.data[32 * 64 + 50].toFixed(3)}`)
    let ordered = true
    for (let x = 47; x < 63; x += 1) {
        if (portrait.data[32 * 64 + x] < portrait.data[32 * 64 + x - 1] - 1e-6) ordered = false
    }
    check(ordered, 'and does so in order, never in bands')

    const band = fromLinear(40, 40, { p1: { x: 0, y: 0.4 }, p2: { x: 0, y: 0.6 }, feather: 0.3, aperture: 1 })
    check(band.data[20 * 40 + 20] === 0, 'inside a tilt-shift band there is no blur')
    check(band.data[0 * 40 + 20] > 0.5 && band.data[39 * 40 + 20] > 0.5, 'outside it, both ends blur')
    const ellipse = fromRadial(40, 40, { center: { x: 0.5, y: 0.5 }, radius: 0.25, feather: 0.4, aperture: 1 })
    check(ellipse.data[20 * 40 + 20] === 0 && ellipse.data[0] > 0.5, 'radial tilt-shift is sharp in the middle, soft in the corners')
    const rotated = fromRadial(40, 40, { center: { x: 0.5, y: 0.5 }, radius: 0.25, aspect: 3, rotation: Math.PI / 2, feather: 0.4 })
    check(rotated.data[20 * 40 + 2] < rotated.data[2 * 40 + 20], 'rotation turns the focus ellipse',
        `${rotated.data[20 * 40 + 2].toFixed(2)} vs ${rotated.data[2 * 40 + 20].toFixed(2)}`)

    const ground = fromGroundPlane(20, 40, { horizon: 0.4, focus: 0.8, aperture: 1, falloff: 1 })
    check(ground.data[Math.round(0.8 * 40) * 20 + 10] < 0.1, 'the ground plane is sharp at the focus row')
    check(ground.data[39 * 20 + 10] > 0.05, 'and blurs toward the very foreground')

    const defocused = fromDefocus(planeFrom(16, 16, (x) => x / 15), { focus: 0, aperture: 1 })
    check(defocused.data[0] < defocused.data[15], 'defocus magnification blurs what was already soft')
    const maxed = combine(band, fromLinear(40, 40, { p1: { x: 0.4, y: 0 }, p2: { x: 0.6, y: 0 }, feather: 0.3 }), 'max')
    check(maxed.data[0] >= band.data[0], 'combining two CoC maps with max keeps the blurrier of the two')
    const rf = refocus(planeFrom(16, 16, (x) => x / 15), { focus: 0.5, aperture: 1 })
    check(rf.data[7] < rf.data[0] && rf.data[7] < rf.data[15], 're-focusing moves the sharp plane without recomputing the source')

    let bounded = true
    for (const p of [focused, portrait, band, ellipse, ground, defocused, maxed, rf]) {
        for (const v of p.data) if (!(v >= 0 && v <= 1)) bounded = false
    }
    check(bounded, 'every CoC source stays inside 0..1')
}

// ── 9. hostile inputs ─────────────────────────────────────────────────────
{
    const tiny = makePlane(1, 1, 0.5)
    check(boxMean(tiny, 5).data[0] === 0.5, 'a 1×1 plane survives a box mean larger than itself')
    check(Number.isFinite(guidedFilter(tiny, tiny, { radius: 4 }).data[0]), 'and a guided filter')
    check(distanceTransform(tiny).data[0] === 0, 'and a distance transform')
    const nan = makePlane(8, 8)
    nan.data[10] = NaN
    const filtered = guidedFilter(nan, nan, { radius: 2 })
    check(filtered.data.length === 64, 'a NaN does not crash the filter (it propagates, it does not throw)')
    let threw = false
    try { guidedFilter(makePlane(8, 8), makePlane(4, 4)) } catch { threw = true }
    check(threw, 'mismatched sizes are rejected loudly rather than read out of bounds')
    let threwCombine = false
    try { combine(makePlane(4, 4), makePlane(8, 8)) } catch { threwCombine = true }
    check(threwCombine, 'so are mismatched CoC maps')
    check(fromMatte(makePlane(8, 8), { reach: 0 }).data.every((v) => v >= 0 && v <= 1), 'a zero reach does not divide by zero')
}

// ── 10. extremes: shapes and parameters that break naive implementations ───
{
    // A 1×4096 strip: separable passes and the EDT's parabola envelope both have
    // to survive an axis of length 1.
    const strip = makePlane(1, 4096)
    for (let y = 0; y < 4096; y += 1) strip.data[y] = y % 97 === 0 ? 1 : 0
    const stripBox = boxMean(strip, 12)
    check(stripBox.data.every((v) => Number.isFinite(v) && v >= 0 && v <= 1), 'a 1×4096 strip box-filters cleanly')
    const stripDt = distanceTransform(strip, { threshold: 0.5 })
    check(stripDt.data[0] <= 97 && Number.isFinite(stripDt.data[4095]), 'and distance-transforms cleanly',
        `d[0]=${stripDt.data[0].toFixed(1)}`)

    // Radius far larger than the image: the window clips to the image and the
    // result must be the plain mean, not a divide-by-zero.
    const small = planeFrom(6, 6, (x, y) => (x + y) / 10)
    const huge = boxMean(small, 10_000)
    let mean = 0
    for (const v of small.data) mean += v
    mean /= small.data.length
    check(Math.abs(huge.data[0] - mean) < 1e-6, 'a radius larger than the image gives the image mean',
        `${huge.data[0].toFixed(4)} vs ${mean.toFixed(4)}`)

    // Hostile filter parameters.
    const guide = planeFrom(32, 32, (x) => (x < 16 ? 0.2 : 0.8))
    const cases = [
        ['negative radius', { radius: -5, eps: 1e-4 }],
        ['zero eps', { radius: 4, eps: 0 }],
        ['huge eps', { radius: 4, eps: 1e9 }],
        ['NaN eps', { radius: 4, eps: NaN }],
        ['subsample larger than the image', { radius: 4, eps: 1e-4, subsample: 999 }],
    ]
    const broken = []
    for (const [name, opts] of cases) {
        const out = fastGuidedFilter(guide, guide, opts)
        if (!out.data.every((v) => Number.isFinite(v))) broken.push(name)
    }
    check(broken.length === 0, 'the guided filter survives hostile parameters', broken.join(', ') || 'all finite')

    // A guide with no variance at all: every window collapses to its mean, which
    // must not divide by zero.
    const flatGuide = makePlane(24, 24, 0.5)
    const flatOut = guidedFilter(flatGuide, planeFrom(24, 24, (x) => x / 23), { radius: 5, eps: 0 })
    check(flatOut.data.every((v) => Number.isFinite(v)), 'a zero-variance guide with eps 0 stays finite')

    // Distance transform when everything is masked, and when nothing is.
    const allMask = makePlane(16, 16, 1)
    check(distanceTransform(allMask).data.every((v) => v === 0), 'everything masked → distance 0 everywhere')
    const noneMask = makePlane(16, 16, 0)
    check(distanceTransform(noneMask).data.every((v) => v > 1e5), 'nothing masked → distance is effectively infinite')

    // Defocus on pure noise: no coherent edges, so it must report "unusable"
    // rather than inventing a depth map.
    const rand2 = rng(99)
    const noise = planeFrom(96, 96, () => rand2())
    const noiseResult = defocusMap(noise, { subsample: 1 })
    check(typeof noiseResult.usable === 'boolean' && noiseResult.map.data.every((v) => v >= 0 && v <= 1),
        'pure noise yields a bounded map and an explicit usable flag', `usable=${noiseResult.usable}`)

    // A constant frame through the whole CoC chain.
    const constant = makePlane(16, 16, 0.5)
    const cocs = [
        fromDepth(constant, { focus: 0.5, aperture: 1 }),
        fromDefocus(constant, { focus: 0.5, aperture: 1 }),
        fromMatte(constant, { reach: 0.2, aperture: 1 }),
    ]
    check(cocs.every((p) => p.data.every((v) => v >= 0 && v <= 1)), 'a constant frame keeps every CoC source bounded')

    // Upsampling by a large factor must not overshoot 0..1 for a 0..1 input.
    const bigUp = upsamplePlane(planeFrom(4, 4, (x, y) => ((x + y) % 2)), 512, 512)
    check(bigUp.data.every((v) => v >= -1e-6 && v <= 1 + 1e-6), 'a 128× upsample does not overshoot',
        `range ${Math.min(...bigUp.data).toFixed(3)}..${Math.max(...bigUp.data).toFixed(3)}`)
}

console.log(`\n${checks - failures}/${checks} checks passed.`)
if (failures > 0) { console.error(`\x1b[31m${failures} check(s) failed.\x1b[0m`); process.exit(1) }
process.exit(0)
