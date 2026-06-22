/**
 * Collage Commands (agent-facing, UI-decoupled)
 * ---------------------------------------------
 * Lets the in-app agent BUILD A COLLAGE TEMPLATE and drop the canvas photos into
 * it headlessly — no Collage tool open, no React. It frames photos through the
 * exact same engine as the manual tool (`src/lib/collage-layout.js`) and styles /
 * backgrounds them through `src/lib/collage-styles.js`, so an agent-built collage
 * is identical to a hand-built one (same cover-fit, clip shapes, pan constraints,
 * serialization).
 *
 * Commands (discoverable via `command-registry.listCommands`):
 *
 *   collage.listLayouts        — enumerate the built-in layouts (read-only).
 *   collage.listStyles         — enumerate style presets, backdrops, AI themes.
 *   collage.createTemplate     — arrange the current photos into a layout with a
 *                                style + background. Auto-picks the layout from
 *                                the photo count when none is given.
 *   collage.setBackground      — set a solid/gradient/named canvas backdrop.
 *   collage.generateBackground — generate a decorative background that "fits the
 *                                photos" (samples their colours) and apply it.
 *   collage.suggestTemplates   — VISION model looks at the photos and returns
 *                                content-matched template recipes (read-only).
 *   collage.aiTemplate         — vision-driven one-shot: design + apply the
 *                                best content-matched template (layout + style +
 *                                content-aware background).
 *   collage.fromDescription    — natural-language entry: parse a prompt like
 *                                "make a rounded pastel 4-grid collage with a
 *                                floral background" → createTemplate (+ generate).
 *
 * Registered by canvas.jsx alongside the mask/crop domains.
 *
 * @module agent/collage-commands
 */

import { FabricImage } from 'fabric'
import { FastAverageColor } from 'fast-average-color'
import {
    LAYOUTS,
    isVisibleImage,
    fitImageToCell,
    computeCollageCells,
    pickLayoutForCount,
} from '@/lib/collage-layout'
import {
    COLLAGE_STYLES,
    COLLAGE_BACKDROPS,
    AI_BG_THEMES,
    applyCollageBackground,
    buildAiBackgroundPrompt,
} from '@/lib/collage-styles'
import { wrapCollageBgPrompt } from '@/lib/collage-ai'
import { applyCanvasSizedBackground } from '@/lib/canvas-background'

const fac = new FastAverageColor()

const NAMED_COLORS = {
    white: '#ffffff', black: '#0b0d12', cream: '#f6efe2', ivory: '#f6efe2',
    sunshine: '#fde68a', yellow: '#fde68a', blush: '#fbcfe8', pink: '#fbcfe8',
    sky: '#bfdbfe', blue: '#bfdbfe', mint: '#bbf7d0', green: '#bbf7d0',
    lilac: '#ddd6fe', purple: '#ddd6fe', violet: '#ddd6fe', peach: '#fed7aa',
    orange: '#fed7aa', slate: '#2f3437', gray: '#2f3437', grey: '#2f3437',
}

const resolveStyle = (style) => {
    const base = { shape: 'rect', radiusPct: 0, shadow: false, framePct: 0, backdrop: null }
    if (!style) return base
    if (typeof style === 'object') {
        const shape = style.shape === 'circle' ? 'circle' : 'rect'
        return {
            shape,
            radiusPct: Math.max(0, Math.min(50, Number(style.radiusPct) || 0)),
            shadow: Boolean(style.shadow),
            framePct: shape === 'circle' ? 0 : Math.max(0, Math.min(14, Number(style.framePct) || 0)),
            backdrop: style.backdrop || null,
        }
    }
    const preset = COLLAGE_STYLES.find((s) => s.id === String(style).toLowerCase())
    if (preset) {
        return { shape: preset.shape, radiusPct: preset.radiusPct, shadow: preset.shadow, framePct: 0, backdrop: preset.backdrop }
    }
    return base
}

const resolveBackdrop = (background, project) => {
    if (!background) return null
    if (typeof background === 'object') return background
    const s = String(background).trim().toLowerCase()
    if (s === 'none' || s === 'clear' || s === 'transparent') return { type: 'none' }
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return { type: 'solid', color: s }
    const named = COLLAGE_BACKDROPS.find((b) => (b.label || '').toLowerCase() === s)
    if (named) return named
    if (s.includes('gradient') || s === 'cotton') return COLLAGE_BACKDROPS.find((b) => b.label === 'Cotton')
    if (s === 'sunset') return COLLAGE_BACKDROPS.find((b) => b.label === 'Sunset')
    if (NAMED_COLORS[s]) return { type: 'solid', color: NAMED_COLORS[s] }
    return null
}

