import { motion } from 'framer-motion'
import { WandSparkles, X } from 'lucide-react'
import { LabeledSlider } from '../_pixel-tool-ui'
import { Section } from './ui'

// Magic Wand: colour flood fill.

export default function WandSection({
    dominantColor,
    handleStartWand,
    setWandActive,
    setWandAntiAlias,
    setWandContiguous,
    setWandSample,
    setWandTolerance,
    wandActive,
    wandAntiAlias,
    wandContiguous,
    wandSample,
    wandTolerance,
}) {
    // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
    'use no memo'
    return (
        <Section title="Magic Wand" icon={WandSparkles}>
            <div className="space-y-2">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Click a colour to select similar pixels. <strong>Shift</strong>+click adds to the
                    selected layer, <strong>Alt</strong>+click subtracts. Tip: lower Tolerance for tighter picks.
                </p>
                <LabeledSlider
                    label="Tolerance"
                    suffix=""
                    value={wandTolerance}
                    min={0}
                    max={255}
                    onChange={(v) => setWandTolerance(Math.max(0, Math.min(255, Math.round(v))))}
                    dominantColor={dominantColor}
                />
                <div className="seg-row seg-row--3 grid grid-cols-3 gap-1.5">
                    {[{ id: 'point', label: 'Point', title: 'Sample the exact pixel' }, { id: '3x3', label: '3×3', title: 'Average a 3×3 area' }, { id: '5x5', label: '5×5', title: 'Average a 5×5 area' }].map((m) => {
                        const MIcon = m.icon
                        const active = wandSample === m.id
                        return (
                            <button
                                key={m.id}
                                type="button"
                                onClick={() => setWandSample(m.id)}
                                aria-pressed={active}
                                title={m.title || m.label}
                                className="seg-btn flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: active ? 'rgba(6,184,212,0.12)' : 'var(--bg-elevated)',
                                    border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                }}
                            >
                                {MIcon && <MIcon className="h-3.5 w-3.5" />}
                                {m.label}
                            </button>
                        )
                    })}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                    <label className="mask-toggle" title="Only select pixels connected to the click">
                        <input type="checkbox" checked={wandContiguous} onChange={(e) => setWandContiguous(e.target.checked)} />
                        Contiguous
                    </label>
                    <label className="mask-toggle" title="Soften the selection edge by one pixel">
                        <input type="checkbox" checked={wandAntiAlias} onChange={(e) => setWandAntiAlias(e.target.checked)} />
                        Anti-alias
                    </label>
                </div>
                <div className="flex items-center gap-1.5">
                    {!wandActive ? (
                    <motion.button
                        type="button"
                        onClick={handleStartWand}
                        whileTap={{ scale: 0.97 }}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-semibold editor-interactive"
                        style={{
                            background: 'linear-gradient(135deg, rgba(6,184,212,0.20) 0%, rgba(124,58,237,0.18) 100%)',
                            border: '1px solid rgba(6,184,212,0.35)',
                            color: 'var(--accent-primary)',
                        }}
                    >
                        <WandSparkles className="h-3.5 w-3.5" />
                        Start Magic Wand
                    </motion.button>
                    ) : (
                    <motion.button
                        type="button"
                        onClick={() => setWandActive(false)}
                        whileTap={{ scale: 0.97 }}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                        style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.30)', color: '#FCA5A5' }}
                    >
                        <X className="h-3.5 w-3.5" />
                        Stop
                    </motion.button>
                    )}
                </div>
            </div>
        </Section>
    )
}
