export const PIXEL_MASK_OVERLAY_NAME = 'pixxel-mask-overlay'
export const PIXEL_MASK_CLIP_NAME = 'pixxel-mask-clip'

const MASK_RLE_TYPE = 'pixxel-mask-rle'
const MASK_RLE_VERSION = 1

export const isPixxelMaskOverlay = (obj) =>
  obj?.name === PIXEL_MASK_OVERLAY_NAME ||
  obj?.pixxelMaskOverlay ||
  obj?._pixxelMaskOverlay

const bytesToBase64 = (bytes) => {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

const base64ToBytes = (value) => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const writeVarint = (bytes, value) => {
  let next = Math.max(0, Math.floor(value))
  while (next > 127) {
    bytes.push((next & 0x7f) | 0x80)
    next = Math.floor(next / 128)
  }
  bytes.push(next)
}

const readVarint = (bytes, state) => {
  let value = 0
  let multiplier = 1

  while (state.offset < bytes.length) {
    const byte = bytes[state.offset]
    state.offset += 1
    value += (byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) break
    multiplier *= 128
  }

  return value
}

export const createMaskCanvas = (width, height, fill = '#ffffff') => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  // Mask canvases are read back via getImageData on virtually every use
  // (encode, overlay paint, flood fill, empty check). Context attributes are
  // only honored on the FIRST getContext call, so request willReadFrequently here.
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = fill
  ctx.fillRect(0, 0, width, height)
  return canvas
}

export const getClipElement = (clipPath) =>
  clipPath?._element ||
  clipPath?._originalElement ||
  clipPath?.getElement?.() ||
  null

export const maskCanvasFromClipPath = (clipPath, width, height) => {
  const element = getClipElement(clipPath)
  if (!element || typeof document === 'undefined') return null

  try {
    const source = document.createElement('canvas')
    source.width = width
    source.height = height
    const sourceCtx = source.getContext('2d', { willReadFrequently: true })
    sourceCtx.drawImage(element, 0, 0, width, height)

    const sourceData = sourceCtx.getImageData(0, 0, width, height)
    const mask = createMaskCanvas(width, height)
    const maskCtx = mask.getContext('2d')
    const maskData = maskCtx.createImageData(width, height)

    for (let i = 0; i < sourceData.data.length; i += 4) {
      const alpha = sourceData.data[i + 3]
      const lum = alpha < 255
        ? alpha
        : Math.round((sourceData.data[i] + sourceData.data[i + 1] + sourceData.data[i + 2]) / 3)

      maskData.data[i] = lum
      maskData.data[i + 1] = lum
      maskData.data[i + 2] = lum
      maskData.data[i + 3] = 255
    }

    maskCtx.putImageData(maskData, 0, 0)
    return mask
  } catch (error) {
    console.warn('[canvas-mask] Failed to rebuild mask from clipPath:', error)
    return null
  }
}

