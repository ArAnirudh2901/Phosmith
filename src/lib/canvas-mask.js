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
  const ctx = canvas.getContext('2d')
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
    const sourceCtx = source.getContext('2d')
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
    const crisp = document.createElement('canvas')
    crisp.width = clipCanvas.width
    crisp.height = clipCanvas.height
    crisp.getContext('2d').drawImage(clipCanvas, 0, 0)
    clipCtx.clearRect(0, 0, clipCanvas.width, clipCanvas.height)
    clipCtx.filter = `blur(${featherPx}px)`
    clipCtx.drawImage(crisp, 0, 0)
    clipCtx.filter = 'none'
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

  const width = Math.max(1, Math.round(encoded.width || 1))
  const height = Math.max(1, Math.round(encoded.height || 1))
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
    const end = Math.min(totalPixels, pixel + runLength)

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

/**
 * Magic eraser: contiguous scanline flood from a seed point, matching pixels in
 * the source bitmap whose per-channel difference is within `tolerance` (0–100,
 * ≈ Photoshop's tolerance). Matched pixels are set to hidden (erase) or visible
 * (restore) in the mask. Returns the number of pixels affected.
 */
export const floodFillMask = (maskCanvas, sourceEl, seedX, seedY, { tolerance = 24, mode = 'erase' } = {}) => {
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
    sampleCtx.drawImage(sourceEl, 0, 0, w, h)
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
      mdata[i] = fill
      mdata[i + 1] = fill
      mdata[i + 2] = fill
      mdata[i + 3] = 255
      affected += 1

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

/** Paint the red "hidden area" preview overlay from the mask. */
export const paintOverlayFromMask = (maskCanvas, overlayCanvas, { threshold = 250 } = {}) => {
  if (!maskCanvas || !overlayCanvas) return
  overlayCanvas.width = maskCanvas.width
  overlayCanvas.height = maskCanvas.height
  const maskCtx = maskCanvas.getContext('2d')
  const overlayCtx = overlayCanvas.getContext('2d')
  const maskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
  const overlayData = overlayCtx.createImageData(maskCanvas.width, maskCanvas.height)

  for (let i = 0; i < maskData.data.length; i += 4) {
    const lum = maskData.data[i]
    if (lum < threshold) {
      overlayData.data[i] = 220
      overlayData.data[i + 1] = 40
      overlayData.data[i + 2] = 60
      overlayData.data[i + 3] = Math.round((255 - lum) * 0.45)
    }
  }
  overlayCtx.putImageData(overlayData, 0, 0)
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
