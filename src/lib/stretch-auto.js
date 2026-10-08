/**
 * One-tap Pixel Stretch, done the way the reference edits are done in Photoshop:
 * find the subject, take its most colourful line, run the stripes from that line
 * into the open side of the frame, bend them with a look that suits the subject's
 * shape, and keep the subject in front.
 *
 * Shared by the panel's Auto Stretch button and the agent's `stretch.auto`, so
 * both make the same layer. The subject matte comes from the caller (on-device
 * SlimSAM); the optional `hint` is the vision route's read of the photo (look,
 * edge, placement). Everything geometric happens here and is deterministic.
 */

import { AUTO_EDGES, AUTO_LOOKS, sanitizeAutoHint } from './stretch-auto-hint.js'
import {
  DEFAULT_STRETCH,
  analyzeStretchPlan,
  applyWarpPreset,
  bestSeedInBand,
  clampStretchParams,
  createStretchBuffer,
  suggestWrapAt,
} from './pixel-stretch.js'

export { AUTO_LOOKS, AUTO_EDGES, sanitizeAutoHint }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** Bounding box and area of a white-on-black matte (normalised), or null if empty. */
export function matteStats(matte) {
  const mw = matte?.width, mh = matte?.height
  if (!mw || !mh) return null
  const s = Math.min(1, 256 / Math.max(mw, mh))
  const w = Math.max(1, Math.round(mw * s)), h = Math.max(1, Math.round(mh * s))
  const c = createStretchBuffer(w, h)
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(matte, 0, 0, w, h)
  let d
  try { d = ctx.getImageData(0, 0, w, h).data } catch { return null }
  let minX = w, minY = h, maxX = -1, maxY = -1, n = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4] <= 127) continue
      n++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!n) return null
  // Frame sides the matte runs along: background touches three or four.
  const touch = (minX <= 1) + (minY <= 1) + (maxX >= w - 2) + (maxY >= h - 2)
  return { x: minX / w, y: minY / h, w: (maxX - minX + 1) / w, h: (maxY - minY + 1) / h, area: n / (w * h), touch }
}

/**
 * The subject, as a white-on-black matte of `small` (the photo in its displayed
 * orientation, ≤1024px). SlimSAM's one-click subject comes first, prompted with
 * the vision box when there is one. On a cluttered frame the saliency seed can
 * land on a PART (the moto's engine: 1% of the frame), so a matte that small is
 * retried with box prompts around it and across the frame, and the most
 * subject-like answer wins: big, not running along the frame like background.
 */
export async function findSubjectMatte(small, { hint = null } = {}) {
  const ai = await import('./client-ai.js')
  const W = small.width, H = small.height
  const dims = { width: W, height: H }
  const px = (b) => [b.x * W, b.y * H, (b.x + b.w) * W, (b.y + b.h) * H]
  const tries = []
  const attempt = async (run, bonus = 0) => {
    try {
      const m = await run()
      const st = m && matteStats(m)
      if (st) tries.push({ m, st, bonus })
    } catch { /* one prompt failing is not the subject failing */ }
  }
  const scoreOf = ({ st, bonus }) => (st.area < 0.02 || st.area > 0.8 ? -1 : Math.min(st.area, 0.45) - 0.15 * Math.max(0, st.touch - 1) + bonus)
  const best = () => tries.slice().sort((a, b) => scoreOf(b) - scoreOf(a))[0]
  try {
    const box = hint?.subject || null
    if (box) await attempt(() => ai.clientSamBox(small, px(box), dims, { whole: true }), 0.2)
    await attempt(() => ai.clientSubjectMask(small, dims))
    const first = best()
    if (!first || scoreOf(first) < 0.04) {
      const found = first?.st
      const boxes = [{ x: 0.08, y: 0.08, w: 0.84, h: 0.84 }]
      if (found) {
        const cx = found.x + found.w / 2, cy = found.y + found.h / 2
        const w = clamp(found.w * 4, 0.3, 0.9), h = clamp(found.h * 4, 0.3, 0.9)
        boxes.unshift({ x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h })
      }
      for (const b of boxes) await attempt(() => ai.clientSamBox(small, px(b), dims, { whole: true }))
    }
    const win = best()
    return win && scoreOf(win) > 0 ? win.m : null
  } finally {
    ai.releaseClientModels?.()
  }
}