export const buildMaskClipCanvas = (maskCanvas, { feather = 0 } = {}) => {
  const ctx = maskCanvas.getContext('2d')
  const source = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
  const clipCanvas = document.createElement('canvas')
  clipCanvas.width = maskCanvas.width
  clipCanvas.height = maskCanvas.height
  const clipCtx = clipCanvas.getContext('2d')
  const clipData = clipCtx.createImageData(maskCanvas.width, maskCanvas.height)

  // The clip's alpha channel IS the mask luminance (white => fully visible,
  // black => fully transparent). RGB is irrelevant for an alpha clip.
  for (let i = 0; i < source.data.length; i += 4) {
    const lum = source.data[i]
    clipData.data[i] = 255
    clipData.data[i + 1] = 255
    clipData.data[i + 2] = 255
    clipData.data[i + 3] = lum
  }

  // Soft edges (feather): blur the alpha channel by `feather` image-space px.
  // We rasterize the crisp alpha first, then redraw it through a Gaussian blur
  // filter so the stored mask stays sharp and feather remains a live, lossless
  // parameter. Falls back to the crisp clip if canvas filter blur is missing.
  const featherPx = Math.max(0, Math.round(feather))
  if (featherPx > 0 && typeof clipCtx.filter !== 'undefined') {
    clipCtx.putImageData(clipData, 0, 0)
    const w = clipCanvas.width
    const h = clipCanvas.height
    const crisp = document.createElement('canvas')
    crisp.width = w
    crisp.height = h
    crisp.getContext('2d').drawImage(clipCanvas, 0, 0)

    // Pad by ~3x the feather radius (a CSS blur(N) kernel reaches ~3*N px) and
    // replicate the crisp alpha's edge pixels (clamp-to-edge) into the padding.
    // Without this, the blur near the image border samples the transparent
    // off-image area and fades fully-opaque borders (alpha 255) toward 0 — a soft
    // transparent rim around the whole image. Holding the border value constant
    // through the padding keeps opaque borders opaque.
    const pad = featherPx * 3
    const padded = document.createElement('canvas')
    padded.width = w + pad * 2
    padded.height = h + pad * 2
    const paddedCtx = padded.getContext('2d')
    // 1px edge strips of the crisp alpha, stretched to fill each padding band.
    // Corners.
    paddedCtx.drawImage(crisp, 0, 0, 1, 1, 0, 0, pad, pad)
    paddedCtx.drawImage(crisp, w - 1, 0, 1, 1, pad + w, 0, pad, pad)
    paddedCtx.drawImage(crisp, 0, h - 1, 1, 1, 0, pad + h, pad, pad)
    paddedCtx.drawImage(crisp, w - 1, h - 1, 1, 1, pad + w, pad + h, pad, pad)
    // Edges.
    paddedCtx.drawImage(crisp, 0, 0, w, 1, pad, 0, w, pad) // top
    paddedCtx.drawImage(crisp, 0, h - 1, w, 1, pad, pad + h, w, pad) // bottom
    paddedCtx.drawImage(crisp, 0, 0, 1, h, 0, pad, pad, h) // left
    paddedCtx.drawImage(crisp, w - 1, 0, 1, h, pad + w, pad, pad, h) // right
    // Center.
    paddedCtx.drawImage(crisp, pad, pad)

    // Pass 1: blur the ENTIRE padded canvas (replicated edges included) onto a
    // same-size intermediate. A full-canvas draw makes the whole padded image the
    // filter input — drawing with a source sub-rect would crop the padding away
    // BEFORE the filter runs (per the canvas drawing model), so the blur would
    // still fade against transparent at the real border and the rim would persist.
    const blurred = document.createElement('canvas')
    blurred.width = padded.width
    blurred.height = padded.height
    const blurredCtx = blurred.getContext('2d')
    blurredCtx.filter = `blur(${featherPx}px)`
    blurredCtx.drawImage(padded, 0, 0)
    blurredCtx.filter = 'none'

    // Pass 2: copy the center (real-image) region back with NO filter active.
    clipCtx.clearRect(0, 0, w, h)
    clipCtx.drawImage(blurred, pad, pad, w, h, 0, 0, w, h)
    return clipCanvas
  }

  clipCtx.putImageData(clipData, 0, 0)
  return clipCanvas
}

export const isMaskCanvasEmpty = (maskCanvas, threshold = 250) => {
  if (!maskCanvas) return true
  const ctx = maskCanvas.getContext('2d')
  const data = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < threshold) return false
  }
  return true
}

export const createMaskClipPath = (FabricImage, maskCanvas, { feather = 0 } = {}) =>
  new FabricImage(buildMaskClipCanvas(maskCanvas, { feather }), {
    left: 0,
    top: 0,
    originX: 'center',
    originY: 'center',
    absolutePositioned: false,
    selectable: false,
    evented: false,
    objectCaching: false,
    name: PIXEL_MASK_CLIP_NAME,
    pixxelMaskClipPath: true,
    _pixxelMaskClipPath: true,
  })

export const encodeMaskCanvas = (maskCanvas) => {
  if (!maskCanvas || typeof btoa !== 'function') return null
  if (isMaskCanvasEmpty(maskCanvas)) return null

  const { width, height } = maskCanvas
  const ctx = maskCanvas.getContext('2d')
  const pixels = ctx.getImageData(0, 0, width, height).data
  const bytes = []
  let current = pixels[0] ?? 255
  let runLength = 0

  const flush = () => {
    if (!runLength) return
    bytes.push(current)
    writeVarint(bytes, runLength)
    runLength = 0
  }

  for (let i = 0; i < pixels.length; i += 4) {
    const value = pixels[i]
    if (value === current && runLength < 0x7fffffff) {
      runLength += 1
    } else {
      flush()
      current = value
      runLength = 1
    }
  }
  flush()

  return {
    type: MASK_RLE_TYPE,
    version: MASK_RLE_VERSION,
    width,
    height,
    data: bytesToBase64(Uint8Array.from(bytes)),
  }
}

export const decodeMaskCanvas = (encoded) => {
  if (!encoded || encoded.type !== MASK_RLE_TYPE || !encoded.data || typeof atob !== 'function') return null
  if (typeof document === 'undefined') return null

  // Persisted state is untrusted input: REJECT (not clamp) any mask whose
  // dimensions are implausibly large, so a malformed/hostile width*height can't
  // allocate gigabytes. Clamping would also silently misalign the mask — the RLE
  // runs were encoded for the original width and would decode into a mis-sized
  // canvas — so dropping the mask is safer than restoring a corrupt one.
  const MAX_DIMENSION = 8192
  const MAX_PIXELS = 8192 * 8192
  const width = Math.max(1, Math.round(encoded.width || 1))
  const height = Math.max(1, Math.round(encoded.height || 1))
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) return null
  const bytes = base64ToBytes(encoded.data)
  const canvas = createMaskCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(width, height)
  const output = imageData.data
  const totalPixels = width * height
  const state = { offset: 0 }
  let pixel = 0

  while (state.offset < bytes.length && pixel < totalPixels) {
    const value = bytes[state.offset]
    state.offset += 1
    const runLength = readVarint(bytes, state)
    // Guard against run lengths that overrun the pixel budget (corrupt/hostile data).
    const end = Math.min(totalPixels, pixel + Math.min(runLength, totalPixels))

    for (; pixel < end; pixel += 1) {
      const i = pixel * 4
      output[i] = value
      output[i + 1] = value
      output[i + 2] = value
      output[i + 3] = 255
    }
  }

  for (; pixel < totalPixels; pixel += 1) {
    const i = pixel * 4
    output[i] = 255
    output[i + 1] = 255
    output[i + 2] = 255
    output[i + 3] = 255
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas
}

