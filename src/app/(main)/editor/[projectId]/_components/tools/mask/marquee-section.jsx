import { motion } from 'framer-motion'
import { CircleDashed, Frame, RectangleHorizontal, SquarePlus, SquaresIntersect, SquaresSubtract, SquaresUnite, X } from 'lucide-react'
import { LabeledSlider } from '../_pixel-tool-ui'
import { Section } from './ui'

// Marquee: rectangle / ellipse.

export default function MarqueeSection({
    dominantColor,
    handleStartMarquee,
    marqueeActive,
    marqueeFeather,
    marqueeOp,
    marqueeShape,
    setMarqueeActive,
    setMarqueeFeather,
    setMarqueeOp,
    setMarqueeShape,
}) {
    return (
        <Section title="Marquee" icon={Frame}>
            <div className="space-y-2">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Drag a rectangle or ellipse. Hold <strong>Shift</strong> for a square/circle,
                    <strong> Alt</strong> to draw from the centre.
                </p>
                <div className="seg-row seg-row--2 grid grid-cols-2 gap-1.5">
                    {[{ id: 'rect', label: 'Rectangle', icon: RectangleHorizontal }, { id: 'ellipse', label: 'Ellipse', icon: CircleDashed }].map((m) => {
                        const MIcon = m.icon
                        const active = marqueeShape === m.id
                        return (
                            <button
                                key={m.id}
                                type="button"
                                onClick={() => setMarqueeShape(m.id)}
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
                <div>
                    <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>Combine</label>
                    <div className="grid grid-cols-4 gap-1">
                        {[
                            { id: 'new', label: 'New', icon: SquarePlus },
                            { id: 'add', label: 'Add', icon: SquaresUnite },
                            { id: 'subtract', label: 'Sub', icon: SquaresSubtract },
                            { id: 'intersect', label: 'Int', icon: SquaresIntersect },
                        ].map((m) => {
                            const MIcon = m.icon
                            const active = marqueeOp === m.id
                            return (
                                <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => setMarqueeOp(m.id)}
                                    aria-pressed={active}
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
                    value={Math.round(marqueeFeather * 100)}
                    min={0}
                    max={40}
                    suffix="%"
                    onChange={(v) => setMarqueeFeather(Math.max(0, Math.min(0.4, v / 100)))}
                    dominantColor={dominantColor}
                />
                <div className="flex items-center gap-1.5">
                    {!marqueeActive ? (
                    <motion.button
                        type="button"
                        onClick={handleStartMarquee}
                        whileTap={{ scale: 0.97 }}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-semibold editor-interactive"
                        style={{
                            background: 'linear-gradient(135deg, rgba(6,184,212,0.20) 0%, rgba(124,58,237,0.18) 100%)',
                            border: '1px solid rgba(6,184,212,0.35)',
                            color: 'var(--accent-primary)',
                        }}
                    >
                        <Frame className="h-3.5 w-3.5" />
                        Start Marquee
                    </motion.button>
                    ) : (
                    <motion.button
                        type="button"
                        onClick={() => setMarqueeActive(false)}
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
