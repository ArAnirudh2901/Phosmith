import { motion } from 'framer-motion'
import { Combine, Crosshair, Loader2, MousePointer, Play, Plus, RotateCcw, Square, X } from 'lucide-react'
import { toast } from 'sonner'
import { Section } from './ui'

// Click / box select (SAM 3.1 on the service, SlimSAM on device).

export default function ClickSelectSection({
    activeDraft,
    boxArmed,
    clientAI,
    handleAddSemanticLayer,
    handleSemanticReset,
    handleSemanticRun,
    handleSemanticStop,
    isSemanticRunning,
    lastSemanticMask,
    lastSemanticPreview,
    refineTargetLayer,
    semanticActive,
    semanticBox,
    semanticClicks,
    semanticRefine,
    semanticRefineMode,
    setBoxArmed,
    setSemanticActive,
    setSemanticBox,
    setSemanticClicks,
    setSemanticRefine,
    setSemanticRefineMode,
    stopModesRef,
}) {
    return (
            <Section title="Click to Select" icon={MousePointer} badge="AI">
                <div className="space-y-2">
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        Click to mark the subject — or draw a box around it — then run SlimSAM. Hold{' '}
                        <kbd className="px-1 rounded text-[9px]" style={{ background: 'var(--bg-elevated)' }}>Alt</kbd>{' '}
                        to mark background (negative click).
                    </p>

                    <div className="flex items-center gap-1.5">
                        {!semanticActive ? (
                            <motion.button
                                type="button"
                                onClick={() => {
                                    if (activeDraft) {
                                        toast('Finish or cancel the current draft first', { icon: 'ℹ️' })
                                        return
                                    }
                                    stopModesRef.current('semantic')
                                    setSemanticActive(true)
                                    toast('Click the subject on the canvas', { id: 'mask-tool-hint' })
                                }}
                                whileTap={{ scale: 0.97 }}
                                className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: 'rgba(124,58,237,0.08)',
                                    border: '1px solid rgba(124,58,237,0.25)',
                                    color: '#A78BFA',
                                }}
                            >
                                <Crosshair className="h-3.5 w-3.5" />
                                Start Clicking
                            </motion.button>
                        ) : (
                            <motion.button
                                type="button"
                                onClick={handleSemanticStop}
                                whileTap={{ scale: 0.97 }}
                                className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
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
                            onClick={handleSemanticReset}
                            disabled={!semanticActive || (semanticClicks.length === 0 && !lastSemanticMask)}
                            whileTap={{ scale: 0.97 }}
                            className="flex items-center justify-center gap-1 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive disabled:opacity-40"
                            style={{
                                background: 'var(--bg-elevated)',
                                border: '1px solid var(--border-subtle)',
                                color: 'var(--text-secondary)',
                            }}
                            title="Clear clicks and last result"
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                        </motion.button>
                    </div>

                    {/* Box prompt — the strongest single prompt for whole
                        objects. One box at a time; a new drag replaces it. */}
                    {semanticActive && (
                        <div className="flex items-center gap-1.5">
                            <motion.button
                                type="button"
                                onClick={() => setBoxArmed((v) => !v)}
                                whileTap={{ scale: 0.97 }}
                                className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-medium editor-interactive"
                                style={{
                                    background: boxArmed ? 'rgba(6,184,212,0.18)' : 'var(--bg-elevated)',
                                    border: `1px solid ${boxArmed ? 'rgba(6,184,212,0.45)' : 'var(--border-subtle)'}`,
                                    color: boxArmed ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                }}
                                title="Drag a rectangle around the object — SlimSAM selects what is inside"
                            >
                                <Square className="h-3 w-3" />
                                {boxArmed ? 'Drag on the image…' : semanticBox ? 'Redraw box' : 'Draw box'}
                            </motion.button>
                            {semanticBox && (
                                <button
                                    type="button"
                                    onClick={() => setSemanticBox(null)}
                                    className="flex items-center gap-1 text-[9px] px-1.5 py-1.5 rounded"
                                    title="Remove the box prompt"
                                    style={{
                                        background: 'rgba(6,184,212,0.15)',
                                        color: 'var(--accent-primary)',
                                        border: '1px solid rgba(6,184,212,0.35)',
                                    }}
                                >
                                    {Math.round(semanticBox[2] - semanticBox[0])}×{Math.round(semanticBox[3] - semanticBox[1])}
                                    <X className="h-2.5 w-2.5" />
                                </button>
                            )}
                        </div>
                    )}

                    {/* Refine: composite results onto the SELECTED mask layer. */}
                    {semanticActive && refineTargetLayer && (
                        <div className="flex items-center gap-1.5">
                            <motion.button
                                type="button"
                                onClick={() => setSemanticRefine((v) => !v)}
                                whileTap={{ scale: 0.97 }}
                                className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-medium editor-interactive truncate"
                                style={{
                                    background: semanticRefine ? 'rgba(155,249,91,0.14)' : 'var(--bg-elevated)',
                                    border: `1px solid ${semanticRefine ? 'rgba(155,249,91,0.40)' : 'var(--border-subtle)'}`,
                                    color: semanticRefine ? '#9bf95b' : 'var(--text-secondary)',
                                }}
                                title="Clicks refine the selected mask instead of staging a new layer"
                            >
                                <Combine className="h-3 w-3" />
                                {semanticRefine ? 'Refining' : 'Refine'} “{refineTargetLayer.label || refineTargetLayer.kind}”
                            </motion.button>
                            {semanticRefine && ['add', 'remove'].map((m) => (
                                <button
                                    key={m}
                                    type="button"
                                    onClick={() => setSemanticRefineMode(m)}
                                    className="text-[9px] px-2 py-1.5 rounded capitalize"
                                    style={{
                                        background: semanticRefineMode === m
                                            ? (m === 'add' ? 'rgba(6,184,212,0.18)' : 'rgba(239,68,68,0.18)')
                                            : 'var(--bg-elevated)',
                                        color: semanticRefineMode === m
                                            ? (m === 'add' ? 'var(--accent-primary)' : '#FCA5A5')
                                            : 'var(--text-secondary)',
                                        border: `1px solid ${semanticRefineMode === m
                                            ? (m === 'add' ? 'rgba(6,184,212,0.45)' : 'rgba(239,68,68,0.40)')
                                            : 'var(--border-subtle)'}`,
                                    }}
                                >
                                    {m}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Click list — cyan dot = positive, red = negative */}
                    {semanticActive && semanticClicks.length > 0 && (
                        <div
                            className="rounded-md p-1.5 flex flex-wrap gap-1"
                            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                        >
                            {semanticClicks.map((c, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    onClick={() => setSemanticClicks((prev) => prev.filter((_, j) => j !== i))}
                                    className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded"
                                    title={`${c[0].toFixed(0)}, ${c[1].toFixed(0)} — click to remove`}
                                    style={{
                                        background: c[2] === 1 ? 'rgba(6,184,212,0.15)' : 'rgba(239,68,68,0.15)',
                                        color: c[2] === 1 ? 'var(--accent-primary)' : '#FCA5A5',
                                        border: `1px solid ${c[2] === 1 ? 'rgba(6,184,212,0.35)' : 'rgba(239,68,68,0.35)'}`,
                                    }}
                                >
                                    <span>{c[2] === 1 ? '+' : '−'}</span>
                                    <span>({c[0].toFixed(0)}, {c[1].toFixed(0)})</span>
                                </button>
                            ))}
                        </div>
                    )}

                    <motion.button
                        type="button"
                        onClick={handleSemanticRun}
                        disabled={isSemanticRunning || (semanticClicks.length === 0 && !semanticBox)}
                        whileTap={{ scale: 0.97 }}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold editor-interactive disabled:opacity-40"
                        style={{
                            background: 'linear-gradient(135deg, rgba(6,184,212,0.20) 0%, rgba(124,58,237,0.18) 100%)',
                            border: '1px solid rgba(6,184,212,0.35)',
                            color: 'var(--accent-primary)',
                        }}
                    >
                        {isSemanticRunning ? (
                            <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                {clientAI.samReady ? 'Running SlimSAM…' : 'Downloading SlimSAM…'}
                            </>
                        ) : (
                            <>
                                <Play className="h-3.5 w-3.5" />
                                Run ({semanticClicks.length}{semanticBox ? ' + box' : ''})
                            </>
                        )}
                    </motion.button>

                    {/* Mask preview + add-to-chain */}
                    {lastSemanticPreview && (
                        <div
                            className="rounded-md p-2 space-y-1.5"
                            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                        >
                            <div className="flex items-center gap-2">
                                <img
                                    src={lastSemanticPreview}
                                    alt="SlimSAM mask preview"
                                    className="rounded"
                                    style={{ width: 64, height: 64, objectFit: 'contain', background: '#000' }}
                                />
                                <div className="flex-1 text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                                    <div className="font-semibold mb-0.5" style={{ color: 'var(--text-secondary)' }}>
                                        Mask ready
                                    </div>
                                    White = keep, black = remove. The mask is at the
                                    original image&apos;s resolution.
                                </div>
                            </div>
                            <motion.button
                                type="button"
                                onClick={handleAddSemanticLayer}
                                whileTap={{ scale: 0.97 }}
                                className="flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: 'rgba(6,184,212,0.10)',
                                    border: '1px solid rgba(6,184,212,0.30)',
                                    color: 'var(--accent-primary)',
                                }}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                Add to Mask Layers
                            </motion.button>
                        </div>
                    )}
                </div>
            </Section>
    )
}