/* ──────────────────────────────────────────────────────────────────────────
 * Shared pixel-paint engine
 *
 * Both the Mask tool and the Erase tool paint into the same per-image
 * grayscale `maskCanvas` (white = visible, black = hidden). Keeping the math in
 * one place guarantees the two tools produce byte-identical results, so erasing
 * in one and refining in the other is seamless.
 * ────────────────────────────────────────────────────────────────────────── */

export const getImageBitmapSize = (img) => ({
  width: Math.max(
    1,
    Math.round(img?.width || img?._element?.naturalWidth || img?._originalElement?.naturalWidth || 1)
  ),
  height: Math.max(
    1,
    Math.round(img?.height || img?._element?.naturalHeight || img?._originalElement?.naturalHeight || 1)
  ),
})

export const isImageObject = (obj) => obj?.type?.toLowerCase?.() === 'image'

/**
 * Resolve the image the brush should act on: the active object if it's a normal
 * image, otherwise the top-most visible non-overlay image on the canvas.
 */
export const getMaskTargetImage = (canvasEditor) => {
  if (!canvasEditor) return null
  const active = canvasEditor.getActiveObject?.()
  if (isImageObject(active) && !isPixxelMaskOverlay(active)) return active

  const objects = canvasEditor.getObjects?.() || []
  return (
    [...objects]
      .reverse()
      .find((obj) => isImageObject(obj) && !isPixxelMaskOverlay(obj) && obj.visible !== false) || null
  )
}

/** Source pixel element to sample for magic/auto erase (the original bitmap). */
export const getImageSourceElement = (img) =>
  img?._originalElement || img?._element || img?.getElement?.() || null

/**
 * Convert a canvas scene point into the image's native bitmap coordinate space,
 * inverting the object's full transform matrix (handles scale/rotate/flip/skew).
 */
export const pointToImageSpace = (img, canvasPoint) => {
  if (!img || !canvasPoint || typeof img.calcTransformMatrix !== 'function') return null
  const transform = [...img.calcTransformMatrix()]
  const det = transform[0] * transform[3] - transform[1] * transform[2]
  if (Math.abs(det) < 1e-10) return null

  const a = transform[3] / det
  const b = -transform[1] / det
  const c = -transform[2] / det
  const d = transform[0] / det
  const tx = (transform[2] * transform[5] - transform[3] * transform[4]) / det
  const ty = (transform[1] * transform[4] - transform[0] * transform[5]) / det
  const { width, height } = getImageBitmapSize(img)

  return {
    x: a * canvasPoint.x + c * canvasPoint.y + tx + width / 2,
    y: b * canvasPoint.x + d * canvasPoint.y + ty + height / 2,
  }
}

export const isPointInImage = (point, img) => {
  if (!point) return false
  const { width, height } = getImageBitmapSize(img)
  return point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height
}

/**
 * Stamp one brush dab onto the mask. `mode` 'erase' paints toward black (hides),
 * 'restore' toward white (reveals). `hardness` (0–1) sets the soft falloff radius
 * and `flow` (0–1) the per-dab strength (build-up brush when < 1).
 */
export const stampMask = (ctx, x, y, { radius, hardness = 1, flow = 1, mode = 'erase' }) => {
  const r = Math.max(0.5, radius)
  const h = Math.max(0, Math.min(1, hardness))
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = Math.max(0.02, Math.min(1, flow))
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)

  if (h >= 0.99) {
    ctx.fillStyle = mode === 'erase' ? '#000000' : '#ffffff'
    ctx.fill()
  } else {
    const inner = Math.max(0, r * h)
    const gradient = ctx.createRadialGradient(x, y, inner, x, y, r)
    if (mode === 'erase') {
      gradient.addColorStop(0, 'rgba(0,0,0,1)')
      gradient.addColorStop(1, 'rgba(0,0,0,0)')
    } else {
      gradient.addColorStop(0, 'rgba(255,255,255,1)')
      gradient.addColorStop(1, 'rgba(255,255,255,0)')
    }
    ctx.fillStyle = gradient
    ctx.fill()
  }
  ctx.restore()
}

