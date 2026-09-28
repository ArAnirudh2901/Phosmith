#!/usr/bin/env bun
/**
 * Pure invariants for the GRID collage engine — the half of the collage tool
 * that had no test at all (`verify-collage-composer.mjs` covers the shard/mosaic
 * composer instead). No browser, no service, no GPU.
 *
 * What it pins down, from the edge-case matrix:
 *   · cell geometry lands on whole pixels and leaves no seam or overlap
 *   · gap / padding / corner-radius / mat clamps hold at 0 and at the extremes
 *   · cover and contain fits, and the pan clamp that belongs to each
 *   · low-resolution detection for a thumbnail dropped into a big frame
 *   · a cell survives the round trip through a persisted clip path
 *   · the device canvas caps that keep a high-res export from coming back blank
 *   · the plan validator against hostile model output
 *
 * Usage: bun scripts/verify-collage.mjs
 */
import {
    LAYOUTS, buildLayoutCells, computeCollageCells, pickLayoutForCount,
    collageFrameFor, defaultWeightsFor, layoutBoundaries, applyBoundaryDrag, MIN_CELL_FRACTION,
    insetCellForFrame, getCellFitScale, getCellCoverScale, assessCellResolution,
    clampToCell, cellFromClipPath,
} from '../src/lib/collage-layout.js'
import { validateCollagePlan, COLLAGE_LAYOUT_CATALOG } from '../src/lib/collage-ai.js'
import { clampToCanvasLimits, maxRenderScale, __setCanvasLimits } from '../src/lib/canvas-limits.js'
import { assignPhotosToCells, bestLayoutForPhotos, focusForCell, photoDescriptor, rankLayoutsForPhotos } from '../src/lib/collage-arrange.js'
import { imagekitResized, workingEdgeForProject } from '../src/lib/canvas-images.js'

let failures = 0
let checks = 0
const check = (ok, name, detail) => {
    checks += 1
    if (!ok) failures += 1
    console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  (${detail})` : ''}`)
}

const CANVASES = [
    { width: 1080, height: 1080 },
    { width: 1080, height: 1920 },
    { width: 1921, height: 1081 },   // odd on both axes: the rounding case
    { width: 320, height: 240 },
    { width: 4096, height: 2731 },
]
const GAPS = [0, 1, 7, 12, 48]
const PADDINGS = [0, 3, 40, 80]

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const area = (cells) => cells.reduce((sum, c) => sum + c.w * c.h, 0)

// ── 1. geometry: whole pixels, inside the frame, never overlapping ───────────
{
    let integers = true
    let inside = true
    let disjoint = true
    let sized = true
    let cases = 0
    for (const layout of LAYOUTS) {
        for (const canvas of CANVASES) {
            for (const gap of GAPS) {
                for (const padding of PADDINGS) {
                    const cells = computeCollageCells(canvas, layout.id, gap, padding)
                    if (cells.length !== layout.cellCount) { sized = false; continue }
                    cases += 1
                    for (const c of cells) {
                        if (!Number.isInteger(c.x) || !Number.isInteger(c.y)
                            || !Number.isInteger(c.w) || !Number.isInteger(c.h)) integers = false
                        if (c.w < 1 || c.h < 1) sized = false
                        // One pixel of tolerance: the frame itself is rounded.
                        if (c.x < -1 || c.y < -1 || c.x + c.w > canvas.width + 1 || c.y + c.h > canvas.height + 1) inside = false
                    }
                    for (let i = 0; i < cells.length; i += 1) {
                        for (let j = i + 1; j < cells.length; j += 1) {
                            if (overlaps(cells[i], cells[j])) disjoint = false
                        }
                    }
                }
            }
        }
    }
    check(cases > 0 && sized, 'every layout yields its declared cell count, each at least 1×1', `${cases} combinations`)
    check(integers, 'every cell lands on whole pixels (no half-pixel clip edges)')
    check(inside, 'no cell escapes the canvas')
    check(disjoint, 'no two cells of a layout overlap')
}

