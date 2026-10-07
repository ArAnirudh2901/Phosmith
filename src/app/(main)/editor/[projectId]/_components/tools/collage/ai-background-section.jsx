import { motion } from 'framer-motion'
import { Loader2, Sparkles } from 'lucide-react'
import { AI_BG_THEMES } from '@/lib/collage-styles'
import { Section } from './ui'

// AI Background: generated backdrop themes.

export default function AiBackgroundSection({
    generateThemedBackground,
    generatingTheme,
    imageCount,
    isGenerating,
    processingMessage,
}) {
    // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
    'use no memo'
    return (
        <Section title="AI Background" icon={Sparkles}>
            <p className="mb-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Generate a decorative background tuned to your photos&apos; colors.
            </p>
            <div className="grid grid-cols-2 gap-2">
                {AI_BG_THEMES.map((theme) => {
                    const isThisGenerating = generatingTheme === theme.id
                    return (
                        <motion.button
                            key={theme.id}
                            type="button"
                            onClick={() => generateThemedBackground(theme)}
                            disabled={isGenerating || Boolean(processingMessage) || imageCount === 0}
                            whileTap={{ scale: 0.96 }}
                            className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2.5 text-[11px] font-medium editor-interactive disabled:cursor-not-allowed disabled:opacity-50"
                            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                        >
                            {isThisGenerating ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--accent-primary)' }} />
                            ) : (
                                <Sparkles className="w-3.5 h-3.5" />
                            )}
                            {theme.label}
                        </motion.button>
                    )
                })}
            </div>
            {imageCount === 0 && (
                <p className="mt-2 text-[10px]" style={{ color: 'var(--accent-warning)' }}>
                    ⚠ Add photos first so the background can match them
                </p>
            )}
        </Section>
    )
}
