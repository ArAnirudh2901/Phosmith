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

const clampCells = (cells) =>
    cells.map((cell) => ({
        ...cell,
        w: Math.max(1, cell.w),
        h: Math.max(1, cell.h),
    }))

const makeRows = ({ x, y, w, h }, count, gap) => {
    const cellW = (w - gap * (count - 1)) / count
    return Array.from({ length: count }, (_, index) => ({
        x: x + index * (cellW + gap),
        y,
        w: cellW,
        h,
    }))
}

const makeColumns = ({ x, y, w, h }, count, gap) => {
    const cellH = (h - gap * (count - 1)) / count
    return Array.from({ length: count }, (_, index) => ({
        x,
        y: y + index * (cellH + gap),
        w,
        h: cellH,
    }))
}

const makeGrid = (frame, columns, rows, gap) => {
    const cellW = (frame.w - gap * (columns - 1)) / columns
    const cellH = (frame.h - gap * (rows - 1)) / rows
    return Array.from({ length: rows }).flatMap((_, row) =>
        Array.from({ length: columns }, (_, column) => ({
            x: frame.x + column * (cellW + gap),
            y: frame.y + row * (cellH + gap),
            w: cellW,
            h: cellH,
        }))
    )
}

export const buildLayoutCells = (layoutId, frame, gap) => {
    const { x, y, w, h } = frame

    if (layoutId === '2-split-h') return clampCells(makeRows(frame, 2, gap))
    if (layoutId === '2-split-v') return clampCells(makeColumns(frame, 2, gap))
    if (layoutId === '3-split-v') return clampCells(makeRows(frame, 3, gap))
    if (layoutId === '3-split-h') return clampCells(makeColumns(frame, 3, gap))
    if (layoutId === '4-grid') return clampCells(makeGrid(frame, 2, 2, gap))
    if (layoutId === '4-columns') return clampCells(makeRows(frame, 4, gap))
    if (layoutId === '4-rows') return clampCells(makeColumns(frame, 4, gap))
    if (layoutId === '6-grid') return clampCells(makeGrid(frame, 3, 2, gap))

    if (layoutId === '3-grid') {
        const topH = (h - gap) / 2
        const bottomH = h - topH - gap
        const bottomW = (w - gap) / 2
        return clampCells([
            { x, y, w, h: topH },
            { x, y: y + topH + gap, w: bottomW, h: bottomH },
            { x: x + bottomW + gap, y: y + topH + gap, w: bottomW, h: bottomH },
        ])
    }

    if (layoutId === '3-feature-left' || layoutId === '3-feature-right') {
        const sideW = (w - gap) * 0.38
        const featureW = w - gap - sideW
        const sideH = (h - gap) / 2
        const sideCells = [
            { x, y, w: sideW, h: sideH },
            { x, y: y + sideH + gap, w: sideW, h: sideH },
        ]

        if (layoutId === '3-feature-left') {
            const sideX = x + featureW + gap
            return clampCells([
                { x, y, w: featureW, h },
                { ...sideCells[0], x: sideX },
                { ...sideCells[1], x: sideX },
            ])
        }

        return clampCells([
            { x: x + sideW + gap, y, w: featureW, h },
            ...sideCells,
        ])
    }

    if (layoutId === '4-feature-top') {
        const featureH = (h - gap) * 0.58
        const bottomH = h - featureH - gap
        return clampCells([
            { x, y, w, h: featureH },
            ...makeRows({ x, y: y + featureH + gap, w, h: bottomH }, 3, gap),
        ])
    }

    if (layoutId === '4-feature-left') {
        const featureW = (w - gap) * 0.58
        const sideW = w - featureW - gap
        return clampCells([
            { x, y, w: featureW, h },
            ...makeColumns({ x: x + featureW + gap, y, w: sideW, h }, 3, gap),
        ])
    }

    if (layoutId === '5-mosaic') {
        const featureW = (w - gap) * 0.48
        const gridFrame = { x: x + featureW + gap, y, w: w - featureW - gap, h }
        return clampCells([
            { x, y, w: featureW, h },
            ...makeGrid(gridFrame, 2, 2, gap),
        ])
    }

    return []
}

