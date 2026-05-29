import { normalizeCanvasState } from './canvas-state'
import { createMaskClipPath, decodeMaskCanvas } from './canvas-mask'

const cleanComparableUrl = (url) =>
  String(url || '')
    .replace(/([?&])_ik_poll=\d+(&?)/, (match, prefix, suffix) => (suffix ? prefix : ''))
    .trim()

const getImageSrc = (obj) =>
  obj?.getSrc?.() ||
  obj?._originalElement?.src ||
  obj?._element?.src ||
  obj?.src ||
  ''

const isUsableRemoteSrc = (src) =>
  Boolean(src) && !String(src).startsWith('data:') && !String(src).startsWith('blob:')

const restoreImageGeometry = (obj, geometry, fallback) => {
  obj.set({
    left: geometry.left,
    top: geometry.top,
    angle: geometry.angle,
    originX: geometry.originX,
    originY: geometry.originY,
    scaleX: geometry.scaleX,
    scaleY: geometry.scaleY,
    width: geometry.width || fallback.width,
    height: geometry.height || fallback.height,
    cropX: geometry.cropX || 0,
    cropY: geometry.cropY || 0,
    flipX: geometry.flipX,
    flipY: geometry.flipY,
    skewX: geometry.skewX,
    skewY: geometry.skewY,
  })
}

const fitImageToCanvas = (obj, replacement, canvasSize) => {
  const imageWidth = replacement.width || obj.width || 1
  const imageHeight = replacement.height || obj.height || 1
  const canvasWidth = canvasSize?.width || imageWidth
  const canvasHeight = canvasSize?.height || imageHeight
  const nativeSizeMatches =
    Math.abs(imageWidth - canvasWidth) <= 2 &&
    Math.abs(imageHeight - canvasHeight) <= 2

  if (nativeSizeMatches) {
    obj.set({
      left: 0,
      top: 0,
      originX: 'left',
      originY: 'top',
      width: imageWidth,
      height: imageHeight,
      scaleX: 1,
      scaleY: 1,
      cropX: 0,
      cropY: 0,
    })
    return
  }

  const scale = Math.min(canvasWidth / imageWidth, canvasHeight / imageHeight)
  obj.set({
    left: canvasWidth / 2,
    top: canvasHeight / 2,
    originX: 'center',
    originY: 'center',
    width: imageWidth,
    height: imageHeight,
    scaleX: scale,
    scaleY: scale,
    cropX: 0,
    cropY: 0,
  })
}

const restoreSerializedMask = (FabricImage, obj) => {
  const encodedMask = obj?.pixxelMask || obj?._pixxelMask
  if (!encodedMask) return

  const maskCanvas = decodeMaskCanvas(encodedMask)
  if (!maskCanvas) return

  const feather = Math.max(0, Math.round(obj?.pixxelMaskFeather || obj?._pixxelMaskFeather || 0))
  obj._pixxelMaskCanvas = maskCanvas
  obj._pixxelHasMask = true
  obj.pixxelHasMask = true
  obj.pixxelMaskFeather = feather
  obj._pixxelMaskFeather = feather
  const clip = createMaskClipPath(FabricImage, maskCanvas, { feather })
  // The mask was authored at the saved bitmap size. If the image was rehydrated to
  // a different-resolution source, scale the (center-origin) clip so it still covers
  // the live image exactly instead of misaligning to the saved dimensions.
  const targetW = Math.max(1, Math.round(obj.width || maskCanvas.width))
  const targetH = Math.max(1, Math.round(obj.height || maskCanvas.height))
  if (targetW !== maskCanvas.width || targetH !== maskCanvas.height) {
    clip.scaleX = targetW / maskCanvas.width
    clip.scaleY = targetH / maskCanvas.height
  }
  obj.clipPath = clip
  obj.set?.('dirty', true)
  obj.setCoords?.()
}

/**
 * After loadFromJSON, ensure image objects have a loadable src.
 */
export async function hydrateCanvasImages(canvas, imageUrl, { forcePrimaryImageUrl = false, canvasSize } = {}) {
  if (!canvas) return

  const { FabricImage } = await import('fabric')
  const objects = canvas.getObjects?.() || []
  const desiredSrc = cleanComparableUrl(imageUrl)

  if (imageUrl) {
    await Promise.all(
      objects
        .filter((obj) => obj?.type?.toLowerCase() === 'image')
        .map(async (obj, index) => {
          const currentSrc = getImageSrc(obj)
          const hasRemote = isUsableRemoteSrc(currentSrc)
          const isPrimaryStale =
            forcePrimaryImageUrl &&
            index === 0 &&
            desiredSrc &&
            cleanComparableUrl(currentSrc) !== desiredSrc

          if (hasRemote && !isPrimaryStale) return

          try {
            const replacement = await FabricImage.fromURL(imageUrl, { crossOrigin: 'anonymous' })
            const geometry = {
              left: obj.left,
              top: obj.top,
              width: obj.width,
              height: obj.height,
              scaleX: obj.scaleX,
              scaleY: obj.scaleY,
              angle: obj.angle,
              originX: obj.originX,
              originY: obj.originY,
              cropX: obj.cropX,
              cropY: obj.cropY,
              flipX: obj.flipX,
              flipY: obj.flipY,
              skewX: obj.skewX,
              skewY: obj.skewY,
            }

            if (typeof obj.setSrc === 'function') {
              await obj.setSrc(imageUrl, { crossOrigin: 'anonymous' })
            }
            if (isPrimaryStale) {
              fitImageToCanvas(obj, replacement, canvasSize)
            } else {
              restoreImageGeometry(obj, geometry, replacement)
            }
            obj.setCoords()
          } catch (err) {
            console.warn('[canvas-history] hydrate image failed:', err)
          }
        })
    )
  }

  for (const obj of objects.filter((item) => item?.type?.toLowerCase() === 'image')) {
    restoreSerializedMask(FabricImage, obj)
  }

  canvas.requestRenderAll()
}

export async function restoreCanvasFromHistory(canvas, state, { imageUrl, setViewportState, fallbackCenter, hydrateOptions } = {}) {
  if (!canvas || !state) return

  const nextState = normalizeCanvasState(state)
  await canvas.loadFromJSON(nextState.canvas || nextState)

  if (nextState.viewport && setViewportState) {
    setViewportState(canvas, nextState.viewport, fallbackCenter)
  }

  await hydrateCanvasImages(canvas, imageUrl, hydrateOptions)

  for (const obj of canvas.getObjects?.() || []) {
    if (obj?.type?.toLowerCase() === 'image' && obj.filters?.length) {
      try {
        obj.applyFilters?.()
        obj.set?.('dirty', true)
      } catch (err) {
        console.warn('[canvas-history] reapply filters failed:', err)
      }
    }
  }

  canvas.calcOffset()
  canvas.requestRenderAll()
}
