"use client"

import { useEffect, useRef, useCallback } from "react"

/**
 * Global keyboard shortcut hook for the Pixxel editor.
 *
 * Immediately bypasses shortcut logic when the user is typing inside
 * an <input>, <textarea>, or contentEditable element.
 *
 * Industry-standard keybindings inspired by Adobe Photoshop:
 *   V  → Selection/Move tool
 *   M  → Marquee/Selection tool (masking operations)
 *   H  → Hand/Pan tool
 *   Z  → Zoom tool (maps clicks to canvas.zoomToPoint())
 *   G  → Generative Expand tool
 *   A  → ImageKit Agent
 *   B  → Brush/Masking tool
 *   [  → Decrease brush size
 *   ]  → Increase brush size
 *   Cmd/Ctrl + Z         → Undo
 *   Cmd/Ctrl + Shift + Z → Redo
 *   Cmd/Ctrl + K         → Command Palette
 *   Spacebar (hold)      → Temporary pan override
 *   +  → Zoom in
 *   -  → Zoom out
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

const useEditorShortcuts = (canvasEditor, activeTool, onToolChange, onToggleCommandPalette) => {
    const previousToolRef = useRef(null)
    const spaceHeldRef = useRef(false)

    const handleKeyDown = useCallback(
        (event) => {
            // Never intercept shortcuts when the user is typing
            if (isTypingContext()) return

            const key = event.key
            const metaOrCtrl = event.metaKey || event.ctrlKey

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

            // ─── Command Palette (Cmd/Ctrl + K) ───
            if (metaOrCtrl && key === "k") {
                event.preventDefault()
                onToggleCommandPalette?.()
                return
            }

            // ─── Zoom in/out (Cmd/Ctrl + = / -) ───
            if (metaOrCtrl && (key === "=" || key === "+")) {
                event.preventDefault()
                if (canvasEditor) {
                    const center = canvasEditor.getCenterPoint()
                    const currentZoom = canvasEditor.getZoom()
                    const newZoom = Math.min(20, currentZoom + ZOOM_STEP)
                    canvasEditor.zoomToPoint(center, newZoom)
                    canvasEditor.requestRenderAll()
                }
                return
            }

            if (metaOrCtrl && key === "-") {
                event.preventDefault()
                if (canvasEditor) {
                    const center = canvasEditor.getCenterPoint()
                    const currentZoom = canvasEditor.getZoom()
                    const newZoom = Math.max(0.1, currentZoom - ZOOM_STEP)
                    canvasEditor.zoomToPoint(center, newZoom)
                    canvasEditor.requestRenderAll()
                }
                return
            }

            // Ignore key combos beyond this point
            if (metaOrCtrl || event.altKey) return

            // ─── Spacebar hold → temporary pan (not during AI Extender) ───
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

            // ─── Zoom with +/- keys (without Cmd) when Z tool is active ───
            if (key === "+" || key === "=") {
                event.preventDefault()
                if (canvasEditor) {
                    const center = canvasEditor.getCenterPoint()
                    const currentZoom = canvasEditor.getZoom()
                    canvasEditor.zoomToPoint(center, Math.min(20, currentZoom + ZOOM_STEP))
                    canvasEditor.requestRenderAll()
                }
                return
            }

            if (key === "-") {
                event.preventDefault()
                if (canvasEditor) {
                    const center = canvasEditor.getCenterPoint()
                    const currentZoom = canvasEditor.getZoom()
                    canvasEditor.zoomToPoint(center, Math.max(0.1, currentZoom - ZOOM_STEP))
                    canvasEditor.requestRenderAll()
                }
                return
            }

            // ─── Tool switching ───
            switch (key.toLowerCase()) {
                case "v":
                    event.preventDefault()
                    onToolChange?.("resize") // Selection/Move — maps to existing "resize" as default
                    break
                case "m":
                    event.preventDefault()
                    onToolChange?.("crop") // Marquee/Selection — maps to "crop" for selection-based operations
                    break
                case "h":
                    event.preventDefault()
                    onToolChange?.("hand")
                    break
                case "z":
                    event.preventDefault()
                    onToolChange?.("zoom")
                    break
                case "g":
                    event.preventDefault()
                    onToolChange?.("ai_extender")
                    break
                case "a":
                    event.preventDefault()
                    onToolChange?.("ai_agent")
                    break
                case "b":
                    event.preventDefault()
                    onToolChange?.("brush")
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
