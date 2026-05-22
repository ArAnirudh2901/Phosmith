"use client"

import { CheckCheck, Crop, Maximize, RectangleHorizontal, RectangleVertical, Smartphone, Square, X } from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useCanvas } from '../../../../../../../context/context'
import { FabricImage } from 'fabric'
import { toast } from 'sonner'
import { createPortal } from 'react-dom'

const ASPECT_RATIOS = [
    { label: "Freeform", value: null, icon: Maximize },
    { label: "Square", value: 1, icon: Square, ratio: "1:1" },
    { label: "Widescreen", value: 16 / 9, icon: RectangleHorizontal, ratio: "16:9" },
    { label: "Portrait", value: 4 / 5, icon: RectangleVertical, ratio: "4:5" },
    { label: "Story", value: 9 / 16, icon: Smartphone, ratio: "9:16" },
]

const HANDLE_SIZE = 10
const MIN_CROP_PX = 20

/**
 * Convert canvas-space coordinates to screen-space DOM coordinates
 * by applying the Fabric.js viewport transform.
 */
const canvasToScreen = (canvas, cx, cy) => {
    const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
    return {
        x: cx * vpt[0] + vpt[4],
        y: cy * vpt[3] + vpt[5],
    }
}

/**
 * Get the image's position in canvas-space (no viewport transform).
 */
const getImageCanvasBounds = (image) => {
    if (!image) return null
    const scaleX = image.scaleX || 1
    const scaleY = image.scaleY || 1
    const w = (image.width || 0) * scaleX
    const h = (image.height || 0) * scaleY

    let left, top
    if (image.originX === 'center') {
        left = (image.left || 0) - w / 2
    } else {
        left = image.left || 0
    }
    if (image.originY === 'center') {
        top = (image.top || 0) - h / 2
    } else {
        top = image.top || 0
    }

    return { left, top, width: w, height: h }
}

// ─── Crop Overlay ────────────────────────────────────────────────────────────
// Renders as an HTML overlay on top of the canvas. Handles are attached
// to the crop region's borders, just like Photoshop / Canva.

