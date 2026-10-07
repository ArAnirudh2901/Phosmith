import { buildLayoutCells } from '@/lib/collage-layout'

export const LabeledSlider = ({ label, value, min, max, onChange, suffix = 'px' }) => (
    <div className="space-y-1.5">
        <div className="flex justify-between items-center text-[10px]" style={{ color: 'var(--text-secondary)' }}>
            <span className="font-medium">{label}</span>
            <span className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
                {value}{suffix}
            </span>
        </div>
        <input
            type="range"
            min={min}
            max={max}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-full accent-[var(--accent-primary)] editor-interactive"
            style={{
                height: '4px',
                background: 'var(--border-subtle)',
                borderRadius: '2px',
                appearance: 'none'
            }}
        />
    </div>
)

/** A mini diagram of a layout's actual cell arrangement (Google-Photos-style
 *  template thumbnail), derived from the same geometry the canvas uses. */
export const LayoutPreview = ({ layoutId, active }) => {
    const cells = buildLayoutCells(layoutId, { x: 0, y: 0, w: 100, h: 100 }, 5)
    return (
        <div className="relative" style={{ width: 30, height: 30 }}>
            {cells.map((cell, index) => (
                <div
                    key={index}
                    style={{
                        position: 'absolute',
                        left: `${cell.x}%`,
                        top: `${cell.y}%`,
                        width: `${cell.w}%`,
                        height: `${cell.h}%`,
                        borderRadius: 2,
                        background: active ? 'var(--accent-primary)' : 'var(--text-muted)',
                        opacity: active ? 0.95 : 0.5,
                    }}
                />
            ))}
        </div>
    )
}

/** A realistic thumbnail of a generated template recipe: the backdrop with the
 *  layout's cells drawn at the recipe's spacing (gap + padding), frame shape,
 *  and inner mat (framePct) — so the gallery actually shows the variety. */
export const TemplatePreview = ({ recipe }) => {
    // Map canvas-px spacing into the 100-unit preview box (rough, for the look).
    const previewPad = Math.min(20, (Number.isFinite(recipe.padding) ? recipe.padding : 6) / 8)
    const previewGap = Math.min(12, (Number.isFinite(recipe.gap) ? recipe.gap : 6) / 8)
    const frame = { x: previewPad, y: previewPad, w: 100 - 2 * previewPad, h: 100 - 2 * previewPad }
    const cells = buildLayoutCells(recipe.layoutId, frame, previewGap)
    const matPct = recipe.style.shape === 'circle' ? 0 : Math.min(14, recipe.style.framePct || 0)
    const radius = recipe.style.shape === 'circle' ? '50%' : `${Math.round((recipe.style.radiusPct || 0) / 5) + 1}px`
    return (
        <div
            className="relative w-full overflow-hidden rounded-md"
            style={{ aspectRatio: '1 / 1', background: recipe.previewBg }}
        >
            {cells.map((cell, index) => (
                <div
                    key={index}
                    style={{
                        position: 'absolute',
                        left: `${cell.x}%`,
                        top: `${cell.y}%`,
                        width: `${cell.w}%`,
                        height: `${cell.h}%`,
                        padding: `${matPct}%`,
                        boxSizing: 'border-box',
                    }}
                >
                    <div
                        style={{
                            width: '100%',
                            height: '100%',
                            borderRadius: radius,
                            background: 'rgba(255,255,255,0.94)',
                            boxShadow: recipe.style.shadow
                                ? '0 1px 3px rgba(0,0,0,0.4)'
                                : 'inset 0 0 0 1px rgba(0,0,0,0.10)',
                        }}
                    />
                </div>
            ))}
        </div>
    )
}

export const Section = ({ title, icon: Icon, children }) => (
    <div className="px-4 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-2 mb-3">
            <div className="flex items-center justify-center w-5 h-5 rounded" style={{ background: 'rgba(6,184,212,0.1)' }}>
                <Icon className="w-3 h-3" style={{ color: 'var(--accent-primary)' }} />
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>
                {title}
            </h3>
        </div>
        {children}
    </div>
)
