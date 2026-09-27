#!/usr/bin/env bun
/**
 * Pixel Stretch: the scanline engine and the NL parser, with no browser.
 *
 * `verify-flow-stretch.mjs` covers the flow-path geometry; this covers the two
 * pieces that have no geometry to check — the segmented scan that produces the
 * datamosh smear, and the deterministic parser that decides whether a sentence
 * is a stretch request at all. Both are pure, so both belong here rather than in
 * the render harness.
 *
 * Usage: bun scripts/verify-stretch-core.mjs
 */
import {
    getStretchPath,
    DEFAULT_SCANLINE,
    clampScanline,
    scanlineStretchPixels,
    clampStretchParams,
    DEFAULT_STRETCH,
} from '../src/lib/pixel-stretch.js'
import { parseStretchPrompt } from '../src/lib/agent/stretch-commands.js'

let checks = 0
let failures = 0
const check = (ok, name, detail) => {
    checks += 1
    if (!ok) failures += 1
    console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  (${detail})` : ''}`)
}
const section = (name) => console.log(`\n[verify-stretch-core] ${name}`)

// ── A frame whose only bright pixel is at x = 1 of every row ────────────────
const frame = (W, H, paint) => {
    const d = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            const i = (y * W + x) * 4
            const [r, g, b] = paint(x, y)
            d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255
        }
    }
    return d
}
const px = (d, W, x, y) => {
    const i = (y * W + x) * 4
    return [d[i], d[i + 1], d[i + 2]]
}

section('scanline scan')
{
    const W = 10, H = 3
    const d = frame(W, H, (x) => (x === 1 ? [255, 120, 0] : [8, 8, 8]))
    const stats = scanlineStretchPixels(d, W, H, { threshold: 0.3, length: 1, direction: 1 })
    check(stats.scanlines === H, 'every scanline with a survivor is touched', `${stats.scanlines}/${H}`)
    check(px(d, W, 0, 0).join() === '8,8,8', 'pixels BEFORE the first survivor are left alone')
    check(px(d, W, 1, 0).join() === '255,120,0', 'the survivor itself is unchanged')
    check(px(d, W, 9, 0).join() === '255,120,0', 'the survivor colour reaches the end of the run')
}
{
    // A run longer than `length` stops: the original pixels stand again.
    const W = 20, H = 1
    const d = frame(W, H, (x) => (x === 0 ? [255, 255, 255] : [10, 20, 30]))
    scanlineStretchPixels(d, W, H, { threshold: 0.3, length: 0.25, direction: 1 })
    check(px(d, W, 3, 0).join() === '255,255,255', 'inside the length budget the colour propagates')
    check(px(d, W, 12, 0).join() === '10,20,30', 'past the length budget the original pixels stand')
}
{
    const W = 8, H = 1
    const fwd = frame(W, H, (x) => (x === 6 ? [250, 220, 90] : [5, 5, 5]))
    scanlineStretchPixels(fwd, W, H, { threshold: 0.2, length: 1, direction: -1 })
    check(px(fwd, W, 0, 0).join() === '250,220,90', 'direction -1 walks the scanline backwards')
}
{
    const W = 6, H = 1
    const d = frame(W, H, (x) => (x === 0 ? [255, 255, 255] : [0, 0, 0]))
    scanlineStretchPixels(d, W, H, { threshold: 0.3, length: 1, fade: 1, direction: 1 })
    const [r5] = px(d, W, 5, 0)
    const [r1] = px(d, W, 1, 0)
    check(r1 > r5, 'fade darkens along the run', `x1=${r1} x5=${r5}`)
    check(r5 < 60, 'fade 1 reaches (near) black at the far end', `${r5}`)
}
{
    // A scanline with no survivor at all must come back byte-identical.
    const W = 6, H = 2
    const d = frame(W, H, () => [4, 4, 4])
    const before = Uint8ClampedArray.from(d)
    const stats = scanlineStretchPixels(d, W, H, { threshold: 0.9, length: 1 })
    check(stats.filled === 0 && d.every((v, i) => v === before[i]),
        'a scanline with no survivor is left byte-identical')
}
{
    const W = 8, H = 1
    const light = frame(W, H, (x) => (x === 1 ? [10, 10, 10] : [240, 240, 240]))
    scanlineStretchPixels(light, W, H, { threshold: 0.5, mode: 'light', length: 1, direction: 1 })
    check(px(light, W, 5, 0).join() === '10,10,10', 'mode "light" keeps the DARK pixels as survivors')
}
{
    // A region limits the pass; outside it nothing moves.
    const W = 10, H = 10
    const d = frame(W, H, (x) => (x === 0 ? [255, 210, 40] : [9, 9, 9]))
    scanlineStretchPixels(d, W, H, { threshold: 0.3, length: 1, region: { x: 0, y: 0.5, w: 1, h: 0.5 } })
    check(px(d, W, 5, 1).join() === '9,9,9', 'rows above the region are untouched')
    check(px(d, W, 5, 7).join() === '255,210,40', 'rows inside the region are smeared')
}
{
    const W = 6, H = 4
    const d = frame(W, H, (x, y) => (y === 0 ? [0, 200, 0] : [7, 7, 7]))
    scanlineStretchPixels(d, W, H, { axis: 'vertical', threshold: 0.2, length: 1, direction: 1 })
    check(px(d, W, 2, 3).join() === '0,200,0', 'the vertical axis scans columns')
}
{
    const W = 6, H = 1
    const d = frame(W, H, (x) => (x === 0 ? [255, 255, 255] : [0, 0, 0]))
    scanlineStretchPixels(d, W, H, { threshold: 0.3, length: 1, opacity: 0.5 })
    const [r] = px(d, W, 3, 0)
    check(r > 100 && r < 160, 'opacity blends the smear back over the original', `${r}`)
}

