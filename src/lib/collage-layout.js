// Collage layout + framing engine (pure, no React).
//
// Extracted from the Collage tool so BOTH the UI component and the agent's
// UI-decoupled `collage.*` commands frame photos through exactly the same code —
// identical geometry, cover-fit, clip shapes and pan constraints. Keeping this
// framework-agnostic is what lets the agent build a collage headlessly.
//
// A "cell" is `{ x, y, w, h }` in canvas/scene coordinates. A framed photo is a
// Fabric image scaled to COVER its cell, centred, and clipped to the cell's shape
// (rect / rounded / ellipse, per the style). The overflow on the non-matching
// axis is the room the user can drag-to-pan through; `clampToCell` keeps it
// covering. Cells are recoverable from the persisted clipPath, so no custom props
// are needed to survive a reload.

import { isPhosmithMaskOverlay } from './canvas-mask'
import {
    buildCellClipPath,
    buildCellShadow,
    backdropPreviewCss,
    TEMPLATE_LOOKS,
    AI_BG_THEMES,
} from './collage-styles'

/** Layout catalogue (UI-free — icons live in the component). */
export const LAYOUTS = [
    { id: '2-split-h', label: '2 Columns', cellCount: 2, maxColumns: 2, maxRows: 1 },
    { id: '2-split-v', label: '2 Rows', cellCount: 2, maxColumns: 1, maxRows: 2 },
    { id: '3-grid', label: 'Top + 2', cellCount: 3, maxColumns: 2, maxRows: 2 },
    { id: '3-split-v', label: '3 Columns', cellCount: 3, maxColumns: 3, maxRows: 1 },
    { id: '3-split-h', label: '3 Rows', cellCount: 3, maxColumns: 1, maxRows: 3 },
    { id: '3-feature-left', label: 'Left Feature', cellCount: 3, maxColumns: 2, maxRows: 2 },
    { id: '3-feature-right', label: 'Right Feature', cellCount: 3, maxColumns: 2, maxRows: 2 },
    { id: '4-grid', label: '4 Grid', cellCount: 4, maxColumns: 2, maxRows: 2 },
    { id: '4-columns', label: '4 Columns', cellCount: 4, maxColumns: 4, maxRows: 1 },
    { id: '4-rows', label: '4 Rows', cellCount: 4, maxColumns: 1, maxRows: 4 },
    { id: '4-feature-top', label: 'Top Feature', cellCount: 4, maxColumns: 3, maxRows: 2 },
    { id: '4-feature-left', label: 'Side Feature', cellCount: 4, maxColumns: 2, maxRows: 3 },
    { id: '5-mosaic', label: '5 Mosaic', cellCount: 5, maxColumns: 3, maxRows: 2 },
    { id: '6-grid', label: '6 Grid', cellCount: 6, maxColumns: 3, maxRows: 2 },
]

/**
 * Snap every cell to whole pixels and keep at least 1×1.
 *
 * Layout maths is fractional — 1080 / 3 = 360.33 — and Fabric happily draws a
 * clip path on a half pixel, which leaves a hairline of backdrop between two
 * cells that are meant to touch. Rounding the EDGES (not the widths) makes the
 * shared boundary between neighbours resolve to the same integer, so the seam
 * closes and the gap stays within a pixel of what was asked for.
 */
const clampCells = (cells) =>
    cells.map((cell) => {
        const x = Math.round(cell.x)
        const y = Math.round(cell.y)
        return {
            ...cell,
            x,
            y,
            w: Math.max(1, Math.round(cell.x + cell.w) - x),
            h: Math.max(1, Math.round(cell.y + cell.h) - y),
        }
    })

/**
 * Adjustable layouts.
 *
 * Every built-in layout is a set of splits. Instead of hard-coding each split as
 * a constant, they are `weights`: fractions the user can drag. A weight can never
 * take a neighbour below `MIN_CELL_FRACTION` of the axis, which is exactly the
 * "resize one frame and the one next to it collapses to zero" failure — the
 * clamp lives in the maths, so no caller can bypass it.
 *
 * Shape of `weights`: `{ cols?: number[], rows?: number[], split?: number }`.
 * `cols`/`rows` are relative sizes along an axis (normalised on use); `split` is
 * the first-part fraction of the layout's defining division.
 */
