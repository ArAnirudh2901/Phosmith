import { motion } from 'framer-motion'
import { Check, LayoutGrid } from 'lucide-react'
import { LAYOUTS } from '@/lib/collage-layout'
import { LayoutPreview, Section } from './ui'

// Layout picker.

export default function LayoutSection({ selectedLayout, setSelectedLayout }) {
    // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
    'use no memo'
    return (
        <Section title="Layout" icon={LayoutGrid}>
            <div className="grid grid-cols-3 gap-2">
                {LAYOUTS.map(layout => {
                    const isActive = selectedLayout === layout.id
                    return (
                        <motion.button
                            key={layout.id}
                            type="button"
                            onClick={() => setSelectedLayout(layout.id)}
                            aria-label={`Use ${layout.label} collage layout`}
                            title={layout.label}
                            whileTap={{ scale: 0.95 }}
                            className="flex min-h-[68px] flex-col items-center justify-center gap-1.5 rounded-lg p-2 text-center editor-interactive relative"
                            style={{
                                background: isActive ? 'rgba(6,184,212,0.12)' : 'var(--bg-elevated)',
                                border: `1px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)'
                            }}
                        >
                            <LayoutPreview layoutId={layout.id} active={isActive} />
                            <span className="text-[9px] font-medium leading-tight">{layout.label}</span>
                            {isActive && (
                                <div className="absolute top-1 right-1">
                                    <div className="bg-[var(--accent-primary)] rounded-full p-0.5">
                                        <Check className="w-2 h-2 text-white" strokeWidth={3} />
                                    </div>
                                </div>
                            )}
                        </motion.button>
                    )
                })}
            </div>
        </Section>
    )
}
