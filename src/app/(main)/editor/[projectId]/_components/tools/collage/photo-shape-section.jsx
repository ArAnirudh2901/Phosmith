import { Circle, Square } from 'lucide-react'
import { LabeledSlider, Section } from './ui'

// Photo Shape: cell shape, fit and arrangement.

export default function PhotoShapeSection({ radiusPct, shadow, shape, updateStyle }) {
    // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
    'use no memo'
    return (
        <Section title="Photo Shape" icon={Square}>
            <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2">
                    {[
                        { id: 'rect', label: 'Rounded', Icon: Square },
                        { id: 'circle', label: 'Circle', Icon: Circle },
                    ].map(({ id, label, Icon }) => {
                        const isActive = shape === id
                        return (
                            <button
                                key={id}
                                type="button"
                                onClick={() => updateStyle({ shape: id })}
                                className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: isActive ? 'rgba(6,184,212,0.12)' : 'var(--bg-elevated)',
                                    border: `1px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                }}
                            >
                                <Icon className="w-3.5 h-3.5" />
                                {label}
                            </button>
                        )
                    })}
                </div>
                {shape === 'rect' && (
                    <LabeledSlider
                        label="Corner Radius"
                        value={radiusPct}
                        min={0}
                        max={50}
                        onChange={(v) => updateStyle({ radiusPct: v })}
                        suffix="%"
                    />
                )}
                <button
                    type="button"
                    onClick={() => updateStyle({ shadow: !shadow })}
                    aria-pressed={shadow}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-[11px] font-medium editor-interactive"
                    style={{
                        background: shadow ? 'rgba(6,184,212,0.1)' : 'var(--bg-elevated)',
                        border: `1px solid ${shadow ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                        color: shadow ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    }}
                >
                    <span>Drop Shadow</span>
                    <span
                        className="h-4 w-7 rounded-full transition-colors"
                        style={{ background: shadow ? 'var(--accent-primary)' : 'var(--border-default)', position: 'relative' }}
                    >
                        <span
                            className="absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all"
                            style={{ left: shadow ? '14px' : '2px' }}
                        />
                    </span>
                </button>
            </div>
        </Section>
    )
}