// ── 2. gap 0 tiles the frame exactly: that is what "no seam" means ───────────
{
    let exact = true
    const detail = []
    for (const layout of LAYOUTS) {
        for (const canvas of CANVASES) {
            const cells = computeCollageCells(canvas, layout.id, 0, 0)
            const covered = area(cells)
            const frame = canvas.width * canvas.height
            if (covered !== frame) {
                exact = false
                if (detail.length < 3) detail.push(`${layout.id} ${canvas.width}×${canvas.height}: ${covered} vs ${frame}`)
            }
        }
    }
    check(exact, 'at gap 0 the cells tile the canvas with no gap and no overlap', detail.join('; '))
}

// ── 3. hostile gap / padding cannot collapse or invert a layout ──────────────
{
    let ok = true
    for (const layout of LAYOUTS) {
        for (const [gap, padding] of [[0, 0], [10_000, 0], [0, 10_000], [10_000, 10_000], [-50, -50], [NaN, NaN]]) {
            const cells = computeCollageCells({ width: 800, height: 600 }, layout.id, gap, padding)
            if (cells.length !== layout.cellCount) { ok = false; break }
            if (cells.some((c) => !(c.w >= 1 && c.h >= 1) || !Number.isFinite(c.x) || !Number.isFinite(c.y))) ok = false
        }
    }
    check(ok, 'a slider pushed to 0, to the maximum, negative or NaN still yields usable cells')
    check(computeCollageCells({ width: 800, height: 600 }, 'no-such-layout', 8, 8).length === 0,
        'an unknown layout id yields no cells rather than guessing one')
}

// ── 4. the inner mat clamps, and never inverts the photo rect ───────────────
{
    const cell = { x: 10, y: 20, w: 100, h: 60 }
    check(insetCellForFrame(cell, { framePct: 0 }) === cell, 'mat 0 leaves the cell untouched')
    const big = insetCellForFrame(cell, { framePct: 999 })
    check(big.w >= 1 && big.h >= 1 && big.w <= cell.w && big.h <= cell.h,
        'a mat larger than the cell is clamped instead of inverting it', `${big.w}×${big.h}`)
    const tiny = insetCellForFrame({ x: 0, y: 0, w: 2, h: 2 }, { framePct: 14 })
    check(tiny.w >= 1 && tiny.h >= 1, 'a mat on a 2×2 cell still leaves a visible photo')
    const neg = insetCellForFrame(cell, { framePct: -20 })
    check(neg === cell, 'a negative mat is ignored, not applied outward')
}

// ── 5. cover vs contain, and the bleed that hides the anti-aliased edge ──────
const fakeImage = (w, h) => ({
    width: w,
    height: h,
    scaleX: 1,
    scaleY: 1,
    left: 0,
    top: 0,
    phosmithCollageSource: { width: w, height: h, cropX: 0, cropY: 0 },
    set(props) { Object.assign(this, props) },
    setCoords() { this.coordsCalls = (this.coordsCalls || 0) + 1 },
})
{
    const cell = { x: 0, y: 0, w: 400, h: 400 }
    const pano = fakeImage(6400, 400)     // 16:1
    const cover = getCellFitScale(pano, cell, 'cover')
    const contain = getCellFitScale(pano, cell, 'contain')
    check(cover * 400 >= 400, 'cover fills the cell on the short axis', `scale ${cover.toFixed(4)}`)
    check(cover > 400 / 400, 'cover overscans slightly so no backdrop shows through the clip edge')
    check(contain * 6400 <= 400 + 1e-6 && contain * 400 <= 400 + 1e-6,
        'contain fits the whole panorama inside the cell', `scale ${contain.toFixed(5)}`)
    check(contain < cover, 'contain is the smaller of the two fits')
    check(getCellCoverScale(pano, cell) === cover, 'getCellCoverScale stays the cover fit')

    const tall = fakeImage(400, 2000)     // 1:5
    check(getCellFitScale(tall, cell, 'cover') * 400 >= 400, 'a 1:5 screenshot still covers a square cell')
}