section('hostile config')
{
    check(clampScanline(null) === null, 'no config means no scanline pass')
    const hostile = clampScanline({ axis: 'sideways', direction: 'left', mode: 'x', threshold: NaN, length: -5, fade: 99, opacity: Infinity, region: { x: 'a' } })
    check(hostile.axis === 'horizontal' && hostile.direction === 1 && hostile.mode === 'dark',
        'garbage enum values fall back to the defaults')
    check(hostile.threshold === DEFAULT_SCANLINE.threshold, 'NaN threshold falls back, it does not poison the pass')
    check(hostile.length >= 0.01 && hostile.length <= 1, 'length is clamped into range', `${hostile.length}`)
    check(hostile.fade === 1 && hostile.opacity === 1, 'fade and opacity clamp to 1')
    check(hostile.region === null, 'a malformed region is dropped, not half-applied')

    const p = clampStretchParams({ ...DEFAULT_STRETCH, fadeIn: 5, scan: { threshold: 0.5 } })
    check(p.fadeIn === 1, 'fadeIn clamps to 0..1')
    check(p.scan && p.scan.threshold === 0.5, 'a scan config survives clampStretchParams')
    check(clampStretchParams({ ...DEFAULT_STRETCH }).scan === null, 'no scan by default')

    // A 1-pixel frame must not throw.
    const tiny = frame(1, 1, () => [255, 255, 255])
    const st = scanlineStretchPixels(tiny, 1, 1, { threshold: 0.1 })
    check(st.filled === 0, 'a 1x1 frame is a no-op rather than a crash')
}

