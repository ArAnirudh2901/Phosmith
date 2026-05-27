import { FabricImage } from 'fabric'
import { toast } from 'sonner'

const CASCADE_OFFSET = 32

// Reads a File/Blob as a data URL. Kept as a last-resort fallback for the rare
// case where the ImageKit upload fails — at least the image stays usable in the
// current session. Data URLs balloon the saved canvas state, so we avoid them
// when we can (Convex documents are capped at 1 MB).
const readFileAsDataURL = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })

// Uploads to our /api/imagekit/upload endpoint (auth-gated) and returns the CDN URL.
// This is the path that keeps saved canvas state small enough for Convex's per-doc
// size limit when users add several photos to one project.
const uploadFileToImageKit = async (file) => {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('fileName', file.name || 'upload')
  const response = await fetch('/api/imagekit/upload', {
    method: 'POST',
    body: formData,
  })
  if (!response.ok) {
    throw new Error(`ImageKit upload failed: ${response.status}`)
  }
  const data = await response.json()
  if (!data?.success || !data?.url) {
    throw new Error(data?.error || 'ImageKit upload returned no URL')
  }
  return data.url
}

export const loadFabricImageFromFile = async (file, { silent = false } = {}) =>
  loadFabricImage(file, { silent })

const loadFabricImage = async (file, { silent }) => {
  // Try ImageKit first — small URL, persistent, CDN-served.
  try {
    const url = await uploadFileToImageKit(file)
    return await FabricImage.fromURL(url, { crossOrigin: 'anonymous' })
  } catch (uploadError) {
    console.warn('[canvas-images] ImageKit upload failed, falling back to data URL:', uploadError)
    if (!silent) {
      toast.warning('Upload service unavailable — image saved locally; refresh may not restore it.')
    }
    const dataUrl = await readFileAsDataURL(file)
    return await FabricImage.fromURL(dataUrl, { crossOrigin: 'anonymous' })
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

  if (!file.type.startsWith('image/')) {
    toast.error('Only image files are supported')
    return false
  }
  if (file.size > 25 * 1024 * 1024) {
    toast.error('Image must be under 25 MB')
    return false
  }

  const { silent = false, stackIndex } = options
  const toastId = silent ? null : toast.loading('Adding image...')
  try {
    const img = await loadFabricImage(file, { silent })
    const resolvedStackIndex =
      typeof stackIndex === 'number' ? stackIndex : countExistingImages(canvasEditor)
    fitNewImageToProject(img, project, { stackIndex: resolvedStackIndex })
    canvasEditor.add(img)
    canvasEditor.setActiveObject(img)
    canvasEditor.requestRenderAll()
    if (!silent) {
      canvasEditor.__pushHistoryState?.()
      canvasEditor.__saveCanvasState?.()
      toast.success('Image added', { id: toastId })
    }
    return img
  } catch (err) {
    if (toastId) toast.error('Failed to load image', { id: toastId })
    else toast.error('Failed to load image')
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
    canvasEditor.__pushHistoryState?.()
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
