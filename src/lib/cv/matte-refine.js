/**
 * A coarse subject matte → one whose edge lies on the photo's real edge.
 *
 * SlimSAM decodes masks at 256×256 and upsamples them, so its outline is a
 * smooth blob that cuts across spokes, handlebars and hair, and the knockout
 * that puts the subject in front of the stripes inherits that blob. Three
 * classical passes fix it, cheapest first:
 *
 *  1. Trimap from the coarse outline: a band ±B either side of it (signed EDT)
 *     is unknown, because SAM is wrong in both directions.
 *  2. Colour likelihood for the unknown band — two 16³ histograms, confident
 *     subject vs. a ring of background just outside (GrabCut's seed model, no
 *     graph cut) — blended with the coarse answer by depth into the band.
 *  3. The colour guided filter (He, Sun & Tang, the 3-channel form): the edge
 *     follows changes of hue as well as brightness, which the luma-only filter
 *     misses wherever subject and background are equally bright (a red tank in
 *     front of a red crate).
 *
 * `guidedUpsample` then carries a matte to a larger frame along that frame's
 * own edges, so a 1024px matte does not come out soft on a 4096px bake.
 *
 * Pure: planes and ImageData-shaped pixels in, planes out.
 */

import { boxMean, makePlane, resamplePlane, upsamplePlane } from './box-filter.js'
import { signedDistanceTransform } from './distance-transform.js'

const LUMA = [0.2126, 0.7152, 0.0722]
const bin = (r, g, b) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)

/** RGBA pixels → three 0..1 planes. */
export const rgbPlanes = (rgba) => {
  const { width: w, height: h, data } = rgba
  const r = makePlane(w, h), g = makePlane(w, h), b = makePlane(w, h)
  for (let p = 0, i = 0; p < w * h; p += 1, i += 4) {
    r.data[p] = data[i] / 255
    g.data[p] = data[i + 1] / 255
    b.data[p] = data[i + 2] / 255
  }
  return { r, g, b }
}

/** RGBA pixels → a luma plane. */
export const lumaPlane = (rgba) => {
  const { width: w, height: h, data } = rgba
  const out = makePlane(w, h)
  for (let p = 0, i = 0; p < w * h; p += 1, i += 4) {
    out.data[p] = (data[i] * LUMA[0] + data[i + 1] * LUMA[1] + data[i + 2] * LUMA[2]) / 255
  }
  return out
}

const mul = (a, b) => {
  const out = makePlane(a.width, a.height)
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = a.data[i] * b.data[i]
  return out
}

/**
 * Colour guided filter: `q = a·I + b` with a 3-vector `a` per window, solved
 * from the window's 3×3 colour covariance. Runs at 1/`subsample` and evaluates
 * against the full-resolution colour guide.
 *
 * @param {{ r, g, b }} I  colour guide planes, 0..1
 * @param {object} p  plane to filter (same size)
 */
export const colorGuidedFilter = (I, p, { radius = 8, eps = 1e-3, subsample = 1 } = {}) => {
  const W = p.width, H = p.height
  const s = Math.max(1, Math.floor(subsample))
  const lw = Math.max(8, Math.round(W / s)), lh = Math.max(8, Math.round(H / s))
  const low = (pl) => (s === 1 ? pl : resamplePlane(pl, lw, lh))
  const k = colorGuidedCoefficients({ r: low(I.r), g: low(I.g), b: low(I.b) }, low(p), { radius: Math.max(1, Math.round(radius / s)), eps })
  return applyColorCoefficients(k, I)
}

/**
 * The colour guided filter's averaged coefficients (a 3-vector and b per
 * pixel) at the guide's own resolution — evaluate them against a guide of any
 * size with `applyColorCoefficients`.
 */
