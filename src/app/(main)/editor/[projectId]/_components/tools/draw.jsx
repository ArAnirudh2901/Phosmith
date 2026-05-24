"use client"

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useCanvas } from '../../../../../../../context/context'
import {
    Circle,
    Eraser,
    Minus,
    Paintbrush,
    Pen,
    Plus,
    SprayCan,
    Trash2,
    Undo2,
} from 'lucide-react'
import { PencilBrush, CircleBrush, SprayBrush } from 'fabric'
import { ProRulerSlider } from '@/components/editor/ProRulerSlider'
import { toast } from 'sonner'
import Colorful from '@uiw/react-color-colorful'
import { motion } from 'framer-motion'

const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

const BRUSH_TYPES = [
    { id: 'pencil', label: 'Pencil', icon: Pen, hint: 'Smooth freehand' },
    { id: 'marker', label: 'Marker', icon: Paintbrush, hint: 'Thick soft strokes' },
    { id: 'circle', label: 'Circle', icon: Circle, hint: 'Dotted circles' },
    { id: 'spray', label: 'Spray', icon: SprayCan, hint: 'Spray can effect' },
    { id: 'eraser', label: 'Eraser', icon: Eraser, hint: 'Remove drawn paths' },
]

const COLOR_SWATCHES = [
    '#111827', '#ffffff', '#ef4444', '#f59e0b',
    '#22c55e', '#06b6d4', '#3b82f6', '#a855f7',
    '#ec4899', '#f97316', '#14b8a6', '#8b5cf6',
]

const DEFAULT_BRUSH_SIZE = 4
const DEFAULT_BRUSH_COLOR = '#111827'

const isPathObject = (obj) => {
    const type = obj?.type?.toLowerCase()
    return type === 'path' || type === 'pathgroup'
}

const commitDrawChange = (canvasEditor) => {
    canvasEditor?.requestRenderAll()
    canvasEditor?.__pushHistoryState?.()
    canvasEditor?.__saveCanvasState?.()
}