// ── 6. the pan clamp belongs to the fit mode ────────────────────────────────
{
    const cell = { x: 0, y: 0, w: 200, h: 200 }
    const img = fakeImage(1000, 500)
    img.phosmithCollageCell = cell
    img.phosmithCollageFit = 'cover'
    img.phosmithCollageCoverScale = getCellFitScale(img, cell, 'cover')
    img.scaleX = 0.05                       // far below cover
    img.scaleY = 0.05
    img.left = 5000                         // dragged out of the cell
    img.top = -5000
    clampToCell(img)
    check(img.scaleX >= img.phosmithCollageCoverScale - 1e-9, 'cover: zooming out below the cell is refused')
    const halfW = (img.width * img.scaleX) / 2
    const cx = cell.x + cell.w / 2
    check(Math.abs(img.left - cx) <= Math.max(0, halfW - cell.w / 2) + 1e-6,
        'cover: panning cannot expose an empty edge')

    const containImg = fakeImage(1000, 500)
    containImg.phosmithCollageCell = cell
    containImg.phosmithCollageFit = 'contain'
    containImg.phosmithCollageCoverScale = getCellFitScale(containImg, cell, 'contain')
    containImg.scaleX = 5
    containImg.scaleY = 5
    containImg.left = 9999
    clampToCell(containImg)
    check(containImg.scaleX <= containImg.phosmithCollageCoverScale + 1e-9,
        'contain: zooming past the frame is refused, so nothing gets cropped')
    const cHalfW = (containImg.width * containImg.scaleX) / 2
    check(Math.abs(containImg.left - cx) <= Math.max(0, cell.w / 2 - cHalfW) + 1e-6,
        'contain: the photo stays inside its cell')

    check(clampToCell(fakeImage(10, 10)) === false, 'an image with no cell is left alone')
}

// ── 7. low-resolution detection ────────────────────────────────────────────
{
    const cell = { x: 0, y: 0, w: 800, h: 800 }
    const thumb = assessCellResolution(fakeImage(200, 200), cell, 1)
    check(thumb.low && thumb.ratio < 0.5, 'a 200×200 thumbnail in an 800 px cell reads as low resolution',
        `ratio ${thumb.ratio.toFixed(3)}`)
    const dslr = assessCellResolution(fakeImage(6000, 4000), cell, 2)
    check(!dslr.low && dslr.ratio >= 1, 'a DSLR frame has detail to spare even at 2× device pixels',
        `ratio ${dslr.ratio.toFixed(2)}`)
    const exact = assessCellResolution(fakeImage(800, 800), cell, 1)
    check(!exact.low, 'a pixel-for-pixel match is not flagged')
}

// ── 8. a cell survives the round trip through a persisted clip path ─────────
{
    const cell = { x: 12, y: 34, w: 200, h: 120 }
    const rect = cellFromClipPath({ clipPath: { type: 'rect', absolutePositioned: true, left: cell.x, top: cell.y, width: cell.w, height: cell.h, scaleX: 1, scaleY: 1 } })
    check(rect && rect.x === cell.x && rect.w === cell.w && rect.h === cell.h, 'a rect clip path recovers its cell')
    const ellipse = cellFromClipPath({ clipPath: { type: 'ellipse', absolutePositioned: true, left: cell.x, top: cell.y, rx: cell.w / 2, ry: cell.h / 2, scaleX: 1, scaleY: 1 } })
    check(ellipse && ellipse.w === cell.w && ellipse.h === cell.h, 'an ellipse clip path recovers its cell')
    check(cellFromClipPath({ clipPath: { type: 'rect', left: 0, top: 0, width: 10, height: 10 } }) === null,
        'a relative clip path is not mistaken for a cell')
    check(cellFromClipPath({}) === null, 'no clip path, no cell')
}

// ── 9. device canvas caps: an export must shrink, never come back blank ─────
{
    __setCanvasLimits({ maxEdge: 4096, maxArea: 16_777_216 })   // an iOS-shaped ceiling
    check(maxRenderScale(1080, 1920, 3) < 3, 'a 3× export of a 9:16 project is capped on such a device',
        `scale ${maxRenderScale(1080, 1920, 3).toFixed(3)}`)
    const capped = maxRenderScale(1080, 1920, 3)
    check(1080 * capped <= 4096 && 1920 * capped <= 4096 && 1080 * 1920 * capped * capped <= 16_777_216 + 1,
        'the capped scale is inside both the edge and the area limit')
    check(maxRenderScale(800, 600, 2) === 2, 'a small project keeps the scale it asked for')
    const clamp = clampToCanvasLimits(9000, 9000)
    check(clamp.clamped && clamp.width <= 4096 && clamp.height <= 4096, 'an over-sized canvas is fitted, not attempted',
        `${clamp.width}×${clamp.height}`)
    const fits = clampToCanvasLimits(1000, 1000)
    check(!fits.clamped && fits.width === 1000, 'a canvas inside the limits is untouched')
    __setCanvasLimits(null)
}

