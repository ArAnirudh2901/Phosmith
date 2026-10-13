#!/usr/bin/env bun
/**
 * Select Subject's scorer (src/lib/subject-pick.js), pure: which SlimSAM answer
 * reads as the subject. The photo-level judgement lives in
 * `bun scripts/preview-subject.mjs` (contact sheet + `--masks` for IoU); this
 * pins the rules it rests on, on scenes where the answer is known:
 *   - the border-prior saliency puts its box and seeds on an object, not on a
 *     sky that fills most of the frame
 *   - a region running along the frame (background) loses to a contained one
 *   - a flat region loses to a detailed one of the same size and place
 *   - a whole object beats a part of it
 *   - out-of-range areas, empty masks and hostile scores are refused, not NaN
 *   - growToWhole: a part becomes the confident whole containing it (the
 *     frame-filling cat), never a less confident, box-cut or background-shaped one
 */

import { SUBJECT_PICK, gradientMagnitude, growToWhole, scoreSubjectCandidate, subjectPrompts } from '../src/lib/subject-pick.js'

let checks = 0, failures = 0
const check = (ok, label, detail = '') => {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const W = 96, H = 72
// Sky-blue frame, a textured red disc left of centre, a small grey hut bottom-right.
const scene = () => {
  const px = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4
      let c = [90, 140, 210 - y]
      if (Math.hypot(x - 36, y - 36) < 16) c = (x + y) % 4 < 2 ? [220, 40, 30] : [170, 20, 20]
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255
    }
  }
  return px
}
const disc = (x, y) => Math.hypot(x - 36, y - 36) < 16

const px = scene()
const { box, seeds, saliency } = subjectPrompts(px, W, H)
check(box[0] <= 22 && box[2] >= 50 && box[1] <= 22 && box[3] >= 50, 'the prompt box holds the disc', box.map((v) => v.toFixed(0)).join(','))
check((box[2] - box[0]) * (box[3] - box[1]) < 0.6 * W * H, 'and not the whole sky', `${(((box[2] - box[0]) * (box[3] - box[1])) / (W * H)).toFixed(2)} of the frame`)
check(seeds.every(([x, y]) => disc(x, y)), 'every seed lands on the disc', seeds.map(([x, y]) => `${x.toFixed(0)},${y.toFixed(0)}`).join(' '))
check(saliency[36 * W + 36] > 5 * saliency[5 * W + 80], 'the disc is far more salient than the sky', `${saliency[36 * W + 36].toFixed(2)} vs ${saliency[5 * W + 80].toFixed(2)}`)

const grad = gradientMagnitude(px, W, H)
const gm = grad.reduce((a, b) => a + b, 0) / grad.length
check(grad[36 * W + 36] > 20 * grad[5 * W + 80], 'the textured disc carries far more gradient than the sky', `${grad[36 * W + 36].toFixed(0)} vs ${grad[5 * W + 80].toFixed(0)}`)

const maskOf = (fn) => {
  const bits = new Uint8Array(W * H)
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) bits[y * W + x] = fn(x, y) ? 1 : 0
  return bits
}
const score = (fn, sam = 0.95) => scoreSubjectCandidate({ bits: maskOf(fn), w: W, h: H, sam }, grad, gm)

const subject = score(disc)
// The upper sky: about half the frame, along three of its edges.
const sky = score((x, y) => y < 40 && !disc(x, y))
check(subject.score > 0 && subject.score > 10 * Math.max(0, sky.score), 'the disc beats the sky around it', `${subject.score.toFixed(4)} vs ${sky.score.toFixed(4)}`)
check(sky.bc > 3 && subject.bc === 0, 'boundary connectivity: the sky runs along the frame, the disc does not', `bc ${sky.bc.toFixed(2)} vs ${subject.bc}`)

const half = score((x, y) => disc(x, y) && x < 36)
check(subject.score > half.score, 'the whole disc beats half of it', `${subject.score.toFixed(4)} vs ${half.score.toFixed(4)}`)

// Same size and place, one textured, one flat: re-score the disc on a flat-red copy.
const flat = new Uint8ClampedArray(px)
for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (disc(x, y)) { const i = (y * W + x) * 4; flat[i] = 200; flat[i + 1] = 30; flat[i + 2] = 25 }
const gFlat = gradientMagnitude(flat, W, H)
const gmFlat = gFlat.reduce((a, b) => a + b, 0) / gFlat.length
const flatDisc = scoreSubjectCandidate({ bits: maskOf(disc), w: W, h: H, sam: 0.95 }, gFlat, gmFlat)
check(subject.detail > flatDisc.detail, 'a detailed region reads as more subject-like than a flat one', `detail ${subject.detail.toFixed(2)} vs ${flatDisc.detail.toFixed(2)}`)

