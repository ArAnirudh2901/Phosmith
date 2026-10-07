import { Rows } from 'lucide-react'
import { computeCollageCells, defaultWeightsFor } from '@/lib/collage-layout'
import { LabeledSlider, Section } from './ui'

// Spacing: gap, padding, mat and the per-cell panel.

export default function SpacingSection({
    applyCellsToPhotos,
    changeFitMode,
    fitMode,
    frameMode,
    framePct,
    gap,
    matte,
    padding,
    project,
    selectedLayout,
    setFrameMode,
    setFramePct,
    setGap,
    setMatte,
    setPadding,
    setSmartArrange,
    setWeights,
    smartArrange,
    weightsRef,
}) {
    // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
    'use no memo'
    return (
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
                <div className="space-y-1.5">
                    <div className="flex justify-between items-center text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                        <span className="font-medium">Photo fit</span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                        {[['cover', 'Fill frame'], ['contain', 'Fit whole photo']].map(([id, label]) => (
                            <button
                                key={id}
                                type="button"
                                onClick={() => changeFitMode(id)}
                                className="rounded-lg px-2 py-2 text-[10px] font-semibold editor-interactive"
                                style={{
                                    background: fitMode === id ? 'var(--accent-primary)' : 'var(--surface-raised)',
                                    color: fitMode === id ? '#ffffff' : 'var(--text-secondary)',
                                    border: '1px solid var(--border-subtle)',
                                }}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                        {fitMode === 'cover'
                            ? 'Fills each frame and crops the overflow — pan a photo to choose what stays.'
                            : 'Shows every photo whole; panoramas and tall shots keep their shape, backdrop fills the rest.'}
                    </p>
                </div>
                <LabeledSlider
                    label="Mat"
                    value={framePct}
                    min={0}
                    max={14}
                    onChange={setFramePct}
                    suffix="%"
                />
                <div className="grid grid-cols-2 gap-1.5">
                    {[['inner', 'Mat inside'], ['outer', 'Mat outside']].map(([id, label]) => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => setFrameMode(id)}
                            className="rounded-lg px-2 py-2 text-[10px] font-semibold editor-interactive"
                            style={{
                                background: frameMode === id ? 'var(--accent-primary)' : 'var(--surface-raised)',
                                color: frameMode === id ? '#ffffff' : 'var(--text-secondary)',
                                border: '1px solid var(--border-subtle)',
                            }}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                    {frameMode === 'inner'
                        ? 'The mat eats into the photo, leaving backdrop as a border.'
                        : `The mat grows outward into the gutter, so the photo keeps its size. Needs a gap to grow into${gap > 0 ? '' : ' — raise Gap above 0'}.`}
                </p>
                <div className="space-y-1.5">
                    <div className="flex justify-between items-center text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                        <span className="font-medium">Panel behind photo</span>
                        {matte && (
                            <button type="button" onClick={() => setMatte(null)} className="text-[9px] editor-interactive" style={{ color: 'var(--text-muted)' }}>
                                clear
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5">
                        {['#ffffff', '#0b0d12', '#f4ede3', '#111827'].map((color) => (
                            <button
                                key={color}
                                type="button"
                                onClick={() => setMatte(color)}
                                className="h-6 w-6 rounded editor-interactive"
                                style={{ background: color, border: matte === color ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)' }}
                                aria-label={`Panel ${color}`}
                            />
                        ))}
                        <input
                            type="color"
                            value={typeof matte === 'string' ? matte : '#ffffff'}
                            onChange={(e) => setMatte(e.target.value)}
                            className="h-6 w-8 rounded editor-interactive"
                            style={{ background: 'transparent', border: '1px solid var(--border-subtle)' }}
                            aria-label="Custom panel colour"
                        />
                    </div>
                    <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                        Gives each frame its own ground, so a cut-out PNG reads as a photo instead of a hole.
                    </p>
                </div>
                <div className="flex items-center justify-between gap-2 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                    <span>
                        <span className="font-medium">Frame sizes</span>
                        <span className="block text-[9px]" style={{ color: 'var(--text-muted)' }}>
                            Drag the lines between frames on the canvas. Neighbours keep a minimum size.
                        </span>
                    </span>
                    <button
                        type="button"
                        onClick={() => {
                            const reset = defaultWeightsFor(selectedLayout)
                            setWeights(reset)
                            weightsRef.current = reset
                            applyCellsToPhotos(computeCollageCells({ width: project?.width, height: project?.height }, selectedLayout, gap, padding, reset))
                        }}
                        className="rounded-lg px-2 py-1.5 text-[10px] font-semibold editor-interactive"
                        style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
                    >
                        Even
                    </button>
                </div>
                <label className="flex items-start gap-2 text-[10px] editor-interactive" style={{ color: 'var(--text-secondary)' }}>
                    <input
                        type="checkbox"
                        checked={smartArrange}
                        onChange={(e) => setSmartArrange(e.target.checked)}
                        className="mt-0.5 accent-[var(--accent-primary)]"
                    />
                    <span>
                        <span className="font-medium">Arrange by content</span>
                        <span className="block text-[9px]" style={{ color: 'var(--text-muted)' }}>
                            Strongest photo takes the biggest frame, each photo goes where its shape fits, and faces stay in frame. Off = upload order, centred.
                        </span>
                    </span>
                </label>
            </div>
        </Section>
    )
}
