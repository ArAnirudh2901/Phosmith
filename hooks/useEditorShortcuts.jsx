"use client"

import { useEffect, useRef, useCallback } from "react"
import { ActiveSelection } from "fabric"

/**
 * Global keyboard shortcut hook for the Pixxel editor.
 *
 * Immediately bypasses shortcut logic when the user is typing inside
 * an <input>, <textarea>, or contentEditable element.
 *
 * Keybindings:
 *   V  → Selection/Move (Resize)
 *   C  → Crop
 *   I  → Images
 *   A  → Adjust
 *   D  → Draw
 *   T  → Text
 *   G  → Generative Extend (AI Extender)
 *   B  → AI Background
 *   E  → AI Edit
 *   Q  → Agent
 *   [  → Decrease brush size
 *   ]  → Increase brush size
 *   Delete/Backspace → Delete selected object
 *   Enter            → Enter editing mode (text) / Deselect
 *   Escape           → Deselect / Exit editing mode
 *   Cmd/Ctrl + Z     → Undo
 *   Cmd/Ctrl + Shift + Z → Redo
 *   Cmd/Ctrl + K     → Command Palette
 *   Cmd/Ctrl + S     → Save
 *   Cmd/Ctrl + D     → Duplicate
 *   Cmd/Ctrl + A     → Select all
 *   Spacebar (hold)  → Temporary pan override
 *   +  → Zoom in
 *   -  → Zoom out
 *   0  → Reset view
 */

const INTERACTIVE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"])
const BRUSH_STEP = 2
const MIN_BRUSH_WIDTH = 1
const MAX_BRUSH_WIDTH = 200
const ZOOM_STEP = 0.15

const isTypingContext = () => {
    if (typeof document === 'undefined') return false
    const el = document.activeElement
    if (!el) return false
    if (INTERACTIVE_TAGS.has(el.tagName)) return true
    if (el.isContentEditable) return true
    return false
}

const isTextObject = (obj) => {
    const t = obj?.type?.toLowerCase()
    return t === 'i-text' || t === 'textbox' || t === 'text'
}