export const colorGuidedCoefficients = (I, q, { radius = 8, eps = 1e-3 } = {}) => {
  const { r, g, b } = I
  const rad = Math.max(1, Math.round(radius))
  const e = Number.isFinite(eps) ? Math.max(eps, 1e-8) : 1e-3

  const mr = boxMean(r, rad), mg = boxMean(g, rad), mb = boxMean(b, rad), mp = boxMean(q, rad)
  const rr = boxMean(mul(r, r), rad), rg = boxMean(mul(r, g), rad), rb = boxMean(mul(r, b), rad)
  const gg = boxMean(mul(g, g), rad), gb = boxMean(mul(g, b), rad), bb = boxMean(mul(b, b), rad)
  const rp = boxMean(mul(r, q), rad), gp = boxMean(mul(g, q), rad), bp = boxMean(mul(b, q), rad)

  const n = r.data.length
  const ar = makePlane(r.width, r.height), ag = makePlane(r.width, r.height), ab = makePlane(r.width, r.height)
  const bo = makePlane(r.width, r.height)
  for (let i = 0; i < n; i += 1) {
    const xr = mr.data[i], xg = mg.data[i], xb = mb.data[i], xp = mp.data[i]
    // Σ + εU
    const srr = rr.data[i] - xr * xr + e, srg = rg.data[i] - xr * xg, srb = rb.data[i] - xr * xb
    const sgg = gg.data[i] - xg * xg + e, sgb = gb.data[i] - xg * xb, sbb = bb.data[i] - xb * xb + e
    const cr = rp.data[i] - xr * xp, cg = gp.data[i] - xg * xp, cb = bp.data[i] - xb * xp
    // Symmetric 3×3 inverse by cofactors.
    const irr = sgg * sbb - sgb * sgb, irg = sgb * srb - srg * sbb, irb = srg * sgb - sgg * srb
    const igg = srr * sbb - srb * srb, igb = srb * srg - srr * sgb, ibb = srr * sgg - srg * srg
    const det = srr * irr + srg * irg + srb * irb
    if (!(Math.abs(det) > 1e-18)) { ar.data[i] = 0; ag.data[i] = 0; ab.data[i] = 0; bo.data[i] = xp; continue }
    const a1 = (irr * cr + irg * cg + irb * cb) / det
    const a2 = (irg * cr + igg * cg + igb * cb) / det
    const a3 = (irb * cr + igb * cg + ibb * cb) / det
    ar.data[i] = a1; ag.data[i] = a2; ab.data[i] = a3
    bo.data[i] = xp - a1 * xr - a2 * xg - a3 * xb
  }
  // Averaging the coefficients is what keeps neighbouring windows from tiling.
  return { ar: boxMean(ar, rad), ag: boxMean(ag, rad), ab: boxMean(ab, rad), b: boxMean(bo, rad) }
}

/** `q = a·I + b`, the coefficients bilinearly upsampled to the guide's size. */
export const applyColorCoefficients = (k, I) => {
  const W = I.r.width, H = I.r.height
  const up = (pl) => (pl.width === W && pl.height === H ? pl : upsamplePlane(pl, W, H))
  const A1 = up(k.ar), A2 = up(k.ag), A3 = up(k.ab), B = up(k.b)
  const out = makePlane(W, H)
  for (let i = 0; i < W * H; i += 1) {
    out.data[i] = A1.data[i] * I.r.data[i] + A2.data[i] * I.g.data[i] + A3.data[i] * I.b.data[i] + B.data[i]
  }
  return out
}

/**
 * Refine a coarse 0..1 subject matte against the photo it came from.
 *
 * @param {{ width, height, data: Uint8ClampedArray }} rgba  the photo
 * @param {object} coarse  plane, same size, 0..1
 * @param {{ band?: number, guideRadius?: number, eps?: number }} [opts]  band and
 *   radius as fractions of the short side
 * @returns {object} refined plane, 0..1
 */
