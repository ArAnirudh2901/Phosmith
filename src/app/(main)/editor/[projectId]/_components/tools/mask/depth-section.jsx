import { motion } from 'framer-motion'
import { Loader2, Mountain, Plus, RotateCcw } from 'lucide-react'
import { LabeledSlider } from '../_pixel-tool-ui'
import { Section } from './ui'

// Depth Range (Depth Anything V2, service only).

export default function DepthSection({
    depthMax,
    depthMin,
    depthSoftness,
    handleAddDepthLayer,
    handleDepthReset,
    handleDepthRun,
    isDepthRunning,
    lastDepthMap,
    lastDepthPreview,
    setDepthMaxBounded,
    setDepthMinBounded,
    setDepthSoftness,
}) {
    return (
        <Section title="Depth Range" icon={Mountain} badge="AI">
            <div className="space-y-2">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Generate a per-pixel depth map, then add it as a
                    non-destructive layer with a custom depth range.
                </p>

                <div className="flex items-center gap-1.5">
                    <motion.button
                        type="button"
                        onClick={handleDepthRun}
                        disabled={isDepthRunning}
                        whileTap={{ scale: 0.97 }}
                        className="flex-1 whitespace-nowrap flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive disabled:opacity-40"
                        style={{
                            background: 'linear-gradient(135deg, rgba(6,184,212,0.20) 0%, rgba(20,184,166,0.18) 100%)',
                            border: '1px solid rgba(6,184,212,0.35)',
                            color: 'var(--accent-primary)',
                        }}
                    >
                        {isDepthRunning ? (
                            <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Generating…
                            </>
                        ) : (
                            <>
                                <Mountain className="h-3.5 w-3.5" />
                                Generate Depth Map
                            </>
                        )}
                    </motion.button>
                    <motion.button
                        type="button"
                        onClick={handleDepthReset}
                        disabled={!lastDepthMap}
                        whileTap={{ scale: 0.97 }}
                        className="flex items-center justify-center gap-1 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive disabled:opacity-40"
                        style={{
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border-subtle)',
                            color: 'var(--text-secondary)',
                        }}
                        title="Clear last result"
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                    </motion.button>
                </div>

                {/* Depth preview + range controls + add-to-chain */}
                {lastDepthPreview && (
                    <div
                        className="rounded-md p-2 space-y-1.5"
                        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                    >
                        <div className="flex items-center gap-2">
                            <img
                                src={lastDepthPreview}
                                alt="Depth map preview"
                                className="rounded"
                                style={{ width: 64, height: 64, objectFit: 'contain', background: '#000' }}
                            />
                            <div className="flex-1 text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                                <div className="font-semibold mb-0.5" style={{ color: 'var(--text-secondary)' }}>
                                    Depth map ready
                                </div>
                                White = near, black = far. Use the sliders
                                below to select a range.
                            </div>
                        </div>

                        <div className="space-y-1.5 pt-1">
                            <LabeledSlider
                                label="Near floor"
                                value={depthMin}
                                onChange={setDepthMinBounded}
                                min={0}
                                max={1}
                                step={0.01}
                                format={(v) => v.toFixed(2)}
                            />
                            <LabeledSlider
                                label="Far ceiling"
                                value={depthMax}
                                onChange={setDepthMaxBounded}
                                min={0}
                                max={1}
                                step={0.01}
                                format={(v) => v.toFixed(2)}
                            />
                            <LabeledSlider
                                label="Softness"
                                value={depthSoftness}
                                onChange={setDepthSoftness}
                                min={0}
                                max={0.5}
                                step={0.01}
                                format={(v) => v.toFixed(2)}
                            />
                        </div>

                        <motion.button
                            type="button"
                            onClick={handleAddDepthLayer}
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