const CropOverlay = ({ canvasEditor, image, cropBox, onCropChange, containerEl }) => {
    const draggingRef = useRef(null) // { type: 'move'|'handle', handle?, startMouse, startBox }

    if (!canvasEditor || !image || !cropBox || !containerEl) return null

    const imgBounds = getImageCanvasBounds(image)
    if (!imgBounds) return null

    // Convert image bounds & crop box from canvas-space to screen-space
    const imgScreen = {
        ...canvasToScreen(canvasEditor, imgBounds.left, imgBounds.top),
        w: imgBounds.width * (canvasEditor.viewportTransform?.[0] || 1),
        h: imgBounds.height * (canvasEditor.viewportTransform?.[3] || 1),
    }

    const cropScreen = {
        x: canvasToScreen(canvasEditor, cropBox.left, cropBox.top).x,
        y: canvasToScreen(canvasEditor, cropBox.left, cropBox.top).y,
        w: cropBox.width * (canvasEditor.viewportTransform?.[0] || 1),
        h: cropBox.height * (canvasEditor.viewportTransform?.[3] || 1),
    }

    const containerRect = containerEl.getBoundingClientRect()

    // Positions relative to the container
    const rel = (screenX, screenY) => ({
        left: screenX,
        top: screenY,
    })

    const cropRel = rel(cropScreen.x, cropScreen.y)
    const imgRel = rel(imgScreen.x, imgScreen.y)

    // Handle definitions: corners + edge midpoints
    const handles = [
        { id: 'tl', cx: 0, cy: 0, cursor: 'nwse-resize' },
        { id: 'tr', cx: 1, cy: 0, cursor: 'nesw-resize' },
        { id: 'bl', cx: 0, cy: 1, cursor: 'nesw-resize' },
        { id: 'br', cx: 1, cy: 1, cursor: 'nwse-resize' },
        { id: 't', cx: 0.5, cy: 0, cursor: 'ns-resize' },
        { id: 'b', cx: 0.5, cy: 1, cursor: 'ns-resize' },
        { id: 'l', cx: 0, cy: 0.5, cursor: 'ew-resize' },
        { id: 'r', cx: 1, cy: 0.5, cursor: 'ew-resize' },
    ]

    const handlePointerDown = (e, type, handleId) => {
        e.preventDefault()
        e.stopPropagation()

        const startMouse = { x: e.clientX, y: e.clientY }
        const startBox = { ...cropBox }
        const zoom = canvasEditor.viewportTransform?.[0] || 1

        draggingRef.current = { type, handle: handleId, startMouse, startBox, zoom }

        const handlePointerMove = (moveEvent) => {
            if (!draggingRef.current) return
            const { type, handle, startMouse, startBox, zoom } = draggingRef.current
            const dx = (moveEvent.clientX - startMouse.x) / zoom
            const dy = (moveEvent.clientY - startMouse.y) / zoom

            let next = { ...startBox }

            if (type === 'move') {
                next.left = startBox.left + dx
                next.top = startBox.top + dy
                // Clamp within image
                next.left = Math.max(imgBounds.left, Math.min(next.left, imgBounds.left + imgBounds.width - next.width))
                next.top = Math.max(imgBounds.top, Math.min(next.top, imgBounds.top + imgBounds.height - next.height))
            } else if (type === 'handle') {
                // Resize from handle
                if (handle.includes('l')) {
                    const newLeft = Math.max(imgBounds.left, startBox.left + dx)
                    next.width = startBox.width - (newLeft - startBox.left)
                    next.left = newLeft
                }
                if (handle.includes('r')) {
                    next.width = Math.min(startBox.width + dx, imgBounds.left + imgBounds.width - startBox.left)
                }
                if (handle.includes('t')) {
                    const newTop = Math.max(imgBounds.top, startBox.top + dy)
                    next.height = startBox.height - (newTop - startBox.top)
                    next.top = newTop
                }
                if (handle.includes('b')) {
                    next.height = Math.min(startBox.height + dy, imgBounds.top + imgBounds.height - startBox.top)
                }

                // Enforce minimum size
                if (next.width < MIN_CROP_PX) {
                    if (handle.includes('l')) next.left = startBox.left + startBox.width - MIN_CROP_PX
                    next.width = MIN_CROP_PX
                }
                if (next.height < MIN_CROP_PX) {
                    if (handle.includes('t')) next.top = startBox.top + startBox.height - MIN_CROP_PX
                    next.height = MIN_CROP_PX
                }
            }

            onCropChange(next)
        }

        const handlePointerUp = () => {
            draggingRef.current = null
            window.removeEventListener('pointermove', handlePointerMove)
            window.removeEventListener('pointerup', handlePointerUp)
        }

        window.addEventListener('pointermove', handlePointerMove)
        window.addEventListener('pointerup', handlePointerUp)
    }

    return (
        <div
            style={{
                position: 'absolute',
                inset: 0,
                zIndex: 50,
                pointerEvents: 'none',
                overflow: 'hidden',
            }}
        >
            {/* Dark overlay — 4 regions around the crop area */}
            {/* Top */}
            <div style={{
                position: 'absolute',
                left: 0, top: 0, right: 0,
                height: Math.max(0, cropRel.top),
                background: 'rgba(0,0,0,0.55)',
                pointerEvents: 'none',
            }} />
            {/* Bottom */}
            <div style={{
                position: 'absolute',
                left: 0, right: 0, bottom: 0,
                top: cropRel.top + cropScreen.h,
                background: 'rgba(0,0,0,0.55)',
                pointerEvents: 'none',
            }} />
            {/* Left */}
            <div style={{
                position: 'absolute',
                left: 0, width: Math.max(0, cropRel.left),
                top: cropRel.top,
                height: cropScreen.h,
                background: 'rgba(0,0,0,0.55)',
                pointerEvents: 'none',
            }} />
            {/* Right */}
            <div style={{
                position: 'absolute',
                left: cropRel.left + cropScreen.w,
                right: 0,
                top: cropRel.top,
                height: cropScreen.h,
                background: 'rgba(0,0,0,0.55)',
                pointerEvents: 'none',
            }} />

            {/* Crop region border — user can drag to move */}
            <div
                style={{
                    position: 'absolute',
                    left: cropRel.left,
                    top: cropRel.top,
                    width: cropScreen.w,
                    height: cropScreen.h,
                    border: '2px solid #00E5FF',
                    cursor: 'move',
                    pointerEvents: 'auto',
                    boxSizing: 'border-box',
                }}
                onPointerDown={(e) => handlePointerDown(e, 'move', null)}
            >
                {/* Rule-of-thirds grid lines */}
                <div style={{ position: 'absolute', left: '33.33%', top: 0, bottom: 0, width: 1, background: 'rgba(0,229,255,0.25)' }} />
                <div style={{ position: 'absolute', left: '66.66%', top: 0, bottom: 0, width: 1, background: 'rgba(0,229,255,0.25)' }} />
                <div style={{ position: 'absolute', top: '33.33%', left: 0, right: 0, height: 1, background: 'rgba(0,229,255,0.25)' }} />
                <div style={{ position: 'absolute', top: '66.66%', left: 0, right: 0, height: 1, background: 'rgba(0,229,255,0.25)' }} />
            </div>

            {/* Drag handles */}
            {handles.map((h) => {
                const hx = cropRel.left + cropScreen.w * h.cx - HANDLE_SIZE / 2
                const hy = cropRel.top + cropScreen.h * h.cy - HANDLE_SIZE / 2
                const isCorner = h.id.length === 2

                return (
                    <div
                        key={h.id}
                        style={{
                            position: 'absolute',
                            left: hx,
                            top: hy,
                            width: HANDLE_SIZE,
                            height: HANDLE_SIZE,
                            background: '#00E5FF',
                            border: '2px solid #fff',
                            borderRadius: isCorner ? 2 : '50%',
                            cursor: h.cursor,
                            pointerEvents: 'auto',
                            zIndex: 51,
                            boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
                        }}
                        onPointerDown={(e) => handlePointerDown(e, 'handle', h.id)}
                    />
                )
            })}

            {/* Crop dimensions label */}
            <div style={{
                position: 'absolute',
                left: cropRel.left + cropScreen.w / 2,
                top: cropRel.top + cropScreen.h + 8,
                transform: 'translateX(-50%)',
                background: 'rgba(0,0,0,0.7)',
                color: '#00E5FF',
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 4,
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
                fontFamily: 'monospace',
            }}>
                {Math.round(cropBox.width)}×{Math.round(cropBox.height)}
            </div>
        </div>
    )
}

