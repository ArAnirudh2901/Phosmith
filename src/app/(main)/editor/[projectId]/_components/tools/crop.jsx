"use client"

import { CheckCheck, Crop, Loader2, Maximize, Mountain, RectangleHorizontal, RectangleVertical, Scissors, Smartphone, Sparkles, Square, Users, X } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCanvas } from '../../../../../../../context/context'
import { FabricImage } from 'fabric'
import { toast } from 'sonner'
import { createPortal } from 'react-dom'
import { adaptiveTextColor } from '@/lib/color-extraction'

/**
 * Auto-Crop strategies surfaced to the user. Each strategy is one click; the
 * Auto-Crop panel forwards the optional aspect ratio of the active preset
 * (when any) to /api/ai/auto-crop so subject-aware composition can be fitted
 * to e.g. 4:5 / 9:16 in a single round trip.
 */
const AUTO_CROP_MODES = [
    {
        id: "subject",
        label: "Subject-Aware",
        sub: "Composes around the subject, keeping context",
        icon: Users,
    },
    {
        id: "aspect",
        label: "Aspect Preset",
        sub: "Max-area fit to the selected ratio",
        icon: RectangleHorizontal,
    },
    {
        id: "content",
        label: "Content-Fill",
        sub: "Trims near-solid borders / matting",
        icon: Scissors,
    },
    {
        id: "depth",
        label: "Depth Foreground",
        sub: "Crops to the nearest plane (slow first run)",
        icon: Mountain,
    },
]

const CROP_PRESETS = [
    { id: "freeform", label: "Freeform", value: null, icon: Maximize, ratio: "Any" },
    { id: "square", label: "Square Post", value: 1, icon: Square, ratio: "1:1", size: "1080×1080" },
    { id: "instagram-portrait", label: "IG Portrait", value: 4 / 5, icon: RectangleVertical, ratio: "4:5", size: "1080×1350" },
    { id: "instagram-story", label: "IG Story", value: 9 / 16, icon: Smartphone, ratio: "9:16", size: "1080×1920" },
    { id: "youtube-thumbnail", label: "YouTube Thumb", value: 16 / 9, icon: RectangleHorizontal, ratio: "16:9", size: "1280×720" },
    { id: "youtube-short", label: "YouTube Short", value: 9 / 16, icon: Smartphone, ratio: "9:16", size: "1080×1920" },
    { id: "pinterest-pin", label: "Pinterest Pin", value: 2 / 3, icon: RectangleVertical, ratio: "2:3", size: "1000×1500" },
    { id: "facebook-cover", label: "FB Cover", value: 820 / 312, icon: RectangleHorizontal, ratio: "820:312", size: "820×312" },
]

const HANDLE_SIZE = 10
const MIN_CROP_PX = 20

// Baseline of the editor's --bg-elevated panel. The active/selected UI states
// paint the photo's dominant color at ACTIVE_TINT_ALPHA over it (the `…1a` hex
// fills below) — text contrast must be measured against THAT composite, not the
// raw dominant color, or light photos produce black-on-dark labels.
const PANEL_SURFACE = '#0E1118'
const ACTIVE_TINT_ALPHA = 0.10

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

const getCropBoxForPreset = (image, ratioValue) => {
    const imgBounds = getImageCanvasBounds(image)
    if (!imgBounds) return null

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

    return {
        left: imgBounds.left + (imgBounds.width - nextWidth) / 2,
        top: imgBounds.top + (imgBounds.height - nextHeight) / 2,
        width: nextWidth,
        height: nextHeight,
    }
}

const isCropBoxInsideImage = (cropBox, image) => {
    const imgBounds = getImageCanvasBounds(image)
    if (!cropBox || !imgBounds) return false
    const tolerance = 0.5
    return (
        cropBox.left >= imgBounds.left - tolerance &&
        cropBox.top >= imgBounds.top - tolerance &&
        cropBox.left + cropBox.width <= imgBounds.left + imgBounds.width + tolerance &&
        cropBox.top + cropBox.height <= imgBounds.top + imgBounds.height + tolerance
    )
}

const hasUnsupportedCropTransform = (image) => {
    const angle = Math.abs(((image?.angle || 0) % 360 + 360) % 360)
    const hasRotation = angle > 0.01 && Math.abs(angle - 360) > 0.01
    return hasRotation || Math.abs(image?.skewX || 0) > 0.01 || Math.abs(image?.skewY || 0) > 0.01
}

const copyDefinedProps = (source, keys) => {
    const props = {}
    keys.forEach((key) => {
        if (source?.[key] !== undefined) props[key] = source[key]
    })
    return props
}