export const MIN_CELL_FRACTION = 0.08

/** Which weights each layout listens to, and what they mean without any drag. */
export const LAYOUT_WEIGHT_SCHEMA = {
    '2-split-h': { cols: 2 },
    '3-split-v': { cols: 3 },
    '4-columns': { cols: 4 },
    '2-split-v': { rows: 2 },
    '3-split-h': { rows: 3 },
    '4-rows': { rows: 4 },
    '4-grid': { cols: 2, rows: 2 },
    '6-grid': { cols: 3, rows: 2 },
    '3-grid': { split: 0.5, cols: 2 },              // top band, then two below
    '3-feature-left': { split: 0.62, rows: 2 },     // feature width, side rows
    '3-feature-right': { split: 0.62, rows: 2 },
    '4-feature-top': { split: 0.58, cols: 3 },      // feature height, bottom columns
    '4-feature-left': { split: 0.58, rows: 3 },     // feature width, side rows
    '5-mosaic': { split: 0.48, cols: 2, rows: 2 },  // feature width, then a 2×2
}

/** Uniform weights for a layout: what it looks like before anyone drags it. */
export const defaultWeightsFor = (layoutId) => {
    const schema = LAYOUT_WEIGHT_SCHEMA[layoutId]
    if (!schema) return {}
    const out = {}
    if (schema.cols) out.cols = Array.from({ length: schema.cols }, () => 1)
    if (schema.rows) out.rows = Array.from({ length: schema.rows }, () => 1)
    if (schema.split !== undefined) out.split = schema.split
    return out
}

/** Normalise a weight vector to fractions summing to 1, each at least the floor. */
const fractions = (weights, count) => {
    const raw = Array.isArray(weights) && weights.length === count
        ? weights.map((v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 1))
        : Array.from({ length: count }, () => 1)
    const floor = Math.min(MIN_CELL_FRACTION, 1 / count)
    let total = raw.reduce((a, b) => a + b, 0)
    let out = raw.map((v) => v / total)
    // Lift anything under the floor, then take the difference off the rest in
    // proportion, so the vector still sums to 1 and nothing collapses.
    for (let pass = 0; pass < 4; pass += 1) {
        const short = out.map((v) => Math.max(0, floor - v))
        const debt = short.reduce((a, b) => a + b, 0)
        if (debt <= 1e-9) break
        const spare = out.map((v, i) => (short[i] > 0 ? 0 : v - floor))
        const spareTotal = spare.reduce((a, b) => a + b, 0)
        if (spareTotal <= 1e-9) { out = out.map(() => 1 / count); break }
        out = out.map((v, i) => (short[i] > 0 ? floor : v - (debt * spare[i]) / spareTotal))
    }
    total = out.reduce((a, b) => a + b, 0)
    return out.map((v) => v / total)
}

const splitFraction = (value, fallback) => {
    const v = Number.isFinite(Number(value)) ? Number(value) : fallback
    return Math.max(MIN_CELL_FRACTION, Math.min(1 - MIN_CELL_FRACTION, v))
}

/** Split an axis into `count` weighted parts, gaps taken out first. */
const weightedRuns = (start, extent, count, gap, weights) => {
    const usable = Math.max(1, extent - gap * (count - 1))
    const f = fractions(weights, count)
    const runs = []
    let cursor = start
    for (let i = 0; i < count; i += 1) {
        const size = usable * f[i]
        runs.push({ start: cursor, size })
        cursor += size + gap
    }
    return runs
}

const makeRows = ({ x, y, w, h }, count, gap, weights) =>
    weightedRuns(x, w, count, gap, weights).map((run) => ({ x: run.start, y, w: run.size, h }))

const makeColumns = ({ x, y, w, h }, count, gap, weights) =>
    weightedRuns(y, h, count, gap, weights).map((run) => ({ x, y: run.start, w, h: run.size }))

const makeGrid = (frame, columns, rows, gap, colWeights, rowWeights) => {
    const cols = weightedRuns(frame.x, frame.w, columns, gap, colWeights)
    const rws = weightedRuns(frame.y, frame.h, rows, gap, rowWeights)
    return rws.flatMap((row) => cols.map((col) => ({ x: col.start, y: row.start, w: col.size, h: row.size })))
}

