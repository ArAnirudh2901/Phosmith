import { memo } from 'react'

/**
 * Phosmith wordmark — a cyan spark of light (phos = light) set beside the name
 * (smith = the maker who forges it). Pure inline SVG + text: scales perfectly at
 * any size, theme-colored, and carries zero raster weight (it replaces the old
 * 6.9 MB Logo.png). Cyan is #06B8D4, the app's accent.
 */

// A clean, symmetric 4-point spark in a 28×28 box, centered at (14,14).
export const PHOSMITH_SPARK =
    'M14 0 C 14.6 8.4, 19.6 13.4, 28 14 C 19.6 14.6, 14.6 19.6, 14 28 C 13.4 19.6, 8.4 14.6, 0 14 C 8.4 13.4, 13.4 8.4, 14 0 Z'

const PhosmithWordmark = memo(function PhosmithWordmark({ height = 22, showText = true, color = '#F4F4F5' }) {
    const gap = Math.round(height * 0.36)
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap, flex: '0 0 auto', lineHeight: 1 }}>
            <svg width={height} height={height} viewBox="0 0 28 28" fill="none" role="img" aria-label="Phosmith">
                <title>Phosmith</title>
                <path d={PHOSMITH_SPARK} fill="#06B8D4" />
            </svg>
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