section('ribbon fold guard')
{
    // A swept ribbon folds through itself — the bow-tie with a hole — wherever its
    // half-width exceeds the path's radius of curvature, so the bend is limited by
    // geometry. Read the limit off the rendered centreline: sagitta s against
    // chord L gives R = (L^2 + 4s^2) / 8s.
    const W = 1000, H = 1000
    const radiusOf = (params) => {
        const pts = getStretchPath(params, W, H, 96)
        const a = pts[0], z = pts[pts.length - 1]
        const L = Math.hypot((z.x - a.x) * W, (z.y - a.y) * H)
        if (L < 1e-6) return { R: Infinity, L: 0, s: 0 }
        const ux = ((z.x - a.x) * W) / L, uy = ((z.y - a.y) * H) / L
        let s = 0
        for (const p of pts) {
            const vx = (p.x - a.x) * W, vy = (p.y - a.y) * H
            const d = Math.abs(vx * uy - vy * ux)
            if (d > s) s = d
        }
        return { R: s < 1e-6 ? Infinity : (L * L + 4 * s * s) / (8 * s), L, s }
    }

    // Short and WIDE and hard-bent: the case that used to fold.
    const wide = { ...DEFAULT_STRETCH, axis: 'vertical', direction: -1, band: { x: 0.2, y: 0.5, w: 0.6, h: 0.2 }, length: 2, bend: 1 }
    const halfWidth = (wide.band.w * W) / 2
    const w = radiusOf(wide)
    check(w.R >= halfWidth * 0.85, 'a short wide ribbon cannot bend tighter than its own half-width',
        `R ${w.R.toFixed(0)} vs half-width ${halfWidth.toFixed(0)}`)

    // Long and thin: the limit must not touch it — the bend has to still work.
    const thin = { ...DEFAULT_STRETCH, axis: 'vertical', direction: -1, band: { x: 0.45, y: 0.55, w: 0.10, h: 0.10 }, length: 5, bend: 1 }
    const t = radiusOf(thin)
    const straightRun = radiusOf({ ...thin, bend: 0 })
    check(t.s > 20, 'a long thin ribbon still bends hard', `sagitta ${t.s.toFixed(1)}px`)
    check(straightRun.s < 1, 'and bend 0 is still dead straight', `sagitta ${straightRun.s.toFixed(2)}px`)

    // The clamp is symmetric and does not flip the bow.
    const neg = radiusOf({ ...wide, bend: -1 })
    check(Math.abs(neg.s - w.s) < 1, 'the limit is symmetric in bend', `${w.s.toFixed(1)} vs ${neg.s.toFixed(1)}`)
    check(radiusOf({ ...wide, bend: 0 }).s < 1, 'a wide ribbon with no bend is straight')
}

section('flare range')
{
    // The reference fans open from a near-point to most of the frame. A tip only
    // twice the seed width cannot make one, so the flare side of `taper` has to
    // reach far past -1.
    const flared = clampStretchParams({ ...DEFAULT_STRETCH, taper: -7 })
    check(flared.taper === -7, 'a wide flare survives clamping', String(flared.taper))
    check(clampStretchParams({ ...DEFAULT_STRETCH, taper: -50 }).taper === -12, 'and is still bounded', '-12')
    check(clampStretchParams({ ...DEFAULT_STRETCH, taper: 1 }).taper === 1, 'the narrowing side still reaches a point')
    check(clampStretchParams({ ...DEFAULT_STRETCH, taper: 5 }).taper === 1, 'and cannot invert past it')
    check(clampStretchParams({ ...DEFAULT_STRETCH, taper: NaN }).taper === 0, 'NaN taper falls back to parallel')

    // A thin slice must be able to cross the frame (see the length clamp).
    check(clampStretchParams({ ...DEFAULT_STRETCH, length: 40 }).length === 40, 'a thin slice can travel 40x its own height')
    check(clampStretchParams({ ...DEFAULT_STRETCH, length: 9999 }).length === 200, 'length is still bounded', '200')
    check(clampStretchParams({ ...DEFAULT_STRETCH, length: 0.2 }).length === 1, 'and never shrinks below the slice')
}

