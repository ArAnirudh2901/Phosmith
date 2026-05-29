"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import { FabricImage } from 'fabric'
import {
    PIXEL_MASK_OVERLAY_NAME,
    createMaskCanvas,
    createMaskClipPath,
    floodFillMask,
    getImageBitmapSize,
    getImageSourceElement,
    getMaskTargetImage,
    isMaskCanvasEmpty,
    isPixxelMaskOverlay,
    maskCanvasFromClipPath,
    maskFromImageAlpha,
    paintOverlayFromMask,
    pointToImageSpace,
    isPointInImage,
    stampMask,
    strokeMaskSegment,
} from '@/lib/canvas-mask'

export const MIN_BRUSH = 1
export const MAX_BRUSH = 400
export const DEFAULT_BRUSH_SIZE = 36
export const MASK_EMPTY_THRESHOLD = 250
const MAX_HISTORY = 40
const BRACKET_STEP = 4

const isMaskOverlay = (obj) => isPixxelMaskOverlay(obj)

const isTypingTarget = () => {
    if (typeof document === 'undefined') return false
    const el = document.activeElement
    if (!el) return false
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    return Boolean(el.isContentEditable)
}

const commitMaskChange = (canvasEditor, img) => {
    if (!canvasEditor) return
    img?.set?.('dirty', true)
    if (img) canvasEditor.fire?.('object:modified', { target: img })
    canvasEditor.requestRenderAll()
    canvasEditor.__pushHistoryState?.()
    canvasEditor.__saveCanvasState?.()
}

/**
 * usePixelMaskTool — the shared painting engine behind both the Mask and Erase
 * tools. It owns all brush state, wires canvas pointer events, draws the live
 * on-canvas brush cursor, manages an undo/redo stack, and keeps the per-image
 * `_pixxelMaskCanvas` → Fabric clipPath in sync (so transparency survives
 * save/export). Each tool renders its own controls bound to the returned state.
 *
 * @param {object}  opts
 * @param {any}     opts.canvasEditor   Fabric canvas instance.
 * @param {string}  opts.defaultMode    'erase' | 'restore'
 * @param {boolean} opts.supportsMagic  Enable click-to-flood (magic eraser).
 */