/** Paint a smooth segment between two image-space points (spacing ~ radius/4). */
export const strokeMaskSegment = (maskCanvas, x1, y1, x2, y2, brush) => {
  if (!maskCanvas) return
  const ctx = maskCanvas.getContext('2d')
  const dx = x2 - x1
  const dy = y2 - y1
  const dist = Math.sqrt(dx * dx + dy * dy)
  const step = Math.max(1, (brush.radius || 1) / 4)
  const steps = Math.max(1, Math.ceil(dist / step))
  for (let i = 0; i <= steps; i += 1) {
    const t = steps === 0 ? 0 : i / steps
    stampMask(ctx, x1 + dx * t, y1 + dy * t, brush)
  }
}

const clampInt = (value, min, max) =>
  Math.min(max, Math.max(min, Math.round(value)))

const markMaskPixel = (data, pixel, fill) => {
  const i = pixel * 4
  if (data[i] === fill) return false
  data[i] = fill
  data[i + 1] = fill
  data[i + 2] = fill
  data[i + 3] = 255
  return true
}

/**
 * Image-aware region grow from a freehand stroke. This keeps all work at the
 * source bitmap/mask resolution: the user's stroke is treated as a hint, then a
 * bounded flood grow expands it to the nearby region whose colours are
 * consistent with the sampled stroke pixels. It gives cleanup-style "draw a
 * line, define an erase region" behaviour without downscaling or sending pixels
 * through a lossy external model.
 */
export const growMaskRegionFromStroke = (
  maskCanvas,
  sourceEl,
  points,
  { radius = 18, tolerance = 24, mode = 'erase', cropX = 0, cropY = 0 } = {},
) => {
  if (!maskCanvas || !sourceEl || !Array.isArray(points) || points.length === 0) return 0

  const w = maskCanvas.width
  const h = maskCanvas.height
  if (w < 1 || h < 1) return 0

  const r = Math.max(1, Number(radius) || 1)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let strokeLength = 0
  let lastPoint = null

  for (const point of points) {
    if (!point) continue
    if (lastPoint) {
      const dx = point.x - lastPoint.x
      const dy = point.y - lastPoint.y
      strokeLength += Math.sqrt(dx * dx + dy * dy)
    }
    lastPoint = point
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return 0

  const span = Math.max(maxX - minX, maxY - minY, strokeLength)
  const requestedPad = Math.max(32, r * 7, span * 0.72, Math.min(w, h) * 0.08)
  const pad = Math.min(requestedPad, Math.max(w, h) * 0.38)

  const sx = clampInt(minX - pad, 0, w - 1)
  const sy = clampInt(minY - pad, 0, h - 1)
  const ex = clampInt(maxX + pad, 0, w - 1)
  const ey = clampInt(maxY + pad, 0, h - 1)
  const rw = Math.max(1, ex - sx + 1)
  const rh = Math.max(1, ey - sy + 1)

  const sample = document.createElement('canvas')
  sample.width = rw
  sample.height = rh
  const sampleCtx = sample.getContext('2d', { willReadFrequently: true })
  let src
  try {
    // Bug #6: offset the source-rect by the crop origin so the sampled
    // region lines up with the mask grid (cropped space). cropX/cropY are 0
    // for uncropped images, preserving the original behaviour.
    sampleCtx.drawImage(sourceEl, sx + cropX, sy + cropY, rw, rh, 0, 0, rw, rh)
    src = sampleCtx.getImageData(0, 0, rw, rh).data
  } catch {
    return 0
  }

  const seedCanvas = document.createElement('canvas')
  seedCanvas.width = rw
  seedCanvas.height = rh
  const seedCtx = seedCanvas.getContext('2d', { willReadFrequently: true })
  seedCtx.lineCap = 'round'
  seedCtx.lineJoin = 'round'
  seedCtx.strokeStyle = '#fff'
  seedCtx.fillStyle = '#fff'
  seedCtx.lineWidth = Math.max(2, r * 1.45)

  const first = points[0]
  seedCtx.beginPath()
  seedCtx.moveTo(first.x - sx, first.y - sy)
  for (let i = 1; i < points.length; i += 1) {
    seedCtx.lineTo(points[i].x - sx, points[i].y - sy)
  }
  seedCtx.stroke()
  if (points.length === 1) {
    seedCtx.beginPath()
    seedCtx.arc(first.x - sx, first.y - sy, r * 0.72, 0, Math.PI * 2)
    seedCtx.fill()
  }

  const seed = seedCtx.getImageData(0, 0, rw, rh).data
  let count = 0
  let sr = 0
  let sg = 0
  let sb = 0
  let sl = 0
  let minR = 255
  let minG = 255
  let minB = 255
  let maxR = 0
  let maxG = 0
  let maxB = 0

  for (let p = 0; p < rw * rh; p += 1) {
    const i = p * 4
    if (seed[i + 3] < 16) continue
    const r0 = src[i]
    const g0 = src[i + 1]
    const b0 = src[i + 2]
    sr += r0
    sg += g0
    sb += b0
    sl += 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0
    minR = Math.min(minR, r0); minG = Math.min(minG, g0); minB = Math.min(minB, b0)
    maxR = Math.max(maxR, r0); maxG = Math.max(maxG, g0); maxB = Math.max(maxB, b0)
    count += 1
  }
  if (!count) return 0

  sr /= count
  sg /= count
  sb /= count
  sl /= count

  let variance = 0
  for (let p = 0; p < rw * rh; p += 1) {
    const i = p * 4
    if (seed[i + 3] < 16) continue
    const dr = src[i] - sr
    const dg = src[i + 1] - sg
    const db = src[i + 2] - sb
    variance += dr * dr + dg * dg + db * db
  }
  const std = Math.sqrt(variance / Math.max(1, count))
  const tol = Math.max(1, Math.min(100, tolerance))
  const chan = Math.round((tol / 100) * 255)
  const rangePad = Math.max(18, chan * 0.52 + std * 0.18)
  const distLimit = Math.max(26, chan * 1.15 + std * 0.72)
  const distLimitSq = distLimit * distLimit
  const lumaPad = Math.max(18, chan * 0.62 + std * 0.16)

  const matches = (p) => {
    const i = p * 4
    const r0 = src[i]
    const g0 = src[i + 1]
    const b0 = src[i + 2]
    const l = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0
    if (Math.abs(l - sl) > lumaPad) return false

    const inRange =
      r0 >= minR - rangePad && r0 <= maxR + rangePad &&
      g0 >= minG - rangePad && g0 <= maxG + rangePad &&
      b0 >= minB - rangePad && b0 <= maxB + rangePad
    if (inRange) return true

    const dr = r0 - sr
    const dg = g0 - sg
    const db = b0 - sb
    return dr * dr + dg * dg + db * db <= distLimitSq
  }

  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })
  const maskImage = maskCtx.getImageData(sx, sy, rw, rh)
  const mdata = maskImage.data
  const fill = mode === 'erase' ? 0 : 255
  const visited = new Uint8Array(rw * rh)
  const stack = []

  for (let p = 0; p < rw * rh; p += 1) {
    if (seed[p * 4 + 3] >= 16 && matches(p)) stack.push(p)
  }

  let affected = 0
  while (stack.length) {
    const p = stack.pop()
    if (visited[p]) continue
    visited[p] = 1
    if (!matches(p)) continue

    if (markMaskPixel(mdata, p, fill)) affected += 1
    const x = p % rw
    const y = Math.floor(p / rw)
    if (x > 0 && !visited[p - 1]) stack.push(p - 1)
    if (x < rw - 1 && !visited[p + 1]) stack.push(p + 1)
    if (y > 0 && !visited[p - rw]) stack.push(p - rw)
    if (y < rh - 1 && !visited[p + rw]) stack.push(p + rw)
    if (x > 0 && y > 0 && !visited[p - rw - 1]) stack.push(p - rw - 1)
    if (x < rw - 1 && y > 0 && !visited[p - rw + 1]) stack.push(p - rw + 1)
    if (x > 0 && y < rh - 1 && !visited[p + rw - 1]) stack.push(p + rw - 1)
    if (x < rw - 1 && y < rh - 1 && !visited[p + rw + 1]) stack.push(p + rw + 1)
  }

  // The hint stroke itself is always part of the selected region, even if a few
  // anti-aliased edge pixels failed the colour predicate.
  for (let p = 0; p < rw * rh; p += 1) {
    if (seed[p * 4 + 3] >= 16 && markMaskPixel(mdata, p, fill)) affected += 1
  }

  if (affected) maskCtx.putImageData(maskImage, sx, sy)
  return affected
}

