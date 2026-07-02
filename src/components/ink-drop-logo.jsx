import { memo } from 'react'

/**
 * Phosmith brand mark — a 5×7 pixel-block capital "P" with one cell of the
 * middle bar (the bar that closes the bowl and joins the descender)
 * replaced with brand cyan. That cell is the structural pivot of the
 * letterform: it sits at the geometric horizontal center and at the
 * junction between bowl and descender. Highlighting it in cyan reads as
 * "this is the specific pixel the editor is currently working on" — the
 * single pixel of the photo (the P) being edited or created.
 *
 * Why every design decision is what it is:
 *   • A real P, not an icon — the bowl is left *open* (a 3×2 void).
 *     Filling the bowl would close the letterform and break the P.
 *   • The cyan pixel belongs to the P, not the void — it replaces a real
 *     pixel of the middle bar instead of floating inside the bowl. Anchored
 *     on both sides by white P pixels, it can't be misread as a stray dot
 *     the way the original ink-drop's splash circles were.
 *   • The position is the geometric and structural focal point of the
 *     letter — middle of the middle bar — so the cyan reads as the focus
 *     of the mark, not an arbitrary accent.
 *   • 5×7 cell grid (not 4×6) so the bowl has a proper 3×2 interior void
 *     and the middle bar has an unambiguous odd-numbered center cell. The
 *     letter reads as typographically real, not as a stunted icon.
 *   • Cyan is #06B8D4 — the same accent used for active tools, the export
 *     pill's offset shadow, and the dashboard header's hard shadow. The
 *     focal pixel reads as the editor's brand-signature interaction.
 *
 * Geometry: 28-unit viewBox, 4×4 pixel cells. The letterform occupies
 * 20×28 — full bleed vertically, with a 4-unit margin on each side
 * horizontally — so the cells stay pixel-perfect at every integer scale
 * (the editor topbar renders at 22px display). Strictly solid rectangles
 * in two colors; nothing in the SVG can produce a floating dot artifact.
 *
 * Export name `InkDropLogo` is preserved for the editor-topbar import
 * even though the design is no longer an ink drop.
 */
const InkDropLogo = memo(function InkDropLogo() {
    return (
        <svg
            width="22"
            height="22"
            viewBox="0 0 28 28"
            fill="none"
            role="img"
            aria-label="Phosmith"
        >
            <title>Phosmith</title>

            {/* Top bar — 5 white cells across the top of the bowl */}
            <rect x="4" y="0" width="4" height="4" fill="#F4F4F5" />
            <rect x="8" y="0" width="4" height="4" fill="#F4F4F5" />
            <rect x="12" y="0" width="4" height="4" fill="#F4F4F5" />
            <rect x="16" y="0" width="4" height="4" fill="#F4F4F5" />
            <rect x="20" y="0" width="4" height="4" fill="#F4F4F5" />

            {/* Bowl row 1 — left stem + right side (interior is the open void
                that makes the shape read as a P) */}
            <rect x="4" y="4" width="4" height="4" fill="#F4F4F5" />
            <rect x="20" y="4" width="4" height="4" fill="#F4F4F5" />

            {/* Bowl row 2 — same */}
            <rect x="4" y="8" width="4" height="4" fill="#F4F4F5" />
            <rect x="20" y="8" width="4" height="4" fill="#F4F4F5" />

            {/* Middle bar — closes the bowl and joins the descender. The
                center cell is cyan: the structural pivot of the letter and
                the focal pixel being edited. Anchored on both sides by
                white P cells so it reads as part of the letterform, not
                as a free-floating dot. */}
            <rect x="4" y="12" width="4" height="4" fill="#F4F4F5" />
            <rect x="8" y="12" width="4" height="4" fill="#F4F4F5" />
            <rect x="12" y="12" width="4" height="4" fill="#06B8D4" />
            <rect x="16" y="12" width="4" height="4" fill="#F4F4F5" />
            <rect x="20" y="12" width="4" height="4" fill="#F4F4F5" />

            {/* Descender — 3 stem cells continuing below the bowl */}
            <rect x="4" y="16" width="4" height="4" fill="#F4F4F5" />
            <rect x="4" y="20" width="4" height="4" fill="#F4F4F5" />
            <rect x="4" y="24" width="4" height="4" fill="#F4F4F5" />
        </svg>
    )
})

export default InkDropLogo
