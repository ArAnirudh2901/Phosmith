// Background helpers for the AI Background tool.
//
// Design constraints (keep the app robust + saves small):
//  • The canvas background is Fabric's `canvas.backgroundImage`, kept backed by a
//    REMOTE URL — never a rasterized data URL — so serialized state stays under
//    Neon's 1 MB document cap.
//  • "Exactly the canvas size" = cover-crop the source via cropX/cropY + width/
//    height + scale so the background fills the project rect (0,0 → W,H) with no
//    overflow and no distortion, while still referencing the original URL.
//  • Merging flattens the background + photo layer(s) into ONE image, uploaded to
//    ImageKit (URL, not data URL). Non-image layers (text, drawings) stay editable.
//  • Color grading can optionally mirror the foreground photo's filters onto the
//    background (a single, change-detected sync — safe with the Canvas2D filter
//    backend this app uses).

import { isPixxelMaskOverlay } from './canvas-mask'
import { uploadImageBlobToImageKit } from './canvas-images'

const isImageObject = (obj) => obj?.type?.toLowerCase?.() === 'image'

const MAX_MERGE_DIMENSION = 4096

export const getForegroundImages = (canvasEditor) =>
  (canvasEditor?.getObjects?.() || []).filter(
    (obj) => isImageObject(obj) && obj.visible !== false && !isPixxelMaskOverlay(obj),
  )

export const hasCanvasBackground = (canvasEditor) => {
  if (!canvasEditor) return false
  const color = canvasEditor.backgroundColor
  const hasColor = typeof color === 'string' && color !== '' && color !== 'transparent'
  return Boolean(canvasEditor.backgroundImage) || hasColor
}

/**
 * Size a FabricImage to fill exactly the canvas rect (0,0 → W,H) using cover-crop
 * (centered, no distortion, no overflow). The image keeps its original src.
 */
export const fitBackgroundToCanvasExactly = (fabricImage, canvasW, canvasH) => {
  const imgW = Math.max(
    1,
    Math.round(fabricImage.width || fabricImage._originalElement?.naturalWidth || canvasW || 1),
  )
  const imgH = Math.max(
    1,
    Math.round(fabricImage.height || fabricImage._originalElement?.naturalHeight || canvasH || 1),
  )
  const W = Math.max(1, Math.round(canvasW || imgW))
  const H = Math.max(1, Math.round(canvasH || imgH))

  const scale = Math.max(W / imgW, H / imgH) // cover
  const srcW = Math.max(1, Math.min(imgW, Math.round(W / scale)))
  const srcH = Math.max(1, Math.min(imgH, Math.round(H / scale)))

  fabricImage.set({
    cropX: Math.max(0, Math.round((imgW - srcW) / 2)),
    cropY: Math.max(0, Math.round((imgH - srcH) / 2)),
    width: srcW,
    height: srcH,
    scaleX: W / srcW,
    scaleY: H / srcH,
    left: 0,
    top: 0,
    originX: 'left',
    originY: 'top',
    selectable: false,
    evented: false,
  })
  fabricImage.setCoords?.()
  return fabricImage
}

/**
 * Load a URL and set it as the canvas background, sized exactly to the canvas.
 * Re-applies the grade mirror if it's currently enabled.
 */
export const applyCanvasSizedBackground = async (canvasEditor, FabricImage, url, project) => {
  if (!canvasEditor || !url) return null
  const isLocal = url.startsWith('data:') || url.startsWith('blob:')
  const fabricImage = await FabricImage.fromURL(url, {
    crossOrigin: isLocal ? undefined : 'anonymous',
  })
  const W = project?.width || canvasEditor.getWidth?.() || fabricImage.width
  const H = project?.height || canvasEditor.getHeight?.() || fabricImage.height
  fitBackgroundToCanvasExactly(fabricImage, W, H)
  canvasEditor.backgroundColor = null
  canvasEditor.backgroundImage = fabricImage
  if (canvasEditor.__pixxelGradeBackground) syncBackgroundGrade(canvasEditor, true)
  canvasEditor.requestRenderAll()
  return fabricImage
}

const filtersSignature = (filters) => {
  if (!Array.isArray(filters) || filters.length === 0) return ''
  try {
    return JSON.stringify(
      filters.map((f) => (typeof f?.toObject === 'function' ? f.toObject() : f)),
    )
  } catch {
    return String(filters.length)
  }
}

/**
 * Mirror (or clear) the foreground photo's color-grade filters onto the canvas
 * background. Change-detected so it's a no-op when nothing changed. Safe to call
 * on every object:modified. The GL filter backend is disabled app-wide, so the
 * Canvas2D filters can be shared between objects without cross-canvas caching.
 */
export const syncBackgroundGrade = (canvasEditor, enabled, sourceImage = null) => {
  const bg = canvasEditor?.backgroundImage
  if (!bg || typeof bg.applyFilters !== 'function') return

  if (!enabled) {
    if (bg.filters && bg.filters.length) {
      bg.filters = []
      try { bg.applyFilters() } catch { /* element may be gone */ }
      canvasEditor.requestRenderAll()
    }
    bg.__pixxelGradeSig = ''
    return
  }

  // Grade from the photo that actually changed when one is provided; otherwise
  // fall back to the first foreground image.
  const foreground =
    (isImageObject(sourceImage) && sourceImage.visible !== false && !isPixxelMaskOverlay(sourceImage)
      ? sourceImage
      : null) || getForegroundImages(canvasEditor)[0]
  const filters = foreground?.filters || []
  const sig = filtersSignature(filters)
  if (bg.__pixxelGradeSig === sig) return

  bg.filters = Array.isArray(filters) ? filters.slice() : []
  try { bg.applyFilters() } catch { /* element may be gone */ }
  bg.__pixxelGradeSig = sig
  canvasEditor.requestRenderAll()
}

