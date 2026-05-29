export const MAX_OUTPUT_DIMENSION = 4096
const MIN_OUTPUT_DIMENSION = 64
const MAX_INSET_RATIO = 0.85

/** Cyan expansion UI strokes (current + legacy theme variants). */
const EXPANSION_STROKE_MARKERS = ['125, 235, 255', '0, 229, 255', '108, 99, 255']

/**
 * Detect expansion frame rects — including persisted JSON without custom props.
 */
export function isExpansionFrameLike(obj) {
  if (!obj) return false
  if (obj._isExpansionFrame) return true

  const type = (obj.type || '').toLowerCase()
  if (type !== 'rect') return false

  const hasDash = Array.isArray(obj.strokeDashArray) && obj.strokeDashArray.length > 0
  if (!hasDash) return false

  const stroke = String(obj.stroke ?? '')
  const fill = String(obj.fill ?? '')

  if (EXPANSION_STROKE_MARKERS.some((marker) => stroke.includes(marker))) {
    return true
  }

  // Low-opacity fill + dashed stroke = expansion chrome, not user shapes
  if (/0\.0[34]\)/.test(fill) && stroke.includes('255')) {
    return true
  }

  return false
}

/** Edge midpoints + corner controls for the expansion frame. */
const EXPANSION_CONTROL_KEYS = new Set(['mt', 'mb', 'ml', 'mr', 'tl', 'tr', 'bl', 'br'])

/** Hide every control handle on an object (Fabric 6/7). */
export function hideAllObjectControls(obj) {
  if (!obj?.controls) return
  for (const key of Object.keys(obj.controls)) {
    const control = obj.controls[key]
    if (control) control.visible = false
  }
  obj.hasControls = false
  obj.hasBorders = false
}

/** Show edge midpoint + corner handles — used for the expansion frame. */
export function showEdgeControlsOnly(obj) {
  if (!obj?.controls) return
  for (const key of Object.keys(obj.controls)) {
    const control = obj.controls[key]
    if (!control) continue
    control.visible = EXPANSION_CONTROL_KEYS.has(key)
  }
  obj.set?.({
    hasControls: true,
    hasBorders: false,
    borderColor: 'transparent',
  })
}

/** Lock image so only the expansion frame is interactive. */
export function silenceImageForExpansion(image) {
  if (!image) return
  image.set({
    selectable: false,
    evented: false,
    hasControls: false,
    hasBorders: false,
    hoverCursor: 'default',
    moveCursor: 'default',
    lockMovementX: true,
    lockMovementY: true,
    lockScalingX: true,
    lockScalingY: true,
    lockRotation: true,
  })
  hideAllObjectControls(image)
}