export const createContentAwareFillCanvas = (
  sourceEl,
  selectionMaskCanvas,
  { threshold = 250, smoothingPasses = 3, cropX = 0, cropY = 0 } = {},
) => {
  if (!sourceEl || !selectionMaskCanvas) return null

  const w = selectionMaskCanvas.width
  const h = selectionMaskCanvas.height
  const total = w * h
  if (w < 1 || h < 1 || total < 1) return null

  const sourceCanvas = document.createElement('canvas')
  sourceCanvas.width = w
  sourceCanvas.height = h
  const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true })
  let sourceImage
  let maskImage
  try {
    // Bug #6: sample only the crop region so the fill source aligns with the
    // cropped mask grid (cropX/cropY default 0 for uncropped images).
    sourceCtx.drawImage(sourceEl, cropX, cropY, w, h, 0, 0, w, h)
    sourceImage = sourceCtx.getImageData(0, 0, w, h)
    maskImage = selectionMaskCanvas
      .getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, w, h)
  } catch {
    return null
  }

  const src = sourceImage.data
  const out = new Uint8ClampedArray(src)
  const mask = maskImage.data
  const selected = new Uint8Array(total)
  const known = new Uint8Array(total)
  const strength = new Float32Array(total)
  const queue = []
  const queued = new Uint8Array(total)
  let selectedCount = 0
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1

  for (let p = 0; p < total; p += 1) {
    const lum = mask[p * 4]
    const s = Math.max(0, Math.min(1, (threshold - lum) / Math.max(1, threshold)))
    if (lum < threshold && s > 0.01) {
      selected[p] = 1
      strength[p] = s
      selectedCount += 1
      const x = p % w
      const y = Math.floor(p / w)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    } else {
      known[p] = 1
    }
  }

  if (!selectedCount) return null
  if (selectedCount >= total) return null

  const hasKnownNeighbor = (p) => {
    const x = p % w
    const y = Math.floor(p / w)
    return (
      (x > 0 && known[p - 1]) ||
      (x < w - 1 && known[p + 1]) ||
      (y > 0 && known[p - w]) ||
      (y < h - 1 && known[p + w])
    )
  }

  const enqueue = (p) => {
    if (!selected[p] || known[p] || queued[p]) return
    if (!hasKnownNeighbor(p)) return
    queued[p] = 1
    queue.push(p)
  }

  for (let p = 0; p < total; p += 1) enqueue(p)

  const writeWeightedKnownAverage = (p) => {
    const x = p % w
    const y = Math.floor(p / w)
    let wr = 0
    let wg = 0
    let wb = 0
    let wa = 0
    let weightSum = 0

    for (let radius = 1; radius <= 10 && weightSum < 2.2; radius += 1) {
      const y0 = Math.max(0, y - radius)
      const y1 = Math.min(h - 1, y + radius)
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(w - 1, x + radius)

      for (let yy = y0; yy <= y1; yy += 1) {
        for (let xx = x0; xx <= x1; xx += 1) {
          const np = yy * w + xx
          if (!known[np]) continue
          const dx = xx - x
          const dy = yy - y
          const distSq = dx * dx + dy * dy
          if (distSq > radius * radius || distSq === 0) continue
          const ni = np * 4
          const weight = 1 / (distSq + 0.35)
          wr += out[ni] * weight
          wg += out[ni + 1] * weight
          wb += out[ni + 2] * weight
          wa += out[ni + 3] * weight
          weightSum += weight
        }
      }
    }

    if (weightSum <= 0) return false

    const i = p * 4
    out[i] = Math.round(wr / weightSum)
    out[i + 1] = Math.round(wg / weightSum)
    out[i + 2] = Math.round(wb / weightSum)
    out[i + 3] = Math.round(wa / weightSum)
    return true
  }

  let filled = 0
  for (let head = 0; head < queue.length; head += 1) {
    const p = queue[head]
    queued[p] = 0
    if (known[p]) continue
    if (!writeWeightedKnownAverage(p)) continue

    known[p] = 1
    filled += 1
    const x = p % w
    const y = Math.floor(p / w)
    if (x > 0) enqueue(p - 1)
    if (x < w - 1) enqueue(p + 1)
    if (y > 0) enqueue(p - w)
    if (y < h - 1) enqueue(p + w)
  }

  if (filled < selectedCount) {
    let wr = 0
    let wg = 0
    let wb = 0
    let wa = 0
    let count = 0
    for (let p = 0; p < total; p += 1) {
      if (!known[p]) continue
      const i = p * 4
      wr += out[i]
      wg += out[i + 1]
      wb += out[i + 2]
      wa += out[i + 3]
      count += 1
    }
    const fallback = count
      ? [Math.round(wr / count), Math.round(wg / count), Math.round(wb / count), Math.round(wa / count)]
      : [0, 0, 0, 255]
    for (let p = 0; p < total; p += 1) {
      if (known[p]) continue
      const i = p * 4
      out[i] = fallback[0]
      out[i + 1] = fallback[1]
      out[i + 2] = fallback[2]
      out[i + 3] = fallback[3]
      known[p] = 1
    }
  }

  const pad = Math.max(2, Math.ceil(Math.sqrt(selectedCount) * 0.04))
  const rx0 = Math.max(0, minX - pad)
  const ry0 = Math.max(0, minY - pad)
  const rx1 = Math.min(w - 1, maxX + pad)
  const ry1 = Math.min(h - 1, maxY + pad)
  const passes = Math.max(0, Math.min(8, Math.round(smoothingPasses)))

  for (let pass = 0; pass < passes; pass += 1) {
    const prev = new Uint8ClampedArray(out)
    for (let y = ry0; y <= ry1; y += 1) {
      for (let x = rx0; x <= rx1; x += 1) {
        const p = y * w + x
        if (!selected[p]) continue
        const i = p * 4
        let wr = prev[i] * 2.2
        let wg = prev[i + 1] * 2.2
        let wb = prev[i + 2] * 2.2
        let wa = prev[i + 3] * 2.2
        let weightSum = 2.2

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue
            const xx = x + dx
            const yy = y + dy
            if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue
            const np = yy * w + xx
            const ni = np * 4
            const weight = selected[np] ? 0.9 : 0.45
            wr += prev[ni] * weight
            wg += prev[ni + 1] * weight
            wb += prev[ni + 2] * weight
            wa += prev[ni + 3] * weight
            weightSum += weight
          }
        }

        out[i] = Math.round(wr / weightSum)
        out[i + 1] = Math.round(wg / weightSum)
        out[i + 2] = Math.round(wb / weightSum)
        out[i + 3] = Math.round(wa / weightSum)
      }
    }
  }

  for (let p = 0; p < total; p += 1) {
    if (!selected[p]) continue
    const i = p * 4
    const s = Math.max(0, Math.min(1, strength[p]))
    if (s >= 0.995) continue
    out[i] = Math.round(src[i] * (1 - s) + out[i] * s)
    out[i + 1] = Math.round(src[i + 1] * (1 - s) + out[i + 1] * s)
    out[i + 2] = Math.round(src[i + 2] * (1 - s) + out[i + 2] * s)
    out[i + 3] = Math.round(src[i + 3] * (1 - s) + out[i + 3] * s)
  }

  const result = document.createElement('canvas')
  result.width = w
  result.height = h
  const resultCtx = result.getContext('2d')
  resultCtx.putImageData(new ImageData(out, w, h), 0, 0)
  return result
}

