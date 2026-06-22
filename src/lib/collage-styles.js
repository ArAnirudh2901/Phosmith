// Stylish-collage helpers for the Collage tool.
//
// The base collage tool only frames photos into geometric grid cells. This module
// adds the "stylish template" layer on top of that geometry:
//   • coloured / gradient canvas backdrops (the Google-Photos "multiple coloured
//     backgrounds" look),
//   • per-cell shape styling — rounded corners or circles — built as an
//     absolutely-positioned clipPath so it survives serialization natively and is
//     recovered from the clipPath bounds on reload (no custom props needed),
//   • an optional drop shadow on each framed photo (native Fabric `shadow`, which
//     serializes), giving the floating-card / scrapbook depth,
//   • prompt builders for "generate a background that fits the photos", which
//     sample the photos' own colours and ask the image model for a decorative
//     border that leaves the centre open for the collage.
//
// Everything here is pure (no React, no canvas mutation beyond the single
// `applyCollageBackground` helper) so the tool component stays the integration
// layer and this stays unit-testable.

import { Rect, Ellipse, Shadow, Gradient } from 'fabric'

/** One-click style presets: backdrop + photo shape + shadow bundled together. */
export const COLLAGE_STYLES = [
    { id: 'clean', label: 'Clean', radiusPct: 0, shape: 'rect', shadow: false, backdrop: { type: 'solid', color: '#ffffff' } },
    { id: 'rounded', label: 'Rounded', radiusPct: 18, shape: 'rect', shadow: false, backdrop: { type: 'solid', color: '#ffffff' } },
    { id: 'cards', label: 'Soft Cards', radiusPct: 16, shape: 'rect', shadow: true, backdrop: { type: 'solid', color: '#eef1f5' } },
    { id: 'circles', label: 'Circles', radiusPct: 0, shape: 'circle', shadow: true, backdrop: { type: 'solid', color: '#fdf0d5' } },
    { id: 'cream', label: 'Cream Bloom', radiusPct: 26, shape: 'rect', shadow: true, backdrop: { type: 'solid', color: '#f6efe2' } },
    { id: 'pastel', label: 'Pastel Pop', radiusPct: 22, shape: 'rect', shadow: true, backdrop: { type: 'gradient', stops: ['#fbcfe8', '#bfdbfe'] } },
    { id: 'sunset', label: 'Sunset', radiusPct: 20, shape: 'rect', shadow: true, backdrop: { type: 'gradient', stops: ['#fde68a', '#fb7185'] } },
    { id: 'mint', label: 'Fresh Mint', radiusPct: 20, shape: 'rect', shadow: true, backdrop: { type: 'gradient', stops: ['#bbf7d0', '#a5f3fc'] } },
    { id: 'mono', label: 'Mono Shadow', radiusPct: 12, shape: 'rect', shadow: true, backdrop: { type: 'solid', color: '#0b0d12' } },
    { id: 'slate', label: 'Slate', radiusPct: 10, shape: 'rect', shadow: true, backdrop: { type: 'solid', color: '#2f3437' } },
]

/** Instant background swatches (applied without re-running the layout). */
export const COLLAGE_BACKDROPS = [
    { type: 'solid', color: '#ffffff', label: 'White' },
    { type: 'solid', color: '#0b0d12', label: 'Black' },
    { type: 'solid', color: '#f6efe2', label: 'Cream' },
    { type: 'solid', color: '#fde68a', label: 'Sunshine' },
    { type: 'solid', color: '#fbcfe8', label: 'Blush' },
    { type: 'solid', color: '#bfdbfe', label: 'Sky' },
    { type: 'solid', color: '#bbf7d0', label: 'Mint' },
    { type: 'solid', color: '#ddd6fe', label: 'Lilac' },
    { type: 'solid', color: '#fed7aa', label: 'Peach' },
    { type: 'solid', color: '#2f3437', label: 'Slate' },
    { type: 'gradient', stops: ['#fbcfe8', '#bfdbfe'], label: 'Cotton' },
    { type: 'gradient', stops: ['#fde68a', '#fb7185'], label: 'Sunset' },
]

