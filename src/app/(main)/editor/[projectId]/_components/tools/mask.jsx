"use client"

import React, { useCallback, useRef, useState } from 'react'
import {
    ArrowDown, ArrowDownLeft, ArrowDownRight, ArrowLeft, ArrowRight,
    ArrowUp, ArrowUpLeft, ArrowUpRight,
    Blend, ChevronDown, ChevronRight, Crosshair,
    Loader2, Palette, Scissors, Sparkles, Sun,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import { useCanvas } from '../../../../../../../context/context'
import usePixelMaskTool, { MIN_BRUSH, MAX_BRUSH } from '../../../../../../../hooks/usePixelMaskTool'
import {
    BrushSizeControl,
    LabeledSlider,
    MaskActionButtons,
    ModeToggle,
    TipCard,
    ToolEmptyState,
} from './_pixel-tool-ui'

/* ─── collapsible section ─── */
const Section = ({ title, icon: Icon, defaultOpen = false, children, badge }) => {
    const [open, setOpen] = useState(defaultOpen)
    return (
        <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                className="flex w-full items-center gap-2 py-2.5 px-1 text-left group"
                style={{ color: 'var(--text-secondary)' }}
            >
                {Icon && <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />}
                <span className="text-xs font-semibold flex-1 tracking-wide uppercase">{title}</span>
                {badge && (
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                        style={{ background: 'rgba(6,184,212,0.12)', color: 'var(--accent-primary)' }}>
                        {badge}
                    </span>
                )}
                {open
                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform" style={{ color: 'var(--text-muted)' }} />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform" style={{ color: 'var(--text-muted)' }} />
                }
            </button>
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: 'easeInOut' }}
                        className="overflow-hidden"
                    >
                        <div className="pb-3 space-y-3 px-0.5">
                            {children}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

/* ─── gradient direction icons ─── */
const DIRECTIONS = [
    { id: 'top', icon: ArrowUp, label: 'Top → Bottom' },
    { id: 'bottom', icon: ArrowDown, label: 'Bottom → Top' },
    { id: 'left', icon: ArrowLeft, label: 'Left → Right' },
    { id: 'right', icon: ArrowRight, label: 'Right → Left' },
    { id: 'top-left', icon: ArrowUpLeft, label: 'Top-Left' },
    { id: 'top-right', icon: ArrowUpRight, label: 'Top-Right' },
    { id: 'bottom-left', icon: ArrowDownLeft, label: 'Bottom-Left' },
    { id: 'bottom-right', icon: ArrowDownRight, label: 'Bottom-Right' },
]

/* ─── color swatch component ─── */
const ColorSwatch = ({ color, size = 24 }) => {
    if (!color) return null
    return (
        <div
            className="rounded border shrink-0"
            style={{
                width: size, height: size,
                background: `rgb(${color.r}, ${color.g}, ${color.b})`,
                borderColor: 'var(--border-subtle)',
            }}
        />
    )
}

const MaskControls = ({ dominantColor }) => {
    const { canvasEditor } = useCanvas()
    const tool = usePixelMaskTool({ canvasEditor, defaultMode: 'erase', supportsMagic: false })

    // AI Subject Selection state
    const [isSegmenting, setIsSegmenting] = useState(false)

    // Color Range state
    const [colorPickerActive, setColorPickerActive] = useState(false)
    const [pickedColor, setPickedColor] = useState(null)
    const [colorTolerance, setColorTolerance] = useState(35)
    const colorPickerRef = useRef(null)

    // Luminance Range state
    const [lumaMin, setLumaMin] = useState(0)
    const [lumaMax, setLumaMax] = useState(128)

    // Gradient state
    const [gradDirection, setGradDirection] = useState('bottom')
    const [gradPosition, setGradPosition] = useState(50)
    const [gradFeather, setGradFeather] = useState(30)

    /* ─── AI Subject Selection ─── */
    const handleSelectSubject = useCallback(async () => {
        if (!tool.mainImage || isSegmenting) return
        setIsSegmenting(true)

        try {
            // Get the source image as a blob
            const fabricObj = tool.mainImage
            const sourceEl = fabricObj?._element || fabricObj?.getElement?.()
            if (!sourceEl) throw new Error('Cannot access image element')

            // Draw source to canvas and export as blob
            const c = document.createElement('canvas')
            const origW = sourceEl.naturalWidth || sourceEl.width || fabricObj.width
            const origH = sourceEl.naturalHeight || sourceEl.height || fabricObj.height
            // Cap to 1024 for upload size
            const scale = Math.min(1, 1024 / Math.max(origW, origH))
            c.width = Math.round(origW * scale)
            c.height = Math.round(origH * scale)
            const ctx = c.getContext('2d')
            ctx.drawImage(sourceEl, 0, 0, c.width, c.height)

            const blob = await new Promise((resolve, reject) => {
                c.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', 0.85)
            })

            const form = new FormData()
            form.append('image', blob, 'image.jpg')

            const resp = await fetch('/api/ai/segment', { method: 'POST', body: form })
            if (!resp.ok) {
                const errJson = await resp.json().catch(() => ({}))
                throw new Error(errJson.error || `Segmentation failed (${resp.status})`)
            }

            const maskBlob = await resp.blob()
            const applied = await tool.applyExternalMaskBlob(maskBlob)
            if (applied) {
                toast.success('Subject selected! Use brush to refine.')
            } else {
                toast.error('Could not apply subject mask')
            }
        } catch (err) {
            console.error('[mask] AI subject selection failed:', err)
            toast.error(err?.message || 'AI subject selection failed')
        } finally {
            setIsSegmenting(false)
        }
    }, [tool, isSegmenting])

    /* ─── Color Range ─── */
    const handleColorPick = useCallback((e) => {
        if (!colorPickerActive || !tool.mainImage) return

        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas) return

        // Get the pixel color at click position from the canvas
        const pointer = fabricCanvas.getPointer(e.e || e)
        const fabricObj = tool.mainImage
        const sourceEl = fabricObj?._element || fabricObj?.getElement?.()
        if (!sourceEl) return

        // Transform pointer to image coordinates
        const imgW = sourceEl.naturalWidth || sourceEl.width || fabricObj.width
        const imgH = sourceEl.naturalHeight || sourceEl.height || fabricObj.height
        const objLeft = fabricObj.left || 0
        const objTop = fabricObj.top || 0
        const objScaleX = fabricObj.scaleX || 1
        const objScaleY = fabricObj.scaleY || 1

        const localX = (pointer.x - objLeft) / objScaleX
        const localY = (pointer.y - objTop) / objScaleY

        if (localX < 0 || localY < 0 || localX >= imgW || localY >= imgH) return

        // Read the pixel color
        const c = document.createElement('canvas')
        c.width = imgW
        c.height = imgH
        const ctx = c.getContext('2d', { willReadFrequently: true })
        try { ctx.drawImage(sourceEl, 0, 0) } catch { return }

        const pixel = ctx.getImageData(Math.floor(localX), Math.floor(localY), 1, 1).data
        const color = { r: pixel[0], g: pixel[1], b: pixel[2] }
        setPickedColor(color)
        setColorPickerActive(false)

        // Apply the color range mask
        tool.applyColorRangeMask({ ...color, tolerance: colorTolerance })
    }, [colorPickerActive, tool, canvasEditor, colorTolerance])

    // Attach/detach canvas click listener for color picker
    React.useEffect(() => {
        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas) return

        if (colorPickerActive) {
            fabricCanvas.defaultCursor = 'crosshair'
            fabricCanvas.on('mouse:down', handleColorPick)
            return () => {
                fabricCanvas.defaultCursor = 'default'
                fabricCanvas.off('mouse:down', handleColorPick)
            }
        }
    }, [colorPickerActive, canvasEditor, handleColorPick])

    const handleApplyColorRange = useCallback(() => {
        if (!pickedColor) return
        tool.applyColorRangeMask({ ...pickedColor, tolerance: colorTolerance })
    }, [tool, pickedColor, colorTolerance])

    /* ─── Luminance Range ─── */
    const handleApplyLuminance = useCallback(() => {
        tool.applyLuminanceRangeMask({ minLuma: lumaMin, maxLuma: lumaMax })
    }, [tool, lumaMin, lumaMax])

    /* ─── Gradient ─── */
    const handleApplyGradient = useCallback(() => {
        tool.applyLinearGradientMask({
            direction: gradDirection,
            position: gradPosition,
            featherPct: gradFeather,
        })
    }, [tool, gradDirection, gradPosition, gradFeather])

    if (!canvasEditor) {
        return (
            <div className="p-4">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Canvas not ready</p>
            </div>
        )
    }

    if (!tool.mainImage) {
        return (
            <ToolEmptyState
                icon={Scissors}
                title="No image on canvas"
                subtitle="Add an image first, then use the mask tool"
            />
        )
    }

    return (
        <div className="space-y-0 overflow-y-auto pr-1 panel-scroll">
            {/* ────────── AI Masking ────────── */}
            <Section title="AI Masking" icon={Sparkles} defaultOpen={true} badge="AI">
                <motion.button
                    type="button"
                    onClick={handleSelectSubject}
                    disabled={isSegmenting}
                    whileTap={{ scale: 0.97 }}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-50"
                    style={{
                        background: 'linear-gradient(135deg, rgba(6,184,212,0.15) 0%, rgba(124,58,237,0.12) 100%)',
                        border: '1px solid rgba(6,184,212,0.25)',
                        color: 'var(--accent-primary)',
                    }}
                >
                    {isSegmenting ? (
                        <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Detecting Subject…
                        </>
                    ) : (
                        <>
                            <Sparkles className="h-4 w-4" />
                            Select Subject
                        </>
                    )}
                </motion.button>
                <p className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>
                    AI detects and masks the main subject
                </p>
            </Section>

            {/* ────────── Color Range ────────── */}
            <Section title="Color Range" icon={Palette}>
                <div className="flex items-center gap-2">
                    <motion.button
                        type="button"
                        onClick={() => setColorPickerActive(v => !v)}
                        whileTap={{ scale: 0.95 }}
                        className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive flex-1"
                        style={{
                            background: colorPickerActive
                                ? 'rgba(6,184,212,0.12)'
                                : 'var(--bg-elevated)',
                            border: `1px solid ${colorPickerActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                            color: colorPickerActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
                        }}
                    >
                        <Crosshair className="h-3.5 w-3.5" />
                        {colorPickerActive ? 'Click image to pick…' : 'Pick Color'}
                    </motion.button>
                    {pickedColor && <ColorSwatch color={pickedColor} />}
                </div>

                {pickedColor && (
                    <div className="space-y-2">
                        <LabeledSlider
                            label="Tolerance"
                            value={colorTolerance}
                            min={5}
                            max={100}
                            suffix=""
                            onChange={setColorTolerance}
                            dominantColor={dominantColor}
                        />
                        <motion.button
                            type="button"
                            onClick={handleApplyColorRange}
                            whileTap={{ scale: 0.97 }}
                            className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
                            style={{
                                background: 'var(--bg-elevated)',
                                border: '1px solid var(--border-subtle)',
                                color: 'var(--text-secondary)',
                            }}
                        >
                            <Palette className="h-3.5 w-3.5" />
                            Apply Color Selection
                        </motion.button>
                    </div>
                )}
            </Section>

            {/* ────────── Luminance Range ────────── */}
            <Section title="Luminance Range" icon={Sun}>
                <div className="space-y-2">
                    <LabeledSlider
                        label="Min Brightness"
                        value={lumaMin}
                        min={0}
                        max={254}
                        suffix=""
                        onChange={(v) => { setLumaMin(Math.min(v, lumaMax - 1)) }}
                        dominantColor={dominantColor}
                    />
                    <LabeledSlider
                        label="Max Brightness"
                        value={lumaMax}
                        min={1}
                        max={255}
                        suffix=""
                        onChange={(v) => { setLumaMax(Math.max(v, lumaMin + 1)) }}
                        dominantColor={dominantColor}
                    />
                    <motion.button
                        type="button"
                        onClick={handleApplyLuminance}
                        whileTap={{ scale: 0.97 }}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
                        style={{
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border-subtle)',
                            color: 'var(--text-secondary)',
                        }}
                    >
                        <Sun className="h-3.5 w-3.5" />
                        Apply Luminance Selection
                    </motion.button>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        Select shadows (low) or highlights (high)
                    </p>
                </div>
            </Section>

            {/* ────────── Linear Gradient ────────── */}
            <Section title="Linear Gradient" icon={Blend}>
                <div className="space-y-3">
                    {/* Direction grid */}
                    <div>
                        <label className="text-[10px] block mb-1.5" style={{ color: 'var(--text-muted)' }}>Direction</label>
                        <div className="grid grid-cols-4 gap-1">
                            {DIRECTIONS.map(d => {
                                const DirIcon = d.icon
                                const active = gradDirection === d.id
                                return (
                                    <motion.button
                                        key={d.id}
                                        type="button"
                                        onClick={() => setGradDirection(d.id)}
                                        whileTap={{ scale: 0.9 }}
                                        className="flex items-center justify-center rounded-md p-1.5 editor-interactive"
                                        style={{
                                            background: active ? 'rgba(6,184,212,0.12)' : 'var(--bg-elevated)',
                                            border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                            color: active ? 'var(--accent-primary)' : 'var(--text-muted)',
                                        }}
                                        title={d.label}
                                    >
                                        <DirIcon className="h-3.5 w-3.5" />
                                    </motion.button>
                                )
                            })}
                        </div>
                    </div>

                    <LabeledSlider
                        label="Position"
                        value={gradPosition}
                        min={10}
                        max={90}
                        suffix="%"
                        onChange={setGradPosition}
                        dominantColor={dominantColor}
                    />
                    <LabeledSlider
                        label="Feather"
                        value={gradFeather}
                        min={5}
                        max={80}
                        suffix="%"
                        onChange={setGradFeather}
                        dominantColor={dominantColor}
                    />
                    <motion.button
                        type="button"
                        onClick={handleApplyGradient}
                        whileTap={{ scale: 0.97 }}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
                        style={{
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border-subtle)',
                            color: 'var(--text-secondary)',
                        }}
                    >
                        <Blend className="h-3.5 w-3.5" />
                        Apply Gradient Mask
                    </motion.button>
                </div>
            </Section>

            {/* ────────── Brush (manual) ────────── */}
            <Section title="Brush" icon={Scissors} defaultOpen={true}>
                <ModeToggle mode={tool.mode} setMode={tool.setMode} altActive={tool.altActive} />
                <BrushSizeControl
                    value={tool.brushSize}
                    setValue={tool.setBrushSize}
                    min={MIN_BRUSH}
                    max={MAX_BRUSH}
                    dominantColor={dominantColor}
                />
                <LabeledSlider label="Hardness" value={tool.hardness} min={1} max={100} suffix="%" onChange={tool.setHardness} dominantColor={dominantColor} />
                <LabeledSlider label="Flow" value={tool.flow} min={5} max={100} suffix="%" onChange={tool.setFlow} dominantColor={dominantColor} />
                <LabeledSlider label="Edge Feather" value={tool.feather} min={0} max={50} suffix="px" onChange={tool.setFeather} dominantColor={dominantColor} />
            </Section>

            {/* ────────── Actions ────────── */}
            <div style={{ paddingTop: '4px' }}>
                <MaskActionButtons
                    hasMask={tool.hasMask}
                    undoDepth={tool.undoDepth}
                    redoDepth={tool.redoDepth}
                    onUndo={tool.undo}
                    onRedo={tool.redo}
                    onInvert={tool.invert}
                    onClear={tool.clear}
                />
            </div>

            <TipCard>
                <p>• <strong>Select Subject</strong> uses AI to mask the main object</p>
                <p>• <strong>Color Range</strong> selects pixels by color (click to sample)</p>
                <p>• <strong>Luminance</strong> selects by brightness level</p>
                <p>• <strong>Gradient</strong> creates a smooth directional mask</p>
                <p>• <strong>Brush</strong> for manual fine-tuning</p>
                <p>• All masks can be refined with <strong>Erase/Restore</strong> brush</p>
            </TipCard>
        </div>
    )
}

export default MaskControls
