import { motion } from 'framer-motion'
import { Plus, Stamp, Sun } from 'lucide-react'
import { LabeledSlider, LuminanceHistogram } from '../_pixel-tool-ui'
import { Section } from './ui'

// Luminance Range.

export default function LuminanceSection({
    dominantColor,
    handleAddLuminanceLayer,
    handleApplyLuminance,
    histogram,
    lumaMax,
    lumaMin,
    setLumaMax,
    setLumaMin,
}) {
    return (
        <Section title="Luminance Range" icon={Sun}>
            <div className="space-y-2">
                <LuminanceHistogram
                    histogram={histogram}
                    min={lumaMin / 255}
                    max={lumaMax / 255}
                    softness={0.1}
                />
                <LabeledSlider
                    label="Min Brightness"
                    value={lumaMin}
                    min={0}
                    max={254}
                    suffix=""
                    onChange={(v) => { setLumaMin(Math.min(v, lumaMax - 1)) }}
                    dominantColor={dominantColor}
                />
                <LabeledSlider
                    label="Max Brightness"
                    value={lumaMax}
                    min={1}
                    max={255}
                    suffix=""
                    onChange={(v) => { setLumaMax(Math.max(v, lumaMin + 1)) }}
                    dominantColor={dominantColor}
                />
                <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(9.5rem, 1fr))' }}>
                    <motion.button
                        type="button"
                        onClick={handleApplyLuminance}
                        whileTap={{ scale: 0.97 }}
                        className="seg-btn flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                        style={{
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border-subtle)',
                            color: 'var(--text-secondary)',
                        }}
                    >
                        <Stamp className="h-3.5 w-3.5" />
                        Apply (bake)
                    </motion.button>
                    <motion.button
                        type="button"
                        onClick={handleAddLuminanceLayer}
                        whileTap={{ scale: 0.97 }}
                        className="seg-btn flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                        style={{
                            background: 'rgba(6,184,212,0.10)',
                            border: '1px solid rgba(6,184,212,0.3)',
                            color: 'var(--accent-primary)',
                        }}
                        title="Add as a live megashader layer"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Add to Mask Layers
                    </motion.button>
                </div>
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Apply (bake) writes to the brush mask. Add to Mask Layers
                    keeps it as a live, editable megashader layer.
                </p>
            </div>
        </Section>
    )
}
