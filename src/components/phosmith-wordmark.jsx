import { memo } from 'react'

// Simple 4-point spark path — used as icon fallback and in favicon
export const PIXXEL_SPARK =
    'M14 0 C 14.6 8.4, 19.6 13.4, 28 14 C 19.6 14.6, 14.6 19.6, 14 28 C 13.4 19.6, 8.4 14.6, 0 14 C 8.4 13.4, 13.4 8.4, 14 0 Z'

/**
 * PixxelWordmark — brand lockup: logo mark + "Pixxel" text.
 *
 * Props:
 *   height      — base size in px (controls the layout rhythm).  default 22
 *   markScale   — logo mark renders at height × markScale.       default 1.6
 *   textSize    — text renders at this exact px size.            default 14
 *   showText    — whether to show the "Pixxel" word.           default true
 *   color       — text colour.                                   default #F4F4F5
 *
 * Tune markScale up for a bigger icon, textSize down for smaller text.
 */
const PixxelWordmark = memo(function PixxelWordmark({
    height = 22,
    markScale = 1.6,
    textSize,
    showText = true,
    color = '#F4F4F5',
}) {
    const markPx = Math.round(height * markScale)
    const fontPx = textSize ?? Math.round(height * 0.84)
    const gap = Math.round(height * 0.45)

    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap, flex: '0 0 auto', lineHeight: 1 }}>
            <img
                src="/logo-mark.svg"
                alt="Pixxel"
                width={markPx}
                height={markPx}
                style={{
                    display: 'block',
                    flexShrink: 0,
                    filter:
                        'drop-shadow(0 0 6px rgba(6,184,212,0.8)) drop-shadow(0 0 14px rgba(6,184,212,0.4)) brightness(1.2)',
                }}
            />
            {showText && (
                <span
                    style={{
                        fontWeight: 600,
                        fontSize: fontPx,
                        letterSpacing: '-0.02em',
                        color,
                        whiteSpace: 'nowrap',
                    }}
                >
                    Pixxel
                </span>
            )}
        </span>
    )
})

export default PixxelWordmark