const useEditorShortcuts = (canvasEditor, activeTool, onToolChange, onToggleCommandPalette) => {
    const previousToolRef = useRef(null)
    const spaceHeldRef = useRef(false)

    const handleKeyDown = useCallback(
        (event) => {
            const key = event.key
            const metaOrCtrl = event.metaKey || event.ctrlKey
            const activeObject = canvasEditor?.getActiveObject?.()
            const isEditing = activeObject?.isEditing

            // ─── Always-active shortcuts (work even while typing) ───

            // Cmd/Ctrl + K → Command Palette
            if (metaOrCtrl && key === "k") {
                event.preventDefault()
                onToggleCommandPalette?.()
                return
            }

            // Cmd/Ctrl + S → Save
            if (metaOrCtrl && key === "s") {
                event.preventDefault()
                canvasEditor?.__saveCanvasState?.()
                return
            }

            // Escape → exit editing / deselect
            if (key === "Escape") {
                if (isEditing) {
                    activeObject.exitEditing()
                    canvasEditor?.requestRenderAll()
                } else if (activeObject) {
                    canvasEditor?.discardActiveObject()
                    canvasEditor?.requestRenderAll()
                }
                return
            }

            // Don't process further shortcuts when typing in inputs
            if (isTypingContext()) return

            // ─── Undo / Redo ───
            if (metaOrCtrl && key === "z") {
                event.preventDefault()
                if (event.shiftKey) {
                    canvasEditor?.__redoCanvasState?.()
                } else {
                    canvasEditor?.__undoCanvasState?.()
                }
                return
            }

            // ─── Cmd/Ctrl + D → Duplicate ───
            if (metaOrCtrl && key === "d") {
                event.preventDefault()
                if (activeObject && canvasEditor) {
                    activeObject.clone().then((cloned) => {
                        cloned.set({ left: (cloned.left || 0) + 20, top: (cloned.top || 0) + 20 })
                        cloned.setCoords()
                        canvasEditor.add(cloned)
                        canvasEditor.setActiveObject(cloned)
                        canvasEditor.requestRenderAll()
                        canvasEditor.__pushHistoryState?.()
                    }).catch(() => {})
                }
                return
            }

            // ─── Cmd/Ctrl + A → Select all ───
            if (metaOrCtrl && key === "a") {
                event.preventDefault()
                if (canvasEditor && !isEditing) {
                    const objects = canvasEditor.getObjects()
                    if (objects.length > 0) {
                        canvasEditor.discardActiveObject()
                        const sel = new ActiveSelection(objects, { canvas: canvasEditor })
                        canvasEditor.setActiveObject(sel)
                        canvasEditor.requestRenderAll()
                    }
                }
                return
            }

            // ─── Zoom in/out (Cmd/Ctrl + = / -) ───
            if (metaOrCtrl && (key === "=" || key === "+")) {
                event.preventDefault()
                if (canvasEditor) {
                    const center = canvasEditor.getCenterPoint()
                    const currentZoom = canvasEditor.getZoom()
                    canvasEditor.zoomToPoint(center, Math.min(20, currentZoom + ZOOM_STEP))
                    canvasEditor.requestRenderAll()
                }
                return
            }

            if (metaOrCtrl && key === "-") {
                event.preventDefault()
                if (canvasEditor) {
                    const center = canvasEditor.getCenterPoint()
                    const currentZoom = canvasEditor.getZoom()
                    canvasEditor.zoomToPoint(center, Math.max(0.1, currentZoom - ZOOM_STEP))
                    canvasEditor.requestRenderAll()
                }
                return
            }

            // ─── Cmd/Ctrl + 0 → Reset view ───
            if (metaOrCtrl && key === "0") {
                event.preventDefault()
                canvasEditor?.__resetCanvasView?.()
                return
            }

            // Ignore remaining key combos with modifier
            if (metaOrCtrl || event.altKey) return

            // ─── Delete / Backspace → Delete selected object ───
            if (key === "Delete" || key === "Backspace") {
                if (activeObject && !isEditing && canvasEditor) {
                    event.preventDefault()
                    canvasEditor.remove(activeObject)
                    canvasEditor.discardActiveObject()
                    canvasEditor.requestRenderAll()
                    canvasEditor.__pushHistoryState?.()
                }
                return
            }

            // ─── Enter → enter text editing or deselect ───
            if (key === "Enter" && !event.shiftKey) {
                if (activeObject && isTextObject(activeObject) && !isEditing) {
                    event.preventDefault()
                    activeObject.enterEditing()
                    activeObject.selectAll()
                    canvasEditor?.requestRenderAll()
                }
                return
            }

            // ─── Spacebar hold → temporary pan ───
            if (key === " " && !event.repeat) {
                event.preventDefault()
                if (activeTool === 'ai_extender') return
                if (!spaceHeldRef.current) {
                    spaceHeldRef.current = true
                    previousToolRef.current = activeTool
                    onToolChange?.("hand")
                }
                return
            }

            // ─── Brush size adjustment ───
            if (key === "[" || key === "]") {
                event.preventDefault()
                if (canvasEditor?.freeDrawingBrush) {
                    const currentWidth = canvasEditor.freeDrawingBrush.width || 10
                    const delta = key === "[" ? -BRUSH_STEP : BRUSH_STEP
                    canvasEditor.freeDrawingBrush.width = Math.max(
                        MIN_BRUSH_WIDTH,
                        Math.min(MAX_BRUSH_WIDTH, currentWidth + delta)
                    )
                }
                return
            }

            // ─── Zoom with +/- keys ───
            if (key === "+" || key === "=") {
                event.preventDefault()
                if (canvasEditor) {
                    const center = canvasEditor.getCenterPoint()
                    canvasEditor.zoomToPoint(center, Math.min(20, canvasEditor.getZoom() + ZOOM_STEP))
                    canvasEditor.requestRenderAll()
                }
                return
            }
            if (key === "-") {
                event.preventDefault()
                if (canvasEditor) {
                    const center = canvasEditor.getCenterPoint()
                    canvasEditor.zoomToPoint(center, Math.max(0.1, canvasEditor.getZoom() - ZOOM_STEP))
                    canvasEditor.requestRenderAll()
                }
                return
            }

            // ─── 0 → Reset view ───
            if (key === "0") {
                event.preventDefault()
                canvasEditor?.__resetCanvasView?.()
                return
            }

            // ─── Tool switching ───
            switch (key.toLowerCase()) {
                case "v":
                    event.preventDefault()
                    onToolChange?.("resize")
                    break
                case "c":
                    event.preventDefault()
                    onToolChange?.("crop")
                    break
                case "i":
                    event.preventDefault()
                    onToolChange?.("images")
                    break
                case "a":
                    event.preventDefault()
                    onToolChange?.("adjust")
                    break
                case "d":
                    event.preventDefault()
                    onToolChange?.("draw")
                    break
                case "t":
                    event.preventDefault()
                    onToolChange?.("text")
                    break
                case "g":
                    event.preventDefault()
                    onToolChange?.("ai_extender")
                    break
                case "b":
                    event.preventDefault()
                    onToolChange?.("ai_background")
                    break
                case "e":
                    event.preventDefault()
                    onToolChange?.("ai_edit")
                    break
                case "q":
                    event.preventDefault()
                    onToolChange?.("ai_agent")
                    break
                default:
                    break
            }
        },
        [canvasEditor, activeTool, onToolChange, onToggleCommandPalette]
    )

    const handleKeyUp = useCallback(
        (event) => {
            // ─── Spacebar release → restore previous tool ───
            if (event.key === " " && spaceHeldRef.current) {
                event.preventDefault()
                spaceHeldRef.current = false
                const restoreTo = previousToolRef.current || "resize"
                previousToolRef.current = null
                onToolChange?.(restoreTo)
            }
        },
        [onToolChange]
    )

    useEffect(() => {
        window.addEventListener("keydown", handleKeyDown)
        window.addEventListener("keyup", handleKeyUp)

        return () => {
            window.removeEventListener("keydown", handleKeyDown)
            window.removeEventListener("keyup", handleKeyUp)
        }
    }, [handleKeyDown, handleKeyUp])
}

export default useEditorShortcuts
