// Vision-driven collage template planning (PURE — no React, no Fabric).
//
// This is the shared contract between the `/api/ai/collage-plan` route (server)
// and the Collage tool / agent (client). It deliberately imports NOTHING from
// `collage-layout.js` or `collage-styles.js` — those pull in Fabric (browser
// canvas), which can't load inside a Node API route. Instead it carries its own
// compact, decoupled catalog of the layout ids / background kinds the AI model
// is allowed to choose from, and strictly validates the model's JSON back into
// the exact recipe shape the Collage tool already knows how to apply.
//
// Pipeline:
//   1. Client downscales each canvas photo to a small JPEG, samples a palette,
//      and POSTs them to /api/ai/collage-plan.
//   2. The route runs a Gemini VISION pass — the model SEES the photos, infers
//      what they are (portrait / food / nature / product / travel …) and the
//      mood, then proposes N tasteful templates that MATCH the content: layout,
//      frame shape, and a background (solid, gradient, or a content-aware
//      generated decoration it writes the prompt for).
//   3. `validateCollagePlan` clamps every field to the allowed catalog so a
//      hallucinated layout / colour can never reach the canvas.
//   4. The tool renders the recipes; applying one runs the SAME layout + style +
//      background engine as the manual tool (content-aware background generated
//      from the recipe's own prompt).

/** Layout menu the model picks from — id + how many photos it needs + a short
 *  art-direction hint. Ids MUST match `collage-layout.js` LAYOUTS. */
export const COLLAGE_LAYOUT_CATALOG = [
    { id: '2-split-h', cellCount: 2, hint: 'two side-by-side columns — comparisons, before/after, two portraits' },
    { id: '2-split-v', cellCount: 2, hint: 'two stacked rows — panoramas, landscape pairs' },
    { id: '3-grid', cellCount: 3, hint: 'one wide hero on top, two below — a standout shot plus support' },
    { id: '3-split-v', cellCount: 3, hint: 'three equal columns — a trio, sequence, or filmstrip' },
    { id: '3-split-h', cellCount: 3, hint: 'three stacked rows — tall/portrait shots, a story sequence' },
    { id: '3-feature-left', cellCount: 3, hint: 'big feature on the left, two small on the right — spotlight one subject' },
    { id: '3-feature-right', cellCount: 3, hint: 'big feature on the right, two small on the left — spotlight one subject' },
    { id: '4-grid', cellCount: 4, hint: 'clean 2×2 grid — balanced sets, products, an even group' },
    { id: '4-columns', cellCount: 4, hint: 'four slim columns — a filmstrip / fashion lineup' },
    { id: '4-rows', cellCount: 4, hint: 'four stacked rows — vertical story, tall shots' },
    { id: '4-feature-top', cellCount: 4, hint: 'wide hero on top, three small below — one headline image' },
    { id: '4-feature-left', cellCount: 4, hint: 'tall hero on the left, three stacked on the right' },
    { id: '5-mosaic', cellCount: 5, hint: 'big feature + a 2×2 mosaic — editorial, travel albums' },
    { id: '6-grid', cellCount: 6, hint: 'full 3×2 grid — big sets, contact sheets, event recaps' },
]

/** Generated-background themes the model can reference for inspiration (it may
 *  also write a fully custom prompt). Ids match `collage-styles.js` AI_BG_THEMES. */
export const COLLAGE_THEME_CATALOG = [
    { id: 'floral', hint: 'hand-drawn blooms & leaves on warm cream — soft, feminine, weddings, portraits' },
    { id: 'botanical', hint: 'delicate single-line leaves on off-white — calm, natural, plants, outdoors' },
    { id: 'doodle', hint: 'playful black marker scribbles on white — fun, kids, casual, candid' },
    { id: 'watercolor', hint: 'loose painted washes — dreamy, romantic, travel, art' },
    { id: 'confetti', hint: 'scattered festive shapes — parties, celebrations, birthdays' },
    { id: 'chalk', hint: 'white chalk on slate — cozy, food, cafe, menus' },
]

/** Content classes the model labels the photo SET with (free-form allowed). */
export const COLLAGE_CONTENT_TYPES = [
    'portrait', 'group', 'pet', 'food', 'nature', 'landscape', 'travel',
    'product', 'fashion', 'event', 'wedding', 'baby', 'architecture',
    'sports', 'art', 'document', 'screenshot', 'abstract', 'mixed',
]

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