const roomOf = (box, edge) => (
  edge === 'up' ? box.y : edge === 'down' ? 1 - box.y - box.h : edge === 'left' ? box.x : 1 - box.x - box.w
)

// The stripes need open frame to run through; the sky is the classic place for
// them and the ground the worst (they read as a shadow), so up is favoured.
const EDGE_WEIGHT = { up: 1.15, left: 1, right: 1, down: 0.7 }

// Stripes read best ACROSS a subject's long side: up off a car's roof, sideways
// off a minaret. Running along the long side they are just a smear of it.
function pickEdge(box, axis = null, W = 1, H = 1) {
  const aspect = (box.w * W) / Math.max(1, box.h * H)
  const along = (edge) => (AUTO_EDGES[edge].axis === 'vertical' ? (aspect >= 1 ? 1.35 : 1) : (aspect <= 0.75 ? 1.3 : 1))
  return Object.keys(AUTO_EDGES)
    .filter((edge) => !axis || AUTO_EDGES[edge].axis === axis)
    .map((edge) => ({ edge, score: roomOf(box, edge) * EDGE_WEIGHT[edge] * along(edge) }))
    .sort((a, b) => b.score - a.score)[0].edge
}

/**
 * The look from the subject's shape and place, the way the reference clips pair
 * them: a tall subject stretched sideways ripples (the minaret), a centred one
 * with sky above fans open from its top (India Gate, the temple dome), a narrow
 * one fans too, one with open space beside it sweeps into that space (the car,
 * the man in the striped shirt), anything else rises straight.
 */
function pickLook(box, edge, W, H) {
  const vertical = AUTO_EDGES[edge].axis === 'vertical'
  const cross = vertical ? box.w : box.h
  const ahead = roomOf(box, edge)
  const lateral = vertical ? Math.max(box.x, 1 - box.x - box.w) : Math.max(box.y, 1 - box.y - box.h)
  const centre = vertical ? box.x + box.w / 2 : box.y + box.h / 2
  const tall = (box.h * H) / Math.max(1, box.w * W)
  if (!vertical && tall >= 1.6) return { id: 'wave', amount: 0.8, why: 'a tall subject, so the stripes run sideways and ripple' }
  // A centred fan reads as a monument's crown only when it opens upward.
  const wide = (box.w * W) / Math.max(1, box.h * H)
  if (ahead >= 0.25 && (cross <= 0.3 || (edge === 'up' && Math.abs(centre - 0.5) < 0.12 && wide <= 1.1))) {
    return { id: 'fan', why: 'a centred subject with open space ahead, so the stripes fan open from it' }
  }
  if (lateral >= 0.18 && ahead >= 0.2) return { id: 'swoosh', amount: 1, why: 'open space beside the subject, so the stripes sweep across into it' }
  return { id: 'rise', amount: 1, why: 'little room to bend, so the stripes run straight' }
}

/**
 * Which part of the subject the stripes are cut from. A fan grows from a narrow
 * slice at the subject's centre; a swoosh from the subject's far end, so it
 * sweeps back across the subject into the open side; the others from the whole
 * width. Returns the band and the fan's amount (tip width reaching the frame).
 */
function bandFor(box, axis, lookId, pickHalf = null) {
  const vertical = axis === 'vertical'
  const lo = vertical ? box.x : box.y
  const len = vertical ? box.w : box.h
  let a = lo, b = lo + len
  if (lookId === 'fan') {
    const w = clamp(len * 0.4, 0.06, 0.3)
    const c = lo + len / 2
    a = clamp(c - w / 2, 0, 1 - w)
    b = a + w
  } else if (lookId === 'swoosh' && len > 0.3) {
    // One end of a wide subject: the band's own position then bends the look
    // toward the larger half of the frame, back across the subject. The more
    // colourful end wins (`pickHalf`); without a say, the end away from the
    // open side.
    const w = Math.max(0.2, len * 0.5)
    const half = pickHalf ? pickHalf([lo, lo + w], [lo + len - w, lo + len]) : (lo > 1 - (lo + len) ? 'high' : 'low')
    if (half === 'high') { a = lo + len - w } else { b = lo + w }
  }
  const band = vertical ? { x: a, w: b - a, y: box.y, h: box.h } : { y: a, h: b - a, x: box.x, w: box.w }
  const fanAmount = clamp((0.95 / Math.max(0.05, b - a) - 1) / 7, 0.2, 1.4)
  return { band, fanAmount }
}

