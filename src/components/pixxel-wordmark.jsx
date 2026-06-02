import { memo } from 'react'

/**
 * Pixxel brand wordmark — the icon P (5×7 cell grid with a single cyan focal
 * pixel) followed by the "PIXXEL" wordmark in JetBrains Mono Bold.
 *
 * Used in the editor topbar, replacing the icon-only `InkDropLogo`. The
 * whole wordmark sits inside a single `.editor-logo-button` frame, which
 * provides the dark background, white border, and cyan offset shadow
 * shared with the icon-only version. At narrow viewports the "PIXXEL" text
 * hides via CSS (`.editor-logo-button--wordmark-text { display: none }`) and
 * the wordmark degrades to the icon-only mark.
 *
 * Why duplicate the icon SVG instead of reusing `InkDropLogo`:
 *   • The icon and wordmark travel together in this frame, so co-locating
 *     the SVG keeps the DOM one component and avoids an extra <svg> node.
 *   • The icon size in the wordmark is 20px (slightly smaller than the
 *     icon-only 22px) so it sits balanced with the 12px text; reusing the
 *     exported `<InkDropLogo />` would force 22px and crowd the label.
 *   • InkDropLogo is still imported by anything that wants the icon-only
 *     mark — no behavioural change for those callers.
 */
const PixxelWordmark = memo(function PixxelWordmark() {
    return (
        <>
            <svg
                width="20"
                height="20"
                viewBox="0 0 28 28"
                fill="none"
                role="img"
                aria-hidden="true"
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
            <span
                className="editor-logo-button--wordmark-text"
                aria-label="Pixxel"
                style={{
                    fontFamily: 'var(--font-mono, ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace)',
                    fontWeight: 800,
                    fontSize: '0.72rem',
                    letterSpacing: '0.1em',
                    color: '#F4F4F5',
                    lineHeight: 1,
                    whiteSpace: 'nowrap',
                }}
            >
                PIXXEL
            </span>
        </>
    )
})

export default PixxelWordmark
