"use client"

import React, { useState, useCallback, useEffect } from 'react'
import { motion } from 'framer-motion'
import { LayoutGrid, Grid2X2, Columns, Rows, GripHorizontal, GripVertical, Check } from 'lucide-react'
import { Rect } from 'fabric'
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

/** Cover scale: the smallest uniform scale that fully fills the cell from the
 *  image's source crop region (overflow on the longer axis = pan room). */
const getCellCoverScale = (image, cell) => {
    const source = getCollageSource(image)
    return Math.max(cell.w / Math.max(1, source.width), cell.h / Math.max(1, source.height))
}

/**
 * Frame an image into a collage cell: scale to COVER the cell, centre it, and
 * clip it to the cell with an absolutely-positioned rect so it can never spill
 * outside its frame (alignment is preserved). The overflow on the non-matching
 * axis is the room the user can drag-to-pan through (`clampToCell` keeps it
 * covering). Rotation/skew are locked so the rectangular cell always stays
 * fully covered; `enterCollageConstraints`/`exitCollageConstraints` toggle that
 * while the tool is open so other tools aren't restricted.
 */
const fitImageToCell = (image, cell) => {
    const source = getCollageSource(image)
    const coverScale = getCellCoverScale(image, cell)

    image.set({
        left: cell.x + cell.w / 2,
        top: cell.y + cell.h / 2,
        originX: 'center',
        originY: 'center',
        width: source.width,
        height: source.height,
        cropX: source.cropX,
        cropY: source.cropY,
        scaleX: coverScale,
        scaleY: coverScale,
        angle: 0,
        selectable: true,
        evented: true,
        lockRotation: true,
        lockSkewingX: true,
        lockSkewingY: true,
        clipPath: new Rect({
            left: cell.x,
            top: cell.y,
            width: Math.max(1, cell.w),
            height: Math.max(1, cell.h),
            originX: 'left',
            originY: 'top',
            absolutePositioned: true,
        }),
    })
    image.pixxelCollageCell = { x: cell.x, y: cell.y, w: cell.w, h: cell.h }
    image._pixxelCollageCell = image.pixxelCollageCell
    image.pixxelCollageCoverScale = coverScale
    image._pixxelCollageCoverScale = coverScale
    image.setCoords()
}

/** Keep a framed image covering its cell — clamp pan so no empty edge shows,
 *  and never let it scale below cover. Returns true if it mutated the image. */
const clampToCell = (image) => {
    const cell = image?.pixxelCollageCell
    if (!cell) return false
    let changed = false

    // Never smaller than cover (would reveal empty cell). Re-clamp from the
    // stored cover scale, recomputed if missing (e.g. after reload).
    const cover = image.pixxelCollageCoverScale || getCellCoverScale(image, cell)
    if (image.scaleX < cover - 1e-4 || image.scaleY < cover - 1e-4) {
        image.set({ scaleX: Math.max(image.scaleX, cover), scaleY: Math.max(image.scaleY, cover) })
        changed = true
    }

    // Centre-origin image: clamp its centre so the scaled half-extent always
    // reaches past the cell edges.
    const halfW = (image.width * image.scaleX) / 2
    const halfH = (image.height * image.scaleY) / 2
    const cx = cell.x + cell.w / 2
    const cy = cell.y + cell.h / 2
    const maxDX = Math.max(0, halfW - cell.w / 2)
    const maxDY = Math.max(0, halfH - cell.h / 2)
    const left = Math.min(cx + maxDX, Math.max(cx - maxDX, image.left))
    const top = Math.min(cy + maxDY, Math.max(cy - maxDY, image.top))
    if (left !== image.left || top !== image.top) {
        image.set({ left, top })
        changed = true
    }
    if (changed) image.setCoords()
    return changed
}

/** Recover a cell from a persisted clipPath (after reload) so panning stays
 *  constrained without re-applying the layout. */
const cellFromClipPath = (image) => {
    const cp = image?.clipPath
    if (!cp || !cp.absolutePositioned) return null
    if ((cp.type || '').toLowerCase() !== 'rect') return null
    return {
        x: cp.left,
        y: cp.top,
        w: (cp.width || 0) * (cp.scaleX || 1),
        h: (cp.height || 0) * (cp.scaleY || 1),
    }
}

