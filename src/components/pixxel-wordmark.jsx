import { memo } from 'react'

/**
 * Pixxel brand icon — the P logo (5×7 cell grid with a single cyan focal
 * pixel).
 *
 * Used in the editor topbar. The icon sits inside a `.editor-logo-button`
 * frame which provides the dark background, white border, and cyan offset
 * shadow.
 */
const PixxelWordmark = memo(function PixxelWordmark() {
    return (
        <svg
            width="20"
            height="20"
            viewBox="0 0 28 28"
            fill="none"
            role="img"
            aria-label="Pixxel"
            style={{ flex: '0 0 auto', display: 'block' }}
        >
            {/* P letterform — same 5×7 cell grid as InkDropLogo, with the
                center cell of the middle bar in cyan as the focal pixel. */}
            <rect x="4" y="0" width="4" height="4" fill="#F4F4F5" />
            <rect x="8" y="0" width="4" height="4" fill="#F4F4F5" />
            <rect x="12" y="0" width="4" height="4" fill="#F4F4F5" />
            <rect x="16" y="0" width="4" height="4" fill="#F4F4F5" />
            <rect x="20" y="0" width="4" height="4" fill="#F4F4F5" />
            <rect x="4" y="4" width="4" height="4" fill="#F4F4F5" />
            <rect x="20" y="4" width="4" height="4" fill="#F4F4F5" />
            <rect x="4" y="8" width="4" height="4" fill="#F4F4F5" />
            <rect x="20" y="8" width="4" height="4" fill="#F4F4F5" />
            <rect x="4" y="12" width="4" height="4" fill="#F4F4F5" />
            <rect x="8" y="12" width="4" height="4" fill="#F4F4F5" />
            <rect x="12" y="12" width="4" height="4" fill="#06B8D4" />
            <rect x="16" y="12" width="4" height="4" fill="#F4F4F5" />
            <rect x="20" y="12" width="4" height="4" fill="#F4F4F5" />
            <rect x="4" y="16" width="4" height="4" fill="#F4F4F5" />
            <rect x="4" y="20" width="4" height="4" fill="#F4F4F5" />
            <rect x="4" y="24" width="4" height="4" fill="#F4F4F5" />
        </svg>
    )
})

export default PixxelWordmark