/**
 * How far into the band (0..1, from the side facing the travel direction) the
 * first line lies that the subject fills at least half of.
 */
function solidFrom(matte, band, axis, direction) {
  const S = 256
  const c = createStretchBuffer(S, S)
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(matte, 0, 0, S, S)
  let d
  try { d = ctx.getImageData(0, 0, S, S).data } catch { return 0.1 }
  const vertical = axis === 'vertical'
  const a0 = Math.floor((vertical ? band.x : band.y) * S), a1 = Math.ceil((vertical ? band.x + band.w : band.y + band.h) * S)
  const l0 = Math.floor((vertical ? band.y : band.x) * S), l1 = Math.ceil((vertical ? band.y + band.h : band.x + band.w) * S)
  const lines = Math.max(1, l1 - l0)
  for (let k = 0; k < lines; k++) {
    const line = direction < 0 ? l0 + k : l1 - 1 - k
    let on = 0
    for (let a = a0; a < a1; a++) {
      const x = vertical ? a : line, y = vertical ? line : a
      if (x >= 0 && y >= 0 && x < S && y < S && d[(y * S + x) * 4] > 127) on++
    }
    if (on >= 0.5 * Math.max(1, a1 - a0)) return Math.min(0.65, k / lines)
  }
  return 0.1
}

/**
 * Plan the whole stretch.
 *
 * @param {object} args
 * @param {HTMLCanvasElement|OffscreenCanvas} args.sample  the photo, any size
 * @param {HTMLCanvasElement|OffscreenCanvas|null} [args.matte]  subject matte, white-on-black
 * @param {object|null} [args.hint]  vision hint (see sanitizeAutoHint) or caller overrides
 * @returns {{ params, look, amount, edge, coverage, wrapAt, subject, reasoning }|null}
 */