const clampNum = (v, lo, hi, fallback) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return fallback
    return Math.max(lo, Math.min(hi, n))
}

const cleanHex = (v) => (typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim() : null)

const cleanStr = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Best-fitting built-in layout for a photo count (pure mirror of
 *  collage-layout.pickLayoutForCount, kept Fabric-free for the route). */
export const bestLayoutForCount = (n) => {
    const fitting = COLLAGE_LAYOUT_CATALOG.filter((l) => l.cellCount <= n)
    if (!fitting.length) return '2-split-h'
    const maxC = Math.max(...fitting.map((l) => l.cellCount))
    return fitting.find((l) => l.cellCount === maxC)?.id || '2-split-h'
}

/** Wrap the model's decorative description into a safe text-to-image prompt:
 *  keep the centre calm for the collage, honour the palette, ban people/text. */
export const wrapCollageBgPrompt = (decorative, palette = []) => {
    const clean = (palette || []).map(cleanHex).filter(Boolean).slice(0, 3)
    const paletteText = clean.length
        ? `Use a colour palette of ${clean.join(', ')}.`
        : 'Use a soft, harmonious palette.'
    return (
        `${cleanStr(decorative, 400)}. ${paletteText} ` +
        `The decoration frames the edges and corners while the centre stays calm and mostly empty ` +
        `so a photo collage can sit on top. No people, no faces, no text, no words, no letters, no watermark.`
    )
}

// ── Gemini prompt + schema ───────────────────────────────────────────────────

// A vocabulary of named aesthetics to pull the model OUT of its generic default
// ("white rounded cards on a pastel background"). It is free to coin its own.
export const CREATIVE_DIRECTIONS = [
    'Editorial / Swiss minimal', 'Magazine cover', 'Gallery wall (matted prints)',
    'Vintage film album', 'Polaroid scrapbook', 'Kraft-paper journal',
    'Pressed-flower botanical', 'Cinematic widescreen', 'Dark luxe / moody',
    'Risograph print', 'Y2K chrome', 'Art-deco gold', 'Scandi pastel',
    'Bold color-block', 'Marble & gold (food)', 'Linen & daylight (lifestyle)',
    'Neon night', 'Travel postcard', 'Monochrome contact sheet',
]

export const buildCollagePlanSystemPrompt = () =>
    `You are a world-class photo-collage ART DIRECTOR with bold, original taste. You are shown a SET of photos that will become ONE collage, plus a sampled palette and the canvas aspect ratio. Design templates that look DESIGNED, not templated — unique, creative and stylish, and unmistakably matched to what these specific photos show.

First, read the photos:
- contentType: what the set mostly shows (portrait, group, food, nature, landscape, travel, product, fashion, event, wedding, baby, pet, architecture, art, abstract…).
- mood: warm, airy, moody, playful, elegant, energetic, minimal, nostalgic, luxe…
- orientation: portrait / landscape / square / mixed — this STEERS the layout (tall shots → rows or columns; one standout → a feature layout; even sets → a grid; sprawling story → a mosaic).
- palette: a few colours that already live in the photos.

Then design each template around ONE named creative DIRECTION — a real, coherent aesthetic (e.g. ${CREATIVE_DIRECTIONS.slice(0, 12).join('; ')}; or coin your own). The direction must SUIT the subject (food → marble/linen/menu-card; nature → pressed-flower/linen daylight; product/fashion → bold color-block/dark luxe/editorial; portraits & family → gallery wall/polaroid/warm film; travel → postcard/cinematic mosaic; party → neon/bold). Every choice below should serve that one concept:
- layout (from the catalog) + gap + padding: SEAMLESS edge-to-edge mosaic (gap 0, padding 0) reads bold/cinematic; AIRY gallery (large gap & padding) reads calm/premium. Use the full range across your set.
- frame: shape (rect vs circle), cornerRadius, shadow, and framePct — an inner MAT of 4–12 around each photo (the background shows through as a border) for matted-gallery / polaroid / scrapbook looks. 0 for edge-to-edge modern looks.
- background: a confident SOLID colour, a rich 2–3 stop GRADIENT, or a GENERATED scene — for "generated" WRITE a vivid, specific prompt naming a real medium/texture and keeping the CENTRE calm (e.g. "warm Carrara marble countertop with soft daylight and a few scattered herbs in the corners", "torn kraft paper with pressed wildflowers and washi tape along the edges", "glossy magazine spread, bold sans-serif colour blocks framing an empty centre", "moody charcoal studio backdrop with a single warm rim light"). Avoid generic "decorative floral border".

Hard rules:
- Pick layoutId ONLY from the catalog, and ONLY layouts whose cellCount ≤ the photo count.
- cornerRadius is a percentage 0–50 (circles ignore it). framePct 0–14. gap 0–48. padding 0–80. Colours are #RRGGBB hex.
- The recipes MUST be visibly DIFFERENT from each other: vary the direction, the layout, AND the finish — include at least one airy/matted look and one seamless/bold look, and a mix of light and dark backgrounds where it suits the photos.
- Do NOT default to white rounded cards on a pastel background unless it genuinely is the best fit.
- Output JSON ONLY, matching the schema. No markdown, no prose.`

