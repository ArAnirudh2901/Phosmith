import { motion } from 'framer-motion'
import { Check, Lasso, Magnet, Pentagon, Scissors, Spline, SquareDashed, SquarePlus, SquaresIntersect, SquaresSubtract, SquaresUnite, X } from 'lucide-react'
import { LabeledSlider } from '../_pixel-tool-ui'
import { Section } from './ui'

// Lasso: freehand, polygonal and magnetic.

export default function LassoSection({
    dominantColor,
    finishLassoSelection,
    handleStartLasso,
    handleStopLasso,
    lassoActive,
    lassoFeather,
    lassoMode,
    lassoModifier,
    lassoSink,
    lassoSmooth,
    lassoVertexCount,
    magneticContrast,
    magneticFrequency,
    magneticWidth,
    setLassoFeather,
    setLassoMode,
    setLassoModifier,
    setLassoSink,
    setLassoSmooth,
    setMagneticContrast,
    setMagneticFrequency,
    setMagneticWidth,
}) {
    // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
    'use no memo'
    return (
        <Section title="Lasso Select" icon={Lasso}>
            <div className="space-y-2">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Draw a selection. <strong>Freehand</strong> = drag;{' '}
                    <strong>Polygonal</strong> = click points;{' '}
                    <strong>Magnetic</strong> = click to start, glide along an
                    edge and the path snaps to it. Double-click or{' '}
                    <kbd className="px-1 rounded text-[9px]" style={{ background: 'var(--bg-elevated)' }}>Enter</kbd>{' '}
                    to close (<kbd className="px-1 rounded text-[9px]" style={{ background: 'var(--bg-elevated)' }}>Backspace</kbd> undoes a point).
                </p>

                {/* Mode: freehand / polygonal / magnetic */}
                <div className="seg-row seg-row--3 grid grid-cols-3 gap-1.5">
                    {[
                        { id: 'freehand', label: 'Freehand', icon: Lasso },
                        { id: 'polygonal', label: 'Polygonal', icon: Pentagon },
                        { id: 'magnetic', label: 'Magnetic', icon: Magnet },
                    ].map((m) => {
                        const MIcon = m.icon
                        const active = lassoMode === m.id
                        return (
                            <button
                                key={m.id}
                                type="button"
                                onClick={() => setLassoMode(m.id)}
                                className="seg-btn flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: active ? 'rgba(6,184,212,0.12)' : 'var(--bg-elevated)',
                                    border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                }}
                            >
                                <MIcon className="h-3.5 w-3.5" />
                                {m.label}
                            </button>
                        )
                    })}
                </div>

                {/* Magnetic options — Width / Contrast / Frequency (Photoshop parity) */}
                {lassoMode === 'magnetic' && (
                    <div className="space-y-1.5 rounded-lg px-2 py-2" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            The path snaps to the strongest nearby edge. Tune how
                            far it looks (Width), how strong an edge must be
                            (Contrast), and how often it drops anchors (Frequency).
                        </p>
                        <LabeledSlider
                            label="Width (search)"
                            value={magneticWidth}
                            min={4}
                            max={60}
                            suffix="px"
                            onChange={setMagneticWidth}
                            dominantColor={dominantColor}
                        />
                        <LabeledSlider
                            label="Contrast (edge threshold)"
                            value={magneticContrast}
                            min={1}
                            max={60}
                            suffix="%"
                            onChange={setMagneticContrast}
                            dominantColor={dominantColor}
                        />
                        <LabeledSlider
                            label="Frequency (anchor spacing)"
                            value={magneticFrequency}
                            min={4}
                            max={48}
                            suffix="px"
                            onChange={setMagneticFrequency}
                            dominantColor={dominantColor}
                        />
                    </div>
                )}

                {/* Pen mode — smooth the captured anchors into a Bézier 'path'
                    layer (Photoshop Pen-tool parity) instead of a straight lasso. */}
                <button
                    type="button"
                    onClick={() => setLassoSmooth((v) => !v)}
                    title="Smooth the captured points into a Bézier pen path before committing"
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                    style={{
                        background: lassoSmooth ? 'rgba(83,216,255,0.12)' : 'var(--bg-elevated)',
                        border: `1px solid ${lassoSmooth ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                        color: lassoSmooth ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    }}
                >
                    <Spline className="h-3.5 w-3.5" />
                    {lassoSmooth ? 'Pen: smooth curves ON' : 'Pen: smooth curves'}
                </button>

                {/* Output: select (fill) vs erase (cut) */}
                <div className="seg-row seg-row--2 grid grid-cols-2 gap-1.5">
                    {[
                        { id: 'select', label: 'Select', icon: SquareDashed, hint: 'visible selection layer' },
                        { id: 'erase', label: 'Erase / Cut', icon: Scissors, hint: 'cut the region out' },
                    ].map((s) => {
                        const SIcon = s.icon
                        const active = lassoSink === s.id
                        return (
                            <button
                                key={s.id}
                                type="button"
                                onClick={() => setLassoSink(s.id)}
                                title={s.hint}
                                className="seg-btn flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: active ? 'rgba(124,58,237,0.10)' : 'var(--bg-elevated)',
                                    border: `1px solid ${active ? 'rgba(124,58,237,0.35)' : 'var(--border-subtle)'}`,
                                    color: active ? '#A78BFA' : 'var(--text-secondary)',
                                }}
                            >
                                <SIcon className="h-3.5 w-3.5" />
                                {s.label}
                            </button>
                        )
                    })}
                </div>

                {/* Boolean modifier — how this selection combines with the chain */}
                <div>
                    <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>
                        Combine (Shift = add, Alt = subtract)
                    </label>
                    <div className="grid grid-cols-4 gap-1">
                        {[
                            { id: 'new', label: 'New', icon: SquarePlus },
                            { id: 'add', label: 'Add', icon: SquaresUnite },
                            { id: 'subtract', label: 'Sub', icon: SquaresSubtract },
                            { id: 'intersect', label: 'Int', icon: SquaresIntersect },
                        ].map((m) => {
                            const MIcon = m.icon
                            const active = lassoModifier === m.id
                            return (
                                <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => setLassoModifier(m.id)}
                                    title={m.label}
                                    className="flex items-center justify-center gap-1 rounded-md px-1 py-1.5 text-[10px] font-medium editor-interactive"
                                    style={{
                                        background: active ? 'rgba(6,184,212,0.12)' : 'var(--bg-elevated)',
                                        border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                        color: active ? 'var(--accent-primary)' : 'var(--text-muted)',
                                    }}
                                >
                                    <MIcon className="h-3 w-3" />
                                    {m.label}
                                </button>
                            )
                        })}
                    </div>
                </div>

                <LabeledSlider
                    label="Feather"
                    value={Math.round(lassoFeather * 100)}
                    min={0}
                    max={40}
                    suffix="%"
                    onChange={(v) => setLassoFeather(Math.max(0, Math.min(0.4, v / 100)))}
                    dominantColor={dominantColor}
                />

                <div className="flex items-center gap-1.5">
                    {!lassoActive ? (
                        <motion.button
                            type="button"
                            onClick={handleStartLasso}
                            whileTap={{ scale: 0.97 }}
                            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-semibold editor-interactive"
                            style={{
                                background: 'linear-gradient(135deg, rgba(6,184,212,0.20) 0%, rgba(124,58,237,0.18) 100%)',
                                border: '1px solid rgba(6,184,212,0.35)',
                                color: 'var(--accent-primary)',
                            }}
                        >
                            <Lasso className="h-3.5 w-3.5" />
                            Start Lasso
                        </motion.button>
                    ) : (
                        <>
                            {(lassoMode === 'polygonal' || lassoMode === 'magnetic') && lassoVertexCount >= 3 && (
                                <motion.button
                                    type="button"
                                    onClick={() => finishLassoSelection(null)}
                                    whileTap={{ scale: 0.97 }}
                                    className="flex items-center justify-center gap-1 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                    style={{ background: 'rgba(6,184,212,0.12)', border: '1px solid var(--accent-primary)', color: 'var(--accent-primary)' }}
                                    title="Close the selection"
                                >
                                    <Check className="h-3.5 w-3.5" /> Close
                                </motion.button>
                            )}
                            <motion.button
                                type="button"
                                onClick={handleStopLasso}
                                whileTap={{ scale: 0.97 }}
                                className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.30)', color: '#FCA5A5' }}
                            >
                                <X className="h-3.5 w-3.5" />
                                Stop{lassoVertexCount > 0 ? ` (${lassoVertexCount})` : ''}
                            </motion.button>
                        </>
                    )}
                </div>
            </div>
        </Section>
    )
}
