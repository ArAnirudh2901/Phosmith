import { isPhosmithMaskOverlay } from './canvas-mask'

// Paint lock for Mask/Erase: selection off, crosshair on. State lives on the canvas
// so the sidebar can take it synchronously and the lazy panel adopt it — otherwise
// an early drag moves the image while the panel chunk loads.

const STATE = '__phosmithPixelToolLock'

export const isPixelToolLocked = (canvas) => Boolean(canvas?.[STATE])

export function lockPixelTool(canvas, targetImage) {
    if (!canvas) return
    const existing = canvas[STATE]
    if (existing) {
        // Sidebar locks before knowing the target image; panel names it later.
        if (targetImage && !existing.activeObject) existing.activeObject = targetImage
        return
    }

    const objects = canvas.getObjects?.() || []
    canvas[STATE] = {
        activeObject: targetImage || canvas.getActiveObject?.() || null,
        selection: canvas.selection,
        skipTargetFind: canvas.skipTargetFind,
        defaultCursor: canvas.defaultCursor,
        hoverCursor: canvas.hoverCursor,
        moveCursor: canvas.moveCursor,
        isDrawingMode: canvas.isDrawingMode,
        objectStates: objects.map((obj) => ({
            obj,
            selectable: obj.selectable,
            evented: obj.evented,
            hoverCursor: obj.hoverCursor,
            moveCursor: obj.moveCursor,
        })),
    }

    canvas.discardActiveObject?.()
    canvas.__pixelToolActive = true
    canvas.selection = false
    canvas.skipTargetFind = true
    canvas.isDrawingMode = false
    canvas.defaultCursor = 'crosshair'
    canvas.hoverCursor = 'crosshair'
    canvas.moveCursor = 'crosshair'
    if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = 'crosshair'

    for (const obj of objects) {
        if (isPhosmithMaskOverlay(obj)) continue
        obj.set?.({ selectable: false, evented: false, hoverCursor: 'crosshair', moveCursor: 'crosshair' })
    }
    canvas.requestRenderAll()
}

export function unlockPixelTool(canvas) {
    const state = canvas?.[STATE]
    if (!state) return

    canvas.selection = state.selection
    canvas.skipTargetFind = state.skipTargetFind
    canvas.defaultCursor = state.defaultCursor
    canvas.hoverCursor = state.hoverCursor
    canvas.moveCursor = state.moveCursor
    canvas.isDrawingMode = state.isDrawingMode

    for (const item of state.objectStates) {
        if (!canvas.getObjects?.().includes(item.obj)) continue
        item.obj.set?.({
            selectable: item.selectable,
            evented: item.evented,
            hoverCursor: item.hoverCursor,
            moveCursor: item.moveCursor,
        })
    }

    canvas.__pixelToolActive = false
    if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = state.defaultCursor || 'default'
    canvas.discardActiveObject?.()
    if (state.activeObject && canvas.getObjects?.().includes(state.activeObject)) {
        try { canvas.setActiveObject(state.activeObject) } catch { /* no longer selectable */ }
    }
    canvas.requestRenderAll()
    canvas[STATE] = null
}
