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

// History push + save for mask edits, coalesced: one serialisation once the
// brush has been still for COMMIT_IDLE_MS, in an idle slot. It used to run per
// stroke, three times over (event-driven push, explicit push, save), each one
// encoding the full-res mask — ~1.3 s of main thread after every stroke at 24 MP.
const COMMIT_IDLE_MS = 300

const idle = (fn) => (typeof requestIdleCallback === 'function'
    ? { id: requestIdleCallback(fn, { timeout: 1000 }), idle: true }
    : { id: setTimeout(fn, 0), idle: false })
const cancel = (handle) => {
    if (!handle) return
    if (handle.idle) cancelIdleCallback(handle.id)
    else clearTimeout(handle.id)
}

export const flushMaskCommit = (canvasEditor) => {
    const pending = canvasEditor?.__phosmithMaskCommit
    if (!pending?.img) return
    clearTimeout(pending.timer)
    cancel(pending.idle)
    const { img, label } = pending
    canvasEditor.__phosmithMaskCommit = null
    // Listeners (agent snapshot, collage) still hear about the edit; the
    // history/autosave handler skips it because the push below covers it.
    canvasEditor.fire?.('object:modified', { target: img, phosmithMaskCommit: true })
    canvasEditor.__pushHistoryState?.({ label, domain: 'mask', coalesceKey: 'mask-brush' })
    canvasEditor.__saveCanvasState?.()
}

export const commitMaskChange = (canvasEditor, img, { label = 'Painted mask' } = {}) => {
    if (!canvasEditor) return
    img?.set?.('dirty', true)
    canvasEditor.requestRenderAll()
    const pending = canvasEditor.__phosmithMaskCommit
    if (pending && pending.img !== img) flushMaskCommit(canvasEditor)
    const next = canvasEditor.__phosmithMaskCommit || { img, label }
    clearTimeout(next.timer)
    cancel(next.idle)
    next.img = img
    next.label = label
    next.timer = setTimeout(() => { next.idle = idle(() => flushMaskCommit(canvasEditor)) }, COMMIT_IDLE_MS)
    canvasEditor.__phosmithMaskCommit = next
}