/** Remove every expansion frame from the canvas (keeps a single active frame). */
export function removeExpansionFramesFromCanvas(canvas) {
  if (!canvas?.getObjects) return 0
  const stale = canvas.getObjects().filter(isExpansionFrameLike)
  stale.forEach((obj) => canvas.remove(obj))
  if (stale.length) canvas.requestRenderAll()
  return stale.length
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

/**
 * Source pixel dimensions from the loaded image element.
 */
export function getSourcePixelDimensions(fabricImage) {
  if (!fabricImage) return { width: 0, height: 0 }
  const el = fabricImage._originalElement || fabricImage.getElement?.()
  const naturalW = el?.naturalWidth || fabricImage.width || 0
  const naturalH = el?.naturalHeight || fabricImage.height || 0
  return {
    width: Math.max(1, Math.round(naturalW)),
    height: Math.max(1, Math.round(naturalH)),
  }
}

const canvasToBlob = (canvas, mimeType, quality) =>
  new Promise((resolve) => {
    if (!canvas?.toBlob) {
      resolve(null)
      return
    }
    canvas.toBlob(resolve, mimeType, quality)
  })

/**
 * Export the actual Fabric image pixels, including local filters/crops.
 * This keeps AI extension aligned with the edited canvas instead of the
 * original remote file URL.
 */
export async function buildVisibleImageBlob(fabricImage) {
  if (!fabricImage?.toCanvasElement) return null

  try {
    fabricImage.applyFilters?.()
    const canvas = fabricImage.toCanvasElement({
      withoutTransform: true,
      withoutShadow: true,
      enableRetinaScaling: false,
    })

    if (!canvas?.width || !canvas?.height) return null

    const webpBlob = await canvasToBlob(canvas, 'image/webp', 0.94)
    const pngBlob = webpBlob?.size ? null : await canvasToBlob(canvas, 'image/png', 1)
    const blob = webpBlob?.size ? webpBlob : pngBlob

    if (!blob?.size) return null

    return {
      blob,
      width: Math.max(1, Math.round(canvas.width)),
      height: Math.max(1, Math.round(canvas.height)),
    }
  } catch (err) {
    console.warn('[ai-extender] visible image export failed:', err)
    return null
  }
}

/**
 * Canvas display bounds → source pixel scale factors.
 */
export function getCanvasScale(imageBounds, pixelDims) {
  if (!imageBounds?.width || !imageBounds?.height) {
    return { scaleX: 1, scaleY: 1 }
  }
  return {
    scaleX: pixelDims.width / imageBounds.width,
    scaleY: pixelDims.height / imageBounds.height,
  }
}

/**
 * Fabric bounding rects → pixel-space expansion spec.
 */
export function frameToPixelExpansion(imageBounds, frameBounds, pixelDims) {
  const { scaleX, scaleY } = getCanvasScale(imageBounds, pixelDims)

  const imageLeft = imageBounds.left
  const imageTop = imageBounds.top
  const imageRight = imageLeft + imageBounds.width
  const imageBottom = imageTop + imageBounds.height

  const frameLeft = frameBounds.left
  const frameTop = frameBounds.top
  const frameRight = frameLeft + frameBounds.width
  const frameBottom = frameTop + frameBounds.height

  const insetLeft = Math.max(0, (imageLeft - frameLeft) * scaleX)
  const insetTop = Math.max(0, (imageTop - frameTop) * scaleY)
  const insetRight = Math.max(0, (frameRight - imageRight) * scaleX)
  const insetBottom = Math.max(0, (frameBottom - imageBottom) * scaleY)

  const maxInsetX = Math.round(pixelDims.width * MAX_INSET_RATIO)
  const maxInsetY = Math.round(pixelDims.height * MAX_INSET_RATIO)
  const clampInset = (v, max) => Math.min(Math.max(0, Math.round(v)), max)

  // Ignore sub-pixel handle jitter (< 2px in source space).
  const INSET_NOISE_PX = 2
  const dropNoise = (v) => (v < INSET_NOISE_PX ? 0 : v)

  let insetLeftC = clampInset(dropNoise(insetLeft), maxInsetX)
  let insetRightC = clampInset(dropNoise(insetRight), maxInsetX)
  let insetTopC = clampInset(dropNoise(insetTop), maxInsetY)
  let insetBottomC = clampInset(dropNoise(insetBottom), maxInsetY)

  // Source already at max — only extend on the other axis (no horizontal jitter).
  if (pixelDims.width >= MAX_OUTPUT_DIMENSION) {
    insetLeftC = 0
    insetRightC = 0
  }
  if (pixelDims.height >= MAX_OUTPUT_DIMENSION) {
    insetTopC = 0
    insetBottomC = 0
  }

  let targetWidth = pixelDims.width + insetLeftC + insetRightC
  let targetHeight = pixelDims.height + insetTopC + insetBottomC

  // Cap output — never use min=source+1 when source is already at MAX (that forces 4097).
  if (targetWidth > MAX_OUTPUT_DIMENSION) {
    const overflow = targetWidth - MAX_OUTPUT_DIMENSION
    if (insetRightC >= insetLeftC && insetRightC > 0) {
      insetRightC = Math.max(0, insetRightC - overflow)
    } else if (insetLeftC > 0) {
      insetLeftC = Math.max(0, insetLeftC - overflow)
    }
    targetWidth = pixelDims.width + insetLeftC + insetRightC
  }
  if (targetHeight > MAX_OUTPUT_DIMENSION) {
    const overflow = targetHeight - MAX_OUTPUT_DIMENSION
    if (insetBottomC >= insetTopC && insetBottomC > 0) {
      insetBottomC = Math.max(0, insetBottomC - overflow)
    } else if (insetTopC > 0) {
      insetTopC = Math.max(0, insetTopC - overflow)
    }
    targetHeight = pixelDims.height + insetTopC + insetBottomC
  }

  targetWidth = Math.min(targetWidth, MAX_OUTPUT_DIMENSION)
  targetHeight = Math.min(targetHeight, MAX_OUTPUT_DIMENSION)

  // Multi-axis sequential extension guard:
  // When both axes have insets, buildSequentialGenfillUrl splits the work into
  // step 1 (horizontal: sourceWidth + left + right) then step 2 (vertical).
  // The intermediate width (step 1 output) must also not exceed MAX_OUTPUT_DIMENSION.
  const hasHorizontal = insetLeftC >= 1 || insetRightC >= 1
  const hasVertical = insetTopC >= 1 || insetBottomC >= 1
  if (hasHorizontal && hasVertical) {
    const intermediateWidth = pixelDims.width + insetLeftC + insetRightC
    if (intermediateWidth > MAX_OUTPUT_DIMENSION) {
      const overflowH = intermediateWidth - MAX_OUTPUT_DIMENSION
      // Trim proportionally from left/right
      const totalH = insetLeftC + insetRightC
      if (totalH > 0) {
        const leftRatio = insetLeftC / totalH
        insetLeftC = Math.max(0, Math.round(insetLeftC - overflowH * leftRatio))
        insetRightC = Math.max(0, Math.round(insetRightC - overflowH * (1 - leftRatio)))
      }
      // Recalculate target width
      targetWidth = Math.min(pixelDims.width + insetLeftC + insetRightC, MAX_OUTPUT_DIMENSION)
    }
  }

  const offsetX = insetLeftC
  const offsetY = insetTopC

  return {
    sourceWidth: pixelDims.width,
    sourceHeight: pixelDims.height,
    targetWidth,
    targetHeight,
    offsetX,
    offsetY,
    insets: {
      top: insetTopC,
      left: insetLeftC,
      right: insetRightC,
      bottom: insetBottomC,
    },
  }
}

/** True when one edge accounts for most of the expansion (ImageKit fo-* pad). */
export function isDominantAxisExpansion(expansion) {
  const { insets } = expansion || {}
  const sides = [insets.left, insets.right, insets.top, insets.bottom]
  const total = sides.reduce((sum, v) => sum + (v || 0), 0)
  if (total < 1) return false
  return Math.max(...sides) / total >= 0.55
}

export function validateExpansion(expansion) {
  if (!expansion) return { valid: false, error: 'No expansion region defined' }

  const { targetWidth, targetHeight, insets } = expansion
  const hasInset =
    insets.top >= 1 || insets.left >= 1 || insets.right >= 1 || insets.bottom >= 1

  if (!hasInset) {
    return { valid: false, error: 'Drag the frame handles outward beyond the image to extend' }
  }

  const overMax = targetWidth > MAX_OUTPUT_DIMENSION || targetHeight > MAX_OUTPUT_DIMENSION
  const underMin =
    targetWidth < MIN_OUTPUT_DIMENSION || targetHeight < MIN_OUTPUT_DIMENSION

  if (overMax || underMin) {
    const atSourceMax =
      expansion.sourceWidth >= MAX_OUTPUT_DIMENSION ||
      expansion.sourceHeight >= MAX_OUTPUT_DIMENSION
    if (atSourceMax && overMax) {
      return {
        valid: false,
        error: `Image is already ${MAX_OUTPUT_DIMENSION}px on one side. Extend only on the other edges, or use a smaller source image.`,
      }
    }
    return {
      valid: false,
      error: `Output must be between ${MIN_OUTPUT_DIMENSION} and ${MAX_OUTPUT_DIMENSION} pixels`,
    }
  }

  return { valid: true }
}

/**
 * Build prompt for bg-genfill. Keep it short — ImageKit docs show
 * single-phrase prompts like "flowers". The model inherently uses
 * the source image as context for seamless continuation.
 */
export function buildExtensionPrompt(userPrompt) {
  const trimmed = (userPrompt || '').trim()
  if (trimmed) return trimmed
  // Short default: genfill already does seamless extension by design
  return 'seamless natural continuation'
}

/**
 * Load the full-resolution source image (no canvas transforms).
 */
export function loadImageElementFromUrl(url, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('No image URL to load'))
      return
    }

    const img = new Image()
    img.crossOrigin = 'anonymous'
    const timer = setTimeout(() => {
      img.onload = null
      img.onerror = null
      reject(new Error('Timed out loading full-resolution image'))
    }, timeoutMs)

    img.onload = () => {
      clearTimeout(timer)
      if (img.naturalWidth < 1 || img.naturalHeight < 1) {
        reject(new Error('Image has no pixel dimensions'))
        return
      }
      resolve(img)
    }
    img.onerror = () => {
      clearTimeout(timer)
      reject(new Error('Failed to load full-resolution image'))
    }
    img.src = url
  })
}