const PRESERVED_IMAGE_PROPS = [
    'opacity',
    'visible',
    'flipX',
    'flipY',
    'lockMovementX',
    'lockMovementY',
    'lockScalingX',
    'lockScalingY',
    'lockRotation',
    'lockSkewingX',
    'lockSkewingY',
    'lockScalingFlip',
    'hoverCursor',
    'moveCursor',
    'perPixelTargetFind',
    'globalCompositeOperation',
    'name',
    'id',
    'data',
]

const canvasToPngBlob = (canvas) =>
    new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob)
            else reject(new Error("Could not encode cropped image"))
        }, 'image/png')
    })

const uploadCroppedCanvas = async (canvas) => {
    const blob = await canvasToPngBlob(canvas)
    const fileName = `crop-${Date.now()}.png`
    const formData = new FormData()
    formData.append('fileName', fileName)
    formData.append('rasterFile', blob, fileName)
    formData.append('rasterFileName', fileName)
    formData.append('rasterWidth', String(canvas.width))
    formData.append('rasterHeight', String(canvas.height))

    const response = await fetch('/api/imagekit/upload', {
        method: 'POST',
        body: formData,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.success || !data?.url) {
        throw new Error(data?.error || 'Could not upload cropped image')
    }
    return data.url
}

// ─── Crop Overlay ────────────────────────────────────────────────────────────
// Renders as an HTML overlay on top of the canvas. Handles are attached
// to the crop region's borders, just like Photoshop / Canva.

const CropOverlay = ({ canvasEditor, image, cropBox, onCropChange, onCropChangeStart, containerEl, interactionMode }) => {
    const draggingRef = useRef(null) // { type: 'move'|'handle', handle?, startMouse, startBox }

    if (!canvasEditor || !image || !cropBox || !containerEl) return null
    const isImageAdjustMode = interactionMode === 'image'

    const imgBounds = getImageCanvasBounds(image)
    if (!imgBounds) return null

    // Convert image bounds & crop box from canvas-space to screen-space
    const cropScreen = {
        x: canvasToScreen(canvasEditor, cropBox.left, cropBox.top).x,
        y: canvasToScreen(canvasEditor, cropBox.left, cropBox.top).y,
        w: cropBox.width * (canvasEditor.viewportTransform?.[0] || 1),
        h: cropBox.height * (canvasEditor.viewportTransform?.[3] || 1),
    }

    // Positions relative to the container
    const rel = (screenX, screenY) => ({
        left: screenX,
        top: screenY,
    })

    const cropRel = rel(cropScreen.x, cropScreen.y)

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

        // Snapshot the pre-gesture box once so a whole drag is one undo step.
        onCropChangeStart?.()

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
                    cursor: isImageAdjustMode ? 'default' : 'move',
                    pointerEvents: isImageAdjustMode ? 'none' : 'auto',
                    boxSizing: 'border-box',
                }}
                onPointerDown={(e) => handlePointerDown(e, 'move', null)}
            >
                {/* Rule-of-thirds grid lines */}
                <div style={{ position: 'absolute', left: '33.33%', top: 0, bottom: 0, width: 1, background: 'rgba(6,184,212,0.25)' }} />
                <div style={{ position: 'absolute', left: '66.66%', top: 0, bottom: 0, width: 1, background: 'rgba(6,184,212,0.25)' }} />
                <div style={{ position: 'absolute', top: '33.33%', left: 0, right: 0, height: 1, background: 'rgba(6,184,212,0.25)' }} />
                <div style={{ position: 'absolute', top: '66.66%', left: 0, right: 0, height: 1, background: 'rgba(6,184,212,0.25)' }} />
            </div>

            {/* Drag handles */}
            {!isImageAdjustMode && handles.map((h) => {
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

const CropContent = ({ dominantColor }) => {
    const { canvasEditor, activeTool } = useCanvas()

    // Text colors that adapt to the photo. `activeTextColor` is measured against
    // the REAL composited background of the faint-tint active/selected states;
    // `solidTextColor` against the dominant color at full opacity (Start Crop /
    // Crop fills). Both maximize WCAG contrast so labels never wash out.
    const activeTextColor = useMemo(
        () => (dominantColor ? adaptiveTextColor(dominantColor, PANEL_SURFACE, ACTIVE_TINT_ALPHA).color : 'var(--text-primary)'),
        [dominantColor],
    )
    const solidTextColor = useMemo(
        () => (dominantColor ? adaptiveTextColor(dominantColor, PANEL_SURFACE, 1).color : '#fff'),
        [dominantColor],
    )
    const [selectedImage, setSelectedImage] = useState(null)
    const [isCropMode, setIsCropMode] = useState(false)
    const [selectedPresetId, setSelectedPresetId] = useState("freeform")
    const [interactionMode, setInteractionMode] = useState("frame")
    const [cropBox, setCropBox] = useState(null) // { left, top, width, height } in canvas-space
    const [originalProps, setOriginalProps] = useState(null)
    const [containerEl, setContainerEl] = useState(null)

    // ── Crop-box undo stack (scoped to crop mode) ────────────────────────────
    // Auto-crop / preset buttons replace the crop-box PREVIEW without committing
    // pixels, so canvas history can't revert them. We keep a small past/future
    // stack of boxes and expose __cropToolUndo/__cropToolRedo (mirroring the
    // Mask tool) so the topbar Undo button — and ⌘Z while cropping — step back
    // through crop-box changes, falling through to canvas history when empty.
    const cropBoxRef = useRef(null)
    const cropHistoryRef = useRef({ past: [], future: [] })

    const syncCropHistoryFlags = useCallback(() => {
        if (canvasEditor) {
            canvasEditor.__cropCanUndo = cropHistoryRef.current.past.length > 0
            canvasEditor.__cropCanRedo = cropHistoryRef.current.future.length > 0
        }
        // Reuse the topbar's history-resync signal so Undo/Redo enable state
        // tracks the crop stack the same way it tracks the mask stack.
        window.dispatchEvent(new Event('phosmith:mask-history-changed'))
    }, [canvasEditor])

    // The single writer for the crop box. `history: true` records the prior box
    // on the undo stack (discrete actions: presets, auto-crop). Drag-moves pass
    // history:false and rely on recordCropHistory() captured at gesture start.
    const applyCropBox = useCallback((next, { history = false } = {}) => {
        const prev = cropBoxRef.current
        if (history && prev) {
            cropHistoryRef.current.past.push(prev)
            cropHistoryRef.current.future = []
        }
        cropBoxRef.current = next
        setCropBox(next)
        if (history) syncCropHistoryFlags()
    }, [syncCropHistoryFlags])

    // Snapshot the current box onto the undo stack (used at drag start, before
    // the stream of history:false move updates).
    const recordCropHistory = useCallback(() => {
        if (!cropBoxRef.current) return
        cropHistoryRef.current.past.push(cropBoxRef.current)
        cropHistoryRef.current.future = []
        syncCropHistoryFlags()
    }, [syncCropHistoryFlags])

    const undoCropBox = useCallback(() => {
        const h = cropHistoryRef.current
        if (!h.past.length) return false
        const prevBox = h.past.pop()
        if (cropBoxRef.current) h.future.push(cropBoxRef.current)
        cropBoxRef.current = prevBox
        setCropBox(prevBox)
        setInteractionMode('frame')
        syncCropHistoryFlags()
        return true
    }, [syncCropHistoryFlags])

    const redoCropBox = useCallback(() => {
        const h = cropHistoryRef.current
        if (!h.future.length) return false
        const nextBox = h.future.pop()
        if (cropBoxRef.current) h.past.push(cropBoxRef.current)
        cropBoxRef.current = nextBox
        setCropBox(nextBox)
        setInteractionMode('frame')
        syncCropHistoryFlags()
        return true
    }, [syncCropHistoryFlags])

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
        cropBoxRef.current = null
        cropHistoryRef.current = { past: [], future: [] }
        setSelectedImage(null)
        setSelectedPresetId("freeform")
        setInteractionMode("frame")
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
                hasControls: originalProps.hasControls ?? true,
                hasBorders: originalProps.hasBorders ?? true,
            })
            canvasEditor.setActiveObject(selectedImage)
        } else {
            canvasEditor.discardActiveObject()
        }

        resetCropState()
        canvasEditor.requestRenderAll()
    }, [canvasEditor, isCropMode, selectedImage, originalProps, resetCropState])

    const initializeCropMode = useCallback((image, preset = CROP_PRESETS[0]) => {
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
            hasControls: image.hasControls,
            hasBorders: image.hasBorders,
        }

        setOriginalProps(original)
        setSelectedImage(image)
        setSelectedPresetId(preset.id)
        setInteractionMode("frame")
        setIsCropMode(true)

        const box = getCropBoxForPreset(image, preset.value)
        cropHistoryRef.current = { past: [], future: [] }
        if (box) applyCropBox(box)
        syncCropHistoryFlags()

        // Disable image interaction while cropping
        image.set({ selectable: false, evented: false, hasControls: false, hasBorders: false })
        canvasEditor.discardActiveObject()
        canvasEditor.requestRenderAll()
    }, [isCropMode, canvasEditor, applyCropBox, syncCropHistoryFlags])

    const handleCropChange = useCallback((newBox) => {
        applyCropBox(newBox, { history: false })
    }, [applyCropBox])

    const applyCropPreset = useCallback((preset) => {
        if (!canvasEditor || !selectedImage) return

        setSelectedPresetId(preset.id)

        const box = getCropBoxForPreset(selectedImage, preset.value)
        if (box) applyCropBox(box, { history: true })
        setInteractionMode("frame")
    }, [canvasEditor, selectedImage, applyCropBox])

    const handlePresetSelect = useCallback((preset) => {
        const image = selectedImage || getActiveImage(canvasEditor)
        if (!image) {
            toast.error("Select an image first")
            return
        }
        if (!isCropMode) {
            initializeCropMode(image, preset)
            return
        }
        applyCropPreset(preset)
    }, [applyCropPreset, canvasEditor, getActiveImage, initializeCropMode, isCropMode, selectedImage])

    // ─── Auto-Crop ──────────────────────────────────────────────────────────
    // Calls /api/ai/auto-crop, converts the returned image-pixel box to a
    // canvas-space cropBox, and either previews it in the existing crop
    // overlay or applies it directly.
    const [autoBusy, setAutoBusy] = useState(null) // null | 'subject' | 'aspect' | ...
    const [autoResults, setAutoResults] = useState(null) // { crops, recommended, subjects }
    const [autoStrategy, setAutoStrategy] = useState(null)
    const autoAbortRef = useRef(null)

    /**
     * Convert an API-returned `[x,y,w,h]` box to a canvas-space cropBox.
     *
     * The API box is expressed in the coordinate space of the image the service
     * received (client downscales to max-2048 before upload, so apiWidth/apiHeight
     * may be smaller than the source element's naturalWidth/Height). We normalise
     * via fractions so the result is always correct regardless of the two scale
     * factors involved.
     */
    const imagePixelBoxToCropBox = useCallback((image, [x, y, w, h], apiWidth = 0, apiHeight = 0) => {
        if (!image) return null
        const imgBounds = getImageCanvasBounds(image)
        if (!imgBounds) return null
        if (apiWidth > 0 && apiHeight > 0) {
            return {
                left: imgBounds.left + (x / apiWidth) * imgBounds.width,
                top: imgBounds.top + (y / apiHeight) * imgBounds.height,
                width: (w / apiWidth) * imgBounds.width,
                height: (h / apiHeight) * imgBounds.height,
            }
        }
        // Fallback for callers that already supply original-pixel coords.
        const sx = Math.abs(image.scaleX || 1)
        const sy = Math.abs(image.scaleY || 1)
        return {
            left: imgBounds.left + x * sx,
            top: imgBounds.top + y * sy,
            width: w * sx,
            height: h * sy,
        }
    }, [])

    const getActivePresetAspect = useCallback(() => {
        const preset = CROP_PRESETS.find((p) => p.id === selectedPresetId)
        return preset?.value || null
    }, [selectedPresetId])

    const runAutoCrop = useCallback(async (modeId, { autoApply = false } = {}) => {
        const image = selectedImage || getActiveImage(canvasEditor)
        if (!image) { toast.error("Select an image first"); return }

        // ── "aspect" is purely geometric — no model or network trip required. ──
        // getCropBoxForPreset already computes the max-area fit in canvas-space,
        // which is inherently correct regardless of image scale or zoom level.
        if (modeId === 'aspect') {
            // Cancel any in-flight AI request so its result doesn't race us.
            autoAbortRef.current?.abort?.()
            setAutoBusy(null)

            let aspectValue = getActivePresetAspect()
            let presetId = selectedPresetId

            // No ratio selected → default to YouTube Thumb (16:9).
            if (!aspectValue) {
                const fallback = CROP_PRESETS.find((p) => p.id === 'youtube-thumbnail')
                if (fallback) { presetId = fallback.id; aspectValue = fallback.value; setSelectedPresetId(fallback.id) }
            }

            if (!aspectValue) {
                toast.error("Pick an aspect preset first (e.g. Square Post or YouTube Thumb).")
                return
            }

            const activePreset = CROP_PRESETS.find((p) => p.id === presetId)
            const ratioLabel = activePreset?.ratio ?? aspectValue.toFixed(3) + ':1'

            if (!isCropMode) {
                initializeCropMode(image, activePreset || CROP_PRESETS[0])
                // initializeCropMode already applies getCropBoxForPreset with the preset,
                // so the box is already correct — just update the strategy label.
            } else {
                const box = getCropBoxForPreset(image, aspectValue)
                if (box) applyCropBox(box, { history: true })
                setInteractionMode('frame')
            }

            setAutoStrategy('aspect')
            setAutoResults({ recommended: 'aspect', crops: { aspect: { score: 0.5 } } })
            toast.success(`Auto-crop ready (max-area fit to ${ratioLabel} around centre)`)

            if (autoApply) {
                requestAnimationFrame(() => {
                    document.dispatchEvent(new CustomEvent('phosmith:crop-auto-apply'))
                })
            }
            return
        }

        const sourceEl =
            image._originalElement || image.getElement?.() || image._element
        if (!sourceEl) { toast.error("Image not ready"); return }
        const sw = sourceEl.naturalWidth || sourceEl.width
        const sh = sourceEl.naturalHeight || sourceEl.height
        if (!sw || !sh) { toast.error("Image has no dimensions"); return }

        // Cancel any in-flight request before kicking a new one.
        autoAbortRef.current?.abort?.()
        const ac = new AbortController()
        autoAbortRef.current = ac

        setAutoBusy(modeId)
        const toastId = toast.loading(`Auto-crop (${modeId})…`)

        try {
            // Capture the image source to a sized JPEG (the route caps at 2048).
            const MAX = 2048
            const scale = Math.min(1, MAX / Math.max(sw, sh))
            const w = Math.max(1, Math.round(sw * scale))
            const h = Math.max(1, Math.round(sh * scale))
            const off = document.createElement('canvas')
            off.width = w
            off.height = h
            off.getContext('2d').drawImage(sourceEl, 0, 0, w, h)
            const blob = await new Promise((res, rej) =>
                off.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), 'image/jpeg', 0.88),
            )

            const activeAspect = getActivePresetAspect()

            const form = new FormData()
            form.append('image', blob, 'image.jpg')
            form.append('mode', modeId === 'subject' || modeId === 'content' || modeId === 'depth' ? modeId : 'all')
            if (activeAspect) form.append('aspect', String(activeAspect))

            const resp = await fetch('/api/ai/auto-crop', { method: 'POST', body: form, signal: ac.signal })
            const data = await resp.json().catch(() => ({}))
            if (!resp.ok) {
                throw new Error(data?.error || `Auto-crop failed (${resp.status})`)
            }

            const chosen = data.crops?.[modeId]
            if (!chosen?.box) {
                throw new Error(`Couldn't compute a ${modeId} crop for this image — try another strategy.`)
            }

            setAutoResults(data)
            setAutoStrategy(modeId)

            // ── "Already tight" detection ──────────────────────────────────
            // Backend flags `already_tight` when the crop box covers ≥ 92% of
            // the frame (the subject already fills the photo). We STILL place
            // the box so the user can drag the handles to recompose — bailing
            // out here is what left the crop window un-adjustable on photos
            // already framed around their subject.
            const [, , bw, bh] = chosen.box
            const imgArea = (data.width || sw) * (data.height || sh)
            const boxArea = bw * bh
            const isAlreadyTight =
                chosen.already_tight === true ||
                (imgArea > 0 && (boxArea / imgArea) >= 0.92)

            const newBox = imagePixelBoxToCropBox(image, chosen.box, data.width, data.height)
            if (!newBox) throw new Error("Could not place crop box on canvas")

            if (!isCropMode) {
                initializeCropMode(image, CROP_PRESETS.find((p) => p.id === selectedPresetId) || CROP_PRESETS[0])
            }
            applyCropBox(newBox, { history: true })
            setInteractionMode("frame")

            const sub = data.subjects?.length
                ? `${data.subjects.length} subject${data.subjects.length === 1 ? '' : 's'}`
                : null

            if (isAlreadyTight) {
                // Box is placed and editable; just tell the user it's full-frame
                // and point at any strategy that would trim more.
                const alternatives = Object.entries(data.crops || {})
                    .filter(([k, v]) => k !== modeId && v?.box && !v.already_tight)
                    .map(([k]) => k.charAt(0).toUpperCase() + k.slice(1))
                let message = `Already framed around the subject — placed a full-frame box you can drag to recompose`
                if (alternatives.length > 0) {
                    message += `. ${alternatives.join(' or ')} would trim more`
                }
                toast.info(message, { id: toastId, duration: 5000 })
            } else {
                toast.success(
                    `Auto-crop ready (${chosen.rationale}${sub ? ' · ' + sub : ''})`,
                    { id: toastId },
                )
            }

            if (autoApply) {
                // Defer one frame so cropBox state is committed before applyCrop reads it.
                requestAnimationFrame(() => {
                    // applyCrop is defined below — guard against undefined during tree-shaking.
                    document.dispatchEvent(new CustomEvent('phosmith:crop-auto-apply'))
                })
            }
        } catch (err) {
            if (err?.name === 'AbortError') {
                toast.dismiss(toastId)
                return
            }
            console.error('[crop.auto]', err)
            toast.error(err?.message || "Auto-crop failed", { id: toastId })
        } finally {
            // Only the latest request owns the busy state. A request that was
            // aborted because the user picked another mode must NOT clear the
            // spinner for the newer in-flight request that replaced it.
            if (autoAbortRef.current === ac) setAutoBusy(null)
        }
    }, [canvasEditor, selectedImage, getActiveImage, getActivePresetAspect, imagePixelBoxToCropBox, initializeCropMode, isCropMode, selectedPresetId, applyCropBox])

    useEffect(() => () => autoAbortRef.current?.abort?.(), [])

    // Expose the crop-box undo stack to the topbar Undo/Redo (and ⌘Z below)
    // while crop mode is active; fall back to canvas history when it's empty.
    useEffect(() => {
        if (!canvasEditor || !isCropMode) return undefined
        canvasEditor.__cropToolUndo = () => undoCropBox()
        canvasEditor.__cropToolRedo = () => redoCropBox()
        canvasEditor.__cropCanUndo = cropHistoryRef.current.past.length > 0
        canvasEditor.__cropCanRedo = cropHistoryRef.current.future.length > 0
        window.dispatchEvent(new Event('phosmith:mask-history-changed'))
        return () => {
            delete canvasEditor.__cropToolUndo
            delete canvasEditor.__cropToolRedo
            canvasEditor.__cropCanUndo = false
            canvasEditor.__cropCanRedo = false
            window.dispatchEvent(new Event('phosmith:mask-history-changed'))
        }
    }, [canvasEditor, isCropMode, undoCropBox, redoCropBox])

    // ⌘Z / ⌘⇧Z revert crop-box previews; Esc cancels crop mode. Capture phase
    // so these win over canvas-level handlers, but only preventDefault when we
    // actually consumed the event (empty stack → let it bubble to canvas undo).
    useEffect(() => {
        if (!isCropMode) return undefined
        const onKeyDown = (e) => {
            const t = e.target
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
            if (e.key === 'Escape') {
                e.preventDefault()
                exitCropMode()
                return
            }
            if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
                const handled = e.shiftKey ? redoCropBox() : undoCropBox()
                if (handled) {
                    e.preventDefault()
                    e.stopPropagation()
                }
            }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
    }, [isCropMode, exitCropMode, undoCropBox, redoCropBox])

    useEffect(() => {
        if (!canvasEditor || !selectedImage || !isCropMode) return

        const canAdjustImage = interactionMode === "image"
        selectedImage.set({
            selectable: canAdjustImage,
            evented: canAdjustImage,
            hasControls: canAdjustImage,
            hasBorders: canAdjustImage,
        })

        if (canAdjustImage) {
            canvasEditor.setActiveObject(selectedImage)
        } else {
            canvasEditor.discardActiveObject()
        }

        selectedImage.setCoords()
        canvasEditor.requestRenderAll()
    }, [canvasEditor, selectedImage, isCropMode, interactionMode])

    const applyCrop = useCallback(async () => {
        if (!canvasEditor || !selectedImage || !cropBox) return
        const toastId = toast.loading("Cropping image...")

        try {
            if (hasUnsupportedCropTransform(selectedImage)) {
                toast.error("Crop currently supports straight images only. Reset rotation/skew first.", { id: toastId })
                return
            }

            const imgBounds = getImageCanvasBounds(selectedImage)
            if (!imgBounds) throw new Error("Cannot determine image bounds")

            if (!isCropBoxInsideImage(cropBox, selectedImage)) {
                toast.error("Move or scale the image so it covers the crop frame", { id: toastId })
                return
            }

            const originalIndex = canvasEditor.getObjects().indexOf(selectedImage)
            if (originalIndex < 0) throw new Error("Selected image is no longer on the canvas")

            const imageScaleX = Math.abs(selectedImage.scaleX || 1)
            const imageScaleY = Math.abs(selectedImage.scaleY || 1)

            // Convert crop box canvas-coords to source image pixel coords
            const cropX = (cropBox.left - imgBounds.left) / imageScaleX
            const cropY = (cropBox.top - imgBounds.top) / imageScaleY
            const cropWidth = cropBox.width / imageScaleX
            const cropHeight = cropBox.height / imageScaleY

            if (cropWidth <= 1 || cropHeight <= 1) {
                toast.error("Choose a larger crop area", { id: toastId })
                return
            }

            const sourceElement =
                selectedImage._originalElement ||
                selectedImage.getElement?.() ||
                selectedImage._element

            if (!sourceElement) throw new Error("Selected image is not ready")

            // Offscreen canvas to extract cropped pixels
            const offscreen = document.createElement('canvas')
            const sourceWidth = sourceElement.naturalWidth || sourceElement.videoWidth || sourceElement.width
            const sourceHeight = sourceElement.naturalHeight || sourceElement.videoHeight || sourceElement.height
            if (!sourceWidth || !sourceHeight) throw new Error("Selected image source has no dimensions")

            const baseCropX = selectedImage.flipX ? (selectedImage.width || 0) - cropX - cropWidth : cropX
            const baseCropY = selectedImage.flipY ? (selectedImage.height || 0) - cropY - cropHeight : cropY
            const sx = Math.max(0, Math.round(baseCropX + (selectedImage.cropX || 0)))
            const sy = Math.max(0, Math.round(baseCropY + (selectedImage.cropY || 0)))
            const sw = Math.round(Math.min(cropWidth, sourceWidth - sx))
            const sh = Math.round(Math.min(cropHeight, sourceHeight - sy))

            if (sw <= 1 || sh <= 1) {
                toast.error("Choose a larger crop area", { id: toastId })
                return
            }

            offscreen.width = sw
            offscreen.height = sh

            const ctx = offscreen.getContext('2d')
            ctx.drawImage(sourceElement, sx, sy, sw, sh, 0, 0, sw, sh)

            const uploadedUrl = await uploadCroppedCanvas(offscreen)
            const croppedImage = await FabricImage.fromURL(uploadedUrl, { crossOrigin: 'anonymous' })
            croppedImage.set({
                ...copyDefinedProps(selectedImage, PRESERVED_IMAGE_PROPS),
                left: cropBox.left,
                top: cropBox.top,
                originX: "left",
                originY: "top",
                selectable: originalProps?.selectable ?? true,
                evented: originalProps?.evented ?? true,
                hasControls: originalProps?.hasControls ?? true,
                hasBorders: originalProps?.hasBorders ?? true,
                angle: 0,
                skewX: 0,
                skewY: 0,
                cropX: 0,
                cropY: 0,
                scaleX: cropBox.width / sw,
                scaleY: cropBox.height / sh,
                filters: selectedImage.filters?.slice?.() || [],
                resizeFilter: selectedImage.resizeFilter,
            })
            if (croppedImage.filters?.length) {
                croppedImage.applyFilters()
            }

            canvasEditor.remove(selectedImage)
            canvasEditor.insertAt(originalIndex, croppedImage)
            canvasEditor.setActiveObject(croppedImage)
            croppedImage.setCoords()
            canvasEditor.requestRenderAll()
            resetCropState()

            canvasEditor.__pushHistoryState?.({ label: 'Applied crop', domain: 'crop' })
            canvasEditor.__saveCanvasState?.()
            toast.success("Crop applied", { id: toastId })
        } catch (error) {
            console.error("Error applying crop: ", error)
            toast.error(error?.message || "Failed to apply crop, please try again", { id: toastId })
            exitCropMode()
        }
    }, [canvasEditor, selectedImage, cropBox, originalProps, resetCropState, exitCropMode])

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (isCropMode && selectedImage && originalProps && canvasEditor) {
                selectedImage.set({
                    ...originalProps,
                    selectable: originalProps.selectable ?? true,
                    evented: originalProps.evented ?? true,
                    hasControls: originalProps.hasControls ?? true,
                    hasBorders: originalProps.hasBorders ?? true,
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
                    <div className='panel-card' style={{ borderColor: `${dominantColor || 'rgba(6, 184, 212, 0.3)'}` }}>
                        <p className='text-xs font-medium' style={{ color: dominantColor || 'var(--accent-primary)' }}>
                            ✂️ Crop Mode Active
                        </p>
                        <p className='text-[11px] mt-1' style={{ color: 'var(--text-muted)' }}>
                            {interactionMode === "image" ? "Move or scale the image, then crop" : "Drag handles to adjust crop area"}
                        </p>
                    </div>
                )}

                {!isCropMode && activeImage && (
                    <button
                        onClick={() => initializeCropMode(activeImage)}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive"
                        style={{
                            background: dominantColor || 'var(--accent-primary)',
                            color: solidTextColor,
                            border: 'none',
                            boxShadow: `0 0 30px ${dominantColor}40`
                        }}
                    >
                        <Crop className='h-3.5 w-3.5' />
                        Start Crop
                    </button>
                )}

                {activeImage && (
                    <div>
                        <label className='panel-label mb-2.5 flex items-center gap-1.5'>
                            <Sparkles className='h-3 w-3' style={{ color: dominantColor || 'var(--accent-primary)' }} />
                            Auto-Crop (AI)
                            {autoResults?.subjects?.length ? (
                                <span className='ml-auto text-[10px] font-normal' style={{ color: 'var(--text-muted)' }}>
                                    {autoResults.subjects.length} subject{autoResults.subjects.length === 1 ? '' : 's'}
                                </span>
                            ) : null}
                        </label>
                        <div className='grid grid-cols-2 gap-1.5'>
                            {AUTO_CROP_MODES.map((mode) => {
                                const Icon = mode.icon
                                const busy = autoBusy === mode.id
                                const active = autoStrategy === mode.id
                                return (
                                    <button
                                        key={mode.id}
                                        type='button'
                                        onClick={() => runAutoCrop(mode.id)}
                                        disabled={busy}
                                        title={mode.sub}
                                        className='rounded-lg p-2.5 text-left editor-interactive disabled:opacity-50 disabled:cursor-not-allowed'
                                        style={{
                                            border: `1px solid ${active ? dominantColor || 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                            background: active
                                                ? (dominantColor ? `${dominantColor}1a` : 'rgba(6,184,212,0.14)')
                                                : 'var(--bg-elevated)',
                                            boxShadow: active
                                                ? `3px 3px 0 0 ${dominantColor || 'var(--accent-primary)'}`
                                                : '3px 3px 0 0 rgba(244, 244, 245, 0.55)',
                                        }}
                                    >
                                        <div className='flex items-start gap-2'>
                                            {busy ? (
                                                <Loader2 className='h-4 w-4 flex-none mt-0.5 animate-spin'
                                                    style={{ color: dominantColor || 'var(--accent-primary)' }} />
                                            ) : (
                                                <Icon className='h-4 w-4 flex-none mt-0.5'
                                                    style={{ color: active ? dominantColor || 'var(--accent-primary)' : 'var(--text-secondary)' }} />
                                            )}
                                            <div className='min-w-0'>
                                                <div className='truncate text-[11px] font-semibold'
                                                    style={{ color: active ? activeTextColor : 'var(--text-primary)' }}>
                                                    {mode.label}
                                                </div>
                                                <div className='mt-0.5 text-[9.5px] leading-tight' style={{ color: 'var(--text-muted)' }}>
                                                    {mode.sub}
                                                </div>
                                            </div>
                                        </div>
                                    </button>
                                )
                            })}
                        </div>
                        {autoResults?.recommended && (
                            <p className='mt-2 text-[10px]' style={{ color: 'var(--text-muted)' }}>
                                Recommended: <strong style={{ color: dominantColor || 'var(--accent-primary)' }}>{autoResults.recommended}</strong>
                                {autoResults.crops?.[autoResults.recommended]?.score
                                    ? ` · score ${(autoResults.crops[autoResults.recommended].score * 100).toFixed(0)}%`
                                    : ''}
                                . Click <strong>Crop</strong> below to confirm.
                            </p>
                        )}
                    </div>
                )}

                {activeImage && (
                    <div>
                        <label className='panel-label mb-2.5 block'>Crop Presets</label>
                        <div className='grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-1.5'>
                            {CROP_PRESETS.map((preset) => {
                                const IconComponent = preset.icon
                                const isSelected = isCropMode && selectedPresetId === preset.id

                                return (
                                    <button
                                        key={preset.id}
                                        type="button"
                                        onClick={() => handlePresetSelect(preset)}
                                        className='rounded-lg p-2.5 text-left editor-interactive'
                                        style={{
                                            border: `1px solid ${isSelected ? dominantColor || 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                            background: isSelected ? (dominantColor ? `${dominantColor}1a` : 'rgba(6,184,212,0.14)') : 'var(--bg-elevated)',
                                        }}
                                    >
                                        <div className="flex items-center gap-2">
                                            <IconComponent className="h-4 w-4 flex-none" style={{ color: isSelected ? dominantColor || 'var(--accent-primary)' : 'var(--text-secondary)' }} />
                                            <div className="min-w-0">
                                                <div className="truncate text-[10px] font-semibold" style={{ color: isSelected ? activeTextColor : 'var(--text-primary)' }}>
                                                    {preset.label}
                                                </div>
                                                <div className="mt-0.5 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                                    {preset.ratio}{preset.size ? ` · ${preset.size}` : ''}
                                                </div>
                                            </div>
                                        </div>
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                )}

                {isCropMode && (
                    <div>
                        <label className='panel-label mb-2.5 block'>Adjust</label>
                        <div className='grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-1.5'>
                            {[
                                ["frame", "Frame"],
                                ["image", "Image"],
                            ].map(([mode, label]) => {
                                const isSelected = interactionMode === mode
                                return (
                                    <button
                                        key={mode}
                                        type="button"
                                        onClick={() => setInteractionMode(mode)}
                                        className="rounded-lg px-3 py-2 text-xs font-semibold editor-interactive"
                                        style={{
                                            border: `1px solid ${isSelected ? dominantColor || 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                            background: isSelected ? (dominantColor ? `${dominantColor}1a` : 'rgba(6,184,212,0.14)') : 'var(--bg-elevated)',
                                            color: isSelected ? activeTextColor : 'var(--text-secondary)',
                                        }}
                                    >
                                        {label}
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
                                color: solidTextColor,
                                border: 'none',
                                boxShadow: `0 0 30px ${dominantColor}40`
                            }}
                        >
                            <CheckCheck className='h-3.5 w-3.5' />
                            Crop
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

                <div className='panel-card text-[11px]' style={{ borderColor: 'rgba(6, 184, 212, 0.1)' }}>
                    <p style={{ color: 'var(--text-muted)' }}>
                        <strong style={{ color: 'var(--text-secondary)' }}>How to crop:</strong>
                        <br />
                        1. Click &quot;Start Crop&quot;
                        <br />
                        2. Drag handles on the image edges
                        <br />
                        3. Choose a preset or adjust the image
                        <br />
                        4. Click &quot;Crop&quot; to finalize
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
                    onCropChangeStart={recordCropHistory}
                    containerEl={containerEl}
                    interactionMode={interactionMode}
                />,
                containerEl
            )}
        </>
    )
}

export default CropContent
