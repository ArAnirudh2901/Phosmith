"use client"

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useCanvas } from '../../../../../../../context/context'
import {
    Eraser,
    Minus,
    Paintbrush,
    Plus,
    RotateCcw,
    Scissors,
    Trash2,
    Undo2,
} from 'lucide-react'
import { FabricImage } from 'fabric'
import { ProRulerSlider } from '@/components/editor/ProRulerSlider'
import { toast } from 'sonner'
import { motion } from 'framer-motion'
import {
    PIXEL_MASK_OVERLAY_NAME,
    createMaskCanvas,
    createMaskClipPath,
    isMaskCanvasEmpty,
    isPixxelMaskOverlay,
    maskCanvasFromClipPath,
} from '@/lib/canvas-mask'

const DEFAULT_BRUSH_SIZE = 30
const MIN_BRUSH = 1
const MAX_BRUSH = 200
const MASK_EMPTY_THRESHOLD = 250

const MODES = [
    { id: 'erase', label: 'Erase', icon: Eraser, hint: 'Paint to hide areas' },
    { id: 'restore', label: 'Restore', icon: Paintbrush, hint: 'Paint to bring areas back' },
]

const isImageObject = (obj) => obj?.type?.toLowerCase?.() === 'image'

const isMaskOverlay = (obj) =>
    isPixxelMaskOverlay(obj)

const getMainImage = (canvasEditor) => {
    if (!canvasEditor) return null
    const active = canvasEditor.getActiveObject?.()
    if (isImageObject(active) && !isMaskOverlay(active)) return active

    const objects = canvasEditor.getObjects?.() || []
    return [...objects].reverse().find((obj) => (
        isImageObject(obj) &&
        !isMaskOverlay(obj) &&
        obj.visible !== false
    )) || null
}

const getImageBitmapSize = (img) => ({
    width: Math.max(1, Math.round(img?.width || img?._element?.naturalWidth || img?._originalElement?.naturalWidth || 1)),
    height: Math.max(1, Math.round(img?.height || img?._element?.naturalHeight || img?._originalElement?.naturalHeight || 1)),
})

const isPointInImage = (point, img) => {
    const { width, height } = getImageBitmapSize(img)
    return point?.x >= 0 && point.x <= width && point?.y >= 0 && point.y <= height
}

const commitMaskChange = (canvasEditor, img) => {
    if (!canvasEditor) return
    img?.set?.('dirty', true)
    if (img) canvasEditor.fire?.('object:modified', { target: img })
    canvasEditor.requestRenderAll()
    canvasEditor.__pushHistoryState?.()
    canvasEditor.__saveCanvasState?.()
}