/**
 * Magic eraser: contiguous scanline flood from a seed point, matching pixels in
 * the source bitmap whose per-channel difference is within `tolerance` (0–100,
 * ≈ Photoshop's tolerance). Matched pixels are set to hidden (erase) or visible
 * (restore) in the mask. Returns the number of pixels affected.
 */
export const floodFillMask = (maskCanvas, sourceEl, seedX, seedY, { tolerance = 24, mode = 'erase', cropX = 0, cropY = 0 } = {}) => {
  if (!maskCanvas || !sourceEl) return 0
  const w = maskCanvas.width
  const h = maskCanvas.height
  // Clamp the seed to the inclusive image bounds (matches isPointInImage), so an
  // edge click at x === width still seeds the last column instead of bailing.
  const sx = Math.min(w - 1, Math.max(0, Math.round(seedX)))
  const sy = Math.min(h - 1, Math.max(0, Math.round(seedY)))

  const sample = document.createElement('canvas')
  sample.width = w
  sample.height = h
  const sampleCtx = sample.getContext('2d', { willReadFrequently: true })
  let src
  try {
    // Bug #6: the mask grid (w×h) is the CROPPED display size, but the
    // source element is the full natural bitmap. Sampling the whole source
    // into the cropped grid would stretch/shift colours so the flood seed
    // lands on the wrong pixel. Blit only the crop region [cropX, cropY, w, h]
    // 1:1 into the grid (cropX/cropY default 0 → unchanged for uncropped images).
    sampleCtx.drawImage(sourceEl, cropX, cropY, w, h, 0, 0, w, h)
    src = sampleCtx.getImageData(0, 0, w, h).data
  } catch {
    // Tainted canvas (image lacked CORS headers) — magic erase isn't possible.
    return 0
  }

  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })
  const maskImage = maskCtx.getImageData(0, 0, w, h)
  const mdata = maskImage.data

  const seed = (sy * w + sx) * 4
  const sr = src[seed]
  const sg = src[seed + 1]
  const sb = src[seed + 2]
  const chan = Math.round((Math.max(0, Math.min(100, tolerance)) / 100) * 255)
  const fill = mode === 'erase' ? 0 : 255

  const matches = (p) => {
    const i = p * 4
    return (
      Math.abs(src[i] - sr) <= chan &&
      Math.abs(src[i + 1] - sg) <= chan &&
      Math.abs(src[i + 2] - sb) <= chan
    )
  }

  const visited = new Uint8Array(w * h)
  const stack = [sx, sy]
  let affected = 0

  while (stack.length) {
    const y = stack.pop()
    const x = stack.pop()
    const rowBase = y * w
    if (visited[rowBase + x] || !matches(rowBase + x)) continue

    let left = x
    while (left > 0 && !visited[rowBase + left - 1] && matches(rowBase + left - 1)) left -= 1
    let right = x
    while (right < w - 1 && !visited[rowBase + right + 1] && matches(rowBase + right + 1)) right += 1

    // Fill the contiguous run and seed neighbour rows ONCE per contiguous run
    // (track the previous-pixel match state) instead of once per pixel — without
    // this a large uniform region pushes O(area) redundant seeds and blows the
    // stack / matches() budget on big images.
    let upPrev = false
    let downPrev = false
    for (let xi = left; xi <= right; xi += 1) {
      const p = rowBase + xi
      visited[p] = 1
      const i = p * 4
      // Only write + count when the mask value actually changes. An idempotent
      // flood (re-erasing already-hidden pixels) then returns 0 so the caller can
      // short-circuit and skip pushing undo / marking dirty. Visited marking and
      // neighbour seeding still happen so the scanline traversal stays correct.
      if (mdata[i] !== fill) {
        mdata[i] = fill
        mdata[i + 1] = fill
        mdata[i + 2] = fill
        mdata[i + 3] = 255
        affected += 1
      }

      if (y > 0) {
        const up = p - w
        const upMatch = !visited[up] && matches(up)
        if (upMatch && !upPrev) stack.push(xi, y - 1)
        upPrev = upMatch
      }
      if (y < h - 1) {
        const down = p + w
        const downMatch = !visited[down] && matches(down)
        if (downMatch && !downPrev) stack.push(xi, y + 1)
        downPrev = downMatch
      }
    }
  }

  if (affected) maskCtx.putImageData(maskImage, 0, 0)
  return affected
}