// ── 10. the plan validator against hostile model output ────────────────────
{
    const hostile = [
        null,
        {},
        { templates: 'nope' },
        { templates: [{ layout: '../../etc/passwd', gap: 1e9, padding: -40, framePct: 900 }] },
        { templates: Array.from({ length: 50 }, () => ({ layout: '4-grid' })) },
    ]
    let survived = true
    for (const input of hostile) {
        try {
            const out = validateCollagePlan(input, { photoCount: 4 })
            if (out && Array.isArray(out.templates)) {
                for (const t of out.templates) {
                    if (t.layout && !COLLAGE_LAYOUT_CATALOG.some((l) => l.id === t.layout)) survived = false
                    if (t.gap !== undefined && (t.gap < 0 || t.gap > 48)) survived = false
                    if (t.padding !== undefined && (t.padding < 0 || t.padding > 80)) survived = false
                    if (t.framePct !== undefined && (t.framePct < 0 || t.framePct > 14)) survived = false
                }
            }
        } catch {
            survived = false
        }
    }
    check(survived, 'the plan validator clamps or drops every hostile field instead of throwing')
}

// ── 11. layout choice for a photo count never exceeds the photos ───────────
{
    let ok = true
    for (let n = 1; n <= 12; n += 1) {
        const id = pickLayoutForCount(n)
        const layout = LAYOUTS.find((l) => l.id === id)
        if (!layout) { ok = false; break }
        if (n >= 2 && layout.cellCount > n) ok = false
    }
    check(ok, 'the layout picked for N photos never asks for more than N')
}

// ── 12. content-aware arrangement ──────────────────────────────────────────
{
    const cells = computeCollageCells({ width: 1200, height: 800 }, '3-feature-left', 10, 10)
    const hero = cells.reduce((best, c) => (c.w * c.h > best.w * best.h ? c : best), cells[0])
    const photos = [
        photoDescriptor({ aspect: 1, quality: 0.2 }, 0),
        photoDescriptor({ aspect: 1.5, quality: 0.95, concentration: 0.8 }, 1),
        photoDescriptor({ aspect: 0.6, quality: 0.4 }, 2),
    ]
    const assignment = assignPhotosToCells(photos, cells)
    const heroIndex = cells.indexOf(hero)
    check(assignment[heroIndex] === 1, 'the strongest photo lands in the biggest frame',
        `hero cell got photo ${assignment[heroIndex]}`)
    check(new Set(assignment.filter((v) => v !== null)).size === assignment.filter((v) => v !== null).length,
        'no photo is placed twice')
    check(JSON.stringify(assignPhotosToCells(photos, cells)) === JSON.stringify(assignment),
        'the assignment is deterministic')

    const fewer = assignPhotosToCells(photos.slice(0, 2), cells)
    check(fewer.filter((v) => v !== null).length === 2 && fewer.includes(null),
        'with fewer photos than cells the extra cells stay empty rather than repeating a photo')

    // A panorama should pull the ranking toward a layout that has a wide cell.
    const withPano = [
        photoDescriptor({ aspect: 6, quality: 0.8 }, 0),
        photoDescriptor({ aspect: 1, quality: 0.6 }, 1),
        photoDescriptor({ aspect: 1, quality: 0.6 }, 2),
    ]
    const ranked = rankLayoutsForPhotos(withPano, { canvasWidth: 1200, canvasHeight: 1200 })
    const best = ranked[0]
    const bestCells = computeCollageCells({ width: 1200, height: 1200 }, best.layoutId, 10, 10)
    const widest = Math.max(...bestCells.map((c) => c.w / c.h))
    const squareOnly = computeCollageCells({ width: 1200, height: 1200 }, '4-grid', 10, 10)
    const squareWidest = Math.max(...squareOnly.map((c) => c.w / c.h))
    check(widest >= squareWidest, 'a set containing a panorama prefers a layout with a wide cell',
        `${best.layoutId}: widest cell ${widest.toFixed(2)}:1`)
    check(ranked.every((r, i) => i === 0 || ranked[i - 1].score >= r.score), 'the ranking is ordered by score')
    check(bestLayoutForPhotos(withPano, { canvasWidth: 1200, canvasHeight: 1200 }) === best.layoutId,
        'bestLayoutForPhotos agrees with the ranking')
    check(rankLayoutsForPhotos([]).length === 0 && bestLayoutForPhotos([]) === null,
        'no photos, no ranking (and no crash)')

    const focus = focusForCell(photoDescriptor({ focus: { x: 0.2, y: 0.9 } }, 0))
    check(focus.x === 0.2 && focus.y === 0.9, 'the analysed focus point is passed through')
    const missing = focusForCell(photoDescriptor(null, 0))
    check(missing.x === 0.5 && missing.y === 0.5, 'a photo with no analysis frames centred')
}