export const buildLayoutCells = (layoutId, frame, gap, weights = null) => {
    const { x, y, w, h } = frame
    const wt = weights || defaultWeightsFor(layoutId)
    const cols = wt.cols
    const rows = wt.rows

    if (layoutId === '2-split-h') return clampCells(makeRows(frame, 2, gap, cols))
    if (layoutId === '2-split-v') return clampCells(makeColumns(frame, 2, gap, rows))
    if (layoutId === '3-split-v') return clampCells(makeRows(frame, 3, gap, cols))
    if (layoutId === '3-split-h') return clampCells(makeColumns(frame, 3, gap, rows))
    if (layoutId === '4-grid') return clampCells(makeGrid(frame, 2, 2, gap, cols, rows))
    if (layoutId === '4-columns') return clampCells(makeRows(frame, 4, gap, cols))
    if (layoutId === '4-rows') return clampCells(makeColumns(frame, 4, gap, rows))
    if (layoutId === '6-grid') return clampCells(makeGrid(frame, 3, 2, gap, cols, rows))

    if (layoutId === '3-grid') {
        const usable = Math.max(1, h - gap)
        const topH = usable * splitFraction(wt.split, 0.5)
        const bottomH = usable - topH
        const bottom = makeRows({ x, y: y + topH + gap, w, h: bottomH }, 2, gap, cols)
        return clampCells([{ x, y, w, h: topH }, ...bottom])
    }

    if (layoutId === '3-feature-left' || layoutId === '3-feature-right') {
        const usable = Math.max(1, w - gap)
        const featureW = usable * splitFraction(wt.split, 0.62)
        const sideW = usable - featureW
        const sideFrameX = layoutId === '3-feature-left' ? x + featureW + gap : x
        const sideCells = makeColumns({ x: sideFrameX, y, w: sideW, h }, 2, gap, rows)

        if (layoutId === '3-feature-left') {
            return clampCells([{ x, y, w: featureW, h }, ...sideCells])
        }
        return clampCells([{ x: x + sideW + gap, y, w: featureW, h }, ...sideCells])
    }

    if (layoutId === '4-feature-top') {
        const usable = Math.max(1, h - gap)
        const featureH = usable * splitFraction(wt.split, 0.58)
        const bottomH = usable - featureH
        return clampCells([
            { x, y, w, h: featureH },
            ...makeRows({ x, y: y + featureH + gap, w, h: bottomH }, 3, gap, cols),
        ])
    }

    if (layoutId === '4-feature-left') {
        const usable = Math.max(1, w - gap)
        const featureW = usable * splitFraction(wt.split, 0.58)
        const sideW = usable - featureW
        return clampCells([
            { x, y, w: featureW, h },
            ...makeColumns({ x: x + featureW + gap, y, w: sideW, h }, 3, gap, rows),
        ])
    }

    if (layoutId === '5-mosaic') {
        const usable = Math.max(1, w - gap)
        const featureW = usable * splitFraction(wt.split, 0.48)
        const gridFrame = { x: x + featureW + gap, y, w: usable - featureW, h }
        return clampCells([
            { x, y, w: featureW, h },
            ...makeGrid(gridFrame, 2, 2, gap, cols, rows),
        ])
    }

    return []
}

/**
 * The draggable dividers of a layout, in canvas coordinates, each tagged with the
 * weight it controls. `orientation` is the line's own direction: a `v` divider is
 * dragged left/right.
 */
