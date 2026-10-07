"use client"

import { useState, useCallback, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { LayoutGrid, Loader2, Replace, SlidersHorizontal, Wand2 } from 'lucide-react'
import { FabricImage, Rect } from 'fabric'
import { FastAverageColor } from 'fast-average-color'
import { useCanvas } from '../../../../../../../context/context'
import { applyCanvasSizedBackground } from '@/lib/canvas-background'
import { loadFabricImageFromFile, workingEdgeForProject } from '@/lib/canvas-images'
import { AI_BG_THEMES, applyCollageBackground, backdropPreviewCss, buildAiBackgroundPrompt } from '@/lib/collage-styles'
import { collagePlanCacheKey, readCollagePlan, writeCollagePlan, wrapCollageBgPrompt } from '@/lib/collage-ai'
import { computePerceptualHash } from '@/lib/image-fingerprint'
import { assignPhotosToCells, focusForCell, photoDescriptor } from '@/lib/collage-arrange'
import { LAYOUTS, collageFrameFor, computeCollageCells, defaultWeightsFor, layoutBoundaries, applyBoundaryDrag, generateTemplateRecipes, isVisibleImage, getCellCoverScale, assessCellResolution, setCellFitMode, fitImageToCell, restyleImage, clampToCell, cellFromClipPath } from '@/lib/collage-layout'
import { toast } from 'sonner'
import CollageComposer, { sourceElement } from './collage-composer'
import { analyzeElement } from '@/lib/collage/analyze'
import { cellFromImage, placeImageInCell, swapFramedPhotos } from '@/lib/collage/render'
import { cellFromSlot, createSlot, isCollageSlot } from '@/lib/collage/slot'
import { buildCellMatte, isCollageMatte } from '@/lib/collage-styles'
import { Section } from './collage/ui'
import TemplatesSection from './collage/templates-section'
import LayoutSection from './collage/layout-section'
import TemplateStyleSection from './collage/template-style-section'
import BackgroundSection from './collage/background-section'
import PhotoShapeSection from './collage/photo-shape-section'
import AiBackgroundSection from './collage/ai-background-section'
import SpacingSection from './collage/spacing-section'

const fac = new FastAverageColor()

const enterCollageConstraints = (image) => {
    image.set({ lockRotation: true, lockSkewingX: true, lockSkewingY: true })
}
const exitCollageConstraints = (image) => {
    image.set({ lockRotation: false, lockSkewingX: false, lockSkewingY: false })
}

export default function CollageControls({ project, dominantColor }) {
    const { canvasEditor, processingMessage, setProcessingMessage, onToolChange } = useCanvas()
    const [selectedLayout, setSelectedLayout] = useState('2-split-h')
    const [gap, setGap] = useState(10)
    const [padding, setPadding] = useState(10)
    const [imageCount, setImageCount] = useState(0)
    // The currently-selected collage cell photo (drives the Replace / Edit panel).
    const [selectedPhoto, setSelectedPhoto] = useState(null)
    const [isReplacing, setIsReplacing] = useState(false)
    const replaceInputRef = useRef(null)
    // Photo-frame styling (shape + corner radius + shadow). The selected preset id
    // is cosmetic; `style` is the live source of truth applied to the cells.
    const [selectedStyle, setSelectedStyle] = useState('clean')
    const [shape, setShape] = useState('rect')
    const [radiusPct, setRadiusPct] = useState(0)
    const [shadow, setShadow] = useState(false)
    // How a photo meets its cell: fill it and crop (cover), or show all of it and
    // let the backdrop frame it (contain — the sane choice for a panorama).
    const [fitMode, setFitMode] = useState('cover')
    // Content-aware placement: the strongest photo takes the biggest frame and
    // each photo goes to the cell whose shape suits it, instead of filling cells
    // in upload order and centre-cropping whatever lands there.
    const [smartArrange, setSmartArrange] = useState(true)
    // Mat: a border of backdrop inside each frame, or one grown outward into the
    // gutter. Outward needs a gap to grow into, hence the two are separate.
    const [framePct, setFramePct] = useState(0)
    const [frameMode, setFrameMode] = useState('inner')
    // A solid panel behind each cell, so a cut-out PNG does not read as a hole.
    const [matte, setMatte] = useState(null)
    // Per-layout divider positions. Dragging a divider moves only the two frames
    // either side of it, and never past the minimum cell size.
    const [weights, setWeights] = useState(() => defaultWeightsFor(selectedLayout))
    const weightsRef = useRef(weights)
    useEffect(() => { weightsRef.current = weights }, [weights])
    // A layout change starts from that layout's own uniform dividers.
    useEffect(() => { setWeights(defaultWeightsFor(selectedLayout)) }, [selectedLayout])
    const layoutRef = useRef(selectedLayout)
    useEffect(() => { layoutRef.current = selectedLayout }, [selectedLayout])
    const spacingRef = useRef({ gap, padding })
    useEffect(() => { spacingRef.current = { gap, padding } }, [gap, padding])
    const styleRef = useRef(null)
    styleRef.current = { shape, radiusPct, shadow, fitMode, framePct, frameMode, matte }
    // cell index → photo index, as the last layout decided it. Without this a
    // divider drag would re-fill the cells in canvas order and undo a
    // content-aware arrangement.
    const assignmentRef = useRef(null)

    const [activeBackdrop, setActiveBackdrop] = useState(null)
    const [generatingTheme, setGeneratingTheme] = useState(null)
    // Generated "stylish template" suggestions (gallery).
    const [templateRecipes, setTemplateRecipes] = useState([])
    // Vision-AI template planning: in-flight flag + the model's content analysis.
    const [isPlanning, setIsPlanning] = useState(false)
    const [aiAnalysis, setAiAnalysis] = useState(null)
    // Optional creative direction the user (or the agent) asks for — steers the
    // whole plan ("editorial", "vintage film", "scrapbook"…). Mirrored to a ref
    // so requestAiTemplates stays stable (no re-fire on each keystroke).
    const [aiDirection, setAiDirection] = useState('')
    const aiDirectionRef = useRef('')
    useEffect(() => { aiDirectionRef.current = aiDirection }, [aiDirection])
    // Latest applyRecipe, so autoTemplate can call it without a definition-order
    // dependency cycle (applyRecipe is defined below autoTemplate).
    const applyRecipeRef = useRef(null)
    // Plan requests race: cycling templates fires several, and without a
    // generation counter the SLOWEST reply wins and lands a stale gallery.
    const planRunRef = useRef(0)
    const planAbortRef = useRef(null)

    // Panel settings live per project, so reopening the editor finds the same
    // layout, spacing, fit, mat, panel and divider positions the collage on the
    // canvas was built with — otherwise the first divider drag would snap the
    // frames back to even.
    const settingsKey = project?._id ? `phosmith:collage:${project._id}` : null
    const settingsLoaded = useRef(false)
    useEffect(() => {
        if (!settingsKey || settingsLoaded.current) return
        settingsLoaded.current = true
        try {
            const saved = JSON.parse(window.localStorage.getItem(settingsKey) || 'null')
            if (!saved) return
            if (LAYOUTS.some((l) => l.id === saved.layout)) setSelectedLayout(saved.layout)
            if (Number.isFinite(saved.gap)) setGap(saved.gap)
            if (Number.isFinite(saved.padding)) setPadding(saved.padding)
            if (Number.isFinite(saved.radiusPct)) setRadiusPct(saved.radiusPct)
            if (Number.isFinite(saved.framePct)) setFramePct(saved.framePct)
            if (saved.shape === 'rect' || saved.shape === 'circle') setShape(saved.shape)
            if (typeof saved.shadow === 'boolean') setShadow(saved.shadow)
            if (saved.fitMode === 'cover' || saved.fitMode === 'contain') setFitMode(saved.fitMode)
            if (saved.frameMode === 'inner' || saved.frameMode === 'outer') setFrameMode(saved.frameMode)
            if (typeof saved.matte === 'string' || saved.matte === null) setMatte(saved.matte)
            if (typeof saved.smartArrange === 'boolean') setSmartArrange(saved.smartArrange)
            // Weights are restored AFTER the layout, whose own effect resets them.
            if (saved.weights && typeof saved.weights === 'object') {
                setTimeout(() => {
                    setWeights(saved.weights)
                    weightsRef.current = saved.weights
                }, 0)
            }
        } catch {
            /* a corrupt entry is not worth failing the panel over */
        }
    }, [settingsKey])

    useEffect(() => {
        if (!settingsKey || !settingsLoaded.current) return
        try {
            window.localStorage.setItem(settingsKey, JSON.stringify({
                layout: selectedLayout, gap, padding, shape, radiusPct, shadow,
                fitMode, framePct, frameMode, matte, smartArrange, weights,
            }))
        } catch {
            /* storage full or blocked — the panel still works */
        }
    }, [settingsKey, selectedLayout, gap, padding, shape, radiusPct, shadow, fitMode, framePct, frameMode, matte, smartArrange, weights])

    const syncImageCount = useCallback(() => {
        const images = canvasEditor?.getObjects?.().filter(isVisibleImage) || []
        setImageCount(images.length)
    }, [canvasEditor])

    useEffect(() => {
        if (!canvasEditor) return
        syncImageCount()
        const events = ['object:added', 'object:removed', 'object:modified']
        events.forEach(event => canvasEditor.on(event, syncImageCount))
        return () => events.forEach(event => canvasEditor.off(event, syncImageCount))
    }, [canvasEditor, syncImageCount])

    // Surface the Replace / Edit actions whenever a SINGLE collage cell photo is
    // the active selection on the canvas.
    useEffect(() => {
        if (!canvasEditor) return undefined
        const sync = () => {
            const active = canvasEditor.getActiveObject?.()
            const framed = active && isVisibleImage(active) && (active.phosmithCollageCell || cellFromClipPath(active))
            setSelectedPhoto(framed ? active : null)
        }
        sync()
        const events = ['selection:created', 'selection:updated', 'selection:cleared', 'object:removed']
        events.forEach((event) => canvasEditor.on(event, sync))
        return () => events.forEach((event) => canvasEditor.off(event, sync))
    }, [canvasEditor])

    // While the collage tool is open, keep every FRAMED image (one carrying a
    // collage cell, or one we can recover a cell from via its persisted absolute
    // clipPath) panning/scaling INSIDE its cell. Handlers are scoped to this
    // tool so other tools aren't constrained; rotation/skew locks are released
    // when the tool closes.
    useEffect(() => {
        if (!canvasEditor) return undefined
        canvasEditor.getObjects().filter(isVisibleImage).forEach((img) => {
            if (!img.phosmithCollageCell) {
                const cell = cellFromClipPath(img)
                if (cell) {
                    img.phosmithCollageCell = cell
                    img._phosmithCollageCell = cell
                    img.phosmithCollageCoverScale = getCellCoverScale(img, cell)
                }
            }
            if (img.phosmithCollageCell) enterCollageConstraints(img)
        })

        const onMoving = (e) => { if (e?.target?.phosmithCollageCell) clampToCell(e.target) }
        const onScaling = (e) => { if (e?.target?.phosmithCollageCell) clampToCell(e.target) }
        const onModified = (e) => {
            if (e?.target?.phosmithCollageCell && clampToCell(e.target)) canvasEditor.requestRenderAll()
        }
        canvasEditor.on('object:moving', onMoving)
        canvasEditor.on('object:scaling', onScaling)
        canvasEditor.on('object:modified', onModified)
        canvasEditor.requestRenderAll()
        return () => {
            canvasEditor.off('object:moving', onMoving)
            canvasEditor.off('object:scaling', onScaling)
            canvasEditor.off('object:modified', onModified)
            canvasEditor.getObjects?.().filter(isVisibleImage).forEach((img) => {
                if (img.phosmithCollageCell) exitCollageConstraints(img)
            })
            canvasEditor.requestRenderAll()
        }
    }, [canvasEditor])

    // Empty slots + rearranging. Click a "+" slot to upload into it (extra files
    // fill the next empty slots); drag a framed photo onto another photo to swap,
    // or onto a slot to move it there.
    const slotInputRef = useRef(null)
    const pendingSlotRef = useRef(null)
    // True while a frame divider is being dragged: the swap/pan gesture stands
    // down so one pointer cannot do both things at once.
    const dividerDragRef = useRef(false)
    const shortSide = Math.min(Number(project?.width) || 1000, Number(project?.height) || 1000)

    const fillSlots = useCallback(async (files, firstSlot) => {
        if (!canvasEditor || !files.length) return
        const toastId = toast.loading(files.length > 1 ? `Adding ${files.length} photos…` : 'Adding photo…')
        let added = 0
        try {
            for (const file of files) {
                const slots = canvasEditor.getObjects().filter(isCollageSlot)
                const slot = added === 0 && firstSlot && slots.includes(firstSlot) ? firstSlot : slots[0]
                if (!slot) break
                const image = await loadFabricImageFromFile(file, { silent: true, maxEdge: workingEdgeForProject(project) })
                const cell = cellFromSlot(slot)
                const analysis = analyzeElement(sourceElement(image))
                const polygonal = Array.isArray(slot.points) && slot.points.length >= 3
                if (polygonal) {
                    // Composer shapes (shards, silhouettes) keep their own placement.
                    placeImageInCell(image, cell, analysis, { shadow: 0.45, S: shortSide })
                } else {
                    // A grid slot is filled the same way the layout fills a cell, so
                    // fit mode, mat and panel apply to a photo added later too.
                    const frameGap = collageFrameFor({ width: project?.width, height: project?.height }, layoutRef.current, spacingRef.current.gap, spacingRef.current.padding)?.gap || 0
                    fitImageToCell(image, cell, {
                        ...styleRef.current,
                        gap: frameGap,
                        focus: focusForCell(photoDescriptor(analysis, 0)),
                    })
                    if (styleRef.current?.matte) {
                        const panel = buildCellMatte(cell, styleRef.current)
                        canvasEditor.add(panel)
                        canvasEditor.sendObjectToBack?.(panel)
                    }
                }
                const index = canvasEditor.getObjects().indexOf(slot)
                canvasEditor.remove(slot)
                if (typeof canvasEditor.insertAt === 'function' && index >= 0) canvasEditor.insertAt(index, image)
                else canvasEditor.add(image)
                added += 1
            }
            canvasEditor.requestRenderAll()
            canvasEditor.__pushHistoryState?.({ label: added > 1 ? `Added ${added} collage photos` : 'Added collage photo', domain: 'collage' })
            canvasEditor.__saveCanvasState?.()
            const left = canvasEditor.getObjects().filter(isCollageSlot).length
            toast.success(left ? `Added. ${left} empty slot${left === 1 ? '' : 's'} left` : 'Collage filled', { id: toastId })
        } catch (error) {
            console.warn('[collage] slot fill failed:', error)
            toast.error(added ? `Added ${added}, then an upload failed` : 'Could not add that photo', { id: toastId })
        }
    }, [canvasEditor, shortSide, project])

    useEffect(() => {
        if (!canvasEditor) return undefined
        const highlight = new Rect({
            left: 0, top: 0, width: 1, height: 1, originX: 'left', originY: 'top',
            fill: 'rgba(6, 184, 212, 0.16)', stroke: '#06b8d4', strokeWidth: shortSide * 0.004,
            strokeDashArray: [shortSide * 0.012, shortSide * 0.008],
            selectable: false, evented: false, excludeFromExport: true, visible: false,
        })
        canvasEditor.add(highlight)
        let down = null
        let drag = null

        const boxOf = (obj) => {
            if (isCollageSlot(obj)) return obj.getBoundingRect()
            return obj.phosmithCollageCell
                ? { left: obj.phosmithCollageCell.x, top: obj.phosmithCollageCell.y, width: obj.phosmithCollageCell.w, height: obj.phosmithCollageCell.h }
                : obj.getBoundingRect()
        }
        const inside = (box, pt) => pt.x >= box.left && pt.x <= box.left + box.width && pt.y >= box.top && pt.y <= box.top + box.height
        const targetAt = (pt, self) => {
            const objs = canvasEditor.getObjects()
            for (let i = objs.length - 1; i >= 0; i -= 1) {
                const o = objs[i]
                if (o === self || o === highlight) continue
                if (isCollageSlot(o) || (isVisibleImage(o) && cellFromImage(o))) {
                    if (inside(boxOf(o), pt)) return o
                }
            }
            return null
        }
        const hide = () => {
            if (highlight.visible) { highlight.set({ visible: false }); canvasEditor.requestRenderAll() }
        }

        // A swap has to be deliberate: the pointer must travel, and it must leave
        // the photo's own cell by a real margin. Otherwise panning a photo that
        // happens to reach the cell edge would fling it into the neighbour.
        const SWAP_TRAVEL = 12
        const SWAP_MARGIN = Math.max(6, shortSide * 0.02)
        // One pointer owns a gesture. A second finger (pinch-zoom, or a grab at
        // the border) cancels the pending swap instead of fighting it.
        const pointerCount = (e) => e?.touches?.length || 1
        const pointerIdOf = (e) => (e?.pointerId ?? e?.changedTouches?.[0]?.identifier ?? 'mouse')
        let owner = null

        const cancelDrag = () => { drag = null; owner = null; hide() }

        const onDown = (opt) => {
            if (dividerDragRef.current) { cancelDrag(); return }
            if (owner !== null || pointerCount(opt.e) > 1) { cancelDrag(); return }
            const t = opt.target
            owner = pointerIdOf(opt.e)
            down = { x: opt.e.clientX, y: opt.e.clientY, target: t }
            drag = t && isVisibleImage(t) && cellFromImage(t) ? { image: t, target: null } : null
        }
        const onMove = (opt) => {
            if (dividerDragRef.current) { cancelDrag(); return }
            if (pointerCount(opt.e) > 1) { cancelDrag(); return }
            if (owner !== null && pointerIdOf(opt.e) !== owner) return
            if (!drag || !opt.e.buttons) return
            const travelled = down ? Math.hypot(opt.e.clientX - down.x, opt.e.clientY - down.y) : 0
            const pt = canvasEditor.getScenePoint(opt.e)
            const own = boxOf(drag.image)
            const leftOwnCell = !inside({
                left: own.left - SWAP_MARGIN,
                top: own.top - SWAP_MARGIN,
                width: own.width + SWAP_MARGIN * 2,
                height: own.height + SWAP_MARGIN * 2,
            }, pt)
            const t = leftOwnCell && travelled >= SWAP_TRAVEL ? targetAt(pt, drag.image) : null
            drag.target = t
            if (!t) { hide(); return }
            const b = boxOf(t)
            highlight.set({ left: b.left, top: b.top, width: b.width, height: b.height, visible: true })
            canvasEditor.bringObjectToFront(highlight)
            canvasEditor.requestRenderAll()
        }
        const onUp = (opt) => {
            if (dividerDragRef.current) { cancelDrag(); return }
            if (owner !== null && pointerIdOf(opt.e) !== owner) return
            const wasClick = down && Math.hypot(opt.e.clientX - down.x, opt.e.clientY - down.y) < 6
            if (wasClick && isCollageSlot(down.target)) {
                pendingSlotRef.current = down.target
                slotInputRef.current?.click()
            } else if (drag?.target) {
                const { image, target } = drag
                const photo = analyzeElement(sourceElement(image))
                if (isCollageSlot(target)) {
                    const from = cellFromImage(image)
                    const fromIndex = canvasEditor.getObjects().indexOf(image)
                    const slotIndex = canvasEditor.getObjects().indexOf(target)
                    placeImageInCell(image, cellFromSlot(target), photo, { shadow: image.shadow ? 0.45 : 0, S: shortSide })
                    canvasEditor.remove(target)
                    if (typeof canvasEditor.moveObjectTo === 'function') canvasEditor.moveObjectTo(image, Math.min(slotIndex, canvasEditor.getObjects().length - 1))
                    const back = createSlot(from)
                    if (typeof canvasEditor.insertAt === 'function') canvasEditor.insertAt(Math.max(0, fromIndex), back)
                    else canvasEditor.add(back)
                    canvasEditor.__pushHistoryState?.({ label: 'Moved collage photo', domain: 'collage' })
                } else if (swapFramedPhotos(canvasEditor, image, target, photo, analyzeElement(sourceElement(target)), shortSide)) {
                    canvasEditor.__pushHistoryState?.({ label: 'Swapped collage photos', domain: 'collage' })
                }
                canvasEditor.discardActiveObject()
                canvasEditor.__saveCanvasState?.()
            }
            hide()
            down = null
            drag = null
            owner = null
        }
        canvasEditor.on('mouse:down', onDown)
        canvasEditor.on('mouse:move', onMove)
        canvasEditor.on('mouse:up', onUp)
        return () => {
            canvasEditor.off('mouse:down', onDown)
            canvasEditor.off('mouse:move', onMove)
            canvasEditor.off('mouse:up', onUp)
            canvasEditor.remove(highlight)
        }
    }, [canvasEditor, shortSide])

    // Dragging the dividers between frames. The layout stays a layout — only the
    // weights move — so nothing about persistence, swapping or export changes.

    /** Re-fit the framed photos (and mattes) to a fresh set of cells. */
    const applyCellsToPhotos = useCallback((cells) => {
        if (!canvasEditor || !cells?.length) return
        const images = canvasEditor.getObjects().filter(isVisibleImage)
        const frameGap = collageFrameFor({ width: project?.width, height: project?.height }, layoutRef.current, spacingRef.current.gap, spacingRef.current.padding)?.gap || 0
        const layoutStyle = { ...styleRef.current, gap: frameGap }
        const filled = Math.min(images.length, cells.length)
        const map = assignmentRef.current
        for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
            const photoIndex = map ? map[cellIndex] : cellIndex
            if (photoIndex === null || photoIndex === undefined || photoIndex >= images.length) continue
            fitImageToCell(images[photoIndex], cells[cellIndex], layoutStyle)
        }
        canvasEditor.getObjects().filter(isCollageSlot).forEach((slot) => canvasEditor.remove(slot))
        cells.slice(filled).forEach((cell) => canvasEditor.add(createSlot(cell)))
        canvasEditor.getObjects().filter(isCollageMatte).forEach((panel) => canvasEditor.remove(panel))
        if (layoutStyle.matte) {
            cells.slice(0, filled).forEach((cell) => {
                const panel = buildCellMatte(cell, layoutStyle)
                canvasEditor.add(panel)
                canvasEditor.sendObjectToBack?.(panel)
            })
        }
        canvasEditor.requestRenderAll()
    }, [canvasEditor, project?.width, project?.height])

    useEffect(() => {
        if (!canvasEditor) return undefined
        const HIT = Math.max(6, shortSide * 0.012)
        const guide = new Rect({
            left: 0, top: 0, width: 1, height: 1, originX: 'left', originY: 'top',
            fill: 'rgba(6, 184, 212, 0.9)', selectable: false, evented: false,
            excludeFromExport: true, visible: false,
        })
        canvasEditor.add(guide)

        const currentBoundaries = () => {
            const info = collageFrameFor({ width: project?.width, height: project?.height }, layoutRef.current, spacingRef.current.gap, spacingRef.current.padding)
            if (!info) return []
            return layoutBoundaries(layoutRef.current, info.frame, info.gap, weightsRef.current)
                .map((b) => ({ ...b, info }))
        }
        const near = (pt, reach = HIT) => {
            let best = null
            for (const b of currentBoundaries()) {
                const along = b.orientation === 'v' ? pt.y : pt.x
                if (along < b.from - reach || along > b.to + reach) continue
                const distance = Math.abs((b.orientation === 'v' ? pt.x : pt.y) - b.position)
                if (distance <= reach && (!best || distance < best.distance)) best = { boundary: b, distance }
            }
            return best?.boundary || null
        }
        const showGuide = (b) => {
            if (b.orientation === 'v') guide.set({ left: b.position - 1, top: b.from, width: 2, height: b.to - b.from, visible: true })
            else guide.set({ left: b.from, top: b.position - 1, width: b.to - b.from, height: 2, visible: true })
            canvasEditor.bringObjectToFront(guide)
        }

        let dragging = null

        const onDown = (opt) => {
            const pt = canvasEditor.getScenePoint(opt.e)
            // In the gutter, the whole hit band resizes. Over a photo — which is
            // what happens at gap 0, where the divider IS the photo's edge — only a
            // narrow band does, so panning the middle of a photo still pans it.
            const overPhoto = Boolean(opt.target) && !isCollageSlot(opt.target)
            const boundary = near(pt, overPhoto ? HIT / 2 : HIT)
            if (!boundary) return
            const held = overPhoto ? opt.target : null
            dragging = {
                boundary,
                start: pt,
                weights: weightsRef.current,
                held,
                heldLocks: held ? { x: held.lockMovementX, y: held.lockMovementY } : null,
            }
            // Fabric is already mid-transform on that photo; locking movement keeps
            // the gesture a resize instead of a resize AND a pan.
            if (held) held.set({ lockMovementX: true, lockMovementY: true })
            dividerDragRef.current = true
            showGuide(boundary)
            canvasEditor.selection = false
            canvasEditor.discardActiveObject()
            canvasEditor.requestRenderAll()
        }
        const onMove = (opt) => {
            const pt = canvasEditor.getScenePoint(opt.e)
            if (!dragging) {
                const hover = near(pt, opt.target && !isCollageSlot(opt.target) ? HIT / 2 : HIT)
                canvasEditor.defaultCursor = hover ? (hover.orientation === 'v' ? 'col-resize' : 'row-resize') : 'default'
                if (hover) showGuide(hover)
                else if (guide.visible) { guide.set({ visible: false }); canvasEditor.requestRenderAll() }
                return
            }
            const delta = dragging.boundary.orientation === 'v' ? pt.x - dragging.start.x : pt.y - dragging.start.y
            const next = applyBoundaryDrag(layoutRef.current, dragging.weights, dragging.boundary, delta)
            weightsRef.current = next
            const cells = computeCollageCells(
                { width: project?.width, height: project?.height },
                layoutRef.current, spacingRef.current.gap, spacingRef.current.padding, next,
            )
            applyCellsToPhotos(cells)
            const moved = layoutBoundaries(layoutRef.current, dragging.boundary.info.frame, dragging.boundary.info.gap, next)
                .find((b) => b.axis === dragging.boundary.axis && b.index === dragging.boundary.index)
            if (moved) showGuide(moved)
            canvasEditor.requestRenderAll()
        }
        const onUp = () => {
            if (!dragging) return
            const next = weightsRef.current
            if (dragging.held && dragging.heldLocks) {
                dragging.held.set({ lockMovementX: dragging.heldLocks.x, lockMovementY: dragging.heldLocks.y })
            }
            dragging = null
            dividerDragRef.current = false
            canvasEditor.selection = true
            guide.set({ visible: false })
            canvasEditor.requestRenderAll()
            setWeights(next)
            canvasEditor.__pushHistoryState?.({ label: 'Resized collage frames', domain: 'collage' })
            canvasEditor.__saveCanvasState?.()
        }

        canvasEditor.on('mouse:down', onDown)
        canvasEditor.on('mouse:move', onMove)
        canvasEditor.on('mouse:up', onUp)
        return () => {
            canvasEditor.off('mouse:down', onDown)
            canvasEditor.off('mouse:move', onMove)
            canvasEditor.off('mouse:up', onUp)
            canvasEditor.defaultCursor = 'default'
            canvasEditor.remove(guide)
            canvasEditor.requestRenderAll()
        }
    }, [canvasEditor, project?.width, project?.height, shortSide, applyCellsToPhotos])

    const applyLayout = useCallback(() => {
        if (!canvasEditor) return

        const images = canvasEditor.getObjects().filter(isVisibleImage)
        const layout = LAYOUTS.find(l => l.id === selectedLayout)
        if (!layout) return

        if (!images.length) {
            toast.error('Add at least one photo first')
            return
        }

        const cells = computeCollageCells(
            { width: project?.width, height: project?.height },
            selectedLayout,
            gap,
            padding,
            weights,
        )

        canvasEditor.discardActiveObject()
        const frameGap = collageFrameFor({ width: project?.width, height: project?.height }, selectedLayout, gap, padding)?.gap || 0
        const layoutStyle = { shape, radiusPct, shadow, fitMode, framePct, frameMode, gap: frameGap, matte }
        const filled = Math.min(images.length, cells.length)
        const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1
        let lowRes = 0

        // Which photo lands in which cell, and where inside its frame it sits.
        const analyses = smartArrange ? images.map((img) => analyzeElement(sourceElement(img))) : null
        const descriptors = analyses ? analyses.map((a, i) => photoDescriptor(a, i)) : null
        const assignment = descriptors ? assignPhotosToCells(descriptors, cells) : null

        assignmentRef.current = cells.map((_, cellIndex) => {
            const photoIndex = assignment ? assignment[cellIndex] : cellIndex
            return photoIndex !== null && photoIndex !== undefined && photoIndex < images.length ? photoIndex : null
        })
        cells.forEach((cell, cellIndex) => {
            const photoIndex = assignment ? assignment[cellIndex] : cellIndex
            if (photoIndex === null || photoIndex === undefined || photoIndex >= images.length) return
            const image = images[photoIndex]
            const focus = descriptors ? focusForCell(descriptors[photoIndex]) : null
            fitImageToCell(image, cell, focus ? { ...layoutStyle, focus } : layoutStyle)
            if (assessCellResolution(image, cell, dpr).low) lowRes += 1
            canvasEditor.fire('object:modified', { target: image })
        })

        // Fewer photos than cells is a legitimate state, not an error: the rest of
        // the template becomes empty slots the user can click to fill.
        canvasEditor.getObjects().filter(isCollageSlot).forEach((slot) => canvasEditor.remove(slot))
        const emptyCells = cells.slice(filled)
        emptyCells.forEach((cell) => canvasEditor.add(createSlot(cell)))

        // Mattes are rebuilt with the layout, never accumulated.
        canvasEditor.getObjects().filter(isCollageMatte).forEach((panel) => canvasEditor.remove(panel))
        if (matte) {
            cells.slice(0, filled).forEach((cell) => {
                const panel = buildCellMatte(cell, layoutStyle)
                canvasEditor.add(panel)
                canvasEditor.sendObjectToBack?.(panel)
            })
        }

        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.({ label: 'Applied collage layout', detail: layout.label, domain: 'collage' })
        canvasEditor.__saveCanvasState?.()

        const extraCount = images.length - filled
        toast.success(emptyCells.length
            ? `${layout.label} applied — ${filled} photo${filled === 1 ? '' : 's'}, ${emptyCells.length} slot${emptyCells.length === 1 ? '' : 's'} to fill`
            : `${layout.label} applied to ${filled} images`)
        if (extraCount > 0) {
            toast.info(`${extraCount} extra layer${extraCount === 1 ? '' : 's'} left unchanged`)
        }
        if (lowRes > 0) {
            toast.warning(`${lowRes} photo${lowRes === 1 ? ' is' : 's are'} smaller than its frame — switch that frame to "Fit whole photo" or use a larger file.`)
        }
    }, [canvasEditor, selectedLayout, gap, padding, project?.width, project?.height, shape, radiusPct, shadow, fitMode, smartArrange, framePct, frameMode, matte, weights])

    // Switch fit mode on every framed photo in place — no re-layout, so the
    // user's chosen arrangement survives the toggle.
    const changeFitMode = useCallback((mode) => {
        setFitMode(mode)
        if (!canvasEditor) return
        let changed = 0
        canvasEditor.getObjects().filter(isVisibleImage).forEach((img) => {
            if (setCellFitMode(img, mode)) changed += 1
        })
        if (!changed) return
        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.({ label: mode === 'contain' ? 'Fit whole photos' : 'Fill frames', domain: 'collage' })
        canvasEditor.__saveCanvasState?.()
    }, [canvasEditor])

    // Re-skin already-framed photos in place (no re-layout) so shape/radius/shadow
    // tweaks are instant. No-op when nothing is framed yet — the choice still sticks
    // and applies the next time a layout runs.
    const restyleFramedPhotos = useCallback((nextStyle) => {
        if (!canvasEditor) return
        let changed = 0
        canvasEditor.getObjects().filter(isVisibleImage).forEach((img) => {
            if (restyleImage(img, nextStyle)) changed += 1
        })
        if (changed > 0) {
            canvasEditor.requestRenderAll()
            canvasEditor.__pushHistoryState?.({ label: 'Restyled collage photos', domain: 'collage' })
            canvasEditor.__saveCanvasState?.()
        }
    }, [canvasEditor])

    const updateStyle = useCallback((patch) => {
        const next = { shape, radiusPct, shadow, ...patch }
        if (patch.shape !== undefined) setShape(patch.shape)
        if (patch.radiusPct !== undefined) setRadiusPct(patch.radiusPct)
        if (patch.shadow !== undefined) setShadow(patch.shadow)
        restyleFramedPhotos(next)
    }, [shape, radiusPct, shadow, restyleFramedPhotos])

    // Apply a backdrop colour/gradient to the canvas immediately (independent of
    // the layout). `null` clears it.
    const applyBackdrop = useCallback((backdrop) => {
        if (!canvasEditor) return
        applyCollageBackground(canvasEditor, backdrop, project)
        setActiveBackdrop(backdrop)
        canvasEditor.__pushHistoryState?.({ label: backdrop ? 'Set collage background' : 'Cleared collage background', domain: 'collage' })
        canvasEditor.__saveCanvasState?.()
    }, [canvasEditor, project])

    // Pick a one-click preset: set the photo style AND its paired backdrop.
    const applyStylePreset = useCallback((preset) => {
        setSelectedStyle(preset.id)
        setShape(preset.shape)
        setRadiusPct(preset.radiusPct)
        setShadow(preset.shadow)
        restyleFramedPhotos({ shape: preset.shape, radiusPct: preset.radiusPct, shadow: preset.shadow })
        if (preset.backdrop) applyBackdrop(preset.backdrop)
    }, [restyleFramedPhotos, applyBackdrop])

    // Sample the dominant colour of each framed/visible photo so the generated
    // background harmonises with them ("fit the photos").
    const samplePhotoColors = useCallback(async () => {
        const images = (canvasEditor?.getObjects?.().filter(isVisibleImage) || []).slice(0, 4)
        const colors = []
        for (const img of images) {
            const src = img.getSrc?.() || img._originalElement?.src
            if (!src || src.startsWith('blob:')) continue
            try {
                const c = await fac.getColorAsync(src, { algorithm: 'dominant', crossOrigin: 'anonymous' })
                if (c?.hex) colors.push(c.hex)
            } catch {
                /* tainted/unreachable source — skip it */
            }
        }
        if (colors.length === 0 && dominantColor) colors.push(dominantColor)
        return colors
    }, [canvasEditor, dominantColor])

    // Shared core: generate a decorative background from a final prompt and set
    // it on the canvas (handles busy state, history, and user-facing toasts).
    const applyGeneratedBackground = useCallback(async (finalPrompt, { busyKey = 'ai', label = 'AI' } = {}) => {
        if (!canvasEditor) return false
        setGeneratingTheme(busyKey)
        setProcessingMessage?.(`Generating ${String(label).toLowerCase()} background...`)
        try {
            const response = await fetch('/api/ai/background', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: finalPrompt, raw: true }),
            })
            if (!response.ok) {
                const data = await response.json().catch(() => ({}))
                throw new Error(data.error || `HTTP ${response.status}`)
            }
            const data = await response.json()
            if (!data?.imageUrl) throw new Error('No image returned')

            setProcessingMessage?.('Applying background...')
            await applyCanvasSizedBackground(canvasEditor, FabricImage, data.imageUrl, project)
            setActiveBackdrop(null)
            canvasEditor.__pushHistoryState?.({ label: 'Generated collage background', detail: label, domain: 'collage' })
            canvasEditor.__saveCanvasState?.()
            toast.success(`${label} background applied`)
            return true
        } catch (error) {
            console.warn('[collage] background generation failed:', error)
            const msg = String(error?.message || '')
            toast.error(
                /rate limit|429/i.test(msg) ? 'AI is busy — try again in a minute.'
                    : /token|configured/i.test(msg) ? 'AI background is not configured.'
                        : 'Could not generate that background. Try another style.'
            )
            return false
        } finally {
            setGeneratingTheme(null)
            setProcessingMessage?.(null)
        }
    }, [canvasEditor, project, setProcessingMessage])

    // Generate a decorative background tuned to the photos for a named theme.
    const generateThemedBackground = useCallback(async (theme) => {
        if (generatingTheme) return false
        const colors = await samplePhotoColors()
        return applyGeneratedBackground(buildAiBackgroundPrompt(theme, colors), { busyKey: theme.id, label: theme.label })
    }, [generatingTheme, samplePhotoColors, applyGeneratedBackground])

    // Generate a CONTENT-AWARE background from a description the vision model
    // wrote for these specific photos (wrapped with palette + safety rules).
    const generateBackgroundFromPrompt = useCallback(async (decorative, label = 'AI') => {
        if (generatingTheme) return false
        const colors = await samplePhotoColors()
        return applyGeneratedBackground(wrapCollageBgPrompt(decorative, colors), { busyKey: 'custom', label })
    }, [generatingTheme, samplePhotoColors, applyGeneratedBackground])

    // Downscale each canvas photo to a small JPEG the vision model can SEE.
    // Tainted (cross-origin, no CORS) sources are skipped — the plan still runs
    // on whatever thumbnails succeed, and falls back to heuristics if none do.
    const buildThumbnails = useCallback(async (images, max = 6) => {
        const out = []
        for (const img of images.slice(0, max)) {
            const el = img._originalElement || img._element || img.getElement?.()
            const w = el?.naturalWidth || el?.width
            const h = el?.naturalHeight || el?.height
            if (!el || !w || !h) continue
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
    }, [])

    // Ask the vision model for templates that MATCH the photos. Maps the plan
    // into the gallery's recipe shape; falls back to the local heuristic set when
    // the model is unavailable. Returns the recipes it set.
    const requestAiTemplates = useCallback(async (directionOverride) => {
        const images = canvasEditor?.getObjects?.().filter(isVisibleImage) || []
        if (images.length < 2) return []
        const directionHint = directionOverride != null ? directionOverride : aiDirectionRef.current

        const heuristicFallback = () => {
            const recipes = generateTemplateRecipes(images.length, 6)
            setTemplateRecipes(recipes)
            setAiAnalysis(null)
            return recipes
        }

        // This run's ticket. Anything that resolves after a newer run started is
        // dropped rather than painted over the newer gallery.
        const run = planRunRef.current + 1
        planRunRef.current = run
        const isStale = () => planRunRef.current !== run
        planAbortRef.current?.abort()
        const controller = new AbortController()
        planAbortRef.current = controller

        const canvasAspect = (Number(project?.width) || 1) / (Number(project?.height) || 1)
        const cacheKey = collagePlanCacheKey({
            photoIds: images.map((img) => computePerceptualHash(img)?.hash || img.getSrc?.() || ''),
            directionHint,
            canvasAspect,
            recipeCount: 6,
        })
        const cached = readCollagePlan(cacheKey)
        if (cached) {
            // Same photos, same brief: the model would return the same templates.
            setTemplateRecipes(cached.recipes)
            setAiAnalysis(cached.analysis)
            return cached.recipes
        }

        setIsPlanning(true)
        try {
            const [thumbs, colors] = await Promise.all([buildThumbnails(images), samplePhotoColors()])
            if (thumbs.length === 0) return heuristicFallback()
            if (isStale()) return []

            const resp = await fetch('/api/ai/collage-plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    photos: thumbs,
                    photoCount: images.length,
                    palette: colors,
                    aspects: thumbs.map((t) => t.aspect),
                    canvasAspect,
                    recipeCount: 6,
                    directionHint,
                }),
            })
            if (!resp.ok) return heuristicFallback()
            const data = await resp.json()
            if (isStale()) return []
            const planRecipes = Array.isArray(data?.recipes) ? data.recipes : []
            if (data?.source !== 'gemini' || planRecipes.length === 0) return heuristicFallback()

            const analysis = data.analysis || null
            const palette = (analysis?.palette || colors || []).filter(Boolean)
            const previewFor = (r) => {
                if (r.backdrop) return backdropPreviewCss(r.backdrop)
                if (palette.length >= 2) return `linear-gradient(135deg, ${palette[0]}, ${palette[1]})`
                if (palette.length === 1) return palette[0]
                return '#eef1f5'
            }
            const mapped = planRecipes.map((r, index) => ({
                id: `${r.layoutId}-ai-${index}-${Math.random().toString(36).slice(2, 6)}`,
                label: r.label,
                direction: r.direction || '',
                layoutId: r.layoutId,
                gap: Number.isFinite(r.gap) ? r.gap : null,
                padding: Number.isFinite(r.padding) ? r.padding : null,
                style: r.style,
                backdrop: r.backdrop || null,
                theme: r.theme || null,
                bgPrompt: r.bgPrompt || null,
                rationale: r.rationale || '',
                isAi: Boolean(r.bgPrompt || r.theme),
                previewBg: previewFor(r),
            }))
            if (isStale()) return []
            setTemplateRecipes(mapped)
            setAiAnalysis(analysis)
            writeCollagePlan(cacheKey, { recipes: mapped, analysis })
            return mapped
        } catch (error) {
            if (error?.name === 'AbortError' || isStale()) return []
            console.warn('[collage] AI template plan failed:', error)
            return heuristicFallback()
        } finally {
            if (!isStale()) setIsPlanning(false)
        }
    }, [canvasEditor, project?.width, project?.height, buildThumbnails, samplePhotoColors])

    // One click: a vision model LOOKS at the photos, designs templates that match
    // their content, fills the gallery, and applies the best-fit one (layout +
    // style + a content-aware background). Falls back to a heuristic pick when the
    // model is unavailable.
    const autoTemplate = useCallback(async () => {
        if (!canvasEditor || generatingTheme || isPlanning) return
        const images = canvasEditor.getObjects().filter(isVisibleImage)
        if (images.length < 2) {
            toast.error('Add at least 2 photos to auto-generate a template')
            return
        }
        const recipes = await requestAiTemplates()
        const best = recipes[0]
        if (!best) {
            toast.error('Could not generate a template — try again')
            return
        }
        await applyRecipeRef.current?.(best)
    }, [canvasEditor, generatingTheme, isPlanning, requestAiTemplates])

    // (Re)generate the gallery — re-runs the vision matcher for fresh, content-fit
    // suggestions (heuristic fallback when the model is unavailable).
    const regenerateTemplates = useCallback(() => {
        if (imageCount < 2 || isPlanning) return
        requestAiTemplates()
    }, [imageCount, isPlanning, requestAiTemplates])

    // Instant heuristic suggestions; the vision planner runs only on Shuffle /
    // Auto-generate (opening the tool used to spend a model call and lock the panel).
    useEffect(() => {
        if (imageCount < 2) return
        setTemplateRecipes((current) => (current.length ? current : generateTemplateRecipes(imageCount, 6)))
    }, [imageCount])

    // Apply one generated template: layout + frame style + its backdrop (instant)
    // or AI theme (generated to fit the photos).
    const applyRecipe = useCallback(async (recipe) => {
        if (!canvasEditor || generatingTheme) return
        const images = canvasEditor.getObjects().filter(isVisibleImage)
        if (images.length < 2) {
            toast.error('Add at least 2 photos first')
            return
        }
        const nextStyle = recipe.style
        const nextGap = Number.isFinite(recipe.gap) ? recipe.gap : gap
        const nextPadding = Number.isFinite(recipe.padding) ? recipe.padding : padding
        setSelectedLayout(recipe.layoutId)
        setShape(nextStyle.shape)
        setRadiusPct(nextStyle.radiusPct)
        setShadow(nextStyle.shadow)
        setGap(nextGap)
        setPadding(nextPadding)

        const cells = computeCollageCells(
            { width: project?.width, height: project?.height },
            recipe.layoutId,
            nextGap,
            nextPadding,
        )
        canvasEditor.discardActiveObject()
        images.slice(0, cells.length).forEach((image, index) => fitImageToCell(image, cells[index], nextStyle))
        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.({ label: 'Applied stylish template', detail: recipe.label, domain: 'collage' })
        canvasEditor.__saveCanvasState?.()

        if (recipe.bgPrompt) {
            // Content-aware background the vision model wrote for THESE photos.
            toast.success(`${recipe.label} — generating background…`)
            await generateBackgroundFromPrompt(recipe.bgPrompt, recipe.label)
        } else if (recipe.theme) {
            const theme = AI_BG_THEMES.find((t) => t.id === recipe.theme)
            if (theme) {
                toast.success(`${recipe.label} — generating background…`)
                await generateThemedBackground(theme)
            }
        } else if (recipe.backdrop) {
            applyBackdrop(recipe.backdrop)
            toast.success(`${recipe.label} applied`)
        }
    }, [canvasEditor, generatingTheme, project?.width, project?.height, gap, padding, generateThemedBackground, generateBackgroundFromPrompt, applyBackdrop])

    // Keep the ref current so autoTemplate can invoke the latest applyRecipe
    // without creating a definition-order dependency cycle.
    useEffect(() => {
        applyRecipeRef.current = applyRecipe
    }, [applyRecipe])

    // Replace the selected cell's photo with an uploaded one, keeping the SAME
    // cell frame, shape and cover-fit so the collage stays intact.
    const onReplaceFileChange = useCallback(async (event) => {
        const file = event.target?.files?.[0]
        if (event.target) event.target.value = ''
        if (!file || !canvasEditor || !selectedPhoto) return
        const cell = selectedPhoto.phosmithCollageCell || cellFromClipPath(selectedPhoto)
        if (!cell) {
            toast.error('That photo is not part of a collage cell')
            return
        }
        setIsReplacing(true)
        const toastId = toast.loading('Replacing photo...')
        try {
            const newImage = await loadFabricImageFromFile(file, { maxEdge: workingEdgeForProject(project) })
            const index = canvasEditor.getObjects().indexOf(selectedPhoto)
            // Composer cells (shards, words, seams, prints) keep their exact shape.
            const shaped = cellFromImage(selectedPhoto)
            if (shaped && (shaped.kind !== 'rect' || shaped.maskClip)) {
                const photo = analyzeElement(sourceElement(newImage))
                placeImageInCell(newImage, shaped, photo, { shadow: selectedPhoto.shadow ? 0.45 : 0, S: Math.min(Number(project?.width) || 1000, Number(project?.height) || 1000) })
            } else {
                fitImageToCell(newImage, cell, { shape, radiusPct, shadow })
            }
            canvasEditor.remove(selectedPhoto)
            if (index >= 0 && typeof canvasEditor.insertAt === 'function') {
                canvasEditor.insertAt(Math.min(index, canvasEditor.getObjects().length), newImage)
            } else {
                canvasEditor.add(newImage)
            }
            canvasEditor.setActiveObject(newImage)
            canvasEditor.requestRenderAll()
            canvasEditor.__pushHistoryState?.({ label: 'Replaced collage photo', domain: 'collage' })
            canvasEditor.__saveCanvasState?.()
            setSelectedPhoto(newImage)
            toast.success('Photo replaced', { id: toastId })
        } catch (error) {
            console.warn('[collage] replace failed:', error)
            toast.error('Could not replace the photo', { id: toastId })
        } finally {
            setIsReplacing(false)
        }
    }, [canvasEditor, selectedPhoto, shape, radiusPct, shadow, project?.width, project?.height])

    // Jump to the Adjust tool with this photo selected to fine-tune it.
    const handleEditPhoto = useCallback(() => {
        if (!canvasEditor || !selectedPhoto) return
        canvasEditor.setActiveObject(selectedPhoto)
        canvasEditor.requestRenderAll()
        onToolChange?.('adjust')
    }, [canvasEditor, selectedPhoto, onToolChange])

    const layout = LAYOUTS.find(item => item.id === selectedLayout)
    const missingCount = Math.max(0, (layout?.cellCount || 0) - imageCount)
    const isGenerating = Boolean(generatingTheme) || isPlanning


    return (
        <div className="h-full flex flex-col hide-scrollbar" style={{ background: 'var(--bg-panel)' }}>
            <input
                ref={replaceInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={onReplaceFileChange}
            />
            <input
                ref={slotInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                aria-label="Add photos to collage slots"
                onChange={(e) => {
                    const files = Array.from(e.target.files || [])
                    e.target.value = ''
                    const first = pendingSlotRef.current
                    pendingSlotRef.current = null
                    fillSlots(files, first)
                }}
            />

            <CollageComposer
                canvasEditor={canvasEditor}
                project={project}
                imageCount={imageCount}
                busyElsewhere={Boolean(generatingTheme) || Boolean(processingMessage)}
                setProcessingMessage={setProcessingMessage}
            />

            <Section title="Auto Template" icon={Wand2}>
                <p className="mb-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {`AI looks at your ${imageCount} photo${imageCount === 1 ? '' : 's'}, designs a layout, style & background that match what they show, and applies the best fit.`}
                </p>
                <motion.button
                    type="button"
                    onClick={autoTemplate}
                    disabled={isGenerating || Boolean(processingMessage) || imageCount < 2}
                    whileTap={{ scale: 0.97 }}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)', color: '#ffffff', border: 'none', boxShadow: 'var(--shadow-glow)' }}
                >
                    {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                    {isGenerating ? 'Generating…' : 'Auto-generate Template'}
                </motion.button>
                {imageCount < 2 && (
                    <p className="mt-2 text-[10px]" style={{ color: 'var(--accent-warning)' }}>
                        ⚠ Add at least 2 photos to the canvas
                    </p>
                )}
            </Section>

            {imageCount >= 2 && (
                <TemplatesSection
                    aiAnalysis={aiAnalysis}
                    aiDirection={aiDirection}
                    applyRecipe={applyRecipe}
                    imageCount={imageCount}
                    isGenerating={isGenerating}
                    isPlanning={isPlanning}
                    processingMessage={processingMessage}
                    regenerateTemplates={regenerateTemplates}
                    requestAiTemplates={requestAiTemplates}
                    setAiDirection={setAiDirection}
                    templateRecipes={templateRecipes}
                />
            )}

            {selectedPhoto && (
                <Section title="Selected Photo" icon={Replace}>
                    <p className="mb-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        Swap this photo for another, or fine-tune it.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            onClick={() => replaceInputRef.current?.click()}
                            disabled={isReplacing}
                            className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-50"
                            style={{ background: 'var(--accent-primary)', color: '#ffffff', border: 'none' }}
                        >
                            {isReplacing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Replace className="w-3.5 h-3.5" />}
                            Replace
                        </button>
                        <button
                            type="button"
                            onClick={handleEditPhoto}
                            className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-xs font-medium editor-interactive"
                            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                        >
                            <SlidersHorizontal className="w-3.5 h-3.5" />
                            Edit
                        </button>
                    </div>
                </Section>
            )}

            <LayoutSection selectedLayout={selectedLayout} setSelectedLayout={setSelectedLayout} />

            <TemplateStyleSection applyStylePreset={applyStylePreset} selectedStyle={selectedStyle} />

            <BackgroundSection activeBackdrop={activeBackdrop} applyBackdrop={applyBackdrop} />

            <PhotoShapeSection
                radiusPct={radiusPct}
                shadow={shadow}
                shape={shape}
                updateStyle={updateStyle}
            />

            <AiBackgroundSection
                generateThemedBackground={generateThemedBackground}
                generatingTheme={generatingTheme}
                imageCount={imageCount}
                isGenerating={isGenerating}
                processingMessage={processingMessage}
            />

            <SpacingSection
                applyCellsToPhotos={applyCellsToPhotos}
                changeFitMode={changeFitMode}
                fitMode={fitMode}
                frameMode={frameMode}
                framePct={framePct}
                gap={gap}
                matte={matte}
                padding={padding}
                project={project}
                selectedLayout={selectedLayout}
                setFrameMode={setFrameMode}
                setFramePct={setFramePct}
                setGap={setGap}
                setMatte={setMatte}
                setPadding={setPadding}
                setSmartArrange={setSmartArrange}
                setWeights={setWeights}
                smartArrange={smartArrange}
                weightsRef={weightsRef}
            />

            <div className="p-4 mt-auto" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <p className="mb-2 text-[10px]" style={{ color: missingCount ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
                    {`${imageCount} visible image${imageCount === 1 ? '' : 's'}${missingCount > 0 ? ` · ${missingCount} frame${missingCount === 1 ? '' : 's'} will stay empty` : ' · ready to arrange'}`}
                </p>
                <motion.button
                    type="button"
                    onClick={applyLayout}
                    disabled={imageCount < 1}
                    whileTap={{ scale: 0.97 }}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                    style={{
                        background: 'var(--accent-primary)',
                        color: '#ffffff',
                    }}
                >
                    <LayoutGrid className="w-4 h-4" />
                    Apply Layout
                </motion.button>
            </div>
        </div>
    )
}