/** Themes for "generate a background that fits the photos". */
export const AI_BG_THEMES = [
    {
        id: 'floral',
        label: 'Floral',
        swatch: '#f6efe2',
        prompt: 'hand-drawn floral illustration with blooming flowers, buds and leaves decorating the edges and corners',
        medium: 'flat vector scrapbook illustration on warm cream paper',
    },
    {
        id: 'botanical',
        label: 'Botanical',
        swatch: '#eef3ea',
        prompt: 'delicate botanical single-line-art leaves and branches tracing the borders',
        medium: 'minimal continuous-line drawing on soft off-white background',
    },
    {
        id: 'doodle',
        label: 'Doodle',
        swatch: '#ffffff',
        prompt: 'playful black marker doodles, squiggles, stars, hearts and hand-drawn scribble frames around the border',
        medium: 'hand-drawn sketchbook doodle on clean white paper',
    },
    {
        id: 'watercolor',
        label: 'Watercolor',
        swatch: '#eaf2f8',
        prompt: 'soft watercolor washes and loosely painted floral corners framing the edges',
        medium: 'wet watercolor painting with visible paper texture',
    },
    {
        id: 'confetti',
        label: 'Confetti',
        swatch: '#fff7ed',
        prompt: 'scattered confetti, dots, sprinkles and small geometric shapes around the border',
        medium: 'flat festive vector pattern on a light background',
    },
    {
        id: 'chalk',
        label: 'Chalkboard',
        swatch: '#2f3437',
        prompt: 'white chalk hand-drawn frames, arrows, swirls and scribbles around the edges',
        medium: 'real chalk strokes on a dark slate chalkboard texture',
    },
]

/**
 * Curated "stylish template" looks for the Template Generator — each pairs a
 * frame style with either an instant backdrop (solid/gradient) or an AI
 * background theme (decorative, generated to fit the photos). The generator
 * marries each look to a layout that fits the current photo count.
 */
// Each look bundles a frame style (shape / corner radius / shadow / inner mat),
// its own spacing (gap + padding — seamless vs airy), and either an instant
// backdrop or an AI background theme. The spread spans matted galleries,
// seamless cinematic mosaics, scrapbook journals and bold gradients so even the
// keyless heuristic gallery is stylish and varied.
export const TEMPLATE_LOOKS = [
    { id: 'gallery-wall', label: 'Gallery Wall', style: { shape: 'rect', radiusPct: 3, shadow: true, framePct: 10 }, gap: 22, padding: 30, backdrop: { type: 'solid', color: '#f4f1ea' } },
    { id: 'cinematic', label: 'Cinematic', style: { shape: 'rect', radiusPct: 0, shadow: false, framePct: 0 }, gap: 0, padding: 0, backdrop: { type: 'solid', color: '#0b0d12' } },
    { id: 'polaroid', label: 'Polaroid Stack', style: { shape: 'rect', radiusPct: 4, shadow: true, framePct: 9 }, gap: 18, padding: 22, backdrop: { type: 'solid', color: '#ffffff' } },
    { id: 'slate-gallery', label: 'Slate Gallery', style: { shape: 'rect', radiusPct: 4, shadow: false, framePct: 11 }, gap: 20, padding: 28, backdrop: { type: 'solid', color: '#2f3437' } },
    { id: 'cream-bloom', label: 'Pressed Bloom', style: { shape: 'rect', radiusPct: 16, shadow: true, framePct: 6 }, gap: 16, padding: 22, theme: 'floral' },
    { id: 'botanical', label: 'Botanical Air', style: { shape: 'rect', radiusPct: 12, shadow: false, framePct: 5 }, gap: 18, padding: 26, theme: 'botanical' },
    { id: 'kraft-journal', label: 'Kraft Journal', style: { shape: 'rect', radiusPct: 6, shadow: true, framePct: 7 }, gap: 14, padding: 18, theme: 'doodle' },
    { id: 'aquarelle', label: 'Aquarelle', style: { shape: 'rect', radiusPct: 18, shadow: true, framePct: 4 }, gap: 12, padding: 16, theme: 'watercolor' },
    { id: 'chalk-menu', label: 'Chalk Menu', style: { shape: 'rect', radiusPct: 8, shadow: true, framePct: 6 }, gap: 14, padding: 18, theme: 'chalk' },
    { id: 'confetti', label: 'Confetti Pop', style: { shape: 'circle', radiusPct: 0, shadow: true, framePct: 0 }, gap: 16, padding: 18, theme: 'confetti' },
    { id: 'pastel-pop', label: 'Pastel Pop', style: { shape: 'rect', radiusPct: 22, shadow: true, framePct: 0 }, gap: 12, padding: 14, backdrop: { type: 'gradient', stops: ['#fbcfe8', '#bfdbfe'] } },
    { id: 'golden-hour', label: 'Golden Hour', style: { shape: 'rect', radiusPct: 18, shadow: true, framePct: 0 }, gap: 10, padding: 12, backdrop: { type: 'gradient', stops: ['#fde68a', '#fb7185'] } },
    { id: 'noir', label: 'Noir Mosaic', style: { shape: 'rect', radiusPct: 6, shadow: false, framePct: 0 }, gap: 3, padding: 6, backdrop: { type: 'solid', color: '#0b0d12' } },
    { id: 'blush-bubbles', label: 'Blush Bubbles', style: { shape: 'circle', radiusPct: 0, shadow: true, framePct: 0 }, gap: 14, padding: 18, backdrop: { type: 'solid', color: '#fbcfe8' } },
]

