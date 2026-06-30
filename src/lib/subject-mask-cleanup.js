/**
 * subject-mask-cleanup
 * --------------------
 * Turn a SOFT subject matte — the raw RMBG-1.4 / background-removal output, an
 * opaque canvas where R=G=B=confidence (0..255, white = subject) — into a clean,
 * solid selection.
 *
 * RMBG-1.4 is tuned for ordinary photos. On stylized / backlit-silhouette art it
 * confidently reads bright regions as "background" even when they sit INSIDE the
 * dark subject, so the matte comes back riddled with holes and sprinkled with
 * small spurious fragments over the bright sky. The semantic shader then hard-
 * cuts at 0.5, so every one of those holes shows straight through. This is the
 * on-device fallback path; when the SAM 3.1 mask service is reachable the app
 * prefers that instead.
 *
 * The pipeline composes primitives that already exist in the codebase rather
 * than re-implementing morphology:
 *   1. binarize at `threshold` (driven by the UI "sensitivity" control)
 *   2. morphological CLOSE (grow +k then shrink -k via growMaskCanvas) to bridge
 *      small gaps and seal thin channels, so an almost-enclosed hole becomes
 *      genuinely enclosed
 *   3. fill enclosed interior holes (fillEnclosedMaskRegions)
 *   4. drop connected components smaller than `minRegionFrac` of the largest —
 *      this keeps BOTH figures while removing stray sky specks
 *   5. (optional) luminance assist for backlit silhouettes: flood from the
 *      already-detected subject through CONNECTED dark source pixels, pulling in
 *      the dark silhouette regions RMBG missed (gated on a fragmentation signal
 *      and guarded against leaking into the whole frame)
 *
 * Returns a new canvas in the same opaque R=G=B=value convention the semantic
 * shader samples, plus a `diagnostics` object whose `fragmented` flag the UI
 * uses to nudge the user toward click-select (SAM) when even cleanup can't save
 * the matte.
 */

import { fillEnclosedMaskRegions } from '@/lib/canvas-mask'
import { growMaskCanvas } from '@/lib/mask-grow'

const makeCanvas = (w, h) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

const readData = (canvas) => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  return { ctx, img: ctx.getImageData(0, 0, canvas.width, canvas.height) }
}

/** Threshold a matte (R channel) into a NEW opaque luma canvas (0 or 255). */
const binarize = (src, thr01) => {
  const w = src.width
  const h = src.height
  const { img } = readData(src)
  const d = img.data
  const out = makeCanvas(w, h)
  const octx = out.getContext('2d')
  const oimg = octx.createImageData(w, h)
  const od = oimg.data
  const t = Math.round(Math.max(0, Math.min(1, thr01)) * 255)
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] >= t ? 255 : 0
    od[i] = v
    od[i + 1] = v
    od[i + 2] = v
    od[i + 3] = 255
  }
  octx.putImageData(oimg, 0, 0)
  return out
}

/** Invert RGB in place (alpha untouched). */
const invertInPlace = (canvas) => {
  const { ctx, img } = readData(canvas)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i]
    d[i + 1] = 255 - d[i + 1]
    d[i + 2] = 255 - d[i + 2]
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * 4-connected connected-component labelling over foreground pixels (R >= 128).
 * @returns {{ label: Int32Array, sizes: number[], count: number }}
 */
const labelForeground = (d, w, h) => {
  const n = w * h
  const label = new Int32Array(n)
  const sizes = [0]
  const queue = new Int32Array(n)
  let count = 0
  for (let p = 0; p < n; p += 1) {
    if (d[p * 4] >= 128 && !label[p]) {
      count += 1
      let qh = 0
      let qt = 0
      let cnt = 0
      queue[qt++] = p
      label[p] = count
      while (qh < qt) {
        const q = queue[qh++]
        cnt += 1
        const x = q % w
        const y = (q / w) | 0
        if (x > 0) { const nb = q - 1; if (d[nb * 4] >= 128 && !label[nb]) { label[nb] = count; queue[qt++] = nb } }
        if (x < w - 1) { const nb = q + 1; if (d[nb * 4] >= 128 && !label[nb]) { label[nb] = count; queue[qt++] = nb } }
        if (y > 0) { const nb = q - w; if (d[nb * 4] >= 128 && !label[nb]) { label[nb] = count; queue[qt++] = nb } }
        if (y < h - 1) { const nb = q + w; if (d[nb * 4] >= 128 && !label[nb]) { label[nb] = count; queue[qt++] = nb } }
      }
      sizes[count] = cnt
    }
  }
  return { label, sizes, count }
}

