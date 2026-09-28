/**
 * Content-aware arrangement for the grid collage: which photo goes in which
 * cell, which layout suits the photos at all, and where inside its frame each
 * photo should sit.
 *
 * The usual collage tool drops photos into cells in upload order and centre-crops
 * them. That wastes the two things already known about every photo: its shape,
 * and where the interesting part of it is. `analyzeElement`
 * (src/lib/collage/analyze.js) computes both on-device and caches them per image
 * element, so this module is arithmetic on numbers that already exist — no model
 * call, no second pass over pixels.
 *
 * Pure and DOM-free: inputs are plain descriptors, so it is unit-testable.
 */

import { LAYOUTS, computeCollageCells } from './collage-layout'

/** Aspect distance that treats 2:1 and 1:2 as equally far from square. */
const aspectDistance = (a, b) => Math.abs(Math.log(Math.max(1e-3, a) / Math.max(1e-3, b)))

/**
 * A photo as this module needs it. `aspect` is width / height; `quality` and
 * `focus` come straight from `analyzeElement`, and both have sane defaults so a
 * photo that failed analysis still gets placed.
 */
export const photoDescriptor = (analysis, index = 0) => ({
    index,
    aspect: Number.isFinite(analysis?.aspect) && analysis.aspect > 0 ? analysis.aspect : 1,
    quality: Number.isFinite(analysis?.quality) ? analysis.quality : 0.5,
    focus: analysis?.focus && Number.isFinite(analysis.focus.x) && Number.isFinite(analysis.focus.y)
        ? { x: clamp01(analysis.focus.x), y: clamp01(analysis.focus.y) }
        : { x: 0.5, y: 0.5 },
    concentration: Number.isFinite(analysis?.concentration) ? analysis.concentration : 0,
})

const clamp01 = (v) => Math.max(0, Math.min(1, v))

/**
 * Where inside the photo the frame should centre. A subject high in the frame
 * (`focus.y` well above the middle) is what a centred cover crop decapitates, so
 * the offset is honoured in full; the caller clamps it to the pan room it has.
 */
export const focusForCell = (photo) => (photo?.focus ? { x: clamp01(photo.focus.x), y: clamp01(photo.focus.y) } : { x: 0.5, y: 0.5 })

/**
 * Greedy, deterministic photo → cell assignment.
 *
 * The largest cell is the hero and gets the strongest photo (quality, with
 * subject concentration as a nudge — a photo whose subject fills the frame reads
 * as deliberate at size). Remaining cells, largest first, take whichever unused
 * photo best matches their shape. Returns one photo index per cell, `null` for a
 * cell with nothing left to put in it.
 */
export const assignPhotosToCells = (photos, cells) => {
    const list = (photos || []).map((p, i) => (p && typeof p === 'object' ? { ...p, index: p.index ?? i } : photoDescriptor(null, i)))
    const order = (cells || [])
        .map((cell, cellIndex) => ({ cellIndex, area: Math.max(0, cell.w) * Math.max(0, cell.h), aspect: cell.h > 0 ? cell.w / cell.h : 1 }))
        .sort((a, b) => b.area - a.area || a.cellIndex - b.cellIndex)

    const taken = new Set()
    const result = new Array((cells || []).length).fill(null)
    order.forEach((slot, rank) => {
        let best = null
        let bestScore = -Infinity
        for (const photo of list) {
            if (taken.has(photo.index)) continue
            const shape = -aspectDistance(photo.aspect, slot.aspect)
            // The hero is chosen on strength first and shape second; the rest are
            // chosen on shape, because a badly cropped photo reads as a mistake
            // wherever it sits.
            const score = rank === 0
                ? (photo.quality * 2 + photo.concentration * 0.5 + shape * 0.75)
                : (shape * 2 + photo.quality * 0.35)
            if (score > bestScore) { bestScore = score; best = photo }
        }
        if (!best) return
        taken.add(best.index)
        result[slot.cellIndex] = best.index
    })
    return result
}

/**
 * How well a layout suits this set of photos, at this canvas shape.
 *
 * Score is the mean shape mismatch of the assignment it would produce (lower is
 * better, so it is negated), plus credit for using more of the photos: a set of
 * six with a panorama in it is better served by a layout with one wide cell than
 * by a 3×3 that crops everything to squares.
 */
export const scoreLayoutForPhotos = (layoutId, photos, { canvasWidth = 1000, canvasHeight = 1000, gap = 10, padding = 10 } = {}) => {
    const layout = LAYOUTS.find((l) => l.id === layoutId)
    if (!layout) return null
    const cells = computeCollageCells({ width: canvasWidth, height: canvasHeight }, layoutId, gap, padding)
    if (!cells.length) return null
    const assignment = assignPhotosToCells(photos, cells)
    let mismatch = 0
    let placed = 0
    assignment.forEach((photoIndex, cellIndex) => {
        if (photoIndex === null || photoIndex === undefined) return
        const photo = photos[photoIndex] || photos.find((p) => p.index === photoIndex)
        if (!photo) return
        const cell = cells[cellIndex]
        mismatch += aspectDistance(photo.aspect, cell.h > 0 ? cell.w / cell.h : 1)
        placed += 1
    })
    const meanMismatch = placed ? mismatch / placed : 2
    const coverage = photos.length ? placed / photos.length : 0
    const empties = Math.max(0, cells.length - placed)
    return {
        layoutId,
        cells: cells.length,
        placed,
        // Coverage matters, but an empty frame costs more than a slightly worse
        // crop — an unfinished-looking collage is not a suggestion worth making.
        score: -meanMismatch + coverage * 0.9 - empties * 0.35,
        meanMismatch,
        assignment,
    }
}

/** Layouts ranked best-first for these photos. */
export const rankLayoutsForPhotos = (photos, options = {}) => {
    const list = photos || []
    if (!list.length) return []
    return LAYOUTS
        .map((layout) => scoreLayoutForPhotos(layout.id, list, options))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || a.layoutId.localeCompare(b.layoutId))
}

/** Best layout id for these photos, or null when there is nothing to arrange. */
export const bestLayoutForPhotos = (photos, options = {}) => rankLayoutsForPhotos(photos, options)[0]?.layoutId || null
