import { FabricImage } from 'fabric'
import { toast } from 'sonner'
import { stripImageMetadata } from '@/lib/strip-metadata'
import { flattenOrientation, isRawFile, readImageMeta, resolveSourceFile } from '@/lib/raw-preview'
import { IMAGEKIT_MAX_EDGE, IMAGEKIT_MAX_MP } from '@/lib/canvas-limits'
import { uploadToImageKit } from '@/lib/imagekit-upload'

const CASCADE_OFFSET = 32

// Reads a File/Blob as a data URL. Kept as a last-resort fallback for the rare
// case where the ImageKit upload fails — at least the image stays usable in the
// current session. Data URLs balloon the saved canvas state, so we avoid them
// when we can (Neon documents are capped at 1 MB).
const readFileAsDataURL = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })

// ImageKit rejects images above 25 MP on serving ("ELIMIT"). We downscale
// anything above 24 MP (safety margin) through an offscreen canvas so the
// uploaded image is always servable.
const MAX_EDGE = IMAGEKIT_MAX_EDGE

// A 50 MP DSLR JPEG at camera quality runs 25-45 MB, and `downscaleIfNeeded`
// already bounds the PIXELS, so the byte cap only needs to stop pathological
// files. RAW keeps its own, larger ceiling.
const MAX_IMAGE_BYTES = 64 * 1024 * 1024

// Orientation from the file, colours converted to the display space: both are
// implementation-defined defaults across engines, and a wrong guess shows up as
// a sideways portrait or a washed-out AdobeRGB frame.
const DECODE_OPTS = { imageOrientation: 'from-image', colorSpaceConversion: 'default' }

/**
 * Normalise a file the canvas is about to own. EXIF is stripped before upload, so
 * an orientation tag has to become pixels first or every portrait shot from a
 * camera is served sideways. CMYK/YCCK JPEGs are refused: browsers either fail
 * the decode or render them inverted, and silently importing one is worse.
 */
const prepareForCanvas = async (file) => {
  if (!file?.type?.startsWith('image/')) return file
  const meta = await readImageMeta(file)
  if (meta?.components === 4) {
    const err = new Error('UNSUPPORTED_COLOR')
    err.code = 'UNSUPPORTED_COLOR'
    throw err
  }
  if (!meta?.orientation || meta.orientation === 1) return file
  const rotated = await flattenOrientation(file, file.type)
  if (!rotated || rotated === file) return file
  return new File([rotated], file.name, { type: rotated.type || file.type, lastModified: Date.now() })
}

// Encode a resized bitmap to a Blob (OffscreenCanvas off the main thread where
// available, else a DOM canvas). Returns null on failure.
const encodeResized = async (bitmap, nw, nh, type) => {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(nw, nh)
    : Object.assign(document.createElement('canvas'), { width: nw, height: nh })
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, nw, nh)
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality: 0.92 })
  return new Promise((res) => canvas.toBlob(res, type, 0.92))
}

// Downscale anything above ImageKit's serving limits. Reads dimensions from the
// header (512 KB) and resizes via createImageBitmap — a hardware-decoded,
// off-main-thread path — so a 50 MP DSLR frame never freezes the tab the way a
// synchronous <img> decode + canvas draw did.
const downscaleIfNeeded = async (file) => {
  if (!file?.type?.startsWith('image/')) return file // canvas blobs are pre-sized

  const meta = await readImageMeta(file)
  let w = meta?.w || 0
  let h = meta?.h || 0
  let probe = null
  if (!w || !h) {
    // Unknown header — decode once off-thread to learn the size.
    probe = await createImageBitmap(file, DECODE_OPTS).catch(() => null)
    if (!probe) return file
    w = probe.width
    h = probe.height
  }

  if (w * h <= IMAGEKIT_MAX_MP && w <= MAX_EDGE && h <= MAX_EDGE) {
    probe?.close?.()
    return file // within limits — use original
  }

  // Target dims (proportional)
  let nw = w, nh = h
  if (nw > MAX_EDGE || nh > MAX_EDGE) {
    const s = MAX_EDGE / Math.max(nw, nh)
    nw = Math.round(nw * s); nh = Math.round(nh * s)
  }
  if (nw * nh > IMAGEKIT_MAX_MP) {
    const s = Math.sqrt(IMAGEKIT_MAX_MP / (nw * nh))
    nw = Math.round(nw * s); nh = Math.round(nh * s)
  }

  try {
    // Explicit dest dims keep it correct where resizeWidth is ignored (older Safari).
    const bitmap = probe || await createImageBitmap(file, { ...DECODE_OPTS, resizeWidth: nw, resizeHeight: nh, resizeQuality: 'high' })
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    const blob = await encodeResized(bitmap, nw, nh, type)
    bitmap.close?.()
    if (!blob) return file
    return new File([blob], file.name, { type: blob.type, lastModified: Date.now() })
  } catch {
    probe?.close?.()
    return file // fall back to original — ImageKit may reject, but no freeze
  }
}