export const layoutBoundaries = (layoutId, frame, gap, weights = null) => {
    const schema = LAYOUT_WEIGHT_SCHEMA[layoutId]
    if (!schema) return []
    const wt = weights || defaultWeightsFor(layoutId)
    const out = []
    const { x, y, w, h } = frame

    const runsAlong = (axis, start, extent, count) => weightedRuns(
        start, extent, count, gap, axis === 'cols' ? wt.cols : wt.rows,
    )
    const pushRunDividers = (axis, start, extent, count, region) => {
        if (!count || count < 2) return
        const runs = runsAlong(axis, start, extent, count)
        for (let i = 0; i < count - 1; i += 1) {
            const edge = runs[i].start + runs[i].size + gap / 2
            out.push({
                axis,
                index: i,
                orientation: axis === 'cols' ? 'v' : 'h',
                position: edge,
                from: axis === 'cols' ? region.from : region.from,
                to: axis === 'cols' ? region.to : region.to,
                extent,
            })
        }
    }

    const splitDivider = (orientation, position, extent, region) => {
        out.push({
            axis: 'split',
            index: 0,
            orientation,
            position,
            from: region.from,
            to: region.to,
            extent,
        })
    }

    switch (layoutId) {
        case '2-split-h': case '3-split-v': case '4-columns':
            pushRunDividers('cols', x, w, schema.cols, { from: y, to: y + h })
            break
        case '2-split-v': case '3-split-h': case '4-rows':
            pushRunDividers('rows', y, h, schema.rows, { from: x, to: x + w })
            break
        case '4-grid': case '6-grid':
            pushRunDividers('cols', x, w, schema.cols, { from: y, to: y + h })
            pushRunDividers('rows', y, h, schema.rows, { from: x, to: x + w })
            break
        case '3-grid': {
            const usable = Math.max(1, h - gap)
            const topH = usable * splitFraction(wt.split, 0.5)
            splitDivider('h', y + topH + gap / 2, usable, { from: x, to: x + w })
            pushRunDividers('cols', x, w, 2, { from: y + topH + gap, to: y + h })
            break
        }
        case '3-feature-left': case '3-feature-right': {
            const usable = Math.max(1, w - gap)
            const featureW = usable * splitFraction(wt.split, 0.62)
            const sideW = usable - featureW
            const dividerX = layoutId === '3-feature-left' ? x + featureW + gap / 2 : x + sideW + gap / 2
            splitDivider('v', dividerX, usable, { from: y, to: y + h })
            const sideX = layoutId === '3-feature-left' ? x + featureW + gap : x
            pushRunDividers('rows', y, h, 2, { from: sideX, to: sideX + sideW })
            break
        }
        case '4-feature-top': {
            const usable = Math.max(1, h - gap)
            const featureH = usable * splitFraction(wt.split, 0.58)
            splitDivider('h', y + featureH + gap / 2, usable, { from: x, to: x + w })
            pushRunDividers('cols', x, w, 3, { from: y + featureH + gap, to: y + h })
            break
        }
        case '4-feature-left': {
            const usable = Math.max(1, w - gap)
            const featureW = usable * splitFraction(wt.split, 0.58)
            splitDivider('v', x + featureW + gap / 2, usable, { from: y, to: y + h })
            pushRunDividers('rows', y, h, 3, { from: x + featureW + gap, to: x + w })
            break
        }
        case '5-mosaic': {
            const usable = Math.max(1, w - gap)
            const featureW = usable * splitFraction(wt.split, 0.48)
            splitDivider('v', x + featureW + gap / 2, usable, { from: y, to: y + h })
            const gridFrame = { x: x + featureW + gap, y, w: usable - featureW, h }
            pushRunDividers('cols', gridFrame.x, gridFrame.w, 2, { from: y, to: y + h })
            pushRunDividers('rows', y, h, 2, { from: gridFrame.x, to: gridFrame.x + gridFrame.w })
            break
        }
        default: break
    }
    return out
}

/**
 * Move one divider by `deltaPx` and return the new weights. The clamp is applied
 * here, so a drag can push a frame right up to the minimum and no further —
 * neither side can be squeezed out of existence.
 */
export const applyBoundaryDrag = (layoutId, weights, boundary, deltaPx) => {
    const schema = LAYOUT_WEIGHT_SCHEMA[layoutId]
    if (!schema || !boundary) return weights || defaultWeightsFor(layoutId)
    const base = weights || defaultWeightsFor(layoutId)
    const extent = Math.max(1, Number(boundary.extent) || 1)
    const delta = (Number(deltaPx) || 0) / extent
    if (boundary.axis === 'split') {
        return { ...base, split: splitFraction((base.split ?? schema.split ?? 0.5) + delta, schema.split ?? 0.5) }
    }
    const count = boundary.axis === 'cols' ? schema.cols : schema.rows
    if (!count || count < 2) return base
    const current = fractions(base[boundary.axis], count)
    const i = Math.max(0, Math.min(count - 2, Number(boundary.index) || 0))
    const floor = Math.min(MIN_CELL_FRACTION, 1 / count)
    const pairTotal = current[i] + current[i + 1]
    const next = [...current]
    // Only the two frames either side of the divider move; everything else holds
    // still, which is what a user dragging one edge expects to see.
    next[i] = Math.max(floor, Math.min(pairTotal - floor, current[i] + delta))
    next[i + 1] = pairTotal - next[i]
    return { ...base, [boundary.axis]: next }
}