const enterCollageConstraints = (image) => {
    image.set({ lockRotation: true, lockSkewingX: true, lockSkewingY: true })
}
const exitCollageConstraints = (image) => {
    image.set({ lockRotation: false, lockSkewingX: false, lockSkewingY: false })
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

    // While the collage tool is open, keep every FRAMED image (one carrying a
    // collage cell, or one we can recover a cell from via its persisted absolute
    // clipPath) panning/scaling INSIDE its cell. Handlers are scoped to this
    // tool so other tools aren't constrained; rotation/skew locks are released
    // when the tool closes.
    useEffect(() => {
        if (!canvasEditor) return undefined
        canvasEditor.getObjects().filter(isVisibleImage).forEach((img) => {
            if (!img.pixxelCollageCell) {
                const cell = cellFromClipPath(img)
                if (cell) {
                    img.pixxelCollageCell = cell
                    img._pixxelCollageCell = cell
                    img.pixxelCollageCoverScale = getCellCoverScale(img, cell)
                }
            }
            if (img.pixxelCollageCell) enterCollageConstraints(img)
        })

        const onMoving = (e) => { if (e?.target?.pixxelCollageCell) clampToCell(e.target) }
        const onScaling = (e) => { if (e?.target?.pixxelCollageCell) clampToCell(e.target) }
        const onModified = (e) => {
            if (e?.target?.pixxelCollageCell && clampToCell(e.target)) canvasEditor.requestRenderAll()
        }
        canvasEditor.on('object:moving', onMoving)
        canvasEditor.on('object:scaling', onScaling)
        canvasEditor.on('object:modified', onModified)
        canvasEditor.requestRenderAll()
        return () => {
            canvasEditor.off('object:moving', onMoving)
            canvasEditor.off('object:scaling', onScaling)
            canvasEditor.off('object:modified', onModified)
            canvasEditor.getObjects?.().filter(isVisibleImage).forEach((img) => {
                if (img.pixxelCollageCell) exitCollageConstraints(img)
            })
            canvasEditor.requestRenderAll()
        }
    }, [canvasEditor])

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
        // Clamp the usable area + gap so an over-large padding/gap (relative to a
        // small canvas) can't produce negative/NaN cell sizes.
        const safeGap = Math.max(0, Math.min(gap, Math.min(W, H) / 2))
        const aw = Math.max(1, W - 2 * padding)
        const ah = Math.max(1, H - 2 * padding)

        // Compute cells (safeGap guards against an over-large gap on a small canvas)
        const cells = []
        if (selectedLayout === '2-split-h') {
            const cw = (aw - safeGap) / 2
            cells.push({ x: padding, y: padding, w: cw, h: ah })
            cells.push({ x: padding + cw + safeGap, y: padding, w: cw, h: ah })
        } else if (selectedLayout === '2-split-v') {
            const ch = (ah - safeGap) / 2
            cells.push({ x: padding, y: padding, w: aw, h: ch })
            cells.push({ x: padding, y: padding + ch + safeGap, w: aw, h: ch })
        } else if (selectedLayout === '3-grid') {
            const ch = (ah - safeGap) / 2
            const cw = (aw - safeGap) / 2
            cells.push({ x: padding, y: padding, w: aw, h: ch })
            cells.push({ x: padding, y: padding + ch + safeGap, w: cw, h: ch })
            cells.push({ x: padding + cw + safeGap, y: padding + ch + safeGap, w: cw, h: ch })
        } else if (selectedLayout === '3-split-v') {
            const cw = (aw - 2 * safeGap) / 3
            cells.push({ x: padding, y: padding, w: cw, h: ah })
            cells.push({ x: padding + cw + safeGap, y: padding, w: cw, h: ah })
            cells.push({ x: padding + 2 * cw + 2 * safeGap, y: padding, w: cw, h: ah })
        } else if (selectedLayout === '4-grid') {
            const cw = (aw - safeGap) / 2
            const ch = (ah - safeGap) / 2
            cells.push({ x: padding, y: padding, w: cw, h: ch })
            cells.push({ x: padding + cw + safeGap, y: padding, w: cw, h: ch })
            cells.push({ x: padding, y: padding + ch + safeGap, w: cw, h: ch })
            cells.push({ x: padding + cw + safeGap, y: padding + ch + safeGap, w: cw, h: ch })
        }
        // Final guard: no cell can be sub-pixel (would make cover scale blow up).
        cells.forEach((c) => { c.w = Math.max(1, c.w); c.h = Math.max(1, c.h) })

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