const MaskControls = ({ dominantColor }) => {
    const { canvasEditor } = useCanvas()

    const [mode, setMode] = useState('erase')
    const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE)
    const [brushHardness, setBrushHardness] = useState(80)
    const [hasMask, setHasMask] = useState(false)
    const [undoDepth, setUndoDepth] = useState(0)

    const modeRef = useRef(mode)
    const brushSizeRef = useRef(brushSize)
    const brushHardnessRef = useRef(brushHardness)
    const maskCanvasRef = useRef(null)
    const overlayCanvasRef = useRef(null)
    const overlayImageRef = useRef(null)
    const targetImageRef = useRef(null)
    const isDrawingRef = useRef(false)
    const lastPointRef = useRef(null)
    const strokeHistoryRef = useRef([])
    const interactionStateRef = useRef(null)

    useEffect(() => { modeRef.current = mode }, [mode])
    useEffect(() => { brushSizeRef.current = brushSize }, [brushSize])
    useEffect(() => { brushHardnessRef.current = brushHardness }, [brushHardness])

    const removeOverlay = useCallback(({ render = true } = {}) => {
        if (!canvasEditor) return

        const staleOverlays = canvasEditor.getObjects?.().filter(isMaskOverlay) || []
        for (const overlay of staleOverlays) {
            canvasEditor.remove(overlay)
        }
        overlayImageRef.current = null
        if (render) canvasEditor.requestRenderAll()
    }, [canvasEditor])

    const ensureMaskCanvas = useCallback((img) => {
        if (!img) return null
        const { width, height } = getImageBitmapSize(img)

        let maskCanvas = null
        const attachedMask = img._pixxelMaskCanvas
        if (attachedMask?.width === width && attachedMask?.height === height) {
            maskCanvas = attachedMask
        } else if (
            targetImageRef.current === img &&
            maskCanvasRef.current?.width === width &&
            maskCanvasRef.current?.height === height
        ) {
            maskCanvas = maskCanvasRef.current
        } else {
            maskCanvas = maskCanvasFromClipPath(img.clipPath, width, height) || createMaskCanvas(width, height)
        }

        img._pixxelMaskCanvas = maskCanvas
        maskCanvasRef.current = maskCanvas

        if (!overlayCanvasRef.current || overlayCanvasRef.current.width !== width || overlayCanvasRef.current.height !== height) {
            overlayCanvasRef.current = createMaskCanvas(width, height, 'rgba(0,0,0,0)')
        }

        targetImageRef.current = img
        return maskCanvas
    }, [])

    const updateOverlay = useCallback((img, maskCanvas) => {
        if (!canvasEditor || !img || !maskCanvas) return

        const overlayCanvas = overlayCanvasRef.current
        if (!overlayCanvas) return

        overlayCanvas.width = maskCanvas.width
        overlayCanvas.height = maskCanvas.height

        const overlayCtx = overlayCanvas.getContext('2d')
        const maskCtx = maskCanvas.getContext('2d')
        const maskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
        const overlayData = overlayCtx.createImageData(maskCanvas.width, maskCanvas.height)

        for (let i = 0; i < maskData.data.length; i += 4) {
            const lum = maskData.data[i]
            if (lum < MASK_EMPTY_THRESHOLD) {
                overlayData.data[i] = 220
                overlayData.data[i + 1] = 40
                overlayData.data[i + 2] = 60
                overlayData.data[i + 3] = Math.round((255 - lum) * 0.45)
            }
        }

        overlayCtx.putImageData(overlayData, 0, 0)

        const geometry = {
            left: img.left,
            top: img.top,
            scaleX: img.scaleX,
            scaleY: img.scaleY,
            angle: img.angle,
            originX: img.originX,
            originY: img.originY,
            flipX: img.flipX,
            flipY: img.flipY,
            skewX: img.skewX,
            skewY: img.skewY,
            width: img.width,
            height: img.height,
            selectable: false,
            evented: false,
            hasControls: false,
            hasBorders: false,
            objectCaching: false,
            excludeFromExport: true,
            opacity: 1,
            name: PIXEL_MASK_OVERLAY_NAME,
            pixxelMaskOverlay: true,
            _pixxelMaskOverlay: true,
        }

        let overlayImg = overlayImageRef.current
        if (!overlayImg || !canvasEditor.getObjects?.().includes(overlayImg)) {
            overlayImg = new FabricImage(overlayCanvas, geometry)
            overlayImageRef.current = overlayImg
            canvasEditor.add(overlayImg)
        } else {
            overlayImg.set(geometry)
            overlayImg.set('dirty', true)
        }

        const imageIndex = canvasEditor.getObjects?.().indexOf(img) ?? -1
        if (imageIndex >= 0 && typeof canvasEditor.moveObjectTo === 'function') {
            canvasEditor.moveObjectTo(overlayImg, imageIndex + 1)
        }
    }, [canvasEditor])

    const syncMaskToImage = useCallback((img, { showOverlay = true } = {}) => {
        if (!canvasEditor || !img) return
        const maskCanvas = ensureMaskCanvas(img)
        if (!maskCanvas) return

        const empty = isMaskCanvasEmpty(maskCanvas, MASK_EMPTY_THRESHOLD)
        setHasMask(!empty)

        if (empty) {
            img.clipPath = undefined
            img._pixxelHasMask = false
            img.pixxelHasMask = false
            removeOverlay({ render: false })
            canvasEditor.requestRenderAll()
            return
        }

        const clipImg = createMaskClipPath(FabricImage, maskCanvas)

        img.clipPath = clipImg
        img._pixxelHasMask = true
        img.pixxelHasMask = true
        img._pixxelMaskCanvas = maskCanvas
        img.set?.('dirty', true)
        img.setCoords?.()

        if (showOverlay) updateOverlay(img, maskCanvas)
        canvasEditor.requestRenderAll()
    }, [canvasEditor, ensureMaskCanvas, removeOverlay, updateOverlay])

    const pushMaskUndo = useCallback(() => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return
        const ctx = maskCanvas.getContext('2d')
        strokeHistoryRef.current.push(ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height))
        if (strokeHistoryRef.current.length > 30) strokeHistoryRef.current.shift()
        setUndoDepth(strokeHistoryRef.current.length)
    }, [])

    const paintOnMask = useCallback((imgSpaceX, imgSpaceY, paintMode) => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return

        const ctx = maskCanvas.getContext('2d')
        const radius = Math.max(0.5, brushSizeRef.current / 2)
        const hardness = brushHardnessRef.current / 100

        ctx.save()
        ctx.beginPath()
        ctx.arc(imgSpaceX, imgSpaceY, radius, 0, Math.PI * 2)

        if (hardness >= 0.95) {
            ctx.fillStyle = paintMode === 'erase' ? '#000000' : '#ffffff'
            ctx.fill()
        } else {
            const innerRadius = Math.max(0, radius * hardness)
            const gradient = ctx.createRadialGradient(
                imgSpaceX,
                imgSpaceY,
                innerRadius,
                imgSpaceX,
                imgSpaceY,
                radius
            )

            if (paintMode === 'erase') {
                gradient.addColorStop(0, 'rgba(0,0,0,1)')
                gradient.addColorStop(1, 'rgba(0,0,0,0)')
            } else {
                gradient.addColorStop(0, 'rgba(255,255,255,1)')
                gradient.addColorStop(1, 'rgba(255,255,255,0)')
            }

            ctx.fillStyle = gradient
            ctx.fill()
        }

        ctx.restore()
    }, [])

    const interpolatePaint = useCallback((x1, y1, x2, y2, paintMode) => {
        const dx = x2 - x1
        const dy = y2 - y1
        const dist = Math.sqrt(dx * dx + dy * dy)
        const step = Math.max(1, brushSizeRef.current / 6)
        const steps = Math.ceil(dist / step)

        for (let i = 0; i <= steps; i++) {
            const t = steps === 0 ? 0 : i / steps
            paintOnMask(x1 + dx * t, y1 + dy * t, paintMode)
        }
    }, [paintOnMask])

    const toImageSpace = useCallback((canvasPoint, img) => {
        if (!img || !canvasPoint) return null
        const transform = [...img.calcTransformMatrix()]
        const det = transform[0] * transform[3] - transform[1] * transform[2]
        if (Math.abs(det) < 1e-10) return null

        const a = transform[3] / det
        const b = -transform[1] / det
        const c = -transform[2] / det
        const d = transform[0] / det
        const tx = (transform[2] * transform[5] - transform[3] * transform[4]) / det
        const ty = (transform[1] * transform[4] - transform[0] * transform[5]) / det
        const { width, height } = getImageBitmapSize(img)

        return {
            x: a * canvasPoint.x + c * canvasPoint.y + tx + width / 2,
            y: b * canvasPoint.x + d * canvasPoint.y + ty + height / 2,
        }
    }, [])

    const getScenePoint = useCallback((event) => {
        if (!canvasEditor || !event) return null
        if (typeof canvasEditor.getScenePoint === 'function') {
            return canvasEditor.getScenePoint(event)
        }
        const pointer = canvasEditor.getPointer?.(event, true)
        return pointer ? { x: pointer.x, y: pointer.y } : null
    }, [canvasEditor])

    const lockCanvasForMasking = useCallback((canvas, targetImage) => {
        if (!canvas || interactionStateRef.current) return

        const objects = canvas.getObjects?.() || []
        interactionStateRef.current = {
            activeObject: targetImage,
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
        canvas.selection = false
        canvas.skipTargetFind = true
        canvas.isDrawingMode = false
        canvas.defaultCursor = 'crosshair'
        canvas.hoverCursor = 'crosshair'
        canvas.moveCursor = 'crosshair'
        if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = 'crosshair'

        for (const obj of objects) {
            if (isMaskOverlay(obj)) continue
            obj.set?.({
                selectable: false,
                evented: false,
                hoverCursor: 'crosshair',
                moveCursor: 'crosshair',
            })
        }
        canvas.requestRenderAll()
    }, [])

    const unlockCanvasFromMasking = useCallback((canvas) => {
        const state = interactionStateRef.current
        if (!canvas || !state) return

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

        if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = state.defaultCursor || 'default'
        canvas.discardActiveObject?.()
        if (state.activeObject && canvas.getObjects?.().includes(state.activeObject)) {
            try { canvas.setActiveObject(state.activeObject) } catch { /* object may not be selectable anymore */ }
        }
        canvas.requestRenderAll()
        interactionStateRef.current = null
    }, [])

    useEffect(() => {
        if (!canvasEditor) return undefined

        const targetImage = getMainImage(canvasEditor)
        if (!targetImage) return undefined

        ensureMaskCanvas(targetImage)
        lockCanvasForMasking(canvasEditor, targetImage)
        syncMaskToImage(targetImage)

        const paintFromEvent = (opt, { start = false } = {}) => {
            if (!opt?.e) return false
            if (opt.e.button != null && opt.e.button !== 0 && start) return false

            opt.e.preventDefault?.()
            opt.e.stopPropagation?.()

            const pointer = getScenePoint(opt.e)
            const local = toImageSpace(pointer, targetImageRef.current)
            if (!isPointInImage(local, targetImageRef.current)) {
                lastPointRef.current = null
                return false
            }

            if (start) {
                pushMaskUndo()
                lastPointRef.current = local
                paintOnMask(local.x, local.y, modeRef.current)
                return true
            }

            if (lastPointRef.current) {
                interpolatePaint(
                    lastPointRef.current.x,
                    lastPointRef.current.y,
                    local.x,
                    local.y,
                    modeRef.current
                )
            } else {
                paintOnMask(local.x, local.y, modeRef.current)
            }
            lastPointRef.current = local
            return true
        }

        const onMouseDown = (opt) => {
            if (!paintFromEvent(opt, { start: true })) return
            isDrawingRef.current = true
            syncMaskToImage(targetImageRef.current)
        }

        const onMouseMove = (opt) => {
            if (!isDrawingRef.current) return
            if (!paintFromEvent(opt)) return
            syncMaskToImage(targetImageRef.current)
        }

        const onMouseUp = () => {
            if (!isDrawingRef.current) return
            isDrawingRef.current = false
            lastPointRef.current = null
            syncMaskToImage(targetImageRef.current)
            commitMaskChange(canvasEditor, targetImageRef.current)
        }

        canvasEditor.on('mouse:down', onMouseDown)
        canvasEditor.on('mouse:move', onMouseMove)
        canvasEditor.on('mouse:up', onMouseUp)

        return () => {
            isDrawingRef.current = false
            lastPointRef.current = null
            canvasEditor.off('mouse:down', onMouseDown)
            canvasEditor.off('mouse:move', onMouseMove)
            canvasEditor.off('mouse:up', onMouseUp)
            removeOverlay({ render: false })
            unlockCanvasFromMasking(canvasEditor)
        }
    }, [
        canvasEditor,
        ensureMaskCanvas,
        getScenePoint,
        interpolatePaint,
        lockCanvasForMasking,
        paintOnMask,
        pushMaskUndo,
        removeOverlay,
        syncMaskToImage,
        toImageSpace,
        unlockCanvasFromMasking,
    ])

    const handleUndo = useCallback(() => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas || strokeHistoryRef.current.length === 0) {
            toast.message('No mask strokes to undo')
            return
        }

        const prev = strokeHistoryRef.current.pop()
        const ctx = maskCanvas.getContext('2d')
        ctx.putImageData(prev, 0, 0)
        setUndoDepth(strokeHistoryRef.current.length)
        syncMaskToImage(targetImageRef.current)
        commitMaskChange(canvasEditor, targetImageRef.current)
    }, [canvasEditor, syncMaskToImage])

    const handleInvert = useCallback(() => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return

        pushMaskUndo()
        const ctx = maskCanvas.getContext('2d')
        const data = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
        for (let i = 0; i < data.data.length; i += 4) {
            const next = 255 - data.data[i]
            data.data[i] = next
            data.data[i + 1] = next
            data.data[i + 2] = next
            data.data[i + 3] = 255
        }

        ctx.putImageData(data, 0, 0)
        syncMaskToImage(targetImageRef.current)
        commitMaskChange(canvasEditor, targetImageRef.current)
        toast.success('Mask inverted')
    }, [canvasEditor, pushMaskUndo, syncMaskToImage])

    const handleClear = useCallback(() => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return

        pushMaskUndo()
        const ctx = maskCanvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height)

        if (targetImageRef.current) {
            targetImageRef.current.clipPath = undefined
            targetImageRef.current._pixxelHasMask = false
            targetImageRef.current.pixxelHasMask = false
        }

        removeOverlay()
        setHasMask(false)
        syncMaskToImage(targetImageRef.current, { showOverlay: false })
        commitMaskChange(canvasEditor, targetImageRef.current)
        toast.success('Mask cleared')
    }, [canvasEditor, pushMaskUndo, removeOverlay, syncMaskToImage])

    if (!canvasEditor) {
        return (
            <div className="p-4">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Canvas not ready</p>
            </div>
        )
    }

    const mainImage = targetImageRef.current || getMainImage(canvasEditor)
    if (!mainImage) {
        return (
            <div className="p-4 text-center">
                <Scissors className="h-8 w-8 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
                <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    No image on canvas
                </p>
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                    Add an image first, then use the mask tool
                </p>
            </div>
        )
    }

    return (
        <div className="space-y-4 overflow-y-auto pr-1 panel-scroll">
            <div className="space-y-2">
                <label className="panel-label">Mask Mode</label>
                <div className="grid grid-cols-1 gap-1">
                    {MODES.map((m) => {
                        const Icon = m.icon
                        const isActive = mode === m.id
                        return (
                            <motion.button
                                key={m.id}
                                type="button"
                                onClick={() => setMode(m.id)}
                                whileTap={{ scale: 0.97 }}
                                className="flex items-center gap-3 rounded-lg px-3 py-2 text-left editor-interactive"
                                style={{
                                    background: isActive ? 'rgba(6, 184, 212, 0.1)' : 'transparent',
                                    border: `1px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                }}
                            >
                                <div
                                    className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
                                    style={{
                                        background: isActive ? 'rgba(6,184,212,0.15)' : 'var(--bg-elevated)',
                                        border: `1px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                                    }}
                                >
                                    <Icon className="h-4 w-4" />
                                </div>
                                <div className="min-w-0">
                                    <div className="text-xs font-semibold">{m.label}</div>
                                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{m.hint}</div>
                                </div>
                            </motion.button>
                        )
                    })}
                </div>
            </div>

            <div className="space-y-2" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                <label className="panel-label">Brush Size</label>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => setBrushSize((value) => Math.max(MIN_BRUSH, value - 5))}
                        className="flex items-center justify-center w-8 h-11 rounded-lg editor-interactive shrink-0"
                        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                    >
                        <Minus className="h-3.5 w-3.5" />
                    </button>
                    <ProRulerSlider
                        className="flex-1 min-w-0"
                        label="Size"
                        value={brushSize}
                        min={MIN_BRUSH}
                        max={MAX_BRUSH}
                        step={1}
                        suffix="px"
                        onChange={setBrushSize}
                        visual={{
                            fill: 'rgba(47, 143, 203, 0.45)',
                            accent: dominantColor || '#5eb8ff',
                            trackBg: 'rgba(18, 22, 30, 0.96)',
                        }}
                    />
                    <button
                        type="button"
                        onClick={() => setBrushSize((value) => Math.min(MAX_BRUSH, value + 5))}
                        className="flex items-center justify-center w-8 h-11 rounded-lg editor-interactive shrink-0"
                        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                    >
                        <Plus className="h-3.5 w-3.5" />
                    </button>
                </div>

                <div className="flex items-center justify-center py-2">
                    <div
                        className="rounded-full"
                        style={{
                            width: Math.max(4, Math.min(60, brushSize)),
                            height: Math.max(4, Math.min(60, brushSize)),
                            background: mode === 'erase'
                                ? 'rgba(220, 40, 60, 0.6)'
                                : 'rgba(100, 220, 140, 0.6)',
                            border: '1px solid var(--border-default)',
                            transition: 'all 0.15s ease',
                            boxShadow: brushHardness < 80
                                ? `0 0 ${(100 - brushHardness) / 4}px ${mode === 'erase' ? 'rgba(220,40,60,0.4)' : 'rgba(100,220,140,0.4)'}`
                                : 'none',
                        }}
                    />
                </div>
            </div>

            <div className="space-y-1.5">
                <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Hardness</label>
                <ProRulerSlider
                    label="Hardness"
                    value={brushHardness}
                    min={10}
                    max={100}
                    step={1}
                    suffix="%"
                    onChange={setBrushHardness}
                    visual={{
                        fill: 'rgba(47, 143, 203, 0.45)',
                        accent: dominantColor || '#5eb8ff',
                        trackBg: 'rgba(18, 22, 30, 0.96)',
                    }}
                />
            </div>

            <div className="space-y-1.5" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                <label className="panel-label">Actions</label>
                <button
                    type="button"
                    onClick={handleUndo}
                    disabled={undoDepth === 0}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive disabled:opacity-35"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                >
                    <Undo2 className="h-3.5 w-3.5" />
                    Undo Last Stroke
                </button>
                <button
                    type="button"
                    onClick={handleInvert}
                    disabled={!hasMask}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive disabled:opacity-35"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Invert Mask
                </button>
                <button
                    type="button"
                    onClick={handleClear}
                    disabled={!hasMask}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive disabled:opacity-35"
                    style={{ background: 'rgba(239, 68, 68, 0.08)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.2)' }}
                >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear Mask
                </button>
            </div>

            <div className="panel-card text-[11px]" style={{ borderColor: 'rgba(6, 184, 212, 0.1)' }}>
                <p className="font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Tips</p>
                <div className="space-y-1" style={{ color: 'var(--text-muted)' }}>
                    <p>- <strong>Erase</strong> hides parts of the image and shows a red preview</p>
                    <p>- <strong>Restore</strong> brings hidden parts back</p>
                    <p>- Lower hardness creates soft, feathered edges</p>
                    <p>- PNG export preserves masked transparency</p>
                </div>
            </div>
        </div>
    )
}

export default MaskControls