/**
 * Compute clamped cells for a layout over a project rect, applying the same
 * padding/gap safety the manual tool uses (so an over-large gap/padding on a
 * small canvas can't yield negative/NaN cells).
 */
export const computeCollageCells = (projectSize, layoutId, gap, padding, weights = null) => {
    const W = Math.max(1, Number(projectSize?.width) || 1)
    const H = Math.max(1, Number(projectSize?.height) || 1)
    const layout = LAYOUTS.find((l) => l.id === layoutId)
    if (!layout) return []
    // A NaN from a half-typed slider value must not propagate into every cell.
    const rawPadding = Number.isFinite(Number(padding)) ? Number(padding) : 0
    const rawGap = Number.isFinite(Number(gap)) ? Number(gap) : 0
    const safePadding = Math.max(0, Math.min(rawPadding, (Math.min(W, H) - 1) / 2))
    const aw = Math.max(1, W - 2 * safePadding)
    const ah = Math.max(1, H - 2 * safePadding)
    const maxGapSlots = Math.max((layout.maxColumns || 1) - 1, (layout.maxRows || 1) - 1, 1)
    const safeGap = Math.max(0, Math.min(rawGap, Math.min(aw, ah) / (maxGapSlots + 1)))
    return buildLayoutCells(layoutId, { x: safePadding, y: safePadding, w: aw, h: ah }, safeGap, weights)
}

/**
 * The frame a layout is built inside, and the gap between its cells — what the
 * divider maths needs, kept next to the clamps that produce them so the two
 * cannot disagree.
 */
export const collageFrameFor = (projectSize, layoutId, gap, padding) => {
    const W = Math.max(1, Number(projectSize?.width) || 1)
    const H = Math.max(1, Number(projectSize?.height) || 1)
    const layout = LAYOUTS.find((l) => l.id === layoutId)
    if (!layout) return null
    const rawPadding = Number.isFinite(Number(padding)) ? Number(padding) : 0
    const rawGap = Number.isFinite(Number(gap)) ? Number(gap) : 0
    const safePadding = Math.max(0, Math.min(rawPadding, (Math.min(W, H) - 1) / 2))
    const aw = Math.max(1, W - 2 * safePadding)
    const ah = Math.max(1, H - 2 * safePadding)
    const maxGapSlots = Math.max((layout.maxColumns || 1) - 1, (layout.maxRows || 1) - 1, 1)
    const safeGap = Math.max(0, Math.min(rawGap, Math.min(aw, ah) / (maxGapSlots + 1)))
    return { frame: { x: safePadding, y: safePadding, w: aw, h: ah }, gap: safeGap }
}

/** Pick the best built-in layout for a given photo count (cellCount ≤ n). */
export const pickLayoutForCount = (n) => {
    if (n >= 6) return '6-grid'
    if (n === 5) return '5-mosaic'
    if (n === 4) return '4-grid'
    if (n === 3) return '3-grid'
    return '2-split-h'
}

const shuffle = (arr) => {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
}

/**
 * Generate a gallery of stylish, ready-to-apply template recipes tuned to the
 * photo count: each curated "look" (style + backdrop or AI theme) is married to
 * a different layout that uses as many photos as possible, so the suggestions
 * vary in both arrangement and finish. Re-run for a fresh shuffled set.
 *
 * Each recipe: `{ id, label, layoutId, style, backdrop, theme, isAi, previewBg }`.
 */