/** Sample up to 4 of the photos' dominant colours so a generated background
 *  harmonises with them. */
const samplePhotoColors = async (images) => {
    const colors = []
    for (const img of images.slice(0, 4)) {
        const src = img.getSrc?.() || img._originalElement?.src
        if (!src || String(src).startsWith('blob:')) continue
        try {
            const c = await fac.getColorAsync(src, { algorithm: 'dominant', crossOrigin: 'anonymous' })
            if (c?.hex) colors.push(c.hex)
        } catch {
            /* tainted/unreachable — skip */
        }
    }
    return colors
}

/** Downscale photos to small JPEGs the vision model can SEE (tainted sources
 *  skipped). Returns `[{ base64, mimeType, aspect }]`. */
const buildThumbnailsFromImages = async (images, max = 6) => {
    const out = []
    for (const img of images.slice(0, max)) {
        const el = img._originalElement || img._element || img.getElement?.()
        const w = el?.naturalWidth || el?.width
        const h = el?.naturalHeight || el?.height
        if (!el || !w || !h || typeof document === 'undefined') continue
        const scale = Math.min(1, 384 / Math.max(w, h))
        const cw = Math.max(1, Math.round(w * scale))
        const ch = Math.max(1, Math.round(h * scale))
        const c = document.createElement('canvas')
        c.width = cw
        c.height = ch
        try {
            c.getContext('2d').drawImage(el, 0, 0, cw, ch)
            const base64 = c.toDataURL('image/jpeg', 0.72).split(',')[1]
            if (base64) out.push({ base64, mimeType: 'image/jpeg', aspect: w / h })
        } catch {
            /* tainted source — skip it */
        }
    }
    return out
}

/**
 * Heuristic natural-language → template-spec parser (keyless, deterministic).
 * Recognises layout, photo shape/radius, shadow, named/colour backgrounds, AI
 * background themes, and spacing intent.
 */
export const parseCollagePrompt = (prompt) => {
    const p = String(prompt || '').toLowerCase()
    const has = (...words) => words.some((w) => p.includes(w))
    const spec = {}

    // "Surprise me" — randomized template tuned to the photo count.
    if (has('surprise', 'random', 'auto template', 'auto-template', 'whatever you', 'pick for me', 'your choice', 'any template')) {
        spec.auto = true
    }

    // ---- Layout ----
    const num =
        has('six', '6') ? 6 : has('five', '5') ? 5 : has('four', '4') ? 4
            : has('three', '3') ? 3 : has('two', '2') ? 2 : null
    if (has('mosaic')) spec.layout = '5-mosaic'
    else if (has('feature', 'spotlight', 'hero')) {
        spec.layout = num === 4 ? (has('top') ? '4-feature-top' : '4-feature-left')
            : has('right') ? '3-feature-right' : '3-feature-left'
    } else if (has('column')) {
        spec.layout = num === 4 ? '4-columns' : num === 3 ? '3-split-v' : '2-split-h'
    } else if (has('row', 'stack')) {
        spec.layout = num === 4 ? '4-rows' : num === 3 ? '3-split-h' : '2-split-v'
    } else if (has('grid') && num) {
        spec.layout = num >= 6 ? '6-grid' : num === 4 ? '4-grid' : num === 3 ? '3-grid' : '4-grid'
    } else if (num && LAYOUTS.some((l) => l.cellCount === num)) {
        spec.layout = num === 2 ? '2-split-h' : num === 3 ? '3-grid' : num === 4 ? '4-grid' : num === 5 ? '5-mosaic' : '6-grid'
    }

    // ---- Style preset by name ----
    const presetByName = COLLAGE_STYLES.find((s) => p.includes(s.label.toLowerCase()) || p.includes(s.id))
    if (presetByName) {
        spec.style = presetByName.id
    } else {
        // Compose a style from individual cues.
        const style = { shape: 'rect', radiusPct: 0, shadow: false }
        if (has('circle', 'circular', 'round photo', 'bubble')) style.shape = 'circle'
        if (has('rounded', 'round corner', 'soft corner')) style.radiusPct = 22
        if (has('shadow', 'floating', 'card', 'polaroid', 'lifted', 'drop shadow')) style.shadow = true
        if (style.shape === 'circle' || style.radiusPct || style.shadow) spec.style = style
    }

    // ---- AI background theme (generate) ----
    if (has('floral', 'flower', 'bloom')) spec.theme = 'floral'
    else if (has('doodle', 'scribble', 'sketch', 'marker')) spec.theme = 'doodle'
    else if (has('botanical', 'leaves', 'leaf', 'vine')) spec.theme = 'botanical'
    else if (has('watercolor', 'watercolour', 'painted')) spec.theme = 'watercolor'
    else if (has('confetti', 'sprinkle', 'festive', 'party')) spec.theme = 'confetti'
    else if (has('chalk', 'chalkboard', 'blackboard')) spec.theme = 'chalk'

    // ---- Plain background colour / gradient (only if no AI theme requested) ----
    if (!spec.theme) {
        if (has('gradient', 'cotton candy', 'cotton')) spec.background = 'cotton'
        else {
            for (const word of Object.keys(NAMED_COLORS)) {
                if (p.includes(`${word} background`) || p.includes(`${word} backdrop`) || p.includes(`on ${word}`)) {
                    spec.background = word
                    break
                }
            }
        }
    }

    // ---- Spacing ----
    if (has('no gap', 'tight', 'seamless', 'gapless')) { spec.gap = 0; spec.padding = 0 }
    else if (has('spacious', 'wide gap', 'lots of space', 'airy')) { spec.gap = 28; spec.padding = 24 }

    return spec
}

