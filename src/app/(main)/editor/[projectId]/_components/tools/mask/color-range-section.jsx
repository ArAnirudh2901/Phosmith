import { motion } from 'framer-motion'
import { Palette, Pipette, Plus, Stamp } from 'lucide-react'
import { LabeledSlider } from '../_pixel-tool-ui'
import { ColorSwatch, Section } from './ui'

// Color Range.

export default function ColorRangeSection({
    colorPickerActive,
    colorTolerance,
    dominantColor,
    handleAddColorLayer,
    handleApplyColorRange,
    pickedColor,
    setColorPickerActive,
    setColorTolerance,
    stopModesRef,
}) {
    return (
        <Section title="Color Range" icon={Palette}>
            <div className="flex items-center gap-2">
                <motion.button
                    type="button"
                    onClick={() => { if (!colorPickerActive) stopModesRef.current('picker'); setColorPickerActive(v => !v) }}
                    whileTap={{ scale: 0.95 }}
                    className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive flex-1"
                    style={{
                        background: colorPickerActive
                            ? 'rgba(6,184,212,0.12)'
                            : 'var(--bg-elevated)',
                        border: `1px solid ${colorPickerActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                        color: colorPickerActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    }}
                >
                    <Pipette className="h-3.5 w-3.5" />
                    {colorPickerActive ? 'Click image to pick…' : 'Pick Color'}
                </motion.button>
                {pickedColor && <ColorSwatch color={pickedColor} />}
            </div>

            {pickedColor && (
                <div className="space-y-2">
                    <LabeledSlider
                        label="Tolerance"
                        value={colorTolerance}
                        min={5}
                        max={100}
                        suffix=""
                        onChange={setColorTolerance}
                        dominantColor={dominantColor}
                    />
                    <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(9.5rem, 1fr))' }}>
                        <motion.button
                            type="button"
                            onClick={handleApplyColorRange}
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
                            onClick={handleAddColorLayer}
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
                </div>
            )}
        </Section>
    )
}