export const generateTemplateRecipes = (photoCount, count = 6) => {
    const usable = LAYOUTS.filter((l) => l.cellCount <= photoCount)
    if (usable.length === 0) return []
    const maxCells = Math.max(...usable.map((l) => l.cellCount))
    const fitting = shuffle(usable.filter((l) => l.cellCount === maxCells))
    const looks = shuffle(TEMPLATE_LOOKS).slice(0, count)

    return looks.map((look, index) => {
        const theme = look.theme ? AI_BG_THEMES.find((t) => t.id === look.theme) : null
        const previewBg = look.backdrop ? backdropPreviewCss(look.backdrop) : theme?.swatch || '#f3f4f6'
        return {
            id: `${look.id}-${index}-${Math.random().toString(36).slice(2, 6)}`,
            label: look.label,
            direction: look.label,
            layoutId: fitting[index % fitting.length].id,
            gap: Number.isFinite(look.gap) ? look.gap : 10,
            padding: Number.isFinite(look.padding) ? look.padding : 10,
            style: { shape: 'rect', radiusPct: 0, shadow: false, framePct: 0, ...look.style },
            backdrop: look.backdrop || null,
            theme: look.theme || null,
            isAi: Boolean(look.theme),
            previewBg,
            rationale: '',
        }
    })
}

export const isVisibleImage = (obj) =>
    obj?.type?.toLowerCase() === 'image' &&
    obj.visible !== false &&
    !isPhosmithMaskOverlay(obj)

export const getCollageSource = (image) => {
    const stored = image.phosmithCollageSource || image._phosmithCollageSource
    if (stored?.width && stored?.height) return stored

    const source = {
        width: Math.max(1, Number(image.width) || 1),
        height: Math.max(1, Number(image.height) || 1),
        cropX: Math.max(0, Number(image.cropX) || 0),
        cropY: Math.max(0, Number(image.cropY) || 0),
    }
    image.phosmithCollageSource = source
    image._phosmithCollageSource = source
    return source
}

/** Half a pixel of overscan per side, so the clip path's anti-aliased edge has
 *  photo under it instead of backdrop. */
const COVER_BLEED = 0.5

export const CELL_FIT_MODES = ['cover', 'contain']

/** Fit modes a cell can use. `cover` fills and overflows (pan room); `contain`
 *  fits the whole frame inside and leaves backdrop around it — the honest choice
 *  for a 16:1 panorama or a 200 px thumbnail that `cover` would gut or smear. */
export const getCellFitScale = (image, cell, mode = 'cover') => {
    const source = getCollageSource(image)
    const sw = Math.max(1, source.width)
    const sh = Math.max(1, source.height)
    if (mode === 'contain') return Math.min(cell.w / sw, cell.h / sh)
    return Math.max((cell.w + COVER_BLEED * 2) / sw, (cell.h + COVER_BLEED * 2) / sh)
}

/** Cover scale: the smallest uniform scale that fully fills the cell from the
 *  image's source crop region (overflow on the longer axis = pan room). */
export const getCellCoverScale = (image, cell) => getCellFitScale(image, cell, 'cover')

/**
 * How much real detail the photo has for this cell. `ratio` below 1 means the
 * source is being enlarged; the UI warns instead of silently smearing a
 * 200×200 screenshot across a half-canvas frame.
 */
export const assessCellResolution = (image, cell, dpr = 1) => {
    const source = getCollageSource(image)
    const needW = Math.max(1, cell.w * dpr)
    const needH = Math.max(1, cell.h * dpr)
    const ratio = Math.min(source.width / needW, source.height / needH)
    return {
        ratio,
        // Below half the needed pixels the softness is obvious at any size.
        low: ratio < 0.5,
        sourceWidth: source.width,
        sourceHeight: source.height,
    }
}

/**
 * Inner mat: shrink the cell the photo occupies by `style.framePct` (% of the
 * cell's short side) so the canvas backdrop shows through as a border around the
 * photo — the matted-gallery / polaroid / scrapbook look. Returns the cell
 * unchanged when no frame is requested.
 */
export const insetCellForFrame = (cell, style) => {
    const pct = Math.max(0, Math.min(14, Number(style?.framePct) || 0))
    if (!pct) return cell
    const raw = Math.min(cell.w, cell.h) * (pct / 100)

    if (style?.frameMode === 'outer') {
        // An outward mat grows into the gutter, so each cell may take at most HALF
        // the gap or it would overlap its neighbour — and with no gap there is
        // nowhere to grow, so the cell is left alone rather than silently overlapping.
        const room = Math.max(0, (Number(style?.gap) || 0) / 2)
        const grow = Math.min(raw, room)
        if (grow <= 0) return cell
        return {
            x: cell.x - grow,
            y: cell.y - grow,
            w: Math.max(1, cell.w + 2 * grow),
            h: Math.max(1, cell.h + 2 * grow),
        }
    }

    const maxInset = Math.max(0, Math.min(cell.w, cell.h) / 2 - 1)
    const inset = Math.max(0, Math.min(raw, maxInset))
    if (!inset) return cell
    return {
        x: cell.x + inset,
        y: cell.y + inset,
        w: Math.max(1, cell.w - 2 * inset),
        h: Math.max(1, cell.h - 2 * inset),
    }
}