export const createCollageCommands = ({ getCanvas, getProject }) => {
    const sizeOf = () => {
        const project = getProject?.()
        const canvas = getCanvas?.()
        return {
            width: Number(project?.width) || canvas?.getWidth?.() || 1000,
            height: Number(project?.height) || canvas?.getHeight?.() || 1000,
        }
    }

    const getImages = () => {
        const canvas = getCanvas?.()
        return (canvas?.getObjects?.() || []).filter(isVisibleImage)
    }

    const doCreateTemplate = ({ layout, style, background, gap = 10, padding = 10 } = {}) => {
        const canvas = getCanvas?.()
        if (!canvas) throw new Error('[agent.collage] canvas unavailable')
        const images = getImages()
        if (images.length < 2) {
            throw new Error(`[agent.collage] need at least 2 photos to build a collage (found ${images.length})`)
        }

        const requested = layout && LAYOUTS.some((l) => l.id === layout) ? layout : null
        const layoutId = requested || pickLayoutForCount(images.length)
        const layoutDef = LAYOUTS.find((l) => l.id === layoutId)
        if (images.length < layoutDef.cellCount) {
            throw new Error(`[agent.collage] "${layoutId}" needs ${layoutDef.cellCount} photos, only ${images.length} available`)
        }

        const st = resolveStyle(style)
        const backdrop = resolveBackdrop(background, getProject?.()) ?? st.backdrop ?? null
        if (backdrop) applyCollageBackground(canvas, backdrop, sizeOf())

        const cells = computeCollageCells(sizeOf(), layoutId, gap, padding)
        const frameStyle = { shape: st.shape, radiusPct: st.radiusPct, shadow: st.shadow, framePct: st.framePct || 0 }

        canvas.discardActiveObject?.()
        images.slice(0, cells.length).forEach((image, index) => fitImageToCell(image, cells[index], frameStyle))
        canvas.requestRenderAll()
        canvas.__pushHistoryState?.({ label: 'Built collage template', detail: layoutId, domain: 'collage' })
        canvas.__saveCanvasState?.()

        return {
            layout: layoutId,
            cells: cells.length,
            placed: Math.min(cells.length, images.length),
            extras: Math.max(0, images.length - cells.length),
            style: frameStyle,
            background: backdrop,
        }
    }

    // Randomized template tuned to the photo count: pick a layout that uses as
    // many photos as possible + a random style + a random AI background theme.
    const doAutoTemplate = async () => {
        const images = getImages()
        if (images.length < 2) {
            throw new Error(`[agent.collage] need at least 2 photos to build a collage (found ${images.length})`)
        }
        const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
        const usable = LAYOUTS.filter((l) => l.cellCount <= images.length)
        const maxCells = Math.max(...usable.map((l) => l.cellCount))
        const layoutDef = pick(usable.filter((l) => l.cellCount === maxCells))
        const preset = pick(COLLAGE_STYLES)
        const theme = pick(AI_BG_THEMES)

        const template = doCreateTemplate({ layout: layoutDef.id, style: preset.id })
        let generatedBackground = null
        try {
            generatedBackground = await doGenerateBackground({ theme: theme.id })
        } catch (error) {
            generatedBackground = { applied: false, error: String(error?.message || error) }
        }
        return { ...template, randomized: true, theme: theme.id, generatedBackground }
    }

    // Vision-driven: the model LOOKS at the photos and proposes templates that
    // match their content. Returns the analysis + validated recipes (read-only).
    const doSuggestTemplates = async (directionHint = '') => {
        const images = getImages()
        if (images.length < 2) {
            throw new Error(`[agent.collage] need at least 2 photos to suggest templates (found ${images.length})`)
        }
        const [thumbs, colors] = await Promise.all([
            buildThumbnailsFromImages(images),
            samplePhotoColors(images),
        ])
        if (thumbs.length === 0) {
            throw new Error('[agent.collage] could not read the photos for vision analysis (cross-origin without CORS?)')
        }
        const project = getProject?.()
        const canvasAspect = (Number(project?.width) || 1) / (Number(project?.height) || 1)
        const resp = await fetch('/api/ai/collage-plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                photos: thumbs,
                photoCount: images.length,
                palette: colors,
                aspects: thumbs.map((t) => t.aspect),
                canvasAspect,
                recipeCount: 6,
                directionHint: typeof directionHint === 'string' ? directionHint : '',
            }),
        })
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}))
            throw new Error(data.error || `[agent.collage] collage-plan HTTP ${resp.status}`)
        }
        const data = await resp.json()
        return {
            source: data.source || 'none',
            analysis: data.analysis || null,
            recipes: Array.isArray(data.recipes) ? data.recipes : [],
        }
    }

    // Vision-driven full build: suggest → apply the best-fit recipe (layout +
    // style + content-aware background). Falls back to the randomized auto when
    // the vision model is unavailable.
    const doAiTemplate = async (directionHint = '') => {
        let plan
        try {
            plan = await doSuggestTemplates(directionHint)
        } catch (error) {
            const auto = await doAutoTemplate()
            return { ...auto, aiFallback: true, reason: String(error?.message || error) }
        }
        const best = plan.recipes[0]
        if (!best) {
            const auto = await doAutoTemplate()
            return { ...auto, aiFallback: true, reason: 'no vision recipes returned' }
        }

        const template = doCreateTemplate({
            layout: best.layoutId,
            style: best.style,
            gap: Number.isFinite(best.gap) ? best.gap : 10,
            padding: Number.isFinite(best.padding) ? best.padding : 10,
        })
        let generatedBackground = null
        try {
            if (best.bgPrompt) {
                const colors = await samplePhotoColors(getImages())
                generatedBackground = await doGenerateBackground({ prompt: wrapCollageBgPrompt(best.bgPrompt, colors) })
            } else if (best.backdrop) {
                applyCollageBackground(getCanvas?.(), best.backdrop, sizeOf())
                getCanvas?.()?.__pushHistoryState?.({ label: 'Set collage background', domain: 'collage' })
                getCanvas?.()?.__saveCanvasState?.()
                generatedBackground = { applied: true, backdrop: best.backdrop }
            }
        } catch (error) {
            generatedBackground = { applied: false, error: String(error?.message || error) }
        }
        return { ...template, analysis: plan.analysis, label: best.label, generatedBackground }
    }

    const doGenerateBackground = async ({ theme, prompt } = {}) => {
        const canvas = getCanvas?.()
        if (!canvas) throw new Error('[agent.collage] canvas unavailable')
        const themeDef =
            AI_BG_THEMES.find((t) => t.id === String(theme || '').toLowerCase()) ||
            AI_BG_THEMES.find((t) => t.label.toLowerCase() === String(theme || '').toLowerCase())
        const colors = await samplePhotoColors(getImages())
        const finalPrompt = prompt || (themeDef ? buildAiBackgroundPrompt(themeDef, colors) : null)
        if (!finalPrompt) throw new Error('[agent.collage] generateBackground needs a known theme or an explicit prompt')

        const response = await fetch('/api/ai/background', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: finalPrompt, raw: true }),
        })
        if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data.error || `[agent.collage] background HTTP ${response.status}`)
        }
        const data = await response.json()
        if (!data?.imageUrl) throw new Error('[agent.collage] no background image returned')

        await applyCanvasSizedBackground(canvas, FabricImage, data.imageUrl, getProject?.())
        canvas.__pushHistoryState?.({ label: 'Generated collage background', detail: themeDef?.label || 'custom', domain: 'collage' })
        canvas.__saveCanvasState?.()
        return { applied: true, theme: themeDef?.id || null, imageUrl: data.imageUrl }
    }

    return {
        listLayouts: {
            description: 'List the built-in collage layouts and how many photos each needs.',
            params: {},
            run: () => LAYOUTS.map((l) => ({ id: l.id, label: l.label, cellCount: l.cellCount })),
        },

        listStyles: {
            description: 'List collage style presets, background swatches, and AI background themes.',
            params: {},
            run: () => ({
                styles: COLLAGE_STYLES.map((s) => ({ id: s.id, label: s.label })),
                backdrops: COLLAGE_BACKDROPS.map((b) => b.label),
                themes: AI_BG_THEMES.map((t) => ({ id: t.id, label: t.label })),
            }),
        },

        createTemplate: {
            description: 'Arrange the current canvas photos into a collage: pick/honor a layout, apply a style (shape/rounded/shadow) and a background, then cover-fit each photo into its cell.',
            params: {
                layout: 'layout id from listLayouts (optional — auto-picked from photo count)',
                style: 'style preset id (e.g. "rounded","circles","cream") or { shape, radiusPct, shadow }',
                background: 'named colour/swatch, hex, "gradient", or "none" (optional)',
                gap: 'px between cells (default 10)',
                padding: 'px around the collage (default 10)',
            },
            run: (args) => doCreateTemplate(args),
        },

        setBackground: {
            description: 'Set the collage canvas background to a solid colour, gradient, named swatch, or clear it.',
            params: { background: 'named colour/swatch, hex, "gradient", or "none"' },
            run: ({ background } = {}) => {
                const canvas = getCanvas?.()
                if (!canvas) throw new Error('[agent.collage] canvas unavailable')
                const backdrop = resolveBackdrop(background, getProject?.())
                applyCollageBackground(canvas, backdrop || { type: 'none' }, sizeOf())
                canvas.__pushHistoryState?.({ label: 'Set collage background', domain: 'collage' })
                canvas.__saveCanvasState?.()
                return { background: backdrop || { type: 'none' } }
            },
        },

        generateBackground: {
            description: 'Generate a decorative background that fits the photos (samples their colours) for a theme like floral, doodle, botanical, watercolor, confetti, or chalkboard — then apply it to the canvas.',
            params: { theme: 'one of: floral, botanical, doodle, watercolor, confetti, chalk', prompt: 'optional explicit prompt overriding the theme' },
            run: (args) => doGenerateBackground(args),
        },

        autoTemplate: {
            description: 'Auto-build a randomized collage tuned to the photo count: detect how many photos are on the canvas, pick a layout that uses as many as possible plus a random style, place the photos, and generate a fit-to-photos background.',
            params: {},
            run: () => doAutoTemplate(),
        },

        suggestTemplates: {
            description: 'Use a VISION model to look at the canvas photos, infer what they show (portrait/food/nature/product/…) and their mood, and return creative template recipes (named direction + layout + spacing + frame style + content-aware background) that MATCH the content. Read-only — pair with createTemplate/generateBackground or use aiTemplate to apply.',
            params: {
                direction: 'optional creative brief steering the look, e.g. "editorial fashion", "90s film album", "cozy cafe menu"',
            },
            run: ({ direction } = {}) => doSuggestTemplates(direction),
        },

        aiTemplate: {
            description: 'Vision-driven one-shot collage: look at the photos, design a unique content-matched template, place the photos, and apply the best-fit layout, spacing, frame style and content-aware background. Pass a direction to steer the aesthetic. Falls back to the randomized autoTemplate if the vision model is unavailable.',
            params: {
                direction: 'optional creative brief, e.g. "vintage scrapbook", "minimal gallery wall", "bold magazine"',
            },
            run: ({ direction } = {}) => doAiTemplate(direction),
        },

        fromDescription: {
            description: 'Build a collage from a natural-language prompt — parses layout, photo shape, shadow, background and AI theme, then creates the template and inserts the photos (generating a decorative background when a theme is mentioned).',
            params: { prompt: 'e.g. "make a rounded pastel 4-grid collage with a floral background"' },
            run: async ({ prompt } = {}) => {
                if (!prompt || String(prompt).trim().length < 3) {
                    throw new Error('[agent.collage] fromDescription needs a prompt of at least 3 characters')
                }
                const spec = parseCollagePrompt(prompt)
                if (spec.auto) {
                    const auto = await doAutoTemplate()
                    return { interpreted: spec, ...auto }
                }
                const template = doCreateTemplate({
                    layout: spec.layout,
                    style: spec.style,
                    background: spec.background,
                    gap: spec.gap,
                    padding: spec.padding,
                })
                let generatedBackground = null
                if (spec.theme) {
                    try {
                        generatedBackground = await doGenerateBackground({ theme: spec.theme })
                    } catch (error) {
                        generatedBackground = { applied: false, error: String(error?.message || error) }
                    }
                }
                return { interpreted: spec, ...template, generatedBackground }
            },
        },
    }
}