// ── 13. working resolution: decoded pixels bounded by what the project needs ─
{
    const edge = workingEdgeForProject({ width: 1080, height: 1920 })
    check(edge === 5760, 'a 1080×1920 project asks for at most 3× its long edge', `${edge}px`)
    check(workingEdgeForProject({ width: 6000, height: 4000 }) === 8192,
        'the request never exceeds the serving limit')
    check(workingEdgeForProject({}) === 0, 'no project, no cap to apply')

    const url = 'https://ik.imagekit.io/demo/photo.jpg'
    const resized = imagekitResized(url, 2400)
    check(resized.includes('tr=w-2400') && resized.includes('c-at_max'),
        'an ImageKit URL is asked for a bounded variant', resized.slice(-40))
    check(imagekitResized(url, 0) === url, 'no cap means the original URL')
    check(imagekitResized('data:image/png;base64,AAAA', 2400).startsWith('data:'),
        'a data URL is left alone (nothing to transform)')
    check(imagekitResized('https://example.com/p.jpg', 2400) === 'https://example.com/p.jpg',
        'a third-party URL is not rewritten')
    check(imagekitResized(`${url}?tr=w-100`, 2400) === `${url}?tr=w-100`,
        'an existing transform is respected')
}

// ── 14. adjustable dividers: drag one, and no neighbour can be squeezed out ──
{
    const size = { width: 1200, height: 900 }
    let everyLayoutHasDividers = true
    let clampHeld = true
    let countsHeld = true
    let noOverlap = true
    let deterministic = true
    const worst = { min: Infinity, layoutId: null }

    for (const layout of LAYOUTS) {
        const info = collageFrameFor(size, layout.id, 10, 10)
        if (!info) { everyLayoutHasDividers = false; continue }
        const dividers = layoutBoundaries(layout.id, info.frame, info.gap)
        if (dividers.length < 1) everyLayoutHasDividers = false

        for (const divider of dividers) {
            // Shove it far past either limit, repeatedly: the clamp has to hold
            // however hard it is pushed.
            for (const direction of [1, -1]) {
                let weights = defaultWeightsFor(layout.id)
                for (let i = 0; i < 25; i += 1) {
                    const live = layoutBoundaries(layout.id, info.frame, info.gap, weights)
                        .find((b) => b.axis === divider.axis && b.index === divider.index) || divider
                    weights = applyBoundaryDrag(layout.id, weights, live, direction * 400)
                }
                const cells = computeCollageCells(size, layout.id, 10, 10, weights)
                if (cells.length !== layout.cellCount) countsHeld = false
                for (const c of cells) {
                    const shortest = Math.min(c.w, c.h)
                    if (shortest < worst.min) { worst.min = shortest; worst.layoutId = layout.id }
                    // Every cell must keep a real size on both axes.
                    if (c.w < 2 || c.h < 2) clampHeld = false
                    if (!Number.isInteger(c.x) || !Number.isInteger(c.w)) clampHeld = false
                }
                for (let i = 0; i < cells.length; i += 1) {
                    for (let j = i + 1; j < cells.length; j += 1) {
                        if (overlaps(cells[i], cells[j])) noOverlap = false
                    }
                }
            }
            const once = applyBoundaryDrag(layout.id, defaultWeightsFor(layout.id), divider, 60)
            const twice = applyBoundaryDrag(layout.id, defaultWeightsFor(layout.id), divider, 60)
            if (JSON.stringify(once) !== JSON.stringify(twice)) deterministic = false
        }
    }
    check(everyLayoutHasDividers, 'every layout exposes at least one draggable divider')
    check(countsHeld, 'dragging a divider never changes how many cells a layout has')
    check(clampHeld, 'no frame can be dragged out of existence', `smallest side seen: ${worst.min}px (${worst.layoutId})`)
    check(noOverlap, 'dragged frames never overlap each other')
    check(deterministic, 'the same drag produces the same weights')

    // Only the two frames either side of the divider move.
    const base = computeCollageCells(size, '4-columns', 10, 10)
    const info = collageFrameFor(size, '4-columns', 10, 10)
    const dragged = computeCollageCells(size, '4-columns', 10, 10,
        applyBoundaryDrag('4-columns', defaultWeightsFor('4-columns'), layoutBoundaries('4-columns', info.frame, info.gap)[0], 120))
    check(dragged[0].w > base[0].w && dragged[1].w < base[1].w,
        'dragging the first divider grows the first frame and shrinks the second',
        `${base[0].w}→${dragged[0].w}, ${base[1].w}→${dragged[1].w}`)
    check(dragged[2].w === base[2].w && dragged[3].w === base[3].w,
        'the frames further along stay exactly where they were')
    check(JSON.stringify(computeCollageCells(size, '4-columns', 10, 10, defaultWeightsFor('4-columns')))
        === JSON.stringify(base), 'uniform weights reproduce the untouched layout')

    // The documented proportions of the feature layouts survive the rewrite.
    const feature = computeCollageCells({ width: 1000, height: 1000 }, '3-feature-left', 0, 0)
    check(Math.abs(feature[0].w / 1000 - 0.62) < 0.01, 'the left-feature layout still gives the feature 62% of the width',
        `${(feature[0].w / 10).toFixed(1)}%`)
    const mosaic = computeCollageCells({ width: 1000, height: 1000 }, '5-mosaic', 0, 0)
    check(Math.abs(mosaic[0].w / 1000 - 0.48) < 0.01, 'the mosaic feature still gets 48% of the width',
        `${(mosaic[0].w / 10).toFixed(1)}%`)
    check(MIN_CELL_FRACTION > 0 && MIN_CELL_FRACTION < 0.5, 'the minimum cell fraction is a sane floor', `${MIN_CELL_FRACTION}`)
    check(layoutBoundaries('no-such-layout', { x: 0, y: 0, w: 100, h: 100 }, 4).length === 0,
        'an unknown layout has no dividers to drag')
    check(JSON.stringify(applyBoundaryDrag('no-such-layout', null, null, 10)) === '{}',
        'a drag on an unknown layout changes nothing')
}