const DrawControls = ({ dominantColor }) => {
    const { canvasEditor } = useCanvas()
    const [brushType, setBrushType] = useState('pencil')
    const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE)
    const [brushColor, setBrushColor] = useState(DEFAULT_BRUSH_COLOR)
    const [brushOpacity, setBrushOpacity] = useState(100)
    const [drawingPaths, setDrawingPaths] = useState(0)
    const strokeStackRef = useRef([])
    const erasingRef = useRef(false)

    const hexWithOpacity = (hex, opacityPercent) => {
        if (opacityPercent >= 100) return hex
        const alpha = Math.round((opacityPercent / 100) * 255)
            .toString(16)
            .padStart(2, '0')
        return `${hex.slice(0, 7)}${alpha}`
    }

    const syncPathCount = useCallback(() => {
        if (!canvasEditor) return
        const paths = canvasEditor.getObjects().filter(isPathObject)
        setDrawingPaths(paths.length)
        const stackIds = new Set(strokeStackRef.current.map((p) => p))
        strokeStackRef.current = strokeStackRef.current.filter((p) => paths.includes(p))
        paths.forEach((p) => {
            if (!stackIds.has(p)) strokeStackRef.current.push(p)
        })
    }, [canvasEditor])

    const erasePathsAtPointer = useCallback(
        (opt) => {
            if (!canvasEditor || !opt?.e) return

            const pointer = canvasEditor.getScenePoint(opt.e)
            const eraserRadius = brushType === 'marker' ? brushSize * 3 : brushSize
            let removed = false

            for (const path of canvasEditor.getObjects().filter(isPathObject)) {
                try {
                    if (typeof path.containsPoint === 'function' && path.containsPoint(pointer)) {
                        canvasEditor.remove(path)
                        strokeStackRef.current = strokeStackRef.current.filter((p) => p !== path)
                        removed = true
                        continue
                    }
                } catch {
                    /* fall through to bounds check */
                }

                const bounds = path.getBoundingRect?.()
                if (!bounds) continue
                const pad = eraserRadius
                if (
                    pointer.x >= bounds.left - pad &&
                    pointer.x <= bounds.left + bounds.width + pad &&
                    pointer.y >= bounds.top - pad &&
                    pointer.y <= bounds.top + bounds.height + pad
                ) {
                    canvasEditor.remove(path)
                    strokeStackRef.current = strokeStackRef.current.filter((p) => p !== path)
                    removed = true
                }
            }

            if (removed) {
                canvasEditor.requestRenderAll()
                syncPathCount()
            }
        },
        [canvasEditor, brushSize, brushType, syncPathCount]
    )

    useEffect(() => {
        if (!canvasEditor) return

        syncPathCount()

        const onPathCreated = (e) => {
            if (e?.path) strokeStackRef.current.push(e.path)
            syncPathCount()
        }

        const onObjectRemoved = () => syncPathCount()

        canvasEditor.on('path:created', onPathCreated)
        canvasEditor.on('object:removed', onObjectRemoved)

        return () => {
            canvasEditor.off('path:created', onPathCreated)
            canvasEditor.off('object:removed', onObjectRemoved)
        }
    }, [canvasEditor, syncPathCount])

    useEffect(() => {
        if (!canvasEditor) return

        if (brushType === 'eraser') {
            canvasEditor.isDrawingMode = false
            canvasEditor.defaultCursor = 'crosshair'
            canvasEditor.hoverCursor = 'crosshair'
            if (canvasEditor.upperCanvasEl) canvasEditor.upperCanvasEl.style.cursor = 'crosshair'

            const onEraserDown = (opt) => {
                erasingRef.current = true
                erasePathsAtPointer(opt)
            }
            const onEraserMove = (opt) => {
                if (!erasingRef.current) return
                erasePathsAtPointer(opt)
            }
            const onEraserUp = () => {
                if (!erasingRef.current) return
                erasingRef.current = false
                commitDrawChange(canvasEditor)
            }

            canvasEditor.on('mouse:down', onEraserDown)
            canvasEditor.on('mouse:move', onEraserMove)
            canvasEditor.on('mouse:up', onEraserUp)

            return () => {
                erasingRef.current = false
                canvasEditor.off('mouse:down', onEraserDown)
                canvasEditor.off('mouse:move', onEraserMove)
                canvasEditor.off('mouse:up', onEraserUp)
                canvasEditor.defaultCursor = 'default'
                canvasEditor.hoverCursor = 'default'
                if (canvasEditor.upperCanvasEl) canvasEditor.upperCanvasEl.style.cursor = 'default'
            }
        }

        canvasEditor.isDrawingMode = true
        canvasEditor.defaultCursor = 'crosshair'
        canvasEditor.hoverCursor = 'crosshair'

        let brush
        switch (brushType) {
            case 'circle':
                brush = new CircleBrush(canvasEditor)
                break
            case 'spray':
                brush = new SprayBrush(canvasEditor)
                break
            case 'marker': {
                brush = new PencilBrush(canvasEditor)
                brush.strokeLineCap = 'round'
                brush.strokeLineJoin = 'round'
                break
            }
            default:
                brush = new PencilBrush(canvasEditor)
                break
        }

        const effectiveSize = brushType === 'marker' ? brushSize * 3 : brushSize
        brush.width = effectiveSize
        brush.color = hexWithOpacity(brushColor, brushOpacity)

        if (brushType === 'spray') {
            brush.density = Math.max(10, Math.round(brushSize * 2))
            brush.dotWidth = Math.max(1, Math.round(brushSize / 3))
        }

        canvasEditor.freeDrawingBrush = brush

        return () => {
            canvasEditor.isDrawingMode = false
            canvasEditor.defaultCursor = 'default'
            canvasEditor.hoverCursor = 'default'
        }
    }, [canvasEditor, brushType, brushSize, brushColor, brushOpacity, erasePathsAtPointer])

    const clearAllDrawings = () => {
        if (!canvasEditor) return
        const paths = canvasEditor.getObjects().filter(isPathObject)
        if (paths.length === 0) {
            toast.message('No drawings to clear')
            return
        }
        paths.forEach((p) => canvasEditor.remove(p))
        strokeStackRef.current = []
        commitDrawChange(canvasEditor)
        syncPathCount()
        toast.success(`Cleared ${paths.length} stroke(s)`)
    }

    const undoLastStroke = () => {
        if (!canvasEditor) return

        let path = strokeStackRef.current.pop()
        while (path && !canvasEditor.getObjects().includes(path)) {
            path = strokeStackRef.current.pop()
        }

        if (!path) {
            const paths = canvasEditor.getObjects().filter(isPathObject)
            if (paths.length === 0) {
                toast.message('No strokes to undo')
                return
            }
            path = paths[paths.length - 1]
        }

        canvasEditor.remove(path)
        strokeStackRef.current = strokeStackRef.current.filter((p) => p !== path)
        commitDrawChange(canvasEditor)
        syncPathCount()
    }

    if (!canvasEditor) {
        return (
            <div className="p-4">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Canvas not ready</p>
            </div>
        )
    }

    return (
        <div className="space-y-4 overflow-y-auto pr-1 panel-scroll">
            <div className="space-y-2">
                <label className="panel-label">Brush Type</label>
                <div className="grid grid-cols-1 gap-1">
                    {BRUSH_TYPES.map((bt) => {
                        const Icon = bt.icon
                        const isActive = brushType === bt.id
                        return (
                            <motion.button
                                key={bt.id}
                                type="button"
                                onClick={() => setBrushType(bt.id)}
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
                                    <div className="text-xs font-semibold">{bt.label}</div>
                                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{bt.hint}</div>
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
                        onClick={() => setBrushSize(Math.max(1, brushSize - 1))}
                        className="flex items-center justify-center w-8 h-11 rounded-lg editor-interactive shrink-0"
                        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                    >
                        <Minus className="h-3.5 w-3.5" />
                    </button>
                    <ProRulerSlider
                        className="flex-1 min-w-0"
                        label="Size"
                        value={brushSize}
                        min={1}
                        max={100}
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
                        onClick={() => setBrushSize(Math.min(100, brushSize + 1))}
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
                            width: Math.max(2, Math.min(60, brushType === 'marker' ? brushSize * 3 : brushSize)),
                            height: Math.max(2, Math.min(60, brushType === 'marker' ? brushSize * 3 : brushSize)),
                            background: brushType === 'eraser' ? 'var(--bg-elevated)' : brushColor,
                            border: '1px solid var(--border-default)',
                            opacity: brushOpacity / 100,
                            transition: 'all 0.15s ease',
                        }}
                    />
                </div>
            </div>

            <div className="space-y-1.5">
                <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Opacity</label>
                <ProRulerSlider
                    label="Opacity"
                    value={brushOpacity}
                    min={5}
                    max={100}
                    step={1}
                    suffix="%"
                    onChange={setBrushOpacity}
                    visual={{
                        fill: 'rgba(47, 143, 203, 0.45)',
                        accent: dominantColor || '#5eb8ff',
                        trackBg: 'rgba(18, 22, 30, 0.96)',
                    }}
                />
            </div>

            {brushType !== 'eraser' && (
                <div className="space-y-2" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                    <label className="panel-label">Color</label>
                    <Colorful
                        color={HEX_COLOR_PATTERN.test(brushColor) ? brushColor : DEFAULT_BRUSH_COLOR}
                        onChange={(color) => setBrushColor(color.hex)}
                        disableAlpha
                        style={{ width: '100%' }}
                    />
                    <div className="flex items-center gap-3">
                        <input
                            value={brushColor}
                            onChange={(e) => {
                                if (HEX_COLOR_PATTERN.test(e.target.value) || e.target.value.length <= 7)
                                    setBrushColor(e.target.value)
                            }}
                            placeholder="#111827"
                            className="panel-input flex-1 min-w-0"
                        />
                        <div
                            className="h-9 w-9 shrink-0 rounded-lg"
                            style={{
                                backgroundColor: HEX_COLOR_PATTERN.test(brushColor) ? brushColor : DEFAULT_BRUSH_COLOR,
                                border: '1px solid var(--border-default)',
                            }}
                        />
                    </div>
                    <div className="grid grid-cols-6 gap-1.5">
                        {COLOR_SWATCHES.map((color) => (
                            <button
                                key={color}
                                type="button"
                                onClick={() => setBrushColor(color)}
                                className="h-6 rounded-md editor-interactive"
                                style={{
                                    backgroundColor: color,
                                    border: `2px solid ${brushColor.toLowerCase() === color ? 'var(--accent-primary)' : 'transparent'}`,
                                    boxShadow: brushColor.toLowerCase() === color ? '0 0 0 1px rgba(6,184,212,0.3)' : 'none',
                                }}
                            />
                        ))}
                    </div>
                </div>
            )}

            <div className="space-y-1.5" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                <label className="panel-label">Actions ({drawingPaths} strokes)</label>
                <button
                    type="button"
                    onClick={undoLastStroke}
                    disabled={drawingPaths === 0}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive disabled:opacity-35"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                >
                    <Undo2 className="h-3.5 w-3.5" />
                    Undo Last Stroke
                </button>
                <button
                    type="button"
                    onClick={clearAllDrawings}
                    disabled={drawingPaths === 0}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive disabled:opacity-35"
                    style={{ background: 'rgba(239, 68, 68, 0.08)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.2)' }}
                >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear All Drawings
                </button>
            </div>

            <div className="panel-card text-[11px]" style={{ borderColor: 'rgba(6, 184, 212, 0.1)' }}>
                <p className="font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Tips</p>
                <div className="space-y-1" style={{ color: 'var(--text-muted)' }}>
                    <p>• Draw directly on the canvas</p>
                    <p>• Eraser removes vector strokes under the cursor</p>
                    <p>• Drawings sync when you undo, clear, or after edits</p>
                </div>
            </div>
        </div>
    )
}

export default DrawControls
