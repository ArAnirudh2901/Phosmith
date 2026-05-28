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

export const buildMaskClipCanvas = (maskCanvas) => {
  const ctx = maskCanvas.getContext('2d')
  const source = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
  const clipCanvas = document.createElement('canvas')
  clipCanvas.width = maskCanvas.width
  clipCanvas.height = maskCanvas.height
  const clipCtx = clipCanvas.getContext('2d')
  const clipData = clipCtx.createImageData(maskCanvas.width, maskCanvas.height)

  for (let i = 0; i < source.data.length; i += 4) {
    const lum = source.data[i]
    clipData.data[i] = 255
    clipData.data[i + 1] = 255
    clipData.data[i + 2] = 255
    clipData.data[i + 3] = lum
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

export const createMaskClipPath = (FabricImage, maskCanvas) =>
  new FabricImage(buildMaskClipCanvas(maskCanvas), {
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