/** Count components at least `minPx` in area (does not mutate). */
const countSignificant = (canvas, minPx) => {
  const { img } = readData(canvas)
  const { sizes, count } = labelForeground(img.data, canvas.width, canvas.height)
  let sig = 0
  for (let c = 1; c <= count; c += 1) if (sizes[c] >= minPx) sig += 1
  return sig
}

/** Count foreground pixels (R >= 128) at full resolution (does not mutate). */
const countForeground = (canvas) => {
  const { img } = readData(canvas)
  const d = img.data
  let n = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] >= 128) n += 1
  return n
}

/**
 * Zero out every component smaller than max(minPx, frac × largest). Keeps the
 * main subject(s) — including a second, smaller figure — and removes specks.
 */
const keepSignificantComponents = (canvas, frac, minPx) => {
  const w = canvas.width
  const h = canvas.height
  const { ctx, img } = readData(canvas)
  const d = img.data
  const { label, sizes, count } = labelForeground(d, w, h)
  let maxSize = 0
  for (let c = 1; c <= count; c += 1) if (sizes[c] > maxSize) maxSize = sizes[c]
  const minKeep = Math.max(minPx, Math.floor(maxSize * frac))
  let kept = 0
  let totalFg = 0
  for (let c = 1; c <= count; c += 1) if (sizes[c] >= minKeep) { kept += 1; totalFg += sizes[c] }
  if (count > kept) {
    const n = w * h
    for (let p = 0; p < n; p += 1) {
      const c = label[p]
      if (c && sizes[c] < minKeep) { const i = p * 4; d[i] = 0; d[i + 1] = 0; d[i + 2] = 0 }
    }
    ctx.putImageData(img, 0, 0)
  }
  return { count, kept, maxSize, totalFg }
}

/**
 * Backlit-silhouette assist. Seeds from subject pixels that are also dark in the
 * SOURCE image, then floods through CONNECTED dark source pixels, marking them
 * subject. This recovers the dark body parts RMBG dropped without grabbing
 * isolated dark background (it must connect to the detected subject). Guarded:
 * if the flood would claim more than half the frame it almost certainly leaked
 * (subject and background darks are connected) so the assist is abandoned.
 *
 * @returns {number} pixels added (0 if skipped/leaked)
 */
const luminanceAssist = (canvas, sourceCanvas, darkThr01) => {
  const w = canvas.width
  const h = canvas.height
  const n = w * h
  const srcAt = makeCanvas(w, h)
  srcAt.getContext('2d').drawImage(sourceCanvas, 0, 0, w, h)
  const sd = srcAt.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data
  const { ctx, img } = readData(canvas)
  const d = img.data

  const t = Math.max(0, Math.min(1, darkThr01)) * 255
  const dark = new Uint8Array(n)
  const inSub = new Uint8Array(n)
  for (let p = 0; p < n; p += 1) {
    const i = p * 4
    const luma = 0.2126 * sd[i] + 0.7152 * sd[i + 1] + 0.0722 * sd[i + 2]
    dark[p] = luma < t ? 1 : 0
    inSub[p] = d[i] >= 128 ? 1 : 0
  }

  const added = new Uint8Array(n)
  const queue = new Int32Array(n)
  let qh = 0
  let qt = 0
  for (let p = 0; p < n; p += 1) if (inSub[p] && dark[p]) { added[p] = 1; queue[qt++] = p }
  const tryAdd = (nb) => { if (dark[nb] && !added[nb]) { added[nb] = 1; queue[qt++] = nb } }
  while (qh < qt) {
    const q = queue[qh++]
    const x = q % w
    const y = (q / w) | 0
    if (x > 0) tryAdd(q - 1)
    if (x < w - 1) tryAdd(q + 1)
    if (y > 0) tryAdd(q - w)
    if (y < h - 1) tryAdd(q + w)
  }

  let extra = 0
  for (let p = 0; p < n; p += 1) if (added[p] && !inSub[p]) extra += 1
  if (extra > 0.5 * n) return 0 // leaked into the background — abandon

  for (let p = 0; p < n; p += 1) {
    if (added[p] && !inSub[p]) { const i = p * 4; d[i] = 255; d[i + 1] = 255; d[i + 2] = 255 }
  }
  ctx.putImageData(img, 0, 0)
  return extra
}

