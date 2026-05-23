import { FabricImage } from 'fabric'
import { toast } from 'sonner'

export const fitNewImageToProject = (fabricImage, projectSize) => {
  const pW = Math.max(1, projectSize?.width || 800)
  const pH = Math.max(1, projectSize?.height || 600)
  const iW = Math.max(1, fabricImage.width || 1)
  const iH = Math.max(1, fabricImage.height || 1)
  const scale = Math.min((pW * 0.6) / iW, (pH * 0.6) / iH, 1)

  fabricImage.set({
    left: pW / 2,
    top: pH / 2,
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
 */
export async function addImageFileToCanvas(canvasEditor, file, project) {
  if (!canvasEditor || !file) return false

  if (!file.type.startsWith('image/')) {
    toast.error('Only image files are supported')
    return false
  }
  if (file.size > 25 * 1024 * 1024) {
    toast.error('Image must be under 25 MB')
    return false
  }

  const toastId = toast.loading('Adding image...')
  try {
    const url = URL.createObjectURL(file)
    const img = await FabricImage.fromURL(url, { crossOrigin: 'anonymous' })
    fitNewImageToProject(img, project)
    canvasEditor.add(img)
    canvasEditor.setActiveObject(img)
    canvasEditor.requestRenderAll()
    canvasEditor.__pushHistoryState?.()
    canvasEditor.__saveCanvasState?.()
    toast.success('Image added', { id: toastId })
    return true
  } catch (err) {
    toast.error('Failed to load image', { id: toastId })
    console.error('[canvas-images] Load error:', err)
    return false
  }
}