/**
 * Compute clamped cells for a layout over a project rect, applying the same
 * padding/gap safety the manual tool uses (so an over-large gap/padding on a
 * small canvas can't yield negative/NaN cells).
 */
export const computeCollageCells = (projectSize, layoutId, gap, padding) => {
    const W = Math.max(1, Number(projectSize?.width) || 1)
    const H = Math.max(1, Number(projectSize?.height) || 1)
    const layout = LAYOUTS.find((l) => l.id === layoutId)
    if (!layout) return []
    const safePadding = Math.max(0, Math.min(padding, (Math.min(W, H) - 1) / 2))
    const aw = Math.max(1, W - 2 * safePadding)
    const ah = Math.max(1, H - 2 * safePadding)
    const maxGapSlots = Math.max((layout.maxColumns || 1) - 1, (layout.maxRows || 1) - 1, 1)
    const safeGap = Math.max(0, Math.min(gap, Math.min(aw, ah) / (maxGapSlots + 1)))
    return buildLayoutCells(layoutId, { x: safePadding, y: safePadding, w: aw, h: ah }, safeGap)
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
            layoutId: fitting[index % fitting.length].id,
            style: { ...look.style },
            backdrop: look.backdrop || null,
            theme: look.theme || null,
            isAi: Boolean(look.theme),
            previewBg,
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

/** Cover scale: the smallest uniform scale that fully fills the cell from the
 *  image's source crop region (overflow on the longer axis = pan room). */
export const getCellCoverScale = (image, cell) => {
    const source = getCollageSource(image)
    return Math.max(cell.w / Math.max(1, source.width), cell.h / Math.max(1, source.height))
}

/**
 * Frame an image into a collage cell: scale to COVER the cell, centre it, and
 * clip it to the cell with an absolutely-positioned shape (rounded rect or
 * ellipse, per `style`). Rotation/skew are locked so the cell always stays
 * covered; the optional drop shadow is a native `shadow` so it serializes.
 */
export const fitImageToCell = (image, cell, style) => {
    const source = getCollageSource(image)
    const coverScale = getCellCoverScale(image, cell)

    image.set({
        left: cell.x + cell.w / 2,
        top: cell.y + cell.h / 2,
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
        clipPath: buildCellClipPath(cell, style),
    })
    image.phosmithCollageCell = { x: cell.x, y: cell.y, w: cell.w, h: cell.h }
    image._phosmithCollageCell = image.phosmithCollageCell
    image.phosmithCollageCoverScale = coverScale
    image._phosmithCollageCoverScale = coverScale
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
    image.phosmithCollageCoverScale = image.phosmithCollageCoverScale || getCellCoverScale(image, cell)
    image.set({ shadow: buildCellShadow(style), clipPath: buildCellClipPath(cell, style) })
    clampToCell(image)
    image.setCoords()
    return true
}

/** Keep a framed image covering its cell — clamp pan so no empty edge shows,
 *  and never let it scale below cover. Returns true if it mutated the image. */
export const clampToCell = (image) => {
    const cell = image?.phosmithCollageCell
    if (!cell) return false
    let changed = false

    const cover = image.phosmithCollageCoverScale || getCellCoverScale(image, cell)
    if (image.scaleX < cover - 1e-4 || image.scaleY < cover - 1e-4) {
        image.set({ scaleX: Math.max(image.scaleX, cover), scaleY: Math.max(image.scaleY, cover) })
        changed = true
    }

    const halfW = (image.width * image.scaleX) / 2
    const halfH = (image.height * image.scaleY) / 2
    const cx = cell.x + cell.w / 2
    const cy = cell.y + cell.h / 2
    const maxDX = Math.max(0, halfW - cell.w / 2)
    const maxDY = Math.max(0, halfH - cell.h / 2)
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
