import { Palette, X } from 'lucide-react'
import { COLLAGE_BACKDROPS, backdropPreviewCss } from '@/lib/collage-styles'
import { Section } from './ui'

// Backdrop swatches.

export default function BackgroundSection({ activeBackdrop, applyBackdrop }) {
    // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
    'use no memo'
    return (
        <Section title="Background" icon={Palette}>
            <div className="grid grid-cols-6 gap-1.5">
                {COLLAGE_BACKDROPS.map((backdrop) => {
                    const isActive =
                        activeBackdrop &&
                        activeBackdrop.type === backdrop.type &&
                        activeBackdrop.color === backdrop.color &&
                        JSON.stringify(activeBackdrop.stops || null) === JSON.stringify(backdrop.stops || null)
                    return (
                        <button
                            key={backdrop.label}
                            type="button"
                            onClick={() => applyBackdrop(backdrop)}
                            aria-label={`Set ${backdrop.label} background`}
                            title={backdrop.label}
                            className="h-7 rounded-md editor-interactive"
                            style={{
                                background: backdropPreviewCss(backdrop),
                                border: `2px solid ${isActive ? 'var(--accent-primary)' : 'transparent'}`,
                                boxShadow: isActive ? '0 0 0 1px rgba(6,184,212,0.3)' : 'inset 0 0 0 1px var(--border-subtle)',
                            }}
                        />
                    )
                })}
            </div>
            <button
                type="button"
                onClick={() => applyBackdrop(null)}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[10px] font-medium editor-interactive"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
            >
                <X className="w-3 h-3" />
                Clear Background
            </button>
        </Section>
    )
}