/**
 * Ask ImageKit for a variant no larger than `maxEdge` on its long side.
 *
 * The point is memory, not bandwidth: a collage holding eight 6000×4000 frames
 * decodes to ~770 MB of RGBA, which is how a tab dies mid-edit on a phone. A
 * photo can never need more than the project's long edge times the largest export
 * scale, so that is what gets fetched — and because the transform lives in the
 * URL, the saved canvas reloads the same pixels.
 */
export const imagekitResized = (url, maxEdge) => {
  if (!url || !maxEdge) return url
  if (!/(^https?:)?\/\/[^/]*imagekit\.io\//.test(url)) return url   // not ours to transform
  if (/[?&]tr=/.test(url)) return url
  const edge = Math.max(512, Math.min(IMAGEKIT_MAX_EDGE, Math.round(maxEdge)))
  return `${url}${url.includes('?') ? '&' : '?'}tr=w-${edge},h-${edge},c-at_max`
}

/** Long edge a photo can possibly need: the project's long edge at 3× export. */
export const workingEdgeForProject = (project) => {
  const long = Math.max(Number(project?.width) || 0, Number(project?.height) || 0)
  if (!long) return 0
  return Math.max(1024, Math.min(IMAGEKIT_MAX_EDGE, Math.ceil(long * 3)))
}

// Uploads to ImageKit (signed by our auth-gated /api/imagekit/upload) and returns
// the CDN URL. This is the path that keeps saved canvas state small enough for
// Neon's per-doc size limit when users add several photos to one project.
const uploadFileToImageKit = async (file) => {
  // Strip EXIF, GPS, XMP, IPTC — binary-level, no re-encoding
  const cleanFile = await stripImageMetadata(file)
  // Downscale if the image exceeds ImageKit's 25 MP serving limit
  const readyFile = await downscaleIfNeeded(cleanFile)
  const { url } = await uploadToImageKit(readyFile, { fileName: file.name || 'upload' })
  return url
}

// Uploads a raw image Blob (e.g. a flattened merge) to ImageKit and returns the
// CDN URL. Throws on failure so callers can fall back to a data URL.
export const uploadImageBlobToImageKit = async (blob, fileName = 'image.png') => {
  if (!blob) throw new Error('No blob to upload')
  // Strip any metadata the browser may have embedded
  const blobFile = blob instanceof File ? blob : new File([blob], fileName, { type: blob.type })
  const cleanBlob = await stripImageMetadata(blobFile)
  const { url } = await uploadToImageKit(cleanBlob, { fileName })
  return url
}

// Builds a Fabric image from a URL with an OFF-MAIN-THREAD decode. Fabric's own
// loadImage only waits on img.onload, so the JPEG decode lands on first draw and
// freezes the UI for a 12-50 MP DSLR. HTMLImageElement.decode() runs the decode
// on a background thread; awaiting it means the bitmap is ready before render.
// We keep el.src = url (not createImageBitmap) so getSrc() persists the URL —
// undo/redo and reload recreate the image from serialized src.
export const fabricImageFromUrl = async (url) => {
  try {
    const el = new Image()
    el.crossOrigin = 'anonymous'
    el.decoding = 'async'
    el.src = url
    await el.decode()
    return new FabricImage(el)
  } catch {
    // decode() can reject (some data: URLs / CORS / older engines) — fall back
    // to Fabric's own loader, which is functionally identical, just main-thread.
    return FabricImage.fromURL(url, { crossOrigin: 'anonymous' })
  }
}

export const loadFabricImageFromFile = async (file, { silent = false, maxEdge = 0 } = {}) =>
  loadFabricImage(file, { silent, maxEdge })

const loadFabricImage = async (file, { silent, maxEdge = 0 }) => {
  const sourceFile = await prepareForCanvas(await resolveSourceFile(file))
  // Try ImageKit first — small URL, persistent, CDN-served.
  try {
    const url = await uploadFileToImageKit(sourceFile)
    return await fabricImageFromUrl(imagekitResized(url, maxEdge))
  } catch (uploadError) {
    console.warn('[canvas-images] ImageKit upload failed, falling back to data URL:', uploadError)
    if (!silent) {
      toast.warning('Upload service unavailable — image saved locally; refresh may not restore it.')
    }
    const dataUrl = await readFileAsDataURL(sourceFile)
    return await fabricImageFromUrl(dataUrl)
  }
}

const countExistingImages = (canvasEditor) => {
  if (!canvasEditor?.getObjects) return 0
  return canvasEditor
    .getObjects()
    .filter((obj) => obj?.type?.toLowerCase() === 'image').length
}

export const fitNewImageToProject = (fabricImage, projectSize, options = {}) => {
  const pW = Math.max(1, projectSize?.width || 800)
  const pH = Math.max(1, projectSize?.height || 600)
  const iW = Math.max(1, fabricImage.width || 1)
  const iH = Math.max(1, fabricImage.height || 1)
  const scale = Math.min((pW * 0.6) / iW, (pH * 0.6) / iH, 1)
  const stackIndex = Math.max(0, Number(options.stackIndex) || 0)
  const offset = stackIndex * CASCADE_OFFSET

  fabricImage.set({
    left: pW / 2 + offset,
    top: pH / 2 + offset,
    originX: 'center',
    originY: 'center',
    scaleX: scale,
    scaleY: scale,
    selectable: true,
    evented: true,
  })
  fabricImage.setCoords()
}

/**
 * Add an image file to the Fabric canvas (used by topbar upload, drop, paste).
 * Pass { silent: true } when adding many images in a batch — only the batch
 * caller should push history + save.
 */
export async function addImageFileToCanvas(canvasEditor, file, project, options = {}) {
  if (!canvasEditor || !file) return false

  const raw = isRawFile(file)
  if (!file.type.startsWith('image/') && !raw) {
    toast.error('Only image files are supported')
    return false
  }
  // A RAW container is large (20–60 MB), but only its small embedded preview is
  // ever read/uploaded — so the byte cap applies to standard images only. Guard
  // RAW with a generous ceiling against pathological files.
  if (!raw && file.size > MAX_IMAGE_BYTES) {
    toast.error('Image must be under 64 MB')
    return false
  }
  if (raw && file.size > 200 * 1024 * 1024) {
    toast.error('RAW file is too large')
    return false
  }

  // Fabric draws a GIF's first frame and nothing else; better to say so than to
  // let the user wonder why their animation is still.
  if (file.type === 'image/gif' && !options.silent) {
    toast.info('GIF added as a still frame — animation is not preserved')
  }

  const { silent = false, stackIndex } = options
  const toastId = silent ? null : toast.loading('Adding image...')
  try {
    const img = await loadFabricImage(file, { silent, maxEdge: workingEdgeForProject(project) })
    const resolvedStackIndex =
      typeof stackIndex === 'number' ? stackIndex : countExistingImages(canvasEditor)
    fitNewImageToProject(img, project, { stackIndex: resolvedStackIndex })
    canvasEditor.add(img)
    canvasEditor.setActiveObject(img)
    canvasEditor.requestRenderAll()
    if (!silent) {
      canvasEditor.__pushHistoryState?.({ label: 'Added image', domain: 'images' })
      canvasEditor.__saveCanvasState?.()
      toast.success('Image added', { id: toastId })
    }
    return img
  } catch (err) {
    const msg = err?.code === 'UNSUPPORTED_COLOR'
      ? 'This JPEG is CMYK (print colour). Convert it to sRGB and try again.'
      : err?.message === 'RAW_NO_PREVIEW'
        ? 'This RAW has no embedded preview to import'
        : 'Failed to load image'
    if (toastId) toast.error(msg, { id: toastId })
    else toast.error(msg)
    console.error('[canvas-images] Load error:', err)
    return false
  }
}

/**
 * Add many image files at once. Adds them sequentially with a cascade offset
 * and only pushes a single history state at the end.
 */
export async function addImageFilesToCanvas(canvasEditor, files, project) {
  if (!canvasEditor || !files?.length) return 0
  const baseIndex = countExistingImages(canvasEditor)
  const toastId = toast.loading(
    files.length === 1 ? 'Adding image...' : `Adding ${files.length} images...`
  )
  let added = 0
  for (let i = 0; i < files.length; i++) {
    const result = await addImageFileToCanvas(canvasEditor, files[i], project, {
      silent: true,
      stackIndex: baseIndex + i,
    })
    if (result) added += 1
  }
  if (added > 0) {
    canvasEditor.__pushHistoryState?.({ label: 'Added images', domain: 'images', detail: `${added} images` })
    canvasEditor.__saveCanvasState?.()
  }
  if (added === files.length) {
    toast.success(added === 1 ? 'Image added' : `${added} images added`, { id: toastId })
  } else if (added > 0) {
    toast.warning(`Added ${added} of ${files.length} images`, { id: toastId })
  } else {
    toast.error('No images were added', { id: toastId })
  }
  return added
}
