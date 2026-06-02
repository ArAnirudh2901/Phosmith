"use client"

import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    ChevronDown, ChevronUp, Eye, EyeOff, Minus, Plus,
    Eraser, Paintbrush, RotateCcw, Redo2, Trash2, Undo2,
} from 'lucide-react'
import { ProRulerSlider } from '@/components/editor/ProRulerSlider'
import { hexToRgba } from '@/lib/color-utils'

/**
 * Shared presentational pieces for the pixel-paint tools (Mask + Erase) so both
 * panels look and behave identically. Logic lives in usePixelMaskTool.
 */

const MODES = [
    { id: 'erase', label: 'Erase', icon: Eraser, hint: 'Paint to hide areas' },
    { id: 'restore', label: 'Restore', icon: Paintbrush, hint: 'Paint hidden areas back' },
]

export function ModeToggle({ mode, setMode, altActive }) {
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <label className="panel-label">Brush Mode</label>
                {altActive && (
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                        style={{ background: 'rgba(6,184,212,0.15)', color: 'var(--accent-primary)' }}>
                        ALT · inverted
                    </span>
                )}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
                {MODES.map((m) => {
                    const Icon = m.icon
                    const isActive = mode === m.id
                    return (
                        <motion.button
                            key={m.id}
                            type="button"
                            onClick={() => setMode(m.id)}
                            whileTap={{ scale: 0.97 }}
                            className="flex flex-col items-center gap-1.5 rounded-lg px-2 py-2.5 editor-interactive"
                            style={{
                                background: isActive ? 'rgba(6, 184, 212, 0.1)' : 'transparent',
                                border: `1px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
                            }}
                        >
                            <Icon className="h-4 w-4" />
                            <span className="text-xs font-semibold">{m.label}</span>
                            <span className="text-[9px] leading-tight text-center" style={{ color: 'var(--text-muted)' }}>{m.hint}</span>
                        </motion.button>
                    )
                })}
            </div>
        </div>
    )
}

export function BrushSizeControl({ value, setValue, min, max, dominantColor }) {
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <label className="panel-label">Brush Size</label>
                <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                    [ / ] to resize
                </span>
            </div>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => setValue(Math.max(min, value - 5))}
                    className="flex items-center justify-center w-8 h-11 rounded-lg editor-interactive shrink-0"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                >
                    <Minus className="h-3.5 w-3.5" />
                </button>
                <ProRulerSlider
                    className="flex-1 min-w-0"
                    label="Size"
                    value={value}
                    min={min}
                    max={max}
                    step={1}
                    suffix="px"
                    onChange={setValue}
                    visual={{
                        fill: 'rgba(47, 143, 203, 0.45)',
                        accent: dominantColor || '#5eb8ff',
                        trackBg: 'rgba(18, 22, 30, 0.96)',
                    }}
                />
                <button
                    type="button"
                    onClick={() => setValue(Math.min(max, value + 5))}
                    className="flex items-center justify-center w-8 h-11 rounded-lg editor-interactive shrink-0"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                >
                    <Plus className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    )
}

export function LabeledSlider({ label, value, min, max, step = 1, suffix = '%', onChange, dominantColor }) {
    return (
        <div className="space-y-1.5">
            <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{label}</label>
            <ProRulerSlider
                label={label}
                value={value}
                min={min}
                max={max}
                step={step}
                suffix={suffix}
                onChange={onChange}
                visual={{
                    fill: 'rgba(47, 143, 203, 0.45)',
                    accent: dominantColor || '#5eb8ff',
                    trackBg: 'rgba(18, 22, 30, 0.96)',
                }}
            />
        </div>
    )
}

export function MaskActionButtons({ hasMask, undoDepth, redoDepth, onUndo, onRedo, onInvert, onClear }) {
    return (
        <div className="space-y-1.5" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
            <label className="panel-label">Actions</label>
            <div className="grid grid-cols-2 gap-1.5">
                <button
                    type="button"
                    onClick={onUndo}
                    disabled={undoDepth === 0}
                    className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium editor-interactive disabled:opacity-35"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                >
                    <Undo2 className="h-3.5 w-3.5" />
                    Undo
                </button>
                <button
                    type="button"
                    onClick={onRedo}
                    disabled={redoDepth === 0}
                    className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium editor-interactive disabled:opacity-35"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                >
                    <Redo2 className="h-3.5 w-3.5" />
                    Redo
                </button>
            </div>
            <button
                type="button"
                onClick={onInvert}
                disabled={!hasMask}
                className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive disabled:opacity-35"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
            >
                <RotateCcw className="h-3.5 w-3.5" />
                Invert
            </button>
            <button
                type="button"
                onClick={onClear}
                disabled={!hasMask}
                className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive disabled:opacity-35"
                style={{ background: 'rgba(239, 68, 68, 0.08)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.2)' }}
            >
                <Trash2 className="h-3.5 w-3.5" />
                Reset
            </button>
        </div>
    )
}

export function ToolEmptyState({ icon: Icon, title, subtitle }) {
    return (
        <div className="p-4 text-center">
            <Icon className="h-8 w-8 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
            <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{title}</p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>
        </div>
    )
}

export function TipCard({ title = 'Tips', children }) {
    return (
        <div className="panel-card text-[11px]" style={{ borderColor: 'rgba(6, 184, 212, 0.1)' }}>
            <p className="font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{title}</p>
            <div className="space-y-1" style={{ color: 'var(--text-muted)' }}>
                {children}
            </div>
        </div>
    )
}

/* ─── Megashader chain UI (Step 2) ─────────────────────────────────────── */

/**
 * Visual badge showing which megashader mask kind a layer is. Each kind
 * has a distinct colour so the chain is scannable. Used in `MaskChainCard`
 * and the test panel.
 */
const KIND_META = {
    luminance:  { label: 'Luminance', color: '#facc15', step: 2 },
    color:      { label: 'Color',     color: '#f97316', step: 2 },
    linear:     { label: 'Linear',    color: '#22d3ee', step: 3 },
    radial:     { label: 'Radial',    color: '#a78bfa', step: 3 },
    smartBrush: { label: 'Smart Brush', color: '#34d399', step: 4 },
    semantic:   { label: 'AI Subject', color: '#f472b6', step: 5 },
    depth:      { label: 'Depth Map', color: '#60a5fa', step: 6 },
}

export const getKindMeta = (kind) => KIND_META[kind] || { label: kind, color: '#94a3b8', step: null }

const OPS = [
    { id: 'add', label: 'Add' },
    { id: 'subtract', label: 'Subtract' },
    { id: 'intersect', label: 'Intersect' },
]

/**
 * Step 8 — Universal per-layer image-adjustment editor. Renders the four
 * adjustment sliders (Exposure/Contrast/Saturation/Brightness) that are
 * available on EVERY mask layer regardless of kind. The math happens in
 * the GLSL `applyLayerAdjust_<slot>(rgb)` function emitted by
 * `buildLayerAdjustFunction` in glsl-fragments.js; this component is
 * just a presentational wrapper.
 *
 * The sliders are also a "Reset" button that zeros all four fields in
 * one click — common workflow when iterating on adjustments.
 */
function LayerAdjustEditor({ layer, onUpdate, dominantColor }) {
    const reset = () => onUpdate({ exposure: 0, contrast: 0, saturation: 0, brightness: 0 })
    const anyActive = (layer.exposure || layer.contrast || layer.saturation || layer.brightness)
    return (
        <div className="space-y-2 pt-2" style={{ borderTop: '1px dashed var(--border-subtle)' }}>
            <div className="flex items-center justify-between">
                <span
                    className="text-[9px] font-bold uppercase tracking-wider"
                    style={{ color: 'var(--text-muted)' }}
                >
                    Adjustments (this layer)
                </span>
                <button
                    type="button"
                    onClick={reset}
                    disabled={!anyActive}
                    className="text-[9px] px-1.5 py-0.5 rounded editor-interactive disabled:opacity-30"
                    style={{
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--text-secondary)',
                    }}
                >
                    Reset
                </button>
            </div>
            <LabeledSlider
                label="Exposure"
                value={Math.round((layer.exposure ?? 0) * 10) / 10}
                min={-3} max={3} step={0.1} suffix=" EV"
                onChange={(v) => onUpdate({ exposure: v })}
                dominantColor={dominantColor}
            />
            <LabeledSlider
                label="Contrast"
                value={Math.round(layer.contrast ?? 0)}
                min={-100} max={100} step={1} suffix="%"
                onChange={(v) => onUpdate({ contrast: v })}
                dominantColor={dominantColor}
            />
            <LabeledSlider
                label="Saturation"
                value={Math.round(layer.saturation ?? 0)}
                min={-100} max={100} step={1} suffix="%"
                onChange={(v) => onUpdate({ saturation: v })}
                dominantColor={dominantColor}
            />
            <LabeledSlider
                label="Brightness"
                value={Math.round(layer.brightness ?? 0)}
                min={-100} max={100} step={1} suffix="%"
                onChange={(v) => onUpdate({ brightness: v })}
                dominantColor={dominantColor}
            />
        </div>
    )
}

/**
 * Per-kind parameter editor. Renders sliders for luminance; a colour
 * swatch + sliders for color; and a "Coming in Step N" placeholder for
 * the kinds Step 2 doesn't yet implement. The parent passes a callback
 * for value updates — this component is presentational.
 *
 * Step 8: every kind editor now ALSO renders `LayerAdjustEditor`
 * underneath the kind-specific controls, so adjustments are universal.
 */
export function KindParamEditor({ layer, onUpdate, dominantColor, imageSize }) {
    const meta = getKindMeta(layer.kind)
    let kindSpecific = null
    if (layer.kind === 'luminance') {
        kindSpecific = (
            <>
                <LabeledSlider
                    label="Min brightness"
                    value={Math.round((layer.min ?? 0) * 255)}
                    min={0} max={254} step={1} suffix=""
                    onChange={(v) => onUpdate({ min: Math.min(v / 255, (layer.max ?? 0.5) - 0.004) })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Max brightness"
                    value={Math.round((layer.max ?? 0.5) * 255)}
                    min={1} max={255} step={1} suffix=""
                    onChange={(v) => onUpdate({ max: Math.max(v / 255, (layer.min ?? 0) + 0.004) })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Softness"
                    value={Math.round((layer.softness ?? 0.1) * 100)}
                    min={0} max={50} step={1} suffix="%"
                    onChange={(v) => onUpdate({ softness: v / 100 })}
                    dominantColor={dominantColor}
                />
            </>
        )
    } else if (layer.kind === 'color') {
        const target = layer.target || { h: 0, s: 1, b: 1 }
        const setTarget = (patch) => onUpdate({ target: { ...target, ...patch } })
        // Render a 6×6×6 RGB preview so the user can see what the target is
        // without bringing in a full colour picker. (Step 7 polish can swap
        // this for @uiw/react-color-colorful when the design system is ready.)
        const swatch = `hsl(${target.h}, ${Math.round(target.s * 100)}%, ${Math.round(target.b * 50)}%)`
        kindSpecific = (
            <>
                <div className="flex items-center gap-2">
                    <div
                        className="w-6 h-6 rounded border shrink-0"
                        style={{ background: swatch, borderColor: 'var(--border-subtle)' }}
                        title={`HSL ${Math.round(target.h)}°, ${Math.round(target.s * 100)}%, ${Math.round(target.b * 100)}%`}
                    />
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        Target colour
                    </span>
                </div>
                <LabeledSlider
                    label="Hue"
                    value={Math.round(target.h || 0)}
                    min={0} max={360} step={1} suffix="°"
                    onChange={(v) => setTarget({ h: v })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Saturation"
                    value={Math.round((target.s || 0) * 100)}
                    min={0} max={100} step={1} suffix="%"
                    onChange={(v) => setTarget({ s: v / 100 })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Brightness"
                    value={Math.round((target.b || 0) * 100)}
                    min={0} max={100} step={1} suffix="%"
                    onChange={(v) => setTarget({ b: v / 100 })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Tolerance"
                    value={Math.round((layer.tolerance ?? 0.15) * 100)}
                    min={1} max={50} step={1} suffix="%"
                    onChange={(v) => onUpdate({ tolerance: v / 100 })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Softness"
                    value={Math.round((layer.softness ?? 0.1) * 100)}
                    min={0} max={50} step={1} suffix="%"
                    onChange={(v) => onUpdate({ softness: v / 100 })}
                    dominantColor={dominantColor}
                />
            </>
        )
    } else if (layer.kind === 'linear') {
        const p1 = layer.p1 || { x: 0, y: 0 }
        const p2 = layer.p2 || { x: 100, y: 0 }
        const setP1 = (patch) => onUpdate({ p1: { ...p1, ...patch } })
        const setP2 = (patch) => onUpdate({ p2: { ...p2, ...patch } })
        const w = imageSize?.width || 1000
        const h = imageSize?.height || 1000
        kindSpecific = (
            <>
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Drag on the canvas, or type exact coordinates below.
                </p>
                <LabeledSlider
                    label="P1 X"
                    value={Math.round(p1.x)}
                    min={0} max={w} step={1} suffix="px"
                    onChange={(v) => setP1({ x: v })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="P1 Y"
                    value={Math.round(p1.y)}
                    min={0} max={h} step={1} suffix="px"
                    onChange={(v) => setP1({ y: v })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="P2 X"
                    value={Math.round(p2.x)}
                    min={0} max={w} step={1} suffix="px"
                    onChange={(v) => setP2({ x: v })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="P2 Y"
                    value={Math.round(p2.y)}
                    min={0} max={h} step={1} suffix="px"
                    onChange={(v) => setP2({ y: v })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Position"
                    value={Math.round((layer.position ?? 0.5) * 100)}
                    min={0} max={100} step={1} suffix="%"
                    onChange={(v) => onUpdate({ position: v / 100 })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Feather"
                    value={Math.round((layer.feather ?? 0.1) * 100)}
                    min={0} max={50} step={1} suffix="%"
                    onChange={(v) => onUpdate({ feather: v / 100 })}
                    dominantColor={dominantColor}
                />
            </>
        )
    } else if (layer.kind === 'radial') {
        const center = layer.center || { x: 0, y: 0 }
        const radius = layer.radius || { x: 100, y: 100 }
        const setCenter = (patch) => onUpdate({ center: { ...center, ...patch } })
        const setRadius = (patch) => onUpdate({ radius: { ...radius, ...patch } })
        const w = imageSize?.width || 1000
        const h = imageSize?.height || 1000
        // Rotation: store radians internally; display degrees for users.
        const rotationDeg = Math.round(((layer.rotation ?? 0) * 180) / Math.PI)
        kindSpecific = (
            <>
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Drag a bounding box on the canvas, or type exact values below.
                </p>
                <LabeledSlider
                    label="Center X"
                    value={Math.round(center.x)}
                    min={0} max={w} step={1} suffix="px"
                    onChange={(v) => setCenter({ x: v })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Center Y"
                    value={Math.round(center.y)}
                    min={0} max={h} step={1} suffix="px"
                    onChange={(v) => setCenter({ y: v })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Radius X"
                    value={Math.round(radius.x)}
                    min={1} max={w} step={1} suffix="px"
                    onChange={(v) => setRadius({ x: Math.max(1, v) })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Radius Y"
                    value={Math.round(radius.y)}
                    min={1} max={h} step={1} suffix="px"
                    onChange={(v) => setRadius({ y: Math.max(1, v) })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Rotation"
                    value={rotationDeg}
                    min={0} max={359} step={1} suffix="°"
                    onChange={(v) => onUpdate({ rotation: (v * Math.PI) / 180 })}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Feather"
                    value={Math.round((layer.feather ?? 0.1) * 100)}
                    min={0} max={50} step={1} suffix="%"
                    onChange={(v) => onUpdate({ feather: v / 100 })}
                    dominantColor={dominantColor}
                />
            </>
        )
    } else if (layer.kind === 'smartBrush') {
        kindSpecific = (
            <>
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Bilateral filter applied to the painted alpha. Larger
                    radius = more neighbours contribute. Smaller colour
                    sigma = stricter edge adherence.
                </p>
                <LabeledSlider
                    label="Filter Radius"
                    value={layer.filterRadius ?? 3}
                    min={1} max={8} step={1} suffix=" px"
                    onChange={(v) => onUpdate({ filterRadius: v })}
                />
                <LabeledSlider
                    label="Color Sigma"
                    value={Math.round((layer.sigmaColor ?? 0.15) * 100)}
                    min={1} max={100} step={1} suffix="%"
                    onChange={(v) => onUpdate({ sigmaColor: v / 100 })}
                />
                <LabeledSlider
                    label="Space Sigma"
                    value={Math.round((layer.sigmaSpace ?? 2) * 10)}
                    min={1} max={80} step={1} suffix=" px"
                    onChange={(v) => onUpdate({ sigmaSpace: v / 10 })}
                />
            </>
        )
    } else if (layer.kind === 'semantic' || layer.kind === 'depth') {
        // Step 5 + 6 editors: just the feather/softness slider.
        const featherKey = layer.kind === 'semantic' ? 'feather' : 'softness'
        kindSpecific = (
            <LabeledSlider
                label={featherKey === 'feather' ? 'Feather' : 'Softness'}
                value={Math.round((layer[featherKey] ?? 0.1) * 100)}
                min={0} max={50} step={1} suffix="%"
                onChange={(v) => onUpdate({ [featherKey]: v / 100 })}
                dominantColor={dominantColor}
            />
        )
    }

    if (kindSpecific) {
        return (
            <div className="space-y-2 pt-2" style={{ borderTop: '1px dashed var(--border-subtle)' }}>
                <div className="space-y-2">{kindSpecific}</div>
                <LayerAdjustEditor layer={layer} onUpdate={onUpdate} dominantColor={dominantColor} />
            </div>
        )
    }
    // Unknown / future kind: read-only placeholder.
    return (
        <div
            className="pt-2 text-[10px] text-center"
            style={{ borderTop: '1px dashed var(--border-subtle)', color: 'var(--text-muted)' }}
        >
            <span
                className="inline-block text-[8px] font-bold px-1.5 py-0.5 rounded mr-1.5"
                style={{ background: 'rgba(124,58,237,0.2)', color: '#A78BFA' }}
            >
                COMING
            </span>
            {meta.label} — editor lands in Step {meta.step}
        </div>
    )
}

/**
 * One card in the megashader chain. Shows the layer kind, op, and
 * common controls (opacity, visible, invert, move, delete). The kind-
 * specific editor is collapsed by default — click the chevron to expand.
 *
 * Used by both the dev test panel and the production Mask tool's
 * "Mask Layers" section.
 */
export function MaskChainCard({
    entry, index, total, isFirst,
    onUpdate, onRemove, onMove, onSetOp,
    dominantColor, imageSize,
}) {
    const layer = entry.layer
    const meta = getKindMeta(layer.kind)
    const [expanded, setExpanded] = useState(false)

    return (
        <motion.div
            layout
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="rounded-md p-2"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
        >
            <div className="flex items-center gap-1.5">
                <span
                    className="text-[9px] font-mono w-4 text-center"
                    style={{ color: 'var(--text-muted)' }}
                >
                    {index}
                </span>
                <span
                    className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                    style={{ background: hexToRgba(meta.color, 0.15), color: meta.color }}
                >
                    {meta.label}
                </span>
                <span
                    className="text-[10px] font-semibold flex-1 truncate"
                    style={{ color: 'var(--text-primary)' }}
                    title={layer.label}
                >
                    {layer.label}
                </span>
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="p-0.5"
                    title={expanded ? 'Hide params' : 'Edit params'}
                >
                    {expanded
                        ? <ChevronUp className="h-3 w-3" style={{ color: 'var(--text-secondary)' }} />
                        : <ChevronDown className="h-3 w-3" style={{ color: 'var(--text-secondary)' }} />}
                </button>
                <button
                    type="button"
                    onClick={() => onUpdate({ visible: layer.visible === false })}
                    className="p-0.5"
                    title={layer.visible === false ? 'Show' : 'Hide'}
                >
                    {layer.visible === false
                        ? <EyeOff className="h-3 w-3" style={{ color: 'var(--text-muted)' }} />
                        : <Eye className="h-3 w-3" style={{ color: 'var(--accent-primary)' }} />}
                </button>
                <button
                    type="button"
                    onClick={() => onMove(layer.id, 'up')}
                    disabled={isFirst}
                    className="p-0.5 disabled:opacity-30"
                    title="Move up"
                >
                    <ChevronUp className="h-3 w-3" style={{ color: 'var(--text-secondary)' }} />
                </button>
                <button
                    type="button"
                    onClick={() => onMove(layer.id, 'down')}
                    disabled={index === total - 1}
                    className="p-0.5 disabled:opacity-30"
                    title="Move down"
                >
                    <ChevronDown className="h-3 w-3" style={{ color: 'var(--text-secondary)' }} />
                </button>
                <button
                    type="button"
                    onClick={() => onRemove(layer.id)}
                    className="p-0.5"
                    title="Remove layer"
                >
                    <Trash2 className="h-3 w-3" style={{ color: '#EF4444' }} />
                </button>
            </div>

            {!isFirst && (
                <select
                    value={entry.op}
                    onChange={(e) => onSetOp(layer.id, e.target.value)}
                    className="w-full text-[10px] px-1.5 py-0.5 rounded mt-1.5"
                    style={{
                        background: 'var(--bg-base)',
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--text-primary)',
                    }}
                >
                    {OPS.map((op) => (
                        <option key={op.id} value={op.id}>{op.label}</option>
                    ))}
                </select>
            )}

            <div className="flex items-center gap-1.5 mt-1.5">
                <span className="text-[9px] flex-1" style={{ color: 'var(--text-muted)' }}>
                    Opacity
                </span>
                <input
                    type="range"
                    min="0" max="100"
                    value={Math.round((layer.opacity ?? 1) * 100)}
                    onChange={(e) => onUpdate({ opacity: Number(e.target.value) / 100 })}
                    className="flex-1"
                />
                <span className="text-[9px] w-6 text-right" style={{ color: 'var(--text-secondary)' }}>
                    {Math.round((layer.opacity ?? 1) * 100)}
                </span>
            </div>
            <label className="flex items-center gap-1.5 text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                <input
                    type="checkbox"
                    checked={!!layer.inverted}
                    onChange={(e) => onUpdate({ inverted: e.target.checked })}
                />
                Invert
            </label>

            <AnimatePresence initial={false}>
                {expanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                    >
                        <KindParamEditor layer={layer} onUpdate={onUpdate} dominantColor={dominantColor} imageSize={imageSize} />
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    )
}

/**
 * Lightroom-style 256-bucket luminance histogram with the min/max range
 * shaded. Pure presentational — the parent passes a precomputed
 * histogram (from `computeImageHistogram`) and the current range.
 *
 * Dimensions are tight (88×36) so it fits above a slider without
 * dominating the panel.
 */
export function LuminanceHistogram({ histogram, min, max, softness }) {
    if (!histogram || !histogram.luma || histogram.luma.length === 0) {
        return (
            <div
                className="rounded-md text-[9px] text-center py-2"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
            >
                No histogram
            </div>
        )
    }
    const w = 88
    const h = 36
    const maxCount = Math.max(1, ...histogram.luma)
    const minBucket = Math.max(0, Math.min(255, Math.round(min * 255)))
    const maxBucket = Math.max(0, Math.min(255, Math.round(max * 255)))
    const softPx = Math.max(0, Math.round(softness * 255))
    const bars = []
    const barWidth = w / 256
    for (let i = 0; i < 256; i += 1) {
        const barH = (histogram.luma[i] / maxCount) * h
        const inRange = i >= minBucket && i <= maxBucket
        const inSoft = i >= Math.max(0, minBucket - softPx) && i <= Math.min(255, maxBucket + softPx)
        const fill = inRange
            ? 'var(--accent-primary)'
            : inSoft
                ? 'rgba(6,184,212,0.35)'
                : 'rgba(148,163,184,0.4)'
        // Even-distribution formula: bar i sits at i * (w/256), so the
        // rightmost bar ends exactly at w (no clipping at the right edge).
        const x = i * barWidth
        bars.push(
            <rect
                key={i}
                x={x.toFixed(2)}
                y={(h - barH).toFixed(2)}
                width={Math.max(0.3, barWidth).toFixed(2)}
                height={Math.max(0.5, barH).toFixed(2)}
                style={{ fill }}
            />,
        )
    }
    return (
        <svg
            viewBox={`0 0 ${w} ${h}`}
            width={w}
            height={h}
            preserveAspectRatio="none"
            style={{ display: 'block', width: '100%', height: h }}
        >
            {bars}
        </svg>
    )
}
