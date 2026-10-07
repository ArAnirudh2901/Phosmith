import { motion } from 'framer-motion'
import { Loader2, Paintbrush, Plus, RotateCcw, ScanLine, Scissors, SquareDashed, SquarePlus, SquaresIntersect, SquaresSubtract, SquaresUnite, X } from 'lucide-react'
import { BrushSizeControl, LabeledSlider } from '../_pixel-tool-ui'
import { Section } from './ui'

// Selection Brush: smart brush and per-layer refine.

export default function BrushSection({
    brushActive,
    brushEdgeSnap,
    brushFeather,
    brushHardness,
    brushHasContent,
    brushModifier,
    brushSink,
    brushSize,
    dominantColor,
    filterRadius,
    handleAddBrushLayer,
    handleClearBrush,
    handleStartBrush,
    handleStopBrush,
    isShapeFilling,
    refineTarget,
    setBrushEdgeSnap,
    setBrushFeather,
    setBrushHardness,
    setBrushModifier,
    setBrushSink,
    setBrushSize,
    setFilterRadius,
    setSigmaColor,
    setSigmaSpace,
    sigmaColor,
    sigmaSpace,
}) {
    // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
    'use no memo'
    return (
        <Section title="Selection Brush" icon={Paintbrush}>
            <div className="space-y-2">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Paint a <strong>selection</strong> — it shows as a live
                    overlay and becomes an editable, non-destructive layer.
                    Closed outlines fill their entire inside automatically.
                    Nothing is erased. Use <strong>Erase / Cut</strong> below
                    to knock the painted region out instead.
                </p>

                {/* Output: select (fill) vs erase (cut) — same as the lasso */}
                <div className="seg-row seg-row--2 grid grid-cols-2 gap-1.5">
                    {[
                        { id: 'select', label: 'Select', icon: SquareDashed, hint: 'visible selection layer' },
                        { id: 'erase', label: 'Erase / Cut', icon: Scissors, hint: 'cut the painted region out' },
                    ].map((s) => {
                        const SIcon = s.icon
                        const active = brushSink === s.id
                        return (
                            <button
                                key={s.id}
                                type="button"
                                onClick={() => setBrushSink(s.id)}
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

                <BrushSizeControl
                    value={brushSize}
                    setValue={setBrushSize}
                    min={2}
                    max={200}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Hardness"
                    value={Math.round(brushHardness * 100)}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={(v) => setBrushHardness(Math.max(0, Math.min(1, v / 100)))}
                    dominantColor={dominantColor}
                />
                {!brushEdgeSnap && (
                    <LabeledSlider
                        label="Edge Feather"
                        value={brushFeather}
                        min={0}
                        max={50}
                        suffix="px"
                        onChange={setBrushFeather}
                        dominantColor={dominantColor}
                    />
                )}

                {/* Snap-to-edges toggle → smartBrush (bilateral) vs plain brush */}
                <button
                    type="button"
                    onClick={() => setBrushEdgeSnap((v) => !v)}
                    aria-pressed={brushEdgeSnap}
                    title="Snap the stroke to underlying edges (bilateral filter)"
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium editor-interactive"
                    style={{
                        background: brushEdgeSnap ? 'rgba(6,184,212,0.12)' : 'var(--bg-elevated)',
                        border: `1px solid ${brushEdgeSnap ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                        color: brushEdgeSnap ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    }}
                >
                    <ScanLine className="h-3.5 w-3.5" />
                    Snap to edges {brushEdgeSnap ? 'ON' : 'OFF'}
                </button>

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
                            const active = brushModifier === m.id
                            return (
                                <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => setBrushModifier(m.id)}
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

                <div className="seg-row seg-row--2 grid grid-cols-2 gap-1.5 pt-1">
                    {!brushActive ? (
                        <motion.button
                            type="button"
                            onClick={handleStartBrush}
                            whileTap={{ scale: 0.97 }}
                            className="seg-btn flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                            style={{
                                background: 'rgba(124,58,237,0.10)',
                                border: '1px solid rgba(124,58,237,0.30)',
                                color: '#A78BFA',
                            }}
                        >
                            <Paintbrush className="h-3.5 w-3.5" />
                            Start Painting
                        </motion.button>
                    ) : (
                        <motion.button
                            type="button"
                            onClick={handleStopBrush}
                            whileTap={{ scale: 0.97 }}
                            className="seg-btn flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                            style={{
                                background: 'rgba(239,68,68,0.10)',
                                border: '1px solid rgba(239,68,68,0.30)',
                                color: '#FCA5A5',
                            }}
                        >
                            <X className="h-3.5 w-3.5" />
                            Stop
                        </motion.button>
                    )}
                    <motion.button
                        type="button"
                        onClick={handleClearBrush}
                        disabled={!brushHasContent && !brushActive}
                        whileTap={{ scale: 0.97 }}
                        className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive disabled:opacity-40"
                        style={{
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border-subtle)',
                            color: 'var(--text-secondary)',
                        }}
                        title="Clear the painted stroke"
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Clear
                    </motion.button>
                </div>

                {/* Edge-snap (bilateral) filter settings — only relevant
                    when "Snap to edges" is on; become the layer's params. */}
                {brushEdgeSnap && (
                    <div className="space-y-1.5 pt-1">
                        <LabeledSlider
                            label="Filter Radius"
                            value={filterRadius}
                            min={1}
                            max={8}
                            step={1}
                            onChange={setFilterRadius}
                            format={(v) => `${v} px`}
                        />
                        <LabeledSlider
                            label="Color Sigma (edge strictness)"
                            value={sigmaColor}
                            min={0.01}
                            max={1}
                            step={0.01}
                            onChange={setSigmaColor}
                            format={(v) => v.toFixed(2)}
                        />
                        <LabeledSlider
                            label="Space Sigma (spatial spread)"
                            value={sigmaSpace}
                            min={0.5}
                            max={8}
                            step={0.1}
                            onChange={setSigmaSpace}
                            format={(v) => v.toFixed(1)}
                        />
                    </div>
                )}

                <motion.button
                    type="button"
                    onClick={handleAddBrushLayer}
                    disabled={!brushHasContent || isShapeFilling || !!refineTarget}
                    whileTap={{ scale: 0.97 }}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold editor-interactive disabled:opacity-40"
                    style={{
                        background: 'linear-gradient(135deg, rgba(6,184,212,0.20) 0%, rgba(124,58,237,0.18) 100%)',
                        border: '1px solid rgba(6,184,212,0.35)',
                        color: 'var(--accent-primary)',
                    }}
                >
                    {isShapeFilling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                    {isShapeFilling
                        ? 'Filling shape...'
                        : refineTarget
                            ? 'Refining layer — strokes apply on release'
                            : brushSink === 'erase'
                                ? 'Add cut to layers'
                                : 'Add selection to layers'}
                </motion.button>
            </div>
        </Section>
    )
}
