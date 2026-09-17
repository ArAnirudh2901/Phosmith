// Pure selection engines: Magic Wand flood fill + Select-and-Mask edge refinement.
import { magicWandMask } from '../src/lib/magic-wand.js'
import { refineCoverage } from '../src/lib/mask-grow-core.js'

let pass = 0, fail = 0
const check = (ok, name) => { if (ok) pass += 1; else { fail += 1; console.log(`✗ ${name}`) } }

// 40×20 blue image with two 6×6 red squares (x 4..9 and x 30..35, y 7..12).
const W = 40, H = 20
const img = new Uint8ClampedArray(W * H * 4)
for (let p = 0; p < W * H; p += 1) { img[p * 4 + 2] = 200; img[p * 4 + 3] = 255 }
const paint = (x0, y0, s, [r, g, b]) => { for (let y = y0; y < y0 + s; y += 1) for (let x = x0; x < x0 + s; x += 1) { const i = (y * W + x) * 4; img[i] = r; img[i + 1] = g; img[i + 2] = b } }
paint(4, 7, 6, [220, 20, 20]); paint(30, 7, 6, [220, 20, 20])

let r = magicWandMask(img, W, H, 6, 9, { antiAlias: false })
check(r.count === 36, 'contiguous selects only the clicked square')
check(r.cover[9 * W + 6] === 255 && r.cover[9 * W + 32] === 0, 'contiguous leaves the far square out')
r = magicWandMask(img, W, H, 6, 9, { contiguous: false, antiAlias: false })
check(r.count === 72, 'non-contiguous selects every matching pixel')
r = magicWandMask(img, W, H, 0, 0, { antiAlias: false })
check(r.count === W * H - 72, 'background click selects the connected background')
r = magicWandMask(img, W, H, 6, 9, { antiAlias: true })
check(r.cover[9 * W + 6] === 255 && r.cover[9 * W + 3] > 0 && r.cover[9 * W + 3] < 255, 'anti-alias softens only the edge')
paint(12, 7, 2, [235, 30, 30])
paint(10, 8, 2, [235, 30, 30])
check(magicWandMask(img, W, H, 6, 9, { tolerance: 0, antiAlias: false }).count === 36, 'tolerance 0 excludes near colours')
check(magicWandMask(img, W, H, 6, 9, { tolerance: 20, antiAlias: false }).count === 44, 'tolerance 20 grows into near colours')
check(magicWandMask(img, W, H, 999, -5, { antiAlias: false }).count > 0, 'out-of-range seed clamps into the image')
check(magicWandMask(new Uint8ClampedArray(0), 0, 0, 0, 0).count === 0, 'empty image is a no-op')
check(magicWandMask(img, W, H, 5, 8, { sample: '3x3', antiAlias: false }).count >= 36, '3×3 sampling works')

// Edge refinement
const S = 160
const sq = new Uint8ClampedArray(S * S)
for (let y = 32; y < 128; y += 1) for (let x = 32; x < 128; x += 1) sq[y * S + x] = 255
const noisy = Uint8ClampedArray.from(sq)
noisy[4 * S + 4] = 255; noisy[150 * S + 140] = 255
check(refineCoverage(sq, S, S, {}) === sq, 'no-op refine returns the input')
const smoothed = refineCoverage(noisy, S, S, { smooth: 60 })
check(smoothed[4 * S + 4] === 0 && smoothed[150 * S + 140] === 0, 'smooth removes isolated specks')
check(smoothed[80 * S + 80] === 255, 'smooth keeps the interior')
const sum = (a) => a.reduce((t, v) => t + v, 0)
check(Math.abs(sum(smoothed) - sum(sq)) / sum(sq) < 0.05, 'smooth preserves area (±5%)')
const ramp = new Uint8ClampedArray(S * S).map((_, i) => Math.round(((i % S) / (S - 1)) * 255))
const hard = refineCoverage(ramp, S, S, { contrast: 100 })
check(hard.every((v) => v === 0 || v === 255), 'contrast 100 yields a binary edge')
const mid = refineCoverage(ramp, S, S, { contrast: 50 })
check(mid[S - 1] === 255 && mid[0] === 0 && mid.some((v) => v > 0 && v < 255), 'contrast 50 steepens but keeps some softness')

console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
