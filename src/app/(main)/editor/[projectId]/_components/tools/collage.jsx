"use client"

import React, { useState, useCallback, useEffect } from 'react'
import { motion } from 'framer-motion'
import { LayoutGrid, Grid2X2, Columns, Rows, GripHorizontal, GripVertical, Check } from 'lucide-react'
import { useCanvas } from '../../../../../../../context/context'
import { isPixxelMaskOverlay } from '@/lib/canvas-mask'
import { toast } from 'sonner'

const LAYOUTS = [
    { id: '2-split-h', label: '2 Columns', icon: Columns, cellCount: 2 },
    { id: '2-split-v', label: '2 Rows', icon: Rows, cellCount: 2 },
    { id: '3-grid', label: '3 Grid', icon: GripHorizontal, cellCount: 3 },
    { id: '3-split-v', label: '3 Columns', icon: GripVertical, cellCount: 3 },
    { id: '4-grid', label: '4 Grid', icon: Grid2X2, cellCount: 4 }
]

const LabeledSlider = ({ label, value, min, max, onChange, suffix = 'px' }) => (
    <div className="space-y-1.5">
        <div className="flex justify-between items-center text-[10px]" style={{ color: 'var(--text-secondary)' }}>
            <span className="font-medium">{label}</span>
            <span className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
                {value}{suffix}
            </span>
        </div>
        <input
            type="range"
            min={min}
            max={max}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-full accent-[var(--accent-primary)] editor-interactive"
            style={{
                height: '4px',
                background: 'var(--border-subtle)',
                borderRadius: '2px',
                appearance: 'none'
            }}
        />
    </div>
)

const Section = ({ title, icon: Icon, children }) => (
    <div className="px-4 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-2 mb-3">
            <div className="flex items-center justify-center w-5 h-5 rounded" style={{ background: 'rgba(6,184,212,0.1)' }}>
                <Icon className="w-3 h-3" style={{ color: 'var(--accent-primary)' }} />
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>
                {title}
            </h3>
        </div>
        {children}
    </div>
)

const isVisibleImage = (obj) =>
    obj?.type?.toLowerCase() === 'image' &&
    obj.visible !== false &&
    !isPixxelMaskOverlay(obj)

const getCollageSource = (image) => {
    const stored = image.pixxelCollageSource || image._pixxelCollageSource
    if (stored?.width && stored?.height) return stored

    const source = {
        width: Math.max(1, Number(image.width) || 1),
        height: Math.max(1, Number(image.height) || 1),
        cropX: Math.max(0, Number(image.cropX) || 0),
        cropY: Math.max(0, Number(image.cropY) || 0),
    }
    image.pixxelCollageSource = source
    image._pixxelCollageSource = source
    return source
}

const fitImageToCell = (image, cell) => {
    const source = getCollageSource(image)
    const targetAspect = cell.w / cell.h
    const sourceAspect = source.width / source.height
    let cropWidth = source.width
    let cropHeight = source.height
    let cropX = source.cropX
    let cropY = source.cropY

    if (sourceAspect > targetAspect) {
        cropWidth = source.height * targetAspect
        cropX += (source.width - cropWidth) / 2
    } else {
        cropHeight = source.width / targetAspect
        cropY += (source.height - cropHeight) / 2
    }

    image.set({
        left: cell.x + cell.w / 2,
        top: cell.y + cell.h / 2,
        originX: 'center',
        originY: 'center',
        width: cropWidth,
        height: cropHeight,
        cropX,
        cropY,
        scaleX: cell.w / cropWidth,
        scaleY: cell.h / cropHeight,
        selectable: true,
        evented: true,
    })
    image.setCoords()
}

