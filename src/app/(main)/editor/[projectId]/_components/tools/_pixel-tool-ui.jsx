"use client"

import React from 'react'
import { motion } from 'framer-motion'
import { Minus, Plus, Eraser, Paintbrush, RotateCcw, Redo2, Trash2, Undo2 } from 'lucide-react'
import { ProRulerSlider } from '@/components/editor/ProRulerSlider'

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
