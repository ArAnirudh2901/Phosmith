import { motion } from 'framer-motion'
import { Blend, Plus } from 'lucide-react'
import { LabeledSlider } from '../_pixel-tool-ui'
import { DIRECTIONS, Section } from './ui'

// Linear Gradient.

export default function LinearGradientSection({
    dominantColor,
    gradDirection,
    gradFeather,
    gradPosition,
    handleAddGradientLayer,
    handleApplyGradient,
    setGradDirection,
    setGradFeather,
    setGradPosition,
}) {
    // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
    'use no memo'
    return (
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
                <motion.button
                    type="button"
                    onClick={handleAddGradientLayer}
                    whileTap={{ scale: 0.97 }}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
                    style={{
                        background: 'rgba(124,58,237,0.08)',
                        border: '1px solid rgba(124,58,237,0.25)',
                        color: '#A78BFA',
                    }}
                    title="Adds a linear megashader layer — drag on canvas to set p1/p2"
                >
                    <Plus className="h-3.5 w-3.5" />
                    Add Linear to Mask Layers

                </motion.button>
            </div>
        </Section>
    )
}