/** clamp a corner-radius percentage (0..50) to px for a given cell. */
const radiusForCell = (cell, radiusPct) =>
    Math.max(0, Math.min(0.5, (Number(radiusPct) || 0) / 100)) * Math.min(cell.w, cell.h)

/**
 * Build the absolutely-positioned clipPath that frames a photo inside its cell.
 * A circle style → an ellipse filling the cell bounds; otherwise a (optionally
 * rounded) rect. Both are reconstructable from their bounds, so the cell can be
 * recovered after a reload without any custom marker props.
 */
export const buildCellClipPath = (cell, style) => {
    const common = { originX: 'left', originY: 'top', absolutePositioned: true }
    if (style?.shape === 'circle') {
        return new Ellipse({
            left: cell.x,
            top: cell.y,
            rx: Math.max(1, cell.w / 2),
            ry: Math.max(1, cell.h / 2),
            ...common,
        })
    }
    const r = radiusForCell(cell, style?.radiusPct)
    return new Rect({
        left: cell.x,
        top: cell.y,
        width: Math.max(1, cell.w),
        height: Math.max(1, cell.h),
        rx: r,
        ry: r,
        ...common,
    })
}

/** Native drop shadow for a framed photo (null when the style has none). */
export const buildCellShadow = (style) =>
    style?.shadow
        ? new Shadow({ color: 'rgba(15, 18, 25, 0.30)', blur: 26, offsetX: 0, offsetY: 12 })
        : null

/**
 * Apply a backdrop (solid colour, gradient, or none) as the canvas background.
 * Clears any background IMAGE and the grade flag so the colour shows cleanly.
 */
export const applyCollageBackground = (canvasEditor, backdrop, project) => {
    if (!canvasEditor) return
    canvasEditor.backgroundImage = null
    canvasEditor.__phosmithGradeBackground = false

    if (!backdrop || backdrop.type === 'none') {
        canvasEditor.backgroundColor = null
    } else if (backdrop.type === 'gradient' && Array.isArray(backdrop.stops) && backdrop.stops.length > 1) {
        const W = Math.max(1, Number(project?.width) || canvasEditor.getWidth?.() || 1000)
        const H = Math.max(1, Number(project?.height) || canvasEditor.getHeight?.() || 1000)
        canvasEditor.backgroundColor = new Gradient({
            type: 'linear',
            coords: { x1: 0, y1: 0, x2: W, y2: H },
            colorStops: backdrop.stops.map((color, index) => ({
                offset: index / (backdrop.stops.length - 1),
                color,
            })),
        })
    } else {
        canvasEditor.backgroundColor = backdrop.color || '#ffffff'
    }

    canvasEditor.requestRenderAll()
}

/** A CSS background value for previewing a backdrop in the UI swatches. */
export const backdropPreviewCss = (backdrop) => {
    if (!backdrop) return 'transparent'
    if (backdrop.type === 'gradient' && Array.isArray(backdrop.stops)) {
        return `linear-gradient(135deg, ${backdrop.stops.join(', ')})`
    }
    return backdrop.color || 'transparent'
}

/**
 * Compose the text-to-image prompt for a "fit the photos" background: the theme's
 * decorative description + the sampled photo colours + an instruction to keep the
 * centre open (where the collage sits) and stay free of text/people.
 */
export const buildAiBackgroundPrompt = (theme, colors = []) => {
    const clean = colors.filter(Boolean).slice(0, 3)
    const palette = clean.length
        ? `using a colour palette of ${clean.join(', ')}`
        : 'using a soft, harmonious pastel palette'
    return (
        `${theme.prompt}, ${palette}. ` +
        `The decoration frames the edges and corners while the centre stays calm and mostly empty ` +
        `so a photo collage can sit on top. ${theme.medium}. ` +
        `No people, no faces, no text, no words, no letters, no watermark.`
    )
}