/**
 * Frame an image into a collage cell: scale to COVER the cell, centre it, and
 * clip it to the cell with an absolutely-positioned shape (rounded rect or
 * ellipse, per `style`). An optional inner mat (`style.framePct`) insets the
 * photo so the backdrop frames it. Rotation/skew are locked so the cell always
 * stays covered; the optional drop shadow is a native `shadow` so it serializes.
 */
export const fitImageToCell = (image, cell, style) => {
    const source = getCollageSource(image)
    const c = insetCellForFrame(cell, style)
    const mode = style?.fitMode === 'contain' ? 'contain' : 'cover'
    const coverScale = getCellFitScale(image, c, mode)
    // Subject-aware framing: `focus` is the point of the photo (0..1) that should
    // land in the middle of the cell, so a face near the top of a tall frame is
    // not cropped out by a centred cover fit. Clamped to the pan room, so the
    // cell still ends up fully covered.
    const focus = style?.focus || image.phosmithCollageFocus
    let dx = 0
    let dy = 0
    if (mode === 'cover' && focus && Number.isFinite(focus.x) && Number.isFinite(focus.y)) {
        const halfW = (source.width * coverScale) / 2
        const halfH = (source.height * coverScale) / 2
        const maxDX = Math.max(0, halfW - c.w / 2)
        const maxDY = Math.max(0, halfH - c.h / 2)
        dx = Math.max(-maxDX, Math.min(maxDX, (0.5 - focus.x) * source.width * coverScale))
        dy = Math.max(-maxDY, Math.min(maxDY, (0.5 - focus.y) * source.height * coverScale))
    }

    image.set({
        left: c.x + c.w / 2 + dx,
        top: c.y + c.h / 2 + dy,
        originX: 'center',
        originY: 'center',
        width: source.width,
        height: source.height,
        cropX: source.cropX,
        cropY: source.cropY,
        scaleX: coverScale,
        scaleY: coverScale,
        angle: 0,
        selectable: true,
        evented: true,
        lockRotation: true,
        lockSkewingX: true,
        lockSkewingY: true,
        shadow: buildCellShadow(style),
        clipPath: buildCellClipPath(c, style),
    })
    image.phosmithCollageCell = { x: c.x, y: c.y, w: c.w, h: c.h }
    image._phosmithCollageCell = image.phosmithCollageCell
    image.phosmithCollageCoverScale = coverScale
    image._phosmithCollageCoverScale = coverScale
    image.phosmithCollageFit = mode
    image._phosmithCollageFit = mode
    if (focus) {
        image.phosmithCollageFocus = focus
        image._phosmithCollageFocus = focus
    }
    image.setCoords()
}

/**
 * Re-skin an already-framed photo to a new style WITHOUT moving or rescaling it,
 * so the user's pan/zoom inside the cell is preserved. Returns false if the image
 * isn't part of a collage.
 */
export const restyleImage = (image, style) => {
    const cell = image?.phosmithCollageCell || cellFromClipPath(image)
    if (!cell) return false
    image.phosmithCollageCell = cell
    image._phosmithCollageCell = cell
    image.phosmithCollageCoverScale = image.phosmithCollageCoverScale
        || getCellFitScale(image, cell, image.phosmithCollageFit === 'contain' ? 'contain' : 'cover')
    // Composer polygon cells keep their shape; only the shadow restyles.
    const polygonal = (image.clipPath?.type || '').toLowerCase() === 'polygon'
    image.set(polygonal ? { shadow: buildCellShadow(style) } : { shadow: buildCellShadow(style), clipPath: buildCellClipPath(cell, style) })
    clampToCell(image)
    image.setCoords()
    return true
}

/**
 * Switch an already-framed photo between cover and contain without re-running
 * the layout, so the mat inset stored in its cell is not applied twice. Returns
 * false when the image is not part of a collage.
 */