section('ribbon twist')
{
    const t = (v) => clampStretchParams({ ...DEFAULT_STRETCH, ...v })
    check(t({}).twistTurns === 0 && t({}).twistDepth === 1, 'no twist by default, at full depth')
    check(t({ twistTurns: 1.5 }).twistTurns === 1.5, 'fractional half-turns are kept')
    check(t({ twistTurns: 99 }).twistTurns === 3, 'turns are bounded', '3')
    check(t({ twistTurns: -2 }).twistTurns === 0, 'and never negative')
    check(t({ twistDepth: 0.42 }).twistDepth === 0.42, 'a partial depth is kept — that is the pinch-without-flip case')
    check(t({ twistDepth: 9 }).twistDepth === 1 && t({ twistDepth: -1 }).twistDepth === 0, 'depth clamps to 0..1')
    check(t({ twistTurns: NaN }).twistTurns === 0 && t({ twistDepth: NaN }).twistDepth === 1, 'NaN falls back rather than poisoning the sweep')

    // Below half depth the width multiplier (1-d) + d*cos never reaches zero, so
    // the ribbon pinches but does not turn over. At or above it, it crosses.
    const minFactor = (turns, d) => {
        let lo = Infinity
        for (let i = 0; i <= 200; i += 1) {
            const v = (1 - d) + d * Math.cos(Math.PI * turns * (i / 200))
            if (v < lo) lo = v
        }
        return lo
    }
    check(minFactor(1, 0.42) > 0, 'depth 0.42 pinches without flipping', minFactor(1, 0.42).toFixed(3))
    check(minFactor(1, 1) < 0, 'depth 1 turns the ribbon over', minFactor(1, 1).toFixed(3))
}

section('natural language parser')
const routes = [
    ['pixel stretch this photo', 'ribbon'],
    ['stretch the pixels from the top', 'ribbon'],
    ['pull a ribbon off the subject', 'ribbon'],
    ['smear the pixels across the frame', 'ribbon'],
    ['make a strong pixel stretch from the bottom', 'ribbon'],
    ['stretch it and arch the streaks over the building', 'warp'],
    ['warp the stretch into a curl', 'warp'],
    ['stretch with a fan warp', 'warp'],
    ['make the streaks flow through the frame', 'flow'],
    ['stretch along a spiral flow', 'flow'],
    ['datamosh it', 'scanline'],
    ['glitch the dark areas sideways', 'scanline'],
    ['scanline stretch with threshold 60', 'scanline'],
    ['pixel sort the bright pixels downward', 'scanline'],
    ['auto pixel stretch', 'auto'],
    ['pick the best pixel stretch for me', 'auto'],
    ['remove the pixel stretch', 'clear'],
    ['get rid of the streaks', 'clear'],
]
for (const [text, want] of routes) {
    const got = parseStretchPrompt(text)
    check(got?.command === want, `"${text}" → ${want}`, got ? got.command : 'null')
}

const fallThrough = [
    'make it warmer',
    'give it a cinematic grade',
    'blur the background',
    'crop this to a square',
    'remove the person on the left',
    'build a collage from these photos',
    'brighten the shadows a little',
    'add a drop shadow at 45 degrees',
]
for (const text of fallThrough) {
    check(parseStretchPrompt(text) === null, `"${text}" is NOT a stretch request`)
}

section('parser detail')
{
    const p = parseStretchPrompt('stretch from the left with a subtle bend')
    check(p?.params?.from === 'left', 'a named edge is read out of the sentence', p?.params?.from)
    check(p?.params?.bend < 55, 'a subtle request bends less than the default', String(p?.params?.bend))
    const strong = parseStretchPrompt('strong pixel stretch')
    check(strong?.params?.bend > 55, 'a strong request bends more', String(strong?.params?.bend))
    const flat = parseStretchPrompt('straight pixel stretch, no bend')
    check(flat?.params?.bend === 0, 'a straight request does not bend at all')
    const mir = parseStretchPrompt('mirrored pixel stretch both sides')
    check(mir?.params?.mirror === true, 'mirror is recognised')
    const thr = parseStretchPrompt('glitch with threshold 72')
    check(thr?.params?.threshold === 72, 'an explicit threshold is carried through', String(thr?.params?.threshold))
    const vert = parseStretchPrompt('datamosh vertical')
    check(vert?.params?.axis === 'vertical', 'the scanline axis is read')
    check(parseStretchPrompt('') === null, 'empty input is not a request')
    check(parseStretchPrompt(null) === null, 'null input is not a request')
    check(parseStretchPrompt('стретч 🎨') === null, 'unicode noise is not a request')
}

console.log(`\n[verify-stretch-core] ${checks - failures}/${checks} checks passed.`)
if (failures > 0) { console.error(`\x1b[31m${failures} check(s) failed.\x1b[0m`); process.exit(1) }