/**
 * Clean a soft subject matte into a solid selection.
 *
 * @param {HTMLCanvasElement} matteCanvas  opaque R=G=B=confidence (white=subject)
 * @param {object} [options]
 * @param {number} [options.threshold=0.5]        binarization cut, 0..1 (UI sensitivity)
 * @param {number} [options.closePx=4]            morphological close radius (px); 0 disables
 * @param {boolean} [options.fillHoles=true]      fill enclosed interior holes
 * @param {number} [options.minRegionFrac=0.03]   drop blobs < this fraction of the largest
 * @param {number} [options.minRegionPx=64]       absolute min blob area to keep
 * @param {boolean} [options.luminanceAssist=false] backlit-silhouette dark-flood (needs sourceCanvas)
 * @param {HTMLCanvasElement|HTMLImageElement} [options.sourceCanvas]  original image, for the assist
 * @param {number} [options.darkThreshold=0.5]    luma below this counts as "dark" for the assist
 * @returns {{ canvas: HTMLCanvasElement, diagnostics: {
 *   coverage: number, componentsRaw: number, componentsKept: number,
 *   holesFilledFrac: number, fragmented: boolean } }}
 */
export const cleanSubjectMatte = (matteCanvas, options = {}) => {
  const {
    threshold = 0.5,
    closePx = 4,
    fillHoles = true,
    minRegionFrac = 0.03,
    minRegionPx = 64,
    luminanceAssist: doLum = false,
    sourceCanvas = null,
    darkThreshold = 0.5,
  } = options

  const empty = { coverage: 0, componentsRaw: 0, componentsKept: 0, holesFilledFrac: 0, fragmented: false }
  if (!matteCanvas || matteCanvas.width < 3 || matteCanvas.height < 3) {
    return { canvas: matteCanvas, diagnostics: empty }
  }
  const w = matteCanvas.width
  const h = matteCanvas.height
  const area = w * h

  // 1. binarize the soft matte
  let bin = binarize(matteCanvas, threshold)

  // 2. morphological close — bridge gaps / seal thin channels
  if (closePx > 0) {
    const grown = growMaskCanvas(bin, closePx)
    const closed = growMaskCanvas(grown, -closePx)
    bin = binarize(closed, 0.5)
  }

  // fragmentation signal measured on the closed binary (before fill/keep)
  const componentsRaw = countSignificant(bin, minRegionPx)

  // 3. fill enclosed interior holes. fillEnclosedMaskRegions treats DARK as the
  //    painted/selected region, so invert (subject->dark) around the call. It
  //    fills at a downscaled working resolution internally, so its returned
  //    pixel count is NOT comparable across image sizes — measure the holes-
  //    filled fraction from the full-res foreground delta instead, keeping the
  //    fragmentation signal resolution-independent for images of any size.
  let holesFilledFrac = 0
  if (fillHoles) {
    const fgBefore = countForeground(bin)
    invertInPlace(bin)
    fillEnclosedMaskRegions(bin)
    invertInPlace(bin)
    const fgAfter = countForeground(bin)
    holesFilledFrac = Math.max(0, fgAfter - fgBefore) / area
  }

  // 4. keep significant blobs (both figures), drop stray fragments
  let comp = keepSignificantComponents(bin, minRegionFrac, minRegionPx)

  const fragmented = componentsRaw > 3 || holesFilledFrac > 0.015

  // 5. optional backlit-silhouette luminance assist (gated on fragmentation)
  if (doLum && sourceCanvas && fragmented) {
    const extra = luminanceAssist(bin, sourceCanvas, darkThreshold)
    if (extra > 0) {
      if (fillHoles) {
        invertInPlace(bin)
        fillEnclosedMaskRegions(bin)
        invertInPlace(bin)
      }
      comp = keepSignificantComponents(bin, minRegionFrac, minRegionPx)
    }
  }

  return {
    canvas: bin,
    diagnostics: {
      coverage: comp.totalFg / area,
      componentsRaw,
      componentsKept: comp.kept,
      holesFilledFrac,
      fragmented,
    },
  }
}

export default cleanSubjectMatte
