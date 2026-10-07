import { isPhosmithMaskOverlay } from '@/lib/canvas-mask'

export const isMaskOverlay = (obj) => isPhosmithMaskOverlay(obj)

export const isTypingTarget = () => {
    if (typeof document === 'undefined') return false
    const el = document.activeElement
    if (!el) return false
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    return Boolean(el.isContentEditable)
}

export const commitMaskChange = (canvasEditor, img) => {
    if (!canvasEditor) return
    img?.set?.('dirty', true)
    if (img) canvasEditor.fire?.('object:modified', { target: img })
    canvasEditor.requestRenderAll()
    canvasEditor.__pushHistoryState?.({ label: 'Painted mask', domain: 'mask', coalesceKey: 'mask-brush' })
    canvasEditor.__saveCanvasState?.()
}
