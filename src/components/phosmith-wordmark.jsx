import { memo } from 'react'

// Simple 4-point spark path — used as icon fallback and in favicon
export const PHOSMITH_SPARK =
    'M14 0 C 14.6 8.4, 19.6 13.4, 28 14 C 19.6 14.6, 14.6 19.6, 14 28 C 13.4 19.6, 8.4 14.6, 0 14 C 8.4 13.4, 13.4 8.4, 14 0 Z'

const PhosmithWordmark = memo(function PhosmithWordmark({ height = 22, showText = true, color = '#F4F4F5' }) {
    const gap = Math.round(height * 0.40)
    // The logo.svg background is #08090D; the header background is #07090E — both near-black,
    // so the mark sits flush. border-radius mirrors the SVG's rx=28 in a 240px viewBox.
    const borderRadius = Math.round(height * (28 / 240))
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap, flex: '0 0 auto', lineHeight: 1 }}>
            <img
                src="/logo-mark.svg"
                alt="Phosmith"
                width={height}
                height={height}
                style={{ display: 'block', flexShrink: 0 }}
            />
            {showText && (
                <span
                    style={{
                        fontWeight: 600,
                        fontSize: Math.round(height * 0.84),
                        letterSpacing: '-0.02em',
                        color,
                        whiteSpace: 'nowrap',
                    }}
                >
                    Phosmith
                </span>
            )}
        </span>
    )
})

export default PhosmithWordmark