export const buildCollagePlanUserText = ({ photoCount, palette = [], canvasAspect, aspects = [], recipeCount = 6, directionHint = '' }) => {
    const layoutLines = COLLAGE_LAYOUT_CATALOG
        .filter((l) => l.cellCount <= photoCount)
        .map((l) => `  - ${l.id} (needs ${l.cellCount}): ${l.hint}`)
        .join('\n')
    const themeLines = COLLAGE_THEME_CATALOG.map((t) => `  - ${t.id}: ${t.hint}`).join('\n')
    const cleanPalette = (palette || []).map(cleanHex).filter(Boolean)
    const hint = cleanStr(directionHint, 160)
    return [
        `Photo count: ${photoCount}.`,
        canvasAspect ? `Canvas aspect ratio (w/h): ${Number(canvasAspect).toFixed(3)}.` : '',
        aspects.length ? `Per-photo aspect ratios (w/h): ${aspects.map((a) => Number(a).toFixed(2)).join(', ')}.` : '',
        cleanPalette.length ? `Sampled palette already in the photos: ${cleanPalette.join(', ')}.` : '',
        hint ? `\nREQUESTED CREATIVE DIRECTION (from the user/agent): "${hint}". Honour this across all templates — vary the execution, not the concept.` : '',
        '',
        `Allowed layouts (use ONLY these ids, cellCount ≤ ${photoCount}):`,
        layoutLines || '  (none — too few photos)',
        '',
        `Generated-background theme inspiration (you may also write a fully custom prompt):`,
        themeLines,
        '',
        `Return exactly ${recipeCount} DISTINCT, creative templates that best fit THESE photos, ordered best-first.`,
        `The images follow.`,
    ].filter(Boolean).join('\n')
}

export const buildCollagePlanSchema = () => ({
    type: 'OBJECT',
    properties: {
        analysis: {
            type: 'OBJECT',
            properties: {
                contentType: { type: 'STRING' },
                subjectDescription: { type: 'STRING' },
                mood: { type: 'STRING' },
                orientation: { type: 'STRING' },
                palette: { type: 'ARRAY', items: { type: 'STRING' } },
                creativeDirections: { type: 'ARRAY', items: { type: 'STRING' } },
            },
            required: ['contentType', 'mood'],
        },
        recipes: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    label: { type: 'STRING' },
                    direction: { type: 'STRING' },
                    layoutId: { type: 'STRING' },
                    shape: { type: 'STRING' },
                    cornerRadius: { type: 'NUMBER' },
                    shadow: { type: 'BOOLEAN' },
                    framePct: { type: 'NUMBER' },
                    gap: { type: 'NUMBER' },
                    padding: { type: 'NUMBER' },
                    background: {
                        type: 'OBJECT',
                        properties: {
                            kind: { type: 'STRING' },
                            color: { type: 'STRING' },
                            stops: { type: 'ARRAY', items: { type: 'STRING' } },
                            prompt: { type: 'STRING' },
                        },
                        required: ['kind'],
                    },
                    rationale: { type: 'STRING' },
                },
                required: ['label', 'layoutId', 'shape', 'background'],
            },
        },
    },
    required: ['analysis', 'recipes'],
})