// ─── Main Crop Content ───────────────────────────────────────────────────────

const CropContent = ({ dominantColor, contrastingColor, lighterColor }) => {
    const { canvasEditor, activeTool } = useCanvas()
    const [selectedImage, setSelectedImage] = useState(null)
    const [isCropMode, setIsCropMode] = useState(false)
    const [selectedRatio, setSelectedRatio] = useState(null)
    const [cropBox, setCropBox] = useState(null) // { left, top, width, height } in canvas-space
    const [originalProps, setOriginalProps] = useState(null)
    const [containerEl, setContainerEl] = useState(null)

    // Find the canvas container DOM element
    useEffect(() => {
        if (!canvasEditor) { setContainerEl(null); return }
        // Fabric.js canvas element → parent wrapper
        const el = canvasEditor.lowerCanvasEl?.parentElement?.parentElement
        if (el?.classList?.contains('editor-canvas-host') || el) {
            setContainerEl(el)
        }
    }, [canvasEditor])

    const getActiveImage = useCallback((canvas) => {
        if (!canvas) return null
        const active = canvas.getActiveObject()
        if (active?.type?.toLowerCase() === 'image') return active
        return canvas.getObjects().find((obj) => obj.type?.toLowerCase() === 'image') ?? null
    }, [])

    const resetCropState = useCallback(() => {
        setCropBox(null)
        setSelectedImage(null)
        setSelectedRatio(null)
        setOriginalProps(null)
        setIsCropMode(false)
    }, [])

    const exitCropMode = useCallback(({ restoreImage = true } = {}) => {
        if (!canvasEditor || !isCropMode) return

        if (restoreImage && selectedImage && originalProps && canvasEditor.getObjects().includes(selectedImage)) {
            selectedImage.set({
                ...originalProps,
                selectable: originalProps.selectable ?? true,
                evented: originalProps.evented ?? true,
            })
            canvasEditor.setActiveObject(selectedImage)
        } else {
            canvasEditor.discardActiveObject()
        }

        resetCropState()
        canvasEditor.requestRenderAll()
    }, [canvasEditor, isCropMode, selectedImage, originalProps, resetCropState])

    const initializeCropMode = useCallback((image) => {
        if (!image || isCropMode || !canvasEditor) return

        const original = {
            left: image.left,
            top: image.top,
            width: image.width,
            height: image.height,
            scaleX: image.scaleX,
            scaleY: image.scaleY,
            angle: image.angle,
            selectable: image.selectable,
            evented: image.evented,
        }

        setOriginalProps(original)
        setSelectedImage(image)
        setIsCropMode(true)

        // Set crop box to full image bounds
        const bounds = getImageCanvasBounds(image)
        if (bounds) {
            setCropBox({
                left: bounds.left,
                top: bounds.top,
                width: bounds.width,
                height: bounds.height,
            })
        }

        // Disable image interaction while cropping
        image.set({ selectable: false, evented: false })
        canvasEditor.discardActiveObject()
        canvasEditor.requestRenderAll()
    }, [isCropMode, canvasEditor])

    const handleCropChange = useCallback((newBox) => {
        setCropBox(newBox)
    }, [])

    const applyAspectRatio = useCallback((ratioValue) => {
        if (!canvasEditor || !cropBox || !selectedImage) return

        setSelectedRatio(ratioValue)

        const imgBounds = getImageCanvasBounds(selectedImage)
        if (!imgBounds) return

        let nextWidth = imgBounds.width
        let nextHeight = imgBounds.height

        if (ratioValue) {
            const maxWidthFromHeight = imgBounds.height * ratioValue

            if (maxWidthFromHeight <= imgBounds.width) {
                nextWidth = maxWidthFromHeight
                nextHeight = imgBounds.height
            } else {
                nextWidth = imgBounds.width
                nextHeight = imgBounds.width / ratioValue
            }
        }

        setCropBox({
            left: imgBounds.left + (imgBounds.width - nextWidth) / 2,
            top: imgBounds.top + (imgBounds.height - nextHeight) / 2,
            width: nextWidth,
            height: nextHeight,
        })
    }, [canvasEditor, cropBox, selectedImage])

    const applyCrop = useCallback(() => {
        if (!canvasEditor || !selectedImage || !cropBox) return

        try {
            const imgBounds = getImageCanvasBounds(selectedImage)
            if (!imgBounds) throw new Error("Cannot determine image bounds")

            const imageScaleX = selectedImage.scaleX || 1
            const imageScaleY = selectedImage.scaleY || 1

            // Convert crop box canvas-coords to source image pixel coords
            const cropX = (cropBox.left - imgBounds.left) / imageScaleX
            const cropY = (cropBox.top - imgBounds.top) / imageScaleY
            const cropWidth = cropBox.width / imageScaleX
            const cropHeight = cropBox.height / imageScaleY

            if (cropWidth <= 1 || cropHeight <= 1) {
                toast.error("Choose a larger crop area")
                return
            }

            const sourceElement =
                selectedImage.getElement?.() ||
                selectedImage._element ||
                selectedImage._originalElement

            if (!sourceElement) throw new Error("Selected image is not ready")

            // Offscreen canvas to extract cropped pixels
            const offscreen = document.createElement('canvas')
            const sx = Math.max(0, Math.round(cropX + (selectedImage.cropX || 0)))
            const sy = Math.max(0, Math.round(cropY + (selectedImage.cropY || 0)))
            const sw = Math.round(Math.min(cropWidth, (sourceElement.naturalWidth || sourceElement.width) - sx))
            const sh = Math.round(Math.min(cropHeight, (sourceElement.naturalHeight || sourceElement.height) - sy))

            offscreen.width = sw
            offscreen.height = sh

            const ctx = offscreen.getContext('2d')
            ctx.drawImage(sourceElement, sx, sy, sw, sh, 0, 0, sw, sh)

            const croppedImage = new FabricImage(offscreen, {
                left: 0,
                top: 0,
                originX: "left",
                originY: "top",
                selectable: true,
                evented: true,
                scaleX: 1,
                scaleY: 1,
            })

            canvasEditor.remove(selectedImage)
            canvasEditor.add(croppedImage)

            // Let the project-level resize handler fit the canvas to new dimensions
            canvasEditor.__fitCanvasToProject?.({ width: sw, height: sh })
            canvasEditor.setActiveObject(croppedImage)
            croppedImage.setCoords()
            canvasEditor.requestRenderAll()
            resetCropState()

            canvasEditor.__pushHistoryState?.()
            canvasEditor.__saveCanvasState?.()
            toast.success("Crop applied")
        } catch (error) {
            console.error("Error applying crop: ", error)
            toast.error("Failed to apply crop, please try again")
            exitCropMode()
        }
    }, [canvasEditor, selectedImage, cropBox, resetCropState, exitCropMode])

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (isCropMode && selectedImage && originalProps && canvasEditor) {
                selectedImage.set({
                    ...originalProps,
                    selectable: originalProps.selectable ?? true,
                    evented: originalProps.evented ?? true,
                })
                canvasEditor.requestRenderAll()
            }
        }
    }, [isCropMode, canvasEditor, selectedImage, originalProps])

    if (!canvasEditor) {
        return (
            <div className='p-4'>
                <p className='text-xs' style={{ color: 'var(--text-muted)' }}>
                    Canvas not ready
                </p>
            </div>
        )
    }

    const activeImage = getActiveImage(canvasEditor)

    return (
        <>
            <div className='space-y-4'>
                {isCropMode && (
                    <div className='panel-card' style={{ borderColor: `${dominantColor || 'rgba(0, 229, 255, 0.3)'}` }}>
                        <p className='text-xs font-medium' style={{ color: dominantColor || 'var(--accent-primary)' }}>
                            ✂️ Crop Mode Active
                        </p>
                        <p className='text-[11px] mt-1' style={{ color: 'var(--text-muted)' }}>
                            Drag handles to adjust crop area
                        </p>
                    </div>
                )}

                {!isCropMode && activeImage && (
                    <button
                        onClick={() => initializeCropMode(activeImage)}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive"
                        style={{
                            background: dominantColor || 'var(--accent-primary)',
                            color: contrastingColor || '#fff',
                            border: 'none',
                            boxShadow: `0 0 30px ${dominantColor}40`
                        }}
                    >
                        <Crop className='h-3.5 w-3.5' />
                        Start Crop
                    </button>
                )}

                {isCropMode && (
                    <div>
                        <label className='panel-label mb-2.5 block'>Aspect Ratios</label>
                        <div className='grid grid-cols-3 gap-1.5'>
                            {ASPECT_RATIOS.map((ratio) => {
                                const IconComponent = ratio.icon
                                const isSelected = selectedRatio === ratio.value

                                return (
                                    <button
                                        key={ratio.label}
                                        type="button"
                                        onClick={() => applyAspectRatio(ratio.value)}
                                        className='rounded-lg p-2.5 text-center editor-interactive'
                                        style={{
                                            border: `1px solid ${isSelected ? dominantColor || 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                            background: isSelected ? `${dominantColor}1a` : 'var(--bg-elevated)',
                                        }}
                                    >
                                        <IconComponent className="mx-auto mb-1.5 h-5 w-5" style={{ color: isSelected ? dominantColor || 'var(--accent-primary)' : 'var(--text-secondary)' }} />
                                        <div className="text-[10px] font-medium" style={{ color: isSelected ? contrastingColor || 'var(--text-primary)' : 'var(--text-primary)' }}>
                                            {ratio.label}
                                        </div>
                                        {ratio.ratio && (
                                            <div className="mt-0.5 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                                {ratio.ratio}
                                            </div>
                                        )}
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                )}

                {isCropMode && (
                    <div className='space-y-2'>
                        <button
                            onClick={applyCrop}
                            className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive"
                            style={{
                                background: dominantColor || 'var(--accent-primary)',
                                color: contrastingColor || '#fff',
                                border: 'none',
                                boxShadow: `0 0 30px ${dominantColor}40`
                            }}
                        >
                            <CheckCheck className='h-3.5 w-3.5' />
                            Apply Crop
                        </button>

                        <button
                            onClick={() => exitCropMode()}
                            className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
                            style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
                        >
                            <X className='h-3.5 w-3.5' />
                            Cancel
                        </button>
                    </div>
                )}

                <div className='panel-card text-[11px]' style={{ borderColor: 'rgba(0, 229, 255, 0.1)' }}>
                    <p style={{ color: 'var(--text-muted)' }}>
                        <strong style={{ color: 'var(--text-secondary)' }}>How to crop:</strong>
                        <br />
                        1. Click &quot;Start Crop&quot;
                        <br />
                        2. Drag handles on the image edges
                        <br />
                        3. Choose aspect ratio (optional)
                        <br />
                        4. Click &quot;Apply Crop&quot; to finalize
                    </p>
                </div>
            </div>

            {/* Portal the crop overlay into the canvas container */}
            {isCropMode && containerEl && cropBox && selectedImage && createPortal(
                <CropOverlay
                    canvasEditor={canvasEditor}
                    image={selectedImage}
                    cropBox={cropBox}
                    onCropChange={handleCropChange}
                    containerEl={containerEl}
                />,
                containerEl
            )}
        </>
    )
}

export default CropContent