export default function CollageControls({ project }) {
    const { canvasEditor } = useCanvas()
    const [selectedLayout, setSelectedLayout] = useState('2-split-h')
    const [gap, setGap] = useState(10)
    const [padding, setPadding] = useState(10)
    const [imageCount, setImageCount] = useState(0)

    const syncImageCount = useCallback(() => {
        const images = canvasEditor?.getObjects?.().filter(isVisibleImage) || []
        setImageCount(images.length)
    }, [canvasEditor])

    useEffect(() => {
        if (!canvasEditor) return
        syncImageCount()
        const events = ['object:added', 'object:removed', 'object:modified']
        events.forEach(event => canvasEditor.on(event, syncImageCount))
        return () => events.forEach(event => canvasEditor.off(event, syncImageCount))
    }, [canvasEditor, syncImageCount])

    const applyLayout = useCallback(() => {
        if (!canvasEditor) return

        const images = canvasEditor.getObjects().filter(isVisibleImage)
        const layout = LAYOUTS.find(l => l.id === selectedLayout)
        if (!layout) return

        if (images.length < layout.cellCount) {
            const missing = layout.cellCount - images.length
            toast.error(`Add ${missing} more image${missing === 1 ? '' : 's'} for this layout`)
            return
        }

        const W = Math.max(1, Number(project?.width) || 1)
        const H = Math.max(1, Number(project?.height) || 1)
        const aw = W - 2 * padding
        const ah = H - 2 * padding

        // Compute cells
        const cells = []
        if (selectedLayout === '2-split-h') {
            const cw = (aw - gap) / 2
            cells.push({ x: padding, y: padding, w: cw, h: ah })
            cells.push({ x: padding + cw + gap, y: padding, w: cw, h: ah })
        } else if (selectedLayout === '2-split-v') {
            const ch = (ah - gap) / 2
            cells.push({ x: padding, y: padding, w: aw, h: ch })
            cells.push({ x: padding, y: padding + ch + gap, w: aw, h: ch })
        } else if (selectedLayout === '3-grid') {
            const ch = (ah - gap) / 2
            const cw = (aw - gap) / 2
            cells.push({ x: padding, y: padding, w: aw, h: ch })
            cells.push({ x: padding, y: padding + ch + gap, w: cw, h: ch })
            cells.push({ x: padding + cw + gap, y: padding + ch + gap, w: cw, h: ch })
        } else if (selectedLayout === '3-split-v') {
            const cw = (aw - 2 * gap) / 3
            cells.push({ x: padding, y: padding, w: cw, h: ah })
            cells.push({ x: padding + cw + gap, y: padding, w: cw, h: ah })
            cells.push({ x: padding + 2 * cw + 2 * gap, y: padding, w: cw, h: ah })
        } else if (selectedLayout === '4-grid') {
            const cw = (aw - gap) / 2
            const ch = (ah - gap) / 2
            cells.push({ x: padding, y: padding, w: cw, h: ch })
            cells.push({ x: padding + cw + gap, y: padding, w: cw, h: ch })
            cells.push({ x: padding, y: padding + ch + gap, w: cw, h: ch })
            cells.push({ x: padding + cw + gap, y: padding + ch + gap, w: cw, h: ch })
        }

        canvasEditor.discardActiveObject()
        images.slice(0, cells.length).forEach((image, index) => {
            fitImageToCell(image, cells[index])
            canvasEditor.fire('object:modified', { target: image })
        })

        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.()
        canvasEditor.__saveCanvasState?.()

        const extraCount = images.length - cells.length
        toast.success(`${layout.label} applied to ${cells.length} images`)
        if (extraCount > 0) {
            toast.info(`${extraCount} extra layer${extraCount === 1 ? '' : 's'} left unchanged`)
        }
    }, [canvasEditor, selectedLayout, gap, padding, project?.width, project?.height])

    const layout = LAYOUTS.find(item => item.id === selectedLayout)
    const missingCount = Math.max(0, (layout?.cellCount || 0) - imageCount)


    return (
        <div className="h-full flex flex-col hide-scrollbar" style={{ background: 'var(--bg-panel)' }}>
            <Section title="Layout" icon={LayoutGrid}>
                <div className="grid grid-cols-2 gap-2">
                    {LAYOUTS.map(layout => {
                        const Icon = layout.icon
                        const isActive = selectedLayout === layout.id
                        return (
                            <motion.button
                                key={layout.id}
                                type="button"
                                onClick={() => setSelectedLayout(layout.id)}
                                whileTap={{ scale: 0.95 }}
                                className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-lg editor-interactive relative"
                                style={{
                                    background: isActive ? 'rgba(6,184,212,0.12)' : 'var(--bg-elevated)',
                                    border: `1px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)'
                                }}
                            >
                                <Icon className="w-5 h-5" strokeWidth={1.5} />
                                <span className="text-[10px] font-medium">{layout.label}</span>
                                {isActive && (
                                    <div className="absolute top-1.5 right-1.5">
                                        <div className="bg-[var(--accent-primary)] rounded-full p-0.5">
                                            <Check className="w-2 h-2 text-white" strokeWidth={3} />
                                        </div>
                                    </div>
                                )}
                            </motion.button>
                        )
                    })}
                </div>
            </Section>

            <Section title="Spacing" icon={Rows}>
                <div className="space-y-4">
                    <LabeledSlider
                        label="Gap"
                        value={gap}
                        min={0}
                        max={100}
                        onChange={setGap}
                    />
                    <LabeledSlider
                        label="Padding"
                        value={padding}
                        min={0}
                        max={100}
                        onChange={setPadding}
                    />
                </div>
            </Section>

            <div className="p-4 mt-auto" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <p className="mb-2 text-[10px]" style={{ color: missingCount ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
                    {`${imageCount} visible image${imageCount === 1 ? '' : 's'}${missingCount > 0 ? ` · add ${missingCount} more for this layout` : ' · ready to arrange'}`}
                </p>
                <motion.button
                    type="button"
                    onClick={applyLayout}
                    disabled={missingCount > 0}
                    whileTap={{ scale: 0.97 }}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                    style={{
                        background: 'var(--accent-primary)',
                        color: '#ffffff',
                    }}
                >
                    <LayoutGrid className="w-4 h-4" />
                    Apply Layout
                </motion.button>
            </div>
        </div>
    )
}