export default function usePixelMaskTool({ canvasEditor, defaultMode = 'erase', supportsMagic = false }) {
    const [mode, setMode] = useState(defaultMode)
    const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE)
    const [hardness, setHardness] = useState(85)
    const [flow, setFlow] = useState(100)
    const [feather, setFeather] = useState(0)
    const [magic, setMagic] = useState(false)
    const [tolerance, setTolerance] = useState(24)
    const [altActive, setAltActive] = useState(false)

    const [ready, setReady] = useState(false)
    const [hasMask, setHasMask] = useState(false)
    const [undoDepth, setUndoDepth] = useState(0)
    const [redoDepth, setRedoDepth] = useState(0)

    const modeRef = useRef(mode)
    const brushSizeRef = useRef(brushSize)
    const hardnessRef = useRef(hardness)
    const flowRef = useRef(flow)
    const featherRef = useRef(feather)
    const magicRef = useRef(magic)
    const toleranceRef = useRef(tolerance)
    const altRef = useRef(false)

    const maskCanvasRef = useRef(null)
    const overlayCanvasRef = useRef(null)
    const overlayImageRef = useRef(null)
    const targetImageRef = useRef(null)
    const isDrawingRef = useRef(false)
    const lastPointRef = useRef(null)
    const undoStackRef = useRef([])
    const redoStackRef = useRef([])
    const interactionStateRef = useRef(null)

    const cursorElRef = useRef(null)
    const cursorInnerElRef = useRef(null)
    const lastClientRef = useRef(null)
    const overCanvasRef = useRef(false)

    const readyRef = useRef(false)
    const hasMaskRef = useRef(false)
    const featherFirstRef = useRef(true)
    const featherCommitTimerRef = useRef(null)
    const liveSyncRafRef = useRef(null)
    const reattachRafRef = useRef(null)
    const spaceRef = useRef(false)

    useEffect(() => { readyRef.current = ready }, [ready])
    useEffect(() => { hasMaskRef.current = hasMask }, [hasMask])
    useEffect(() => { modeRef.current = mode }, [mode])
    useEffect(() => { brushSizeRef.current = brushSize }, [brushSize])
    useEffect(() => { hardnessRef.current = hardness }, [hardness])
    useEffect(() => { flowRef.current = flow }, [flow])
    useEffect(() => { featherRef.current = feather }, [feather])
    useEffect(() => { magicRef.current = magic }, [magic])
    useEffect(() => { toleranceRef.current = tolerance }, [tolerance])

    const effectiveMode = useCallback(() => {
        const base = modeRef.current
        if (!altRef.current) return base
        return base === 'erase' ? 'restore' : 'erase'
    }, [])

    /* ─── mask canvas / overlay management ─── */

    const ensureMaskCanvas = useCallback((img) => {
        if (!img) return null
        const { width, height } = getImageBitmapSize(img)

        let maskCanvas = null
        const attached = img._pixxelMaskCanvas
        if (attached?.width === width && attached?.height === height) {
            maskCanvas = attached
        } else if (
            targetImageRef.current === img &&
            maskCanvasRef.current?.width === width &&
            maskCanvasRef.current?.height === height
        ) {
            maskCanvas = maskCanvasRef.current
        } else {
            maskCanvas = maskCanvasFromClipPath(img.clipPath, width, height) || createMaskCanvas(width, height)
        }

        img._pixxelMaskCanvas = maskCanvas
        maskCanvasRef.current = maskCanvas

        if (
            !overlayCanvasRef.current ||
            overlayCanvasRef.current.width !== width ||
            overlayCanvasRef.current.height !== height
        ) {
            overlayCanvasRef.current = createMaskCanvas(width, height, 'rgba(0,0,0,0)')
        }

        targetImageRef.current = img
        return maskCanvas
    }, [])

    const removeOverlay = useCallback(({ render = true } = {}) => {
        if (!canvasEditor) return
        const stale = canvasEditor.getObjects?.().filter(isMaskOverlay) || []
        for (const overlay of stale) canvasEditor.remove(overlay)
        overlayImageRef.current = null
        if (render) canvasEditor.requestRenderAll()
    }, [canvasEditor])

    const updateOverlay = useCallback((img, maskCanvas) => {
        if (!canvasEditor || !img || !maskCanvas) return
        const overlayCanvas = overlayCanvasRef.current
        if (!overlayCanvas) return

        paintOverlayFromMask(maskCanvas, overlayCanvas, { threshold: MASK_EMPTY_THRESHOLD })

        const geometry = {
            left: img.left,
            top: img.top,
            scaleX: img.scaleX,
            scaleY: img.scaleY,
            angle: img.angle,
            originX: img.originX,
            originY: img.originY,
            flipX: img.flipX,
            flipY: img.flipY,
            skewX: img.skewX,
            skewY: img.skewY,
            width: img.width,
            height: img.height,
            selectable: false,
            evented: false,
            hasControls: false,
            hasBorders: false,
            objectCaching: false,
            excludeFromExport: true,
            opacity: 1,
            name: PIXEL_MASK_OVERLAY_NAME,
            pixxelMaskOverlay: true,
            _pixxelMaskOverlay: true,
        }

        let overlayImg = overlayImageRef.current
        if (!overlayImg || !canvasEditor.getObjects?.().includes(overlayImg)) {
            overlayImg = new FabricImage(overlayCanvas, geometry)
            overlayImageRef.current = overlayImg
            canvasEditor.add(overlayImg)
        } else {
            overlayImg.set(geometry)
            overlayImg.set('dirty', true)
        }

        const imageIndex = canvasEditor.getObjects?.().indexOf(img) ?? -1
        if (imageIndex >= 0 && typeof canvasEditor.moveObjectTo === 'function') {
            canvasEditor.moveObjectTo(overlayImg, imageIndex + 1)
        }
    }, [canvasEditor])

    const syncMaskToImage = useCallback((img, { showOverlay = true } = {}) => {
        if (!canvasEditor || !img) return
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return

        const empty = isMaskCanvasEmpty(maskCanvas, MASK_EMPTY_THRESHOLD)
        setHasMask(!empty)

        if (empty) {
            img.clipPath = undefined
            img._pixxelHasMask = false
            img.pixxelHasMask = false
            removeOverlay({ render: false })
            canvasEditor.requestRenderAll()
            return
        }

        const clipImg = createMaskClipPath(FabricImage, maskCanvas, { feather: featherRef.current })
        img.clipPath = clipImg
        img._pixxelHasMask = true
        img.pixxelHasMask = true
        img._pixxelMaskCanvas = maskCanvas
        img.pixxelMaskFeather = featherRef.current
        img._pixxelMaskFeather = featherRef.current
        img.set?.('dirty', true)
        img.setCoords?.()

        if (showOverlay) updateOverlay(img, maskCanvas)
        canvasEditor.requestRenderAll()
    }, [canvasEditor, removeOverlay, updateOverlay])

    /* ─── undo / redo ─── */

    const snapshot = useCallback(() => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return null
        const ctx = maskCanvas.getContext('2d')
        return ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
    }, [])

    const pushUndo = useCallback(() => {
        const snap = snapshot()
        if (!snap) return
        undoStackRef.current.push(snap)
        if (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift()
        redoStackRef.current = []
        setUndoDepth(undoStackRef.current.length)
        setRedoDepth(0)
    }, [snapshot])

    const applySnapshot = useCallback((snap) => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas || !snap) return
        maskCanvas.getContext('2d').putImageData(snap, 0, 0)
    }, [])

    const undo = useCallback(() => {
        if (undoStackRef.current.length === 0) return false
        const current = snapshot()
        const prev = undoStackRef.current.pop()
        if (current) redoStackRef.current.push(current)
        applySnapshot(prev)
        setUndoDepth(undoStackRef.current.length)
        setRedoDepth(redoStackRef.current.length)
        syncMaskToImage(targetImageRef.current)
        commitMaskChange(canvasEditor, targetImageRef.current)
        return true
    }, [snapshot, applySnapshot, syncMaskToImage, canvasEditor])

    const redo = useCallback(() => {
        if (redoStackRef.current.length === 0) return false
        const current = snapshot()
        const next = redoStackRef.current.pop()
        if (current) undoStackRef.current.push(current)
        applySnapshot(next)
        setUndoDepth(undoStackRef.current.length)
        setRedoDepth(redoStackRef.current.length)
        syncMaskToImage(targetImageRef.current)
        commitMaskChange(canvasEditor, targetImageRef.current)
        return true
    }, [snapshot, applySnapshot, syncMaskToImage, canvasEditor])

    /* ─── high-level actions ─── */

    const invert = useCallback(() => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return
        pushUndo()
        const ctx = maskCanvas.getContext('2d')
        const data = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
        for (let i = 0; i < data.data.length; i += 4) {
            const next = 255 - data.data[i]
            data.data[i] = next
            data.data[i + 1] = next
            data.data[i + 2] = next
            data.data[i + 3] = 255
        }
        ctx.putImageData(data, 0, 0)
        syncMaskToImage(targetImageRef.current)
        commitMaskChange(canvasEditor, targetImageRef.current)
    }, [pushUndo, syncMaskToImage, canvasEditor])

    const clear = useCallback(() => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return
        pushUndo()
        const ctx = maskCanvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height)
        if (targetImageRef.current) {
            targetImageRef.current.clipPath = undefined
            targetImageRef.current._pixxelHasMask = false
            targetImageRef.current.pixxelHasMask = false
        }
        removeOverlay()
        setHasMask(false)
        syncMaskToImage(targetImageRef.current, { showOverlay: false })
        commitMaskChange(canvasEditor, targetImageRef.current)
    }, [pushUndo, removeOverlay, syncMaskToImage, canvasEditor])

    /**
     * Replace the mask with one derived from a source element's alpha channel
     * (AI auto-erase). The original image is untouched, so the Restore brush can
     * bring the background back.
     */
    const applyAlphaMask = useCallback((sourceEl, { invert: invertAlpha = false } = {}) => {
        const img = targetImageRef.current
        const maskCanvas = maskCanvasRef.current
        if (!img || !maskCanvas || !sourceEl) return false
        const { width, height } = getImageBitmapSize(img)
        const derived = maskFromImageAlpha(sourceEl, width, height, { invert: invertAlpha })
        if (!derived) return false

        pushUndo()
        const ctx = maskCanvas.getContext('2d')
        ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
        ctx.drawImage(derived, 0, 0, maskCanvas.width, maskCanvas.height)
        syncMaskToImage(img)
        commitMaskChange(canvasEditor, img)
        return true
    }, [pushUndo, syncMaskToImage, canvasEditor])

    /* ─── live brush cursor ─── */

    const styleCursor = useCallback(() => {
        const el = cursorElRef.current
        const inner = cursorInnerElRef.current
        if (!el || !inner) return
        const img = targetImageRef.current
        // Use the geometric mean of both axis scales so the ring stays an honest
        // average diameter on non-uniformly stretched images (Resize sets scaleX
        // and scaleY independently).
        const sx = img ? Math.abs(img.scaleX || 1) : 1
        const sy = img ? Math.abs(img.scaleY || 1) : 1
        const scale = Math.sqrt(sx * sy)
        const zoom = canvasEditor?.getZoom?.() || 1
        const diameter = Math.max(6, brushSizeRef.current * scale * zoom)
        const mEff = effectiveMode()
        const rgb = mEff === 'erase' ? '220, 60, 80' : '90, 220, 150'

        el.style.width = `${diameter}px`
        el.style.height = `${diameter}px`
        el.style.borderColor = `rgba(${rgb}, 0.95)`
        el.style.background = `rgba(${rgb}, 0.08)`
        el.style.boxShadow = `0 0 0 1px rgba(0,0,0,0.45), 0 0 12px rgba(${rgb}, 0.35)`

        const innerD = Math.max(0, diameter * (hardnessRef.current / 100))
        inner.style.width = `${innerD}px`
        inner.style.height = `${innerD}px`
        inner.style.display = innerD > 4 && innerD < diameter - 2 ? 'block' : 'none'
    }, [canvasEditor, effectiveMode])

    const positionCursor = useCallback((clientX, clientY) => {
        const el = cursorElRef.current
        if (!el) return
        el.style.left = `${clientX}px`
        el.style.top = `${clientY}px`
    }, [])

    const setCursorVisible = useCallback((visible) => {
        const el = cursorElRef.current
        if (el) el.style.display = visible ? 'block' : 'none'
    }, [])

    /* ─── painting ─── */

    const getScenePoint = useCallback((event) => {
        if (!canvasEditor || !event) return null
        if (typeof canvasEditor.getScenePoint === 'function') return canvasEditor.getScenePoint(event)
        const pointer = canvasEditor.getPointer?.(event, true)
        return pointer ? { x: pointer.x, y: pointer.y } : null
    }, [canvasEditor])

    const brushAt = useCallback((x, y) => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return
        stampMask(maskCanvas.getContext('2d'), x, y, {
            radius: Math.max(0.5, brushSizeRef.current / 2),
            hardness: hardnessRef.current / 100,
            flow: flowRef.current / 100,
            mode: effectiveMode(),
        })
    }, [effectiveMode])

    const strokeTo = useCallback((x1, y1, x2, y2) => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return
        strokeMaskSegment(maskCanvas, x1, y1, x2, y2, {
            radius: Math.max(0.5, brushSizeRef.current / 2),
            hardness: hardnessRef.current / 100,
            flow: flowRef.current / 100,
            mode: effectiveMode(),
        })
    }, [effectiveMode])

    /* ─── live (in-stroke) sync ───
     * During an active stroke we run a CHEAP rebuild, coalesced to one per animation
     * frame: a crisp (un-feathered) clip + overlay, skipping the full-image emptiness
     * scan and the Gaussian feather blur. The full sync (with feather + emptiness)
     * runs once on mouse:up. This keeps brushing smooth on large images where a full
     * rebuild on every mouse:move was unusable. */
    const liveSync = useCallback((img) => {
        if (!canvasEditor || !img) return
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return
        img.clipPath = createMaskClipPath(FabricImage, maskCanvas, { feather: 0 })
        img._pixxelHasMask = true
        img.pixxelHasMask = true
        img._pixxelMaskCanvas = maskCanvas
        img.set?.('dirty', true)
        img.setCoords?.()
        if (!hasMaskRef.current) setHasMask(true)
        updateOverlay(img, maskCanvas)
        canvasEditor.requestRenderAll()
    }, [canvasEditor, updateOverlay])

    const scheduleLiveSync = useCallback((img) => {
        if (liveSyncRafRef.current) return
        liveSyncRafRef.current = requestAnimationFrame(() => {
            liveSyncRafRef.current = null
            liveSync(img)
        })
    }, [liveSync])

    /* ─── canvas lock / unlock (disable selection while painting) ─── */

    const lockCanvas = useCallback((canvas, targetImage) => {
        if (!canvas || interactionStateRef.current) return
        const objects = canvas.getObjects?.() || []
        interactionStateRef.current = {
            activeObject: targetImage,
            selection: canvas.selection,
            skipTargetFind: canvas.skipTargetFind,
            defaultCursor: canvas.defaultCursor,
            hoverCursor: canvas.hoverCursor,
            moveCursor: canvas.moveCursor,
            isDrawingMode: canvas.isDrawingMode,
            objectStates: objects.map((obj) => ({
                obj,
                selectable: obj.selectable,
                evented: obj.evented,
                hoverCursor: obj.hoverCursor,
                moveCursor: obj.moveCursor,
            })),
        }

        canvas.discardActiveObject?.()
        canvas.__pixelToolActive = true
        canvas.selection = false
        canvas.skipTargetFind = true
        canvas.isDrawingMode = false
        canvas.defaultCursor = 'crosshair'
        canvas.hoverCursor = 'crosshair'
        canvas.moveCursor = 'crosshair'
        if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = 'crosshair'

        for (const obj of objects) {
            if (isMaskOverlay(obj)) continue
            obj.set?.({ selectable: false, evented: false, hoverCursor: 'crosshair', moveCursor: 'crosshair' })
        }
        canvas.requestRenderAll()
    }, [])

    const unlockCanvas = useCallback((canvas) => {
        const state = interactionStateRef.current
        if (!canvas || !state) return

        canvas.selection = state.selection
        canvas.skipTargetFind = state.skipTargetFind
        canvas.defaultCursor = state.defaultCursor
        canvas.hoverCursor = state.hoverCursor
        canvas.moveCursor = state.moveCursor
        canvas.isDrawingMode = state.isDrawingMode

        for (const item of state.objectStates) {
            if (!canvas.getObjects?.().includes(item.obj)) continue
            item.obj.set?.({
                selectable: item.selectable,
                evented: item.evented,
                hoverCursor: item.hoverCursor,
                moveCursor: item.moveCursor,
            })
        }

        canvas.__pixelToolActive = false
        if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = state.defaultCursor || 'default'
        canvas.discardActiveObject?.()
        if (state.activeObject && canvas.getObjects?.().includes(state.activeObject)) {
            try { canvas.setActiveObject(state.activeObject) } catch { /* no longer selectable */ }
        }
        canvas.requestRenderAll()
        interactionStateRef.current = null
    }, [])

    /* ─── main wiring effect (binds once per canvas) ─── */

    useEffect(() => {
        if (!canvasEditor) {
            setReady(false)
            return undefined
        }

        const targetImage = getMaskTargetImage(canvasEditor)
        if (!targetImage) {
            setReady(false)
            return undefined
        }

        ensureMaskCanvas(targetImage)
        // Seed feather from any previously-stored value so reopening the tool on a
        // soft-edged mask shows the right slider position and rebuilds soft edges.
        const storedFeather = Math.max(0, Math.round(targetImage.pixxelMaskFeather || targetImage._pixxelMaskFeather || 0))
        featherRef.current = storedFeather
        setFeather(storedFeather)
        // Restore any undo/redo history stashed on this image from a previous visit,
        // so switching tools and back doesn't silently discard the stack.
        undoStackRef.current = Array.isArray(targetImage._pixxelUndoStack) ? targetImage._pixxelUndoStack : []
        redoStackRef.current = Array.isArray(targetImage._pixxelRedoStack) ? targetImage._pixxelRedoStack : []
        setUndoDepth(undoStackRef.current.length)
        setRedoDepth(redoStackRef.current.length)
        lockCanvas(canvasEditor, targetImage)
        syncMaskToImage(targetImage)
        setReady(true)

        // Build the floating brush-cursor ring (outer ring + inner hardness ring).
        const cursorEl = document.createElement('div')
        cursorEl.className = 'pixxel-brush-cursor'
        const innerEl = document.createElement('div')
        innerEl.className = 'pixxel-brush-cursor-inner'
        cursorEl.appendChild(innerEl)
        document.body.appendChild(cursorEl)
        cursorElRef.current = cursorEl
        cursorInnerElRef.current = innerEl

        const pointInCanvas = (clientX, clientY) => {
            const el = canvasEditor.upperCanvasEl
            if (!el) return false
            const rect = el.getBoundingClientRect()
            return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
        }

        const applyCanvasCursor = () => {
            const el = canvasEditor.upperCanvasEl
            if (!el) return
            // Hide the system cursor under the ring for the brush; show a crosshair
            // for the magic-eraser click mode (no meaningful brush size there).
            el.style.cursor = magicRef.current ? 'crosshair' : (overCanvasRef.current ? 'none' : 'crosshair')
        }

        const onWindowMouseMove = (e) => {
            const inside = pointInCanvas(e.clientX, e.clientY)
            overCanvasRef.current = inside
            lastClientRef.current = { x: e.clientX, y: e.clientY }
            applyCanvasCursor()
            if (inside && !magicRef.current) {
                positionCursor(e.clientX, e.clientY)
                styleCursor()
                setCursorVisible(true)
            } else {
                setCursorVisible(false)
            }
        }

        const onModifierKeyDown = (e) => {
            if (e.key === 'Alt' && !altRef.current) {
                altRef.current = true
                setAltActive(true)
                styleCursor()
            } else if (e.key === ' ') {
                // Space = temporary pan; suppress painting (canvas.jsx owns the pan).
                spaceRef.current = true
            }
        }
        const onModifierKeyUp = (e) => {
            if (e.key === 'Alt') {
                altRef.current = false
                setAltActive(false)
                styleCursor()
            } else if (e.key === ' ') {
                spaceRef.current = false
            }
        }

        // Window blur / tab switch can swallow the keyup, leaving Alt or Space
        // "stuck". Reset modifier state and restore the cursor when focus is lost.
        const resetModifiers = () => {
            if (altRef.current) {
                altRef.current = false
                setAltActive(false)
            }
            spaceRef.current = false
            overCanvasRef.current = false
            setCursorVisible(false)
            const el = canvasEditor.upperCanvasEl
            if (el) el.style.cursor = 'crosshair'
        }
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') resetModifiers()
        }

        const onBracketKey = (e) => {
            if (e.key !== '[' && e.key !== ']' && e.key !== '{' && e.key !== '}') return
            if (isTypingTarget()) return
            if (e.metaKey || e.ctrlKey || e.altKey) return
            e.preventDefault()
            const big = e.key === '{' || e.key === '}'
            const dir = e.key === '[' || e.key === '{' ? -1 : 1
            const step = (big ? BRACKET_STEP * 4 : BRACKET_STEP) * dir
            setBrushSize((value) => Math.max(MIN_BRUSH, Math.min(MAX_BRUSH, value + step)))
        }

        /* magic-eraser click */
        const doMagic = (local) => {
            const maskCanvas = maskCanvasRef.current
            const img = targetImageRef.current
            if (!maskCanvas || !img) return
            const sourceEl = getImageSourceElement(img)
            if (!sourceEl) return
            // Snapshot BEFORE mutating, but only commit it to the undo stack (and clear
            // redo) if the flood actually changed something — a no-op click must not
            // wipe the redo stack.
            const before = snapshot()
            const affected = floodFillMask(maskCanvas, sourceEl, local.x, local.y, {
                tolerance: toleranceRef.current,
                mode: effectiveMode(),
            })
            if (affected > 0) {
                if (before) {
                    undoStackRef.current.push(before)
                    if (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift()
                    redoStackRef.current = []
                    setUndoDepth(undoStackRef.current.length)
                    setRedoDepth(0)
                }
                syncMaskToImage(img)
                commitMaskChange(canvasEditor, img)
            }
        }

        const localFromEvent = (e) => pointToImageSpace(targetImageRef.current, getScenePoint(e))

        const onMouseDown = (opt) => {
            if (!opt?.e) return
            // Let Space / middle-button pan the canvas without painting (Photoshop-style).
            if (spaceRef.current || opt.e.button === 1 || opt.e.buttons === 4) return
            if (opt.e.button != null && opt.e.button !== 0) return
            const local = localFromEvent(opt.e)
            if (!isPointInImage(local, targetImageRef.current)) {
                lastPointRef.current = null
                return
            }
            opt.e.preventDefault?.()
            opt.e.stopPropagation?.()

            if (magicRef.current) {
                doMagic(local)
                return
            }

            pushUndo()
            isDrawingRef.current = true
            lastPointRef.current = local
            brushAt(local.x, local.y)
            scheduleLiveSync(targetImageRef.current)
        }

        const onMouseMove = (opt) => {
            if (!isDrawingRef.current || !opt?.e) return
            if (spaceRef.current) return
            const local = localFromEvent(opt.e)
            if (!isPointInImage(local, targetImageRef.current)) {
                lastPointRef.current = null
                return
            }
            opt.e.preventDefault?.()
            opt.e.stopPropagation?.()
            if (lastPointRef.current) {
                strokeTo(lastPointRef.current.x, lastPointRef.current.y, local.x, local.y)
            } else {
                brushAt(local.x, local.y)
            }
            lastPointRef.current = local
            scheduleLiveSync(targetImageRef.current)
        }

        const onMouseUp = () => {
            if (!isDrawingRef.current) return
            isDrawingRef.current = false
            lastPointRef.current = null
            // Cancel any pending cheap frame and run the full sync (feather + emptiness
            // check + overlay) once, then commit to history.
            if (liveSyncRafRef.current) {
                cancelAnimationFrame(liveSyncRafRef.current)
                liveSyncRafRef.current = null
            }
            syncMaskToImage(targetImageRef.current)
            commitMaskChange(canvasEditor, targetImageRef.current)
        }

        // Restore the system cursor when the pointer leaves the canvas by a path
        // that doesn't fire a window mousemove (e.g. straight onto browser chrome),
        // so 'cursor:none' never gets stuck.
        const onCanvasMouseLeave = () => {
            overCanvasRef.current = false
            setCursorVisible(false)
            const el = canvasEditor.upperCanvasEl
            if (el) el.style.cursor = 'crosshair'
        }

        // A global history restore (Cmd+Z → loadFromJSON) replaces every object with
        // brand-new instances. The effect's deps don't change, so we'd keep painting
        // into an orphaned image. Re-resolve the target whenever our image leaves the
        // canvas, re-seeding the mask + stacks from the freshly-restored image.
        const handleObjectsChanged = () => {
            if (reattachRafRef.current) return
            reattachRafRef.current = requestAnimationFrame(() => {
                reattachRafRef.current = null
                const current = targetImageRef.current
                if (current && canvasEditor.getObjects?.().includes(current)) return
                const next = getMaskTargetImage(canvasEditor)
                if (!next) {
                    setReady(false)
                    return
                }
                ensureMaskCanvas(next)
                undoStackRef.current = Array.isArray(next._pixxelUndoStack) ? next._pixxelUndoStack : []
                redoStackRef.current = Array.isArray(next._pixxelRedoStack) ? next._pixxelRedoStack : []
                setUndoDepth(undoStackRef.current.length)
                setRedoDepth(redoStackRef.current.length)
                const f = Math.max(0, Math.round(next.pixxelMaskFeather || next._pixxelMaskFeather || 0))
                featherRef.current = f
                setFeather(f)
                lockCanvas(canvasEditor, next)
                syncMaskToImage(next)
                setReady(true)
            })
        }

        // Route the tool's Cmd+Z/Cmd+Shift+Z to its own per-stroke stack first; fall
        // back to the global canvas history only when the local stack is exhausted.
        const onMaskUndo = () => {
            if (undoStackRef.current.length > 0) undo()
            else canvasEditor.__undoCanvasState?.()
        }
        const onMaskRedo = () => {
            if (redoStackRef.current.length > 0) redo()
            else canvasEditor.__redoCanvasState?.()
        }

        canvasEditor.on('mouse:down', onMouseDown)
        canvasEditor.on('mouse:move', onMouseMove)
        canvasEditor.on('mouse:up', onMouseUp)
        canvasEditor.on('object:removed', handleObjectsChanged)
        canvasEditor.on('object:added', handleObjectsChanged)
        canvasEditor.upperCanvasEl?.addEventListener('mouseleave', onCanvasMouseLeave)
        window.addEventListener('mousemove', onWindowMouseMove)
        window.addEventListener('keydown', onModifierKeyDown)
        window.addEventListener('keyup', onModifierKeyUp)
        window.addEventListener('keydown', onBracketKey)
        window.addEventListener('blur', resetModifiers)
        document.addEventListener('visibilitychange', onVisibilityChange)
        window.addEventListener('pixxel:mask-undo', onMaskUndo)
        window.addEventListener('pixxel:mask-redo', onMaskRedo)

        // Expose live updaters so param-change effects can restyle the cursor.
        cursorElRef.current.__restyle = styleCursor
        cursorElRef.current.__applyCanvasCursor = applyCanvasCursor

        return () => {
            isDrawingRef.current = false
            lastPointRef.current = null
            if (liveSyncRafRef.current) { cancelAnimationFrame(liveSyncRafRef.current); liveSyncRafRef.current = null }
            if (reattachRafRef.current) { cancelAnimationFrame(reattachRafRef.current); reattachRafRef.current = null }
            // Stash the local undo/redo stacks on the image so re-entering the tool
            // (or switching Erase↔Mask) keeps the history.
            const stashImg = targetImageRef.current
            if (stashImg && canvasEditor.getObjects?.().includes(stashImg)) {
                stashImg._pixxelUndoStack = undoStackRef.current
                stashImg._pixxelRedoStack = redoStackRef.current
            }
            canvasEditor.off('mouse:down', onMouseDown)
            canvasEditor.off('mouse:move', onMouseMove)
            canvasEditor.off('mouse:up', onMouseUp)
            canvasEditor.off('object:removed', handleObjectsChanged)
            canvasEditor.off('object:added', handleObjectsChanged)
            canvasEditor.upperCanvasEl?.removeEventListener('mouseleave', onCanvasMouseLeave)
            window.removeEventListener('mousemove', onWindowMouseMove)
            window.removeEventListener('keydown', onModifierKeyDown)
            window.removeEventListener('keyup', onModifierKeyUp)
            window.removeEventListener('keydown', onBracketKey)
            window.removeEventListener('blur', resetModifiers)
            document.removeEventListener('visibilitychange', onVisibilityChange)
            window.removeEventListener('pixxel:mask-undo', onMaskUndo)
            window.removeEventListener('pixxel:mask-redo', onMaskRedo)
            removeOverlay({ render: false })
            unlockCanvas(canvasEditor)
            if (cursorElRef.current?.parentNode) cursorElRef.current.parentNode.removeChild(cursorElRef.current)
            cursorElRef.current = null
            cursorInnerElRef.current = null
            altRef.current = false
            spaceRef.current = false
        }
    }, [
        canvasEditor,
        ensureMaskCanvas,
        lockCanvas,
        unlockCanvas,
        syncMaskToImage,
        removeOverlay,
        getScenePoint,
        brushAt,
        strokeTo,
        pushUndo,
        snapshot,
        undo,
        redo,
        scheduleLiveSync,
        styleCursor,
        positionCursor,
        setCursorVisible,
        effectiveMode,
    ])

    // Restyle the floating cursor whenever brush params change (without moving
    // the mouse) and re-apply the canvas cursor when toggling magic mode.
    useEffect(() => {
        cursorElRef.current?.__restyle?.()
        cursorElRef.current?.__applyCanvasCursor?.()
        if (!magic && overCanvasRef.current && lastClientRef.current) {
            positionCursor(lastClientRef.current.x, lastClientRef.current.y)
            setCursorVisible(true)
        } else if (magic) {
            setCursorVisible(false)
        }
    }, [brushSize, hardness, mode, magic, altActive, positionCursor, setCursorVisible])

    // Re-sync clip edges when feather changes. The clip is rebuilt immediately
    // for live feedback, but the history/save commit is debounced so dragging the
    // slider doesn't spam undo entries or autosaves. The first render is skipped
    // so simply opening the tool never marks the project dirty.
    useEffect(() => {
        if (featherFirstRef.current) {
            featherFirstRef.current = false
            return undefined
        }
        if (!readyRef.current || !hasMaskRef.current) return undefined
        // The feather rebuild runs a full-image Gaussian blur, so coalesce rapid
        // slider ticks to one rebuild per animation frame, and debounce the
        // history/save commit so a drag doesn't spam undo entries or autosaves.
        if (liveSyncRafRef.current) cancelAnimationFrame(liveSyncRafRef.current)
        liveSyncRafRef.current = requestAnimationFrame(() => {
            liveSyncRafRef.current = null
            syncMaskToImage(targetImageRef.current)
        })
        clearTimeout(featherCommitTimerRef.current)
        featherCommitTimerRef.current = setTimeout(() => {
            canvasEditor?.__pushHistoryState?.()
            canvasEditor?.__saveCanvasState?.()
        }, 350)
        return () => clearTimeout(featherCommitTimerRef.current)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [feather])

    const mainImage = targetImageRef.current

    return {
        ready,
        mainImage,
        mode, setMode,
        brushSize, setBrushSize,
        hardness, setHardness,
        flow, setFlow,
        feather, setFeather,
        magic, setMagic,
        tolerance, setTolerance,
        altActive,
        hasMask, undoDepth, redoDepth,
        undo, redo, invert, clear, applyAlphaMask,
        supportsMagic,
    }
}
