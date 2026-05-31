import React, { useState, useCallback, useMemo } from 'react'
import { motion } from 'framer-motion'
import { LayoutGrid, Grid2X2, Columns, Rows, GripHorizontal, GripVertical, Check } from 'lucide-react'
import * as fabric from 'fabric'
import { useCanvas } from '../../../../../../../context/context'

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

export default function CollageControls() {
    const { canvasEditor } = useCanvas()
    const [selectedLayout, setSelectedLayout] = useState('2-split-h')
    const [gap, setGap] = useState(10)
    const [padding, setPadding] = useState(10)

    const applyLayout = useCallback(() => {
        if (!canvasEditor || !canvasEditor.canvas) return

        const canvas = canvasEditor.canvas
        const images = canvas.getObjects().filter(obj => obj.type === 'image')

        if (images.length === 0) {
            alert('No images on the canvas to collage!')
            return
        }

        const layout = LAYOUTS.find(l => l.id === selectedLayout)
        if (!layout) return

        const W = canvas.width
        const H = canvas.height
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

        // Apply
        let cellIndex = 0
        images.forEach(img => {
            if (cellIndex >= cells.length) {
                // If there are more images than cells, we hide them or just skip
                // For now, let's just make them invisible or very small? No, let's just skip
                img.set({ visible: false })
                return
            }
            img.set({ visible: true })

            const cell = cells[cellIndex]
            cellIndex++

            // Calculate scale to "cover" the cell
            const imgW = img.width
            const imgH = img.height
            const scaleX = cell.w / imgW
            const scaleY = cell.h / imgH
            const scale = Math.max(scaleX, scaleY) // cover

            // Target center in the cell
            const centerX = cell.x + cell.w / 2
            const centerY = cell.y + cell.h / 2

            // Since image origin is typically left/top, adjust position so center matches
            const currentOriginX = img.originX || 'left'
            const currentOriginY = img.originY || 'top'

            let left = centerX
            let top = centerY

            if (currentOriginX === 'left') {
                left -= (imgW * scale) / 2
            }
            if (currentOriginY === 'top') {
                top -= (imgH * scale) / 2
            }

            img.set({
                scaleX: scale,
                scaleY: scale,
                left,
                top
            })

            // Calculate ClipPath
            // ClipPath needs to be the size of the cell / scale to counteract the image's scale
            const clipW = cell.w / scale
            const clipH = cell.h / scale

            // ClipPath origin must match the image center
            // If image is originX='left', image center in unscaled coords is width/2
            let clipLeft = img.width / 2
            let clipTop = img.height / 2
            
            if (currentOriginX === 'center') clipLeft = 0
            if (currentOriginY === 'center') clipTop = 0

            const clipRect = new fabric.Rect({
                width: clipW,
                height: clipH,
                originX: 'center',
                originY: 'center',
                left: clipLeft,
                top: clipTop
            })

            img.set({ clipPath: clipRect })
        })

        canvas.renderAll()
        canvasEditor.saveHistory?.()

    }, [canvasEditor, selectedLayout, gap, padding])


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
                <motion.button
                    type="button"
                    onClick={applyLayout}
                    whileTap={{ scale: 0.97 }}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold shadow-sm"
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