// ── Validation / normalization ───────────────────────────────────────────────

const normalizeBackground = (bg) => {
    const kind = cleanStr(bg?.kind, 20).toLowerCase()
    if (kind === 'solid') {
        const color = cleanHex(bg?.color) || '#ffffff'
        return { backdrop: { type: 'solid', color }, bgPrompt: null }
    }
    if (kind === 'gradient') {
        const stops = Array.isArray(bg?.stops) ? bg.stops.map(cleanHex).filter(Boolean) : []
        if (stops.length >= 2) return { backdrop: { type: 'gradient', stops: stops.slice(0, 3) }, bgPrompt: null }
        // Not enough valid stops — degrade to a clean solid.
        return { backdrop: { type: 'solid', color: stops[0] || '#ffffff' }, bgPrompt: null }
    }
    if (kind === 'generated') {
        const prompt = cleanStr(bg?.prompt, 400)
        if (prompt) return { backdrop: null, bgPrompt: prompt }
    }
    // Unknown / empty → safe white backdrop.
    return { backdrop: { type: 'solid', color: '#ffffff' }, bgPrompt: null }
}

const normalizeRecipe = (raw, photoCount) => {
    if (!raw || typeof raw !== 'object') return null
    const layoutEntry = COLLAGE_LAYOUT_CATALOG.find((l) => l.id === raw.layoutId)
    // Reject a layout that doesn't exist or needs more photos than we have —
    // remap to the best fit so the suggestion is still usable.
    const layoutId = layoutEntry && layoutEntry.cellCount <= photoCount ? raw.layoutId : bestLayoutForCount(photoCount)

    const shape = String(raw.shape).toLowerCase() === 'circle' ? 'circle' : 'rect'
    const radiusPct = shape === 'circle' ? 0 : Math.round(clampNum(raw.cornerRadius, 0, 50, 0))
    const shadow = Boolean(raw.shadow)
    // Inner mat (% of cell) — circles look wrong matted, so force 0 there.
    const framePct = shape === 'circle' ? 0 : Math.round(clampNum(raw.framePct, 0, 14, 0))
    const { backdrop, bgPrompt } = normalizeBackground(raw.background)

    return {
        label: cleanStr(raw.label, 40) || 'Template',
        direction: cleanStr(raw.direction, 40),
        layoutId,
        // Spacing is part of the look (seamless mosaic ↔ airy gallery).
        gap: Math.round(clampNum(raw.gap, 0, 48, 10)),
        padding: Math.round(clampNum(raw.padding, 0, 80, 10)),
        style: { shape, radiusPct, shadow, framePct },
        backdrop,
        bgPrompt,
        theme: null,
        rationale: cleanStr(raw.rationale, 200),
        isAi: Boolean(bgPrompt),
    }
}

/**
 * Validate a raw Gemini collage plan into `{ analysis, recipes }` where each
 * recipe is the plain spec the Collage tool's `applyRecipe` consumes. Anything
 * malformed is clamped or dropped — a hallucinated layout/colour never reaches
 * the canvas.
 */
export const validateCollagePlan = (raw, { photoCount, maxRecipes = 6 } = {}) => {
    const count = Math.max(2, Number(photoCount) || 2)
    const analysisRaw = raw?.analysis || {}
    const analysis = {
        contentType: cleanStr(analysisRaw.contentType, 40) || 'mixed',
        subjectDescription: cleanStr(analysisRaw.subjectDescription, 200),
        mood: cleanStr(analysisRaw.mood, 40),
        orientation: cleanStr(analysisRaw.orientation, 20),
        palette: Array.isArray(analysisRaw.palette) ? analysisRaw.palette.map(cleanHex).filter(Boolean).slice(0, 5) : [],
        creativeDirections: Array.isArray(analysisRaw.creativeDirections)
            ? analysisRaw.creativeDirections.map((d) => cleanStr(d, 40)).filter(Boolean).slice(0, 6)
            : [],
    }
    const list = Array.isArray(raw?.recipes) ? raw.recipes : []
    const recipes = list
        .map((r) => normalizeRecipe(r, count))
        .filter(Boolean)
        .slice(0, maxRecipes)
    return { analysis, recipes }
}