/** Draw full source image + transparent margins onto an offscreen canvas. */
export function createExpansionCompositeCanvas(imageElement, expansion) {
  const { targetWidth, targetHeight, offsetX, offsetY, sourceWidth, sourceHeight } =
    expansion

  if (!imageElement) {
    throw new Error('Image element not available for composite')
  }

  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')

  if (!ctx) {
    throw new Error(`Browser refused to create a ${targetWidth}x${targetHeight} canvas. The requested size may be too large for this device's memory. Try scaling down.`)
  }

  ctx.clearRect(0, 0, targetWidth, targetHeight)
  ctx.drawImage(
    imageElement,
    0,
    0,
    sourceWidth,
    sourceHeight,
    offsetX,
    offsetY,
    sourceWidth,
    sourceHeight
  )

  return canvas
}

/** @deprecated Prefer buildExpansionCompositeBlob for smaller uploads. */
export function buildExpansionComposite(imageElement, expansion) {
  return createExpansionCompositeCanvas(imageElement, expansion).toDataURL('image/png')
}

/** WebP keeps transparency and is much smaller than PNG for large canvases. */
export function buildExpansionCompositeBlob(
  imageElement,
  expansion,
  { mimeType = 'image/webp', quality = 0.92 } = {}
) {
  const canvas = createExpansionCompositeCanvas(imageElement, expansion)
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Failed to encode extension composite'))
      },
      mimeType,
      quality
    )
  })
}