/**
 * Flatten the canvas background + every visible photo layer into a single image,
 * uploaded to ImageKit (falls back to a data URL only if the upload fails). Non-
 * image layers (text, drawings) are preserved on top, still editable. Returns the
 * new merged FabricImage, or null if there was nothing to merge / it failed.
 */
export const mergeBackgroundWithImages = async (canvasEditor, FabricImage, project) => {
  if (!canvasEditor) return null

  const foreground = getForegroundImages(canvasEditor)
  const bg = canvasEditor.backgroundImage
  if (foreground.length === 0 && !bg) return null

  const W = Math.max(1, Math.round(project?.width || canvasEditor.getWidth?.() || 1))
  const H = Math.max(1, Math.round(project?.height || canvasEditor.getHeight?.() || 1))
  // Cap the rasterization so a huge project doesn't blow memory; scale stays exact.
  const scale = Math.min(1, MAX_MERGE_DIMENSION / Math.max(W, H))

  const savedVpt = [...(canvasEditor.viewportTransform || [1, 0, 0, 1, 0, 0])]
  const savedW = canvasEditor.getWidth()
  const savedH = canvasEditor.getHeight()
  const previousActive = canvasEditor.getActiveObject?.()
  const hidden = []

  let mergedCanvas = null
  try {
    canvasEditor.discardActiveObject?.()
    // Hide everything that is NOT the background or a photo layer, so the flatten
    // captures only bg + images and leaves text/drawings editable on top.
    for (const obj of canvasEditor.getObjects?.() || []) {
      const keep = isImageObject(obj) && obj.visible !== false && !isPixxelMaskOverlay(obj)
      if (!keep && obj.visible !== false) {
        obj.visible = false
        hidden.push(obj)
      } else if (isPixxelMaskOverlay(obj) && obj.visible !== false) {
        obj.visible = false
        hidden.push(obj)
      }
    }

    canvasEditor.viewportTransform = [1, 0, 0, 1, 0, 0]
    canvasEditor.setDimensions({ width: W, height: H }, { backstoreOnly: false })
    canvasEditor.calcOffset()
    canvasEditor.renderAll()

    // toCanvasElement renders background + visible objects for the given region.
    mergedCanvas = canvasEditor.toCanvasElement(scale, { left: 0, top: 0, width: W, height: H })
  } finally {
    for (const obj of hidden) {
      try { obj.visible = true } catch { /* removed */ }
    }
    try {
      canvasEditor.setDimensions({ width: savedW, height: savedH }, { backstoreOnly: false })
      canvasEditor.viewportTransform = savedVpt
      canvasEditor.calcOffset()
    } catch { /* disposed */ }
    // Restore the prior selection — on success the merged image overrides this; on
    // any abort/throw below the canvas is left exactly as it was.
    if (previousActive && canvasEditor.getObjects?.().includes(previousActive)) {
      try { canvasEditor.setActiveObject(previousActive) } catch { /* not selectable */ }
    }
    canvasEditor.requestRenderAll()
  }

  if (!mergedCanvas) return null

  const blob = await new Promise((resolve) => {
    try {
      mergedCanvas.toBlob((b) => resolve(b), 'image/png')
    } catch {
      resolve(null)
    }
  })
  if (!blob) throw new Error('Could not capture the canvas to merge.')

  // A merge is DESTRUCTIVE (removes the originals), so it must end with a durable
  // remote URL. A >500KB data-URL fallback gets stripped on save and the merged
  // layer would be lost on reload — so if the upload fails we abort BEFORE touching
  // the canvas, leaving the originals + background intact.
  let mergedUrl = null
  try {
    mergedUrl = await uploadImageBlobToImageKit(blob, `merged-${project?._id || 'bg'}.png`)
  } catch (uploadError) {
    console.warn('[canvas-background] merged upload failed:', uploadError?.message || uploadError)
  }
  if (!mergedUrl) {
    throw new Error('Merge needs the image service to store the result. Please try again.')
  }

  const mergedImage = await FabricImage.fromURL(mergedUrl, { crossOrigin: 'anonymous' })

  // The merged raster represents the whole canvas rect → place at (0,0) and scale
  // back up to canvas dimensions (it was rasterized at `scale`).
  mergedImage.set({
    left: 0,
    top: 0,
    originX: 'left',
    originY: 'top',
    scaleX: W / (mergedImage.width || W),
    scaleY: H / (mergedImage.height || H),
    selectable: true,
    evented: true,
    name: 'Background + photo',
    pixxelLayerName: 'Background + photo',
  })
  mergedImage.setCoords?.()

  // Remove the source photo layers + the background, insert the merged image at the
  // bottom so any kept layers (text/drawings) remain on top.
  for (const obj of foreground) canvasEditor.remove(obj)
  canvasEditor.backgroundImage = null
  canvasEditor.backgroundColor = null
  canvasEditor.__pixxelGradeBackground = false
  if (typeof canvasEditor.insertAt === 'function') canvasEditor.insertAt(0, mergedImage)
  else canvasEditor.add(mergedImage)
  canvasEditor.setActiveObject?.(mergedImage)
  canvasEditor.requestRenderAll()
  canvasEditor.__pushHistoryState?.({ label: 'Merged background with photos', domain: 'background' })
  canvasEditor.__saveCanvasState?.()
  return mergedImage
}