export const setCellFitMode = (image, mode) => {
    const cell = image?.phosmithCollageCell || cellFromClipPath(image)
    if (!cell) return false
    const next = mode === 'contain' ? 'contain' : 'cover'
    const scale = getCellFitScale(image, cell, next)
    image.phosmithCollageCell = cell
    image._phosmithCollageCell = cell
    image.phosmithCollageFit = next
    image._phosmithCollageFit = next
    image.phosmithCollageCoverScale = scale
    image._phosmithCollageCoverScale = scale
    image.set({
        scaleX: scale,
        scaleY: scale,
        left: cell.x + cell.w / 2,
        top: cell.y + cell.h / 2,
    })
    image.setCoords()
    return true
}

/** Keep a framed image covering its cell — clamp pan so no empty edge shows,
 *  and never let it scale below cover. Returns true if it mutated the image. */
export const clampToCell = (image) => {
    const cell = image?.phosmithCollageCell
    if (!cell) return false
    let changed = false

    const mode = image.phosmithCollageFit === 'contain' ? 'contain' : 'cover'
    const fitScale = image.phosmithCollageCoverScale || getCellFitScale(image, cell, mode)
    // Cover must never shrink below filling the cell. Contain must never GROW
    // past it, or the photo it was chosen to show whole starts being cropped.
    if (mode === 'cover' && (image.scaleX < fitScale - 1e-4 || image.scaleY < fitScale - 1e-4)) {
        image.set({ scaleX: Math.max(image.scaleX, fitScale), scaleY: Math.max(image.scaleY, fitScale) })
        changed = true
    }
    if (mode === 'contain' && (image.scaleX > fitScale + 1e-4 || image.scaleY > fitScale + 1e-4)) {
        image.set({ scaleX: Math.min(image.scaleX, fitScale), scaleY: Math.min(image.scaleY, fitScale) })
        changed = true
    }

    const halfW = (image.width * image.scaleX) / 2
    const halfH = (image.height * image.scaleY) / 2
    const cx = cell.x + cell.w / 2
    const cy = cell.y + cell.h / 2
    // Cover pans within its overflow; contain pans within the slack left inside
    // the cell, so it can be nudged but never leaves the frame.
    const maxDX = Math.max(0, mode === 'contain' ? cell.w / 2 - halfW : halfW - cell.w / 2)
    const maxDY = Math.max(0, mode === 'contain' ? cell.h / 2 - halfH : halfH - cell.h / 2)
    const left = Math.min(cx + maxDX, Math.max(cx - maxDX, image.left))
    const top = Math.min(cy + maxDY, Math.max(cy - maxDY, image.top))
    if (left !== image.left || top !== image.top) {
        image.set({ left, top })
        changed = true
    }
    if (changed) image.setCoords()
    return changed
}

/** Recover a cell from a persisted clipPath (after reload) so panning stays
 *  constrained without re-applying the layout. */
export const cellFromClipPath = (image) => {
    const cp = image?.clipPath
    if (!cp || !cp.absolutePositioned) return null
    const type = (cp.type || '').toLowerCase()
    // Composer shards/strata cells: the points are absolute scene coords.
    if (type === 'polygon' && Array.isArray(cp.points) && cp.points.length >= 3) {
        const xs = cp.points.map((p) => p.x)
        const ys = cp.points.map((p) => p.y)
        const x = Math.min(...xs), y = Math.min(...ys)
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
    }
    // Composer silhouette (path) and tapestry (seam-mask image) clips.
    if (type === 'path' || type === 'image') {
        const w = (cp.width || 0) * (cp.scaleX || 1), h = (cp.height || 0) * (cp.scaleY || 1)
        return w > 0 && h > 0 ? { x: cp.left, y: cp.top, w, h } : null
    }
    if (type === 'ellipse') {
        return {
            x: cp.left,
            y: cp.top,
            w: (cp.rx || 0) * 2 * (cp.scaleX || 1),
            h: (cp.ry || 0) * 2 * (cp.scaleY || 1),
        }
    }
    if (type !== 'rect') return null
    return {
        x: cp.left,
        y: cp.top,
        w: (cp.width || 0) * (cp.scaleX || 1),
        h: (cp.height || 0) * (cp.scaleY || 1),
    }
}