// ── 15. the mat, inward and outward ─────────────────────────────────────────
{
    const cell = { x: 100, y: 100, w: 200, h: 150 }
    const inner = insetCellForFrame(cell, { framePct: 10 })
    check(inner.w < cell.w && inner.x > cell.x, 'an inward mat shrinks the photo and leaves backdrop around it',
        `${inner.w}×${inner.h}`)
    const outer = insetCellForFrame(cell, { framePct: 10, frameMode: 'outer', gap: 20 })
    check(outer.w > cell.w && outer.x < cell.x, 'an outward mat grows into the gutter instead of cropping the photo',
        `${outer.w}×${outer.h}`)
    check(outer.w - cell.w <= 20 + 1e-6, 'an outward mat takes at most half the gap per side, so neighbours cannot overlap')
    const noRoom = insetCellForFrame(cell, { framePct: 10, frameMode: 'outer', gap: 0 })
    check(noRoom === cell, 'with no gap there is nowhere to grow, so the cell is left alone')

    // Two real neighbours with an outward mat must still not touch.
    const cells = computeCollageCells({ width: 1000, height: 500 }, '2-split-h', 24, 0)
    const style = { framePct: 14, frameMode: 'outer', gap: 24 }
    const a = insetCellForFrame(cells[0], style)
    const b = insetCellForFrame(cells[1], style)
    check(!overlaps(a, b), 'outward mats on adjacent frames never overlap',
        `${a.x + a.w} vs ${b.x}`)
}

console.log(`\n${checks - failures}/${checks} checks passed.`)
if (failures > 0) { console.error(`\x1b[31m${failures} check(s) failed.\x1b[0m`); process.exit(1) }
process.exit(0)