/** True when Fabric canvas is mounted and safe to call calcOffset / render. */
export function isCanvasLive(canvas) {
  return Boolean(
    canvas &&
      typeof canvas.getObjects === 'function' &&
      (canvas.lower?.el || canvas.upperCanvasEl)
  )
}

/**
 * Map canvas object bounds to screen coordinates (viewport-aware).
 */
export function canvasBoundsToScreen(canvas, bounds) {
  if (!isCanvasLive(canvas) || !bounds) return null

  const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
  const zoom = vpt[0] || 1
  const panX = vpt[4] || 0
  const panY = vpt[5] || 0

  let offset = { left: 0, top: 0 }
  try {
    offset = canvas.calcOffset?.() || offset
  } catch {
    return null
  }

  const toScreen = (x, y) => ({
    x: x * zoom + panX + offset.left,
    y: y * zoom + panY + offset.top,
  })

  const tl = toScreen(bounds.left, bounds.top)
  const br = toScreen(bounds.left + bounds.width, bounds.top + bounds.height)

  return {
    left: tl.x,
    top: tl.y,
    width: br.x - tl.x,
    height: br.y - tl.y,
    centerX: (tl.x + br.x) / 2,
    centerY: (tl.y + br.y) / 2,
  }
}

export function getFrameBoundsFromFabricRect(frame) {
  if (!frame) return null
  const rect = frame.getBoundingRect?.()
  if (rect?.width && rect?.height) {
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    }
  }
  const w = frame.getScaledWidth?.() || frame.width * (frame.scaleX || 1)
  const h = frame.getScaledHeight?.() || frame.height * (frame.scaleY || 1)
  return {
    left: frame.left,
    top: frame.top,
    width: w,
    height: h,
  }
}

/** Pick ImageKit pad_resize focus from expansion insets (single-axis fallback). */
export function getExpansionFocus(expansion) {
  const { insets } = expansion
  const entries = [
    ['left', insets.left],
    ['right', insets.right],
    ['top', insets.top],
    ['bottom', insets.bottom],
  ]
  const dominant = entries.sort((a, b) => b[1] - a[1])[0]
  if (dominant[1] <= 0) return 'center'

  // Invert: if extending RIGHT, anchor image LEFT (so genfill fills the right).
  const invertMap = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }
  return invertMap[dominant[0]] || 'center'
}