/** Paint the red "hidden area" preview overlay from the mask.
 *
 * Pass `rect` ({ x, y, w, h } in mask px) to repaint ONLY that region — the
 * brush's dirty bounding box. This makes the per-frame cost proportional to the
 * brush footprint instead of the whole image, which is what keeps the live
 * stroke (and the floating brush cursor, on the same thread) responsive on
 * large images. A full repaint is used whenever the overlay was just
 * (re)allocated, since a partial write would leave the rest of a fresh buffer
 * blank. */
export const paintOverlayFromMask = (
  maskCanvas,
  overlayCanvas,
  {
    threshold = 250,
    // Default tint: a softer "lighter red" (pinkish coral) instead of the
    // hard crimson (220, 40, 60) the original used, so the overlay reads
    // as a non-destructive preview and not a selection highlight.
    tintR = 255,
    tintG = 140,
    tintB = 140,
    // Max alpha at fully-masked pixels. 0.2 == 80% transparent — the
    // overlay is now a faint tint over the source, not a solid fill.
    // Multiply by (255 - lum) to keep a soft inner-to-outer falloff.
    maxAlpha = 0.2,
    rect = null,
  } = {},
) => {
  if (!maskCanvas || !overlayCanvas) return
  const fullW = maskCanvas.width
  const fullH = maskCanvas.height
  // Assigning width/height reallocates + clears the backing store, so only do it
  // when the size actually changed. A reallocation forces a FULL repaint (a
  // partial putImageData would leave the rest of the cleared buffer blank).
  let resized = false
  if (overlayCanvas.width !== fullW) { overlayCanvas.width = fullW; resized = true }
  if (overlayCanvas.height !== fullH) { overlayCanvas.height = fullH; resized = true }

  // Resolve the region to repaint (clamped to the canvas). null/resized => full.
  let rx = 0
  let ry = 0
  let rw = fullW
  let rh = fullH
  if (rect && !resized) {
    // Clamp the start to [0, fullW] (NOT fullW-1): a fully out-of-bounds rect
    // then collapses to rw/rh = 0 and early-returns, instead of needlessly
    // repainting the last row/column. The right edge uses ceil() so the
    // inclusive max pixel of the dirty bbox is always covered.
    rx = Math.max(0, Math.min(fullW, Math.floor(rect.x)))
    ry = Math.max(0, Math.min(fullH, Math.floor(rect.y)))
    rw = Math.max(0, Math.min(fullW - rx, Math.ceil(rect.x + rect.w) - rx))
    rh = Math.max(0, Math.min(fullH - ry, Math.ceil(rect.y + rect.h) - ry))
    if (rw <= 0 || rh <= 0) return
  }

  const maskCtx = maskCanvas.getContext('2d')
  const overlayCtx = overlayCanvas.getContext('2d')
  const maskData = maskCtx.getImageData(rx, ry, rw, rh)
  const overlayData = overlayCtx.createImageData(rw, rh)

  for (let i = 0; i < maskData.data.length; i += 4) {
    const lum = maskData.data[i]
    if (lum < threshold) {
      overlayData.data[i] = tintR
      overlayData.data[i + 1] = tintG
      overlayData.data[i + 2] = tintB
      overlayData.data[i + 3] = Math.round((255 - lum) * maxAlpha)
    }
  }
  overlayCtx.putImageData(overlayData, rx, ry)
}

/**
 * Build a mask from an image's alpha channel — used by AI auto-erase, where a
 * background-removed PNG's transparency marks what to hide. Opaque (alpha 255)
 * => visible (lum 255); transparent => hidden (lum 0). `invert` flips it.
 */
export const maskFromImageAlpha = (sourceEl, width, height, { invert = false } = {}) => {
  if (!sourceEl) return null
  const sample = document.createElement('canvas')
  sample.width = width
  sample.height = height
  const sampleCtx = sample.getContext('2d', { willReadFrequently: true })
  let src
  try {
    sampleCtx.drawImage(sourceEl, 0, 0, width, height)
    src = sampleCtx.getImageData(0, 0, width, height).data
  } catch {
    return null
  }

  const mask = createMaskCanvas(width, height)
  const maskCtx = mask.getContext('2d')
  const maskData = maskCtx.createImageData(width, height)
  for (let i = 0; i < src.length; i += 4) {
    const lum = invert ? 255 - src[i + 3] : src[i + 3]
    maskData.data[i] = lum
    maskData.data[i + 1] = lum
    maskData.data[i + 2] = lum
    maskData.data[i + 3] = 255
  }
  maskCtx.putImageData(maskData, 0, 0)
  return mask
}