const corner = score((x, y) => Math.hypot(x - 80, y - 60) < 9)
const centred = score((x, y) => Math.hypot(x - 48, y - 36) < 9)
check(centred.score > corner.score, 'the centre prior: the same blob scores higher in the middle', `${centred.score.toFixed(4)} vs ${corner.score.toFixed(4)}`)

check(score(() => false).score === -1, 'an empty mask is refused')
check(score(() => true).score === -1, `a mask over ${SUBJECT_PICK.maxArea * 100}% of the frame is refused`)
check(score((x, y) => x === 10 && y === 10).score === -1, `a speck under ${SUBJECT_PICK.minArea * 100}% is refused`)
const hostile = [NaN, -3, Infinity, undefined, '0.9'].map((sam) => score(disc, sam).score)
check(hostile.every((v) => Number.isFinite(v) && v >= 0), 'hostile SAM scores give a finite, non-negative score', hostile.map((v) => v.toFixed(3)).join(' '))
check(score(disc, 0.5).score < score(disc, 0.95).score, 'SAM confidence counts')

const tiny = new Uint8ClampedArray(16 * 16 * 4).fill(128)
const t = subjectPrompts(tiny, 16, 16)
check(t.box.every(Number.isFinite) && t.seeds.every((s) => s.every(Number.isFinite)), 'a flat 16×16 frame still gives a finite box and seeds')

// growToWhole. A big subject running off the bottom edge (the cat), its face inside it.
const bigFn = (x, y) => Math.hypot(x - 40, y - 44) < 38
const faceFn = (x, y) => Math.hypot(x - 40, y - 38) < 20
const cand = (fn, sam, extra = {}) => {
  const bits = maskOf(fn)
  let reads = 0
  const c = { sam, ...scoreSubjectCandidate({ bits, w: W, h: H, sam }, grad, gm), ...extra }
  Object.defineProperty(c, 'bits', { get: () => { reads += 1; return bits } })
  c.reads = () => reads
  return c
}
const face = cand(faceFn, 0.95)
const whole = cand(bigFn, 0.97)
check(whole.bc > 0 && whole.borderRatio < SUBJECT_PICK.wholeBorder, 'the subject runs off the frame, but holds far less of the border than of the frame', `bc ${whole.bc.toFixed(2)}, border/area ${whole.borderRatio.toFixed(2)}`)
check(sky.borderRatio > 1 && subject.borderRatio === 0, 'border/area: background above 1, a contained subject 0', `${sky.borderRatio.toFixed(2)} vs ${subject.borderRatio}`)
check(growToWhole(face, [face, whole]) === whole, 'a part grows into the confident whole that contains it')
check(growToWhole(face, [face, cand(bigFn, 0.92)]) === face, 'not into a whole SAM is less sure of')
check(growToWhole(face, [face, cand(bigFn, 0.97, { boxed: true })]) === face, 'not into a box answer (it may stop at our box)')
const withSky = cand((x, y) => bigFn(x, y) && faceFn(x, y) || y < 30, 0.99)
check(withSky.score > 0 && growToWhole(face, [face, withSky]) === face, 'not into the face plus the sky around it', `border/area ${withSky.borderRatio.toFixed(2)}`)
check(growToWhole(face, [face, cand((x, y) => bigFn(x, y) && x > 40, 0.99)]) === face, 'not into a region holding only part of it')
const surer = cand((x, y) => bigFn(x, y) || Math.hypot(x - 40, y - 8) < 6, 0.99)
check(growToWhole(face, [face, whole, surer]) === surer, 'of several wholes, the one SAM is surest of')
const lazy = [cand(bigFn, 0.5), cand(bigFn, 0.97, { boxed: true }), cand((x, y) => faceFn(x, y) && x < 40, 0.99)]
const face2 = cand(faceFn, 0.95)
growToWhole(face2, [face2, ...lazy])
check(lazy.every((c) => c.reads() === 0) && face2.reads() === 0, 'masks are read only for candidates that pass the cheap tests', `${lazy.map((c) => c.reads())} ${face2.reads()}`)

console.log(`\n[verify-subject-pick] ${checks - failures}/${checks} checks passed.`)
if (failures) process.exit(1)