export const refineSubjectMatte = (rgba, coarse, { band = 0.025, guideRadius = 0.008, eps = 1e-3 } = {}) => {
  const W = coarse.width, H = coarse.height
  if (!W || !H || rgba?.width !== W || rgba?.height !== H) return coarse
  const N = W * H
  const B = Math.max(2, Math.round(Math.min(W, H) * band))
  const sd = signedDistanceTransform(coarse)
  const d = rgba.data

  const fg = new Float64Array(4096), bg = new Float64Array(4096)
  let nf = 0, nb = 0
  for (let p = 0, i = 0; p < N; p += 1, i += 4) {
    const s = sd.data[p]
    if (s < -B) { fg[bin(d[i], d[i + 1], d[i + 2])] += 1; nf += 1 }
    else if (s > B && s <= 3 * B) { bg[bin(d[i], d[i + 1], d[i + 2])] += 1; nb += 1 }
  }
  const out = makePlane(W, H)
  const model = nf >= 256 && nb >= 256
  for (let p = 0, i = 0; p < N; p += 1, i += 4) {
    const s = sd.data[p]
    if (s <= -B) { out.data[p] = 1; continue }
    if (s >= B) continue
    const prior = Math.min(1, Math.max(0, coarse.data[p]))
    if (!model) { out.data[p] = prior; continue }
    const k = bin(d[i], d[i + 1], d[i + 2])
    const pf = (fg[k] + 0.5) / nf, pb = (bg[k] + 0.5) / nb
    const post = pf / (pf + pb)
    // At the coarse edge the colours decide; towards the band's rim the coarse
    // answer takes over again, so a colour shared by both sides cannot carve a
    // hole deep in the subject or paint a blob far into the background.
    const w = Math.abs(s) / B
    out.data[p] = post + ((s < 0 ? 1 : 0) - post) * w * w
  }
  const I = rgbPlanes(rgba)
  const radius = Math.max(2, Math.round(Math.min(W, H) * guideRadius))
  const refined = colorGuidedFilter(I, boxMean(out, 1), { radius, eps, subsample: Math.min(W, H) > 700 ? 2 : 1 })
  for (let i = 0; i < N; i += 1) refined.data[i] = Math.min(1, Math.max(0, refined.data[i]))
  // Islands: a highlight on the saucer the colour model mistook for the cup.
  // Anything not connected to the subject's confident interior is dropped.
  const keep = new Uint8Array(N)
  const queue = new Int32Array(N)
  let head = 0, tail = 0
  for (let p = 0; p < N; p += 1) if (sd.data[p] < -B && refined.data[p] >= 0.5) { keep[p] = 1; queue[tail++] = p }
  while (head < tail) {
    const p = queue[head++], x = p % W
    const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]
    for (const q of nb) {
      if (q < 0 || q >= N || keep[q] || refined.data[q] < 0.5) continue
      keep[q] = 1
      queue[tail++] = q
    }
  }
  // The soft fringe around kept pixels stays (it is the anti-aliasing).
  for (let p = 0; p < N; p += 1) {
    if (keep[p] || refined.data[p] < 0.5) continue
    refined.data[p] = 0
  }
  return refined
}

/**
 * Carry a matte to a larger frame along that frame's edges (guided upsampling):
 * colour-guided coefficients at the matte's resolution against a downsampled
 * copy of the frame, evaluated against the full-size frame — so the edge
 * sharpens instead of blurring as it is scaled up. Colour, not luma: a subject
 * can be exactly as bright as what is behind it.
 *
 * @param {object} low  matte plane, 0..1
 * @param {{ r, g, b }} guideHigh  colour planes of the target frame
 */
export const guidedUpsample = (low, guideHigh, { radius = 2, eps = 1e-4 } = {}) => {
  const lw = low.width, lh = low.height
  const lowI = { r: resamplePlane(guideHigh.r, lw, lh), g: resamplePlane(guideHigh.g, lw, lh), b: resamplePlane(guideHigh.b, lw, lh) }
  const out = applyColorCoefficients(colorGuidedCoefficients(lowI, low, { radius, eps }), guideHigh)
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = Math.min(1, Math.max(0, out.data[i]))
  return out
}
