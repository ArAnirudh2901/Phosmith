import { motion } from 'framer-motion'
import { Check, Sparkles } from 'lucide-react'
import { COLLAGE_STYLES, backdropPreviewCss } from '@/lib/collage-styles'
import { Section } from './ui'

// Template Style presets.

export default function TemplateStyleSection({ applyStylePreset, selectedStyle }) {
    // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
    'use no memo'
    return (
        <Section title="Template Style" icon={Sparkles}>
            <div className="grid grid-cols-2 gap-2">
                {COLLAGE_STYLES.map((preset) => {
                    const isActive = selectedStyle === preset.id
                    return (
                        <motion.button
                            key={preset.id}
                            type="button"
                            onClick={() => applyStylePreset(preset)}
                            aria-label={`Use ${preset.label} style`}
                            title={preset.label}
                            whileTap={{ scale: 0.95 }}
                            className="relative flex items-center gap-2 rounded-lg p-2 editor-interactive"
                            style={{
                                background: isActive ? 'rgba(6,184,212,0.12)' : 'var(--bg-elevated)',
                                border: `1px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                            }}
                        >
                            <span
                                className="h-8 w-8 shrink-0"
                                style={{
                                    background: backdropPreviewCss(preset.backdrop),
                                    border: '1px solid var(--border-default)',
                                    borderRadius: preset.shape === 'circle' ? '999px' : `${Math.round(preset.radiusPct / 4) + 2}px`,
                                    boxShadow: preset.shadow ? '0 2px 6px rgba(0,0,0,0.35)' : 'none',
                                }}
                            />
                            <span
                                className="text-[10px] font-medium leading-tight text-left"
                                style={{ color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)' }}
                            >
                                {preset.label}
                            </span>
                            {isActive && (
                                <div className="absolute top-1 right-1 rounded-full bg-[var(--accent-primary)] p-0.5">
                                    <Check className="w-2 h-2 text-white" strokeWidth={3} />
                                </div>
                            )}
                        </motion.button>
                    )
                })}
            </div>
        </Section>
    )
}