export function planAutoStretch({ sample, matte = null, hint = null, prefer = null }) {
  const W = sample?.width, H = sample?.height
  if (!W || !H) return null
  // `hint` is the vision read (advice); `prefer` is what the caller asked for
  // and always wins.
  const v = sanitizeAutoHint(hint) || {}
  const want = sanitizeAutoHint(prefer) || {}
  const h = { ...v }
  for (const [k, val] of Object.entries(want)) if (val !== null && val !== '') h[k] = val
  const stats = matte ? matteStats(matte) : null
  // A matte that is the whole frame or a speck did not find a subject.
  const fromMatte = stats && stats.area >= 0.01 && stats.area <= 0.85 && stats.w < 0.98 ? stats : null
  const box = fromMatte || (h.subject && h.subject.w * h.subject.h < 0.85 ? h.subject : null)
  // A vision edge with far less room than the open side is a misread, not taste
  // (it sent a motorbike's stripes into the floor).
  if (box && h.edge && !want.edge) {
    const best = pickEdge(box, null, W, H)
    if (roomOf(box, h.edge) < 0.5 * roomOf(box, best)) h.edge = null
  }

  if (!box) {
    // No subject at all: the old on-device read picks a colourful slice, and the
    // stripes rise from it to the frame edge with nothing kept in front.
    const plan = analyzeStretchPlan(sample)
    if (!plan) return null
    const base = clampStretchParams({ ...DEFAULT_STRETCH, axis: plan.axis, direction: plan.direction, band: plan.region, seed: plan.seed, warpModel: 'stretch', anchor: 'seed' })
    const r = applyWarpPreset(base, h.look || 'rise', h.amount ?? 1, W, H)
    return {
      params: clampStretchParams({ ...base, warpGrid: r.grid, warpRest: r.rest, warpLook: r.look }),
      look: r.look.id, amount: r.look.amount, edge: null, coverage: 0, wrapAt: null, subject: null,
      reasoning: h.reasoning || `No clear subject, so the stripes rise from the most colourful slice. ${plan.reasoning || ''}`.trim(),
    }
  }

  const edge = h.edge || pickEdge(box, h.axis, W, H)
  const { axis, direction } = AUTO_EDGES[edge]
  const picked = pickLook(box, edge, W, H)
  const lookId = h.look || picked.id
  const vertical0 = axis === 'vertical'
  const colourOf = ([a, b]) => {
    const half = vertical0 ? { x: a, w: b - a, y: box.y, h: box.h } : { y: a, h: b - a, x: box.x, w: box.w }
    return bestSeedInBand(sample, half, axis)?.score ?? 0
  }
  const { band, fanAmount } = bandFor(box, axis, lookId, (low, high) => (colourOf(high) > colourOf(low) ? 'high' : 'low'))
  const amount = clamp((h.amount ?? (lookId === 'fan' ? fanAmount : lookId === picked.id ? picked.amount ?? 1 : 1)) * (h.gain ?? 1), -2, 2)

  // The sampled line: the reference edits take it just inside the subject's
  // edge that faces the open space (the gate's lit top, the car's tail), where
  // the line crosses the subject rather than the background around it. So the
  // search starts at the first line the subject fills and covers the next third.
  const vertical = axis === 'vertical'
  const start = matte ? solidFrom(matte, band, axis, direction) : 0.1
  const depth = 0.35
  const lo = direction < 0 ? start : Math.max(0, 1 - start - depth)
  const sub = vertical
    ? { x: band.x, w: band.w, y: band.y + band.h * lo, h: band.h * depth }
    : { y: band.y, h: band.h, x: band.x + band.w * lo, w: band.w * depth }
  const best = bestSeedInBand(sample, sub, axis)
  const seed = best ? lo + depth * best.seed : 0.5

  const base = clampStretchParams({ ...DEFAULT_STRETCH, axis, direction, band, seed, polygon: null, warpModel: 'stretch', anchor: 'seed' })
  const r = applyWarpPreset(base, lookId, amount, W, H)
  const params = clampStretchParams({ ...base, warpGrid: r.grid, warpRest: r.rest, warpLook: r.look })

  // Subject in front whenever there is a matte to put there; a wrap when the look
  // comes back over the subject (or the hint asks for one).
  let coverage = fromMatte ? 1 : 0
  let wrapAt = null
  if (coverage && h.placement === 'above') coverage = 0
  if (coverage) {
    // Only a look that turns back can come over the subject again; a straight
    // ribbon "re-entering" a concave subject (a saucer round a cup) is not that.
    const turns = ['swoosh', 'arch', 'fold'].includes(lookId)
    const s = suggestWrapAt(params, matte, W, H)
    if (turns && s.recross) wrapAt = s.wrapAt
    // Asked for, with no return found: a turning look comes in front from its
    // apex (out from behind, back across); a straight one over the subject's top.
    else if (h.placement === 'partial') wrapAt = turns ? 0.5 : s.wrapAt
  }

  const where = { up: 'up into the open space above', down: 'down into the space below', left: 'left into the open side', right: 'right into the open side' }[edge]
  const lookWhy = lookId === picked.id ? picked.why : `a ${lookId} look`
  const reasoning = h.reasoning || [
    `Stripes from the subject's most colourful line run ${where}`,
    `${lookWhy}`,
    coverage ? (wrapAt != null ? 'the subject stays in front until the ribbon crosses back over it' : 'the subject stays in front') : 'the stripes sit over the photo',
  ].join('; ') + '.'

  return { params, look: r.look.id, amount: r.look.amount, edge, coverage, wrapAt, subject: box, reasoning }
}

/**
 * Ask the vision route for its read of the photo. Optional: no key, quota or a
 * dropped connection returns null and the planner decides alone.
 */
export async function fetchAutoHint(el, { signal } = {}) {
  try {
    const natW = el.naturalWidth || el.videoWidth || el.width || 512
    const natH = el.naturalHeight || el.videoHeight || el.height || 512
    const s = Math.min(1, 512 / Math.max(natW, natH))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(natW * s))
    c.height = Math.max(1, Math.round(natH * s))
    c.getContext('2d').drawImage(el, 0, 0, c.width, c.height)
    const imageBase64 = c.toDataURL('image/jpeg', 0.85).split(',')[1]
    const res = await fetch('/api/ai/stretch-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, mimeType: 'image/jpeg', width: natW, height: natH }),
      signal,
    })
    const data = await res.json().catch(() => null)
    return res.ok && data?.hint ? sanitizeAutoHint(data.hint) : null
  } catch {
    return null
  }
}

export const _test = { pickEdge, pickLook, roomOf }
