"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import { FabricImage } from 'fabric'
import { toast } from 'sonner'
import {
    PIXEL_MASK_OVERLAY_NAME,
    createMaskCanvas,
    createContentAwareFillCanvas,
    createMaskClipPath,
    decodeMaskCanvas,
    encodeMaskCanvas,
    floodFillMask,
    getImageBitmapSize,
    getImageSourceElement,
    getMaskTargetImage,
    growMaskRegionFromStroke,
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
const DEFERRED_REGION_PREVIEW_MS = 90

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
 * Fraction of a decoded greyscale mask that's "on" (white). Used to tell an
 * empty SAM result (no object under the click → all-black) from a real hit,
 * and to flag a near-full-frame selection. Sampled at ≤128px because only the
 * rough proportion matters, not the exact area. Same-origin mask, so
 * getImageData won't taint; the guards just keep a transient failure from
 * blocking the erase (assume non-empty and proceed).
 */
const sampleMaskCoverage = (imageEl) => {
    const cap = 128
    const iw = imageEl?.naturalWidth || imageEl?.width || 0
    const ih = imageEl?.naturalHeight || imageEl?.height || 0
    if (!iw || !ih) return 1
    const s = Math.min(1, cap / Math.max(iw, ih))
    const w = Math.max(1, Math.round(iw * s))
    const h = Math.max(1, Math.round(ih * s))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return 1
    ctx.drawImage(imageEl, 0, 0, w, h)
    try {
        const { data } = ctx.getImageData(0, 0, w, h)
        let on = 0
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 127) on += 1
        }
        return on / (w * h)
    } catch {
        return 1
    }
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
 * @param {boolean} opts.deferApply     When true, painting only updates the
 *                                      overlay preview — the clipPath is NOT
 *                                      applied until commitErase() is called.
 * @param {boolean} opts.inferRegion    Expand erase strokes into an image-aware
 *                                      region before preview/apply.
 * @param {boolean} opts.showOverlay    Render the red mask overlay.
 * @param {boolean} opts.livePreview    Refresh the overlay while a stroke is active.
 * @param {boolean} opts.disabled       When true, skip all pointer-event
 *                                      handling so another brush (e.g. the
 *                                      smart brush in `tools/mask.jsx`) can
 *                                      take over without conflict. Undo/redo
 *                                      and the mode toggle remain active —
 *                                      only the canvas pointer handlers are
 *                                      suppressed. The underlying mask
 *                                      canvas + overlay are also detached.
 */
export default function usePixelMaskTool({
    canvasEditor,
    defaultMode = 'erase',
    supportsMagic = false,
    deferApply = false,
    inferRegion = false,
    showOverlay = true,
    livePreview = true,
    disabled = false,
}) {
    const [mode, setMode] = useState(defaultMode)
    const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE)
    const [hardness, setHardness] = useState(85)
    const [flow, setFlow] = useState(100)
    const [feather, setFeather] = useState(0)
    const [magic, setMagic] = useState(false)
    // AI object mode (SAM 2): a click segments the WHOLE object under the
    // pointer and erases/restores it. Mutually exclusive with `magic` (the
    // colour flood) — each setter below clears the other.
    const [objectSelect, setObjectSelectState] = useState(false)
    const [isObjectRunning, setIsObjectRunning] = useState(false)
    const [tolerance, setTolerance] = useState(24)
    const [altActive, setAltActive] = useState(false)

    const [ready, setReady] = useState(false)
    const [hasMask, setHasMask] = useState(false)
    const [undoDepth, setUndoDepth] = useState(0)
    const [redoDepth, setRedoDepth] = useState(0)
    // deferApply: track whether the user has painted a selection that hasn't been committed yet
    const [hasPending, setHasPending] = useState(false)
    const deferApplyRef = useRef(deferApply)
    const inferRegionRef = useRef(inferRegion)
    const showOverlayRef = useRef(showOverlay)
    const livePreviewRef = useRef(livePreview)
    const disabledRef = useRef(disabled)

    const modeRef = useRef(mode)
    const brushSizeRef = useRef(brushSize)
    const hardnessRef = useRef(hardness)
    const flowRef = useRef(flow)
    const featherRef = useRef(feather)
    const magicRef = useRef(magic)
    const objectSelectRef = useRef(objectSelect)
    const objectAbortRef = useRef(null)
    const isObjectRunningRef = useRef(false)
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
    const deferredLiveSyncTimerRef = useRef(null)
    const lastDeferredLiveSyncRef = useRef(0)
    const reattachRafRef = useRef(null)
    const spaceRef = useRef(false)
    const strokePointsRef = useRef([])
    // Bounding box (mask px) of pixels touched since the last overlay sync, so
    // the live overlay repaint only scans the brush footprint, not the whole
    // image. Reset at stroke start and after each overlay frame consumes it.
    const strokeDirtyRectRef = useRef(null)
    // Snapshot of the mask canvas before the current deferred painting session.
    // Used by discardPending() to revert the mask when the user cancels.
    const preCommitSnapshotRef = useRef(null)
    const preCommitUndoDepthRef = useRef(null)
    const preCommitRedoStackRef = useRef(null)

    useEffect(() => { readyRef.current = ready }, [ready])
    useEffect(() => { hasMaskRef.current = hasMask }, [hasMask])
    useEffect(() => { modeRef.current = mode }, [mode])
    useEffect(() => { brushSizeRef.current = brushSize }, [brushSize])
    useEffect(() => { hardnessRef.current = hardness }, [hardness])
    useEffect(() => { flowRef.current = flow }, [flow])
    useEffect(() => { featherRef.current = feather }, [feather])
    useEffect(() => { magicRef.current = magic }, [magic])
    useEffect(() => { objectSelectRef.current = objectSelect }, [objectSelect])
    useEffect(() => { deferApplyRef.current = deferApply }, [deferApply])
    useEffect(() => { inferRegionRef.current = inferRegion }, [inferRegion])
    useEffect(() => { showOverlayRef.current = showOverlay }, [showOverlay])
    useEffect(() => { livePreviewRef.current = livePreview }, [livePreview])
    useEffect(() => { disabledRef.current = disabled }, [disabled])
    useEffect(() => { toleranceRef.current = tolerance }, [tolerance])

    // Mirror the per-stroke stack depth onto the canvas + broadcast it, so the
    // topbar Undo/Redo buttons can reflect THIS stack (not just the global
    // history) while the tool is mounted. Without this the Redo button stays
    // disabled after a mask-stack undo even though a mask redo is available.
    useEffect(() => {
        if (!canvasEditor) return
        canvasEditor.__maskCanUndo = undoDepth > 0
        canvasEditor.__maskCanRedo = redoDepth > 0
        try { window.dispatchEvent(new CustomEvent('pixxel:mask-history-changed')) } catch { /* SSR */ }
    }, [canvasEditor, undoDepth, redoDepth])

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

    const updateOverlay = useCallback((img, maskCanvas, rect = null) => {
        if (!canvasEditor || !img || !maskCanvas) return
        const overlayCanvas = overlayCanvasRef.current
        if (!overlayCanvas) return

        paintOverlayFromMask(maskCanvas, overlayCanvas, { threshold: MASK_EMPTY_THRESHOLD, rect })

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
            // visible:true restores the object after a stroke (it's hidden for
            // the stroke's duration while contextTop carries the live preview).
            overlayImg.set({ ...geometry, visible: true })
            overlayImg.set('dirty', true)
        }

        const imageIndex = canvasEditor.getObjects?.().indexOf(img) ?? -1
        if (imageIndex >= 0 && typeof canvasEditor.moveObjectTo === 'function') {
            canvasEditor.moveObjectTo(overlayImg, imageIndex + 1)
        }
    }, [canvasEditor])

    const syncMaskToImage = useCallback((img, { showOverlay: shouldShowOverlay = showOverlayRef.current, skipClip = false } = {}) => {
        if (!canvasEditor || !img) return
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return

        const empty = isMaskCanvasEmpty(maskCanvas, MASK_EMPTY_THRESHOLD)
        setHasMask(!empty)

        if (empty && !skipClip) {
            img.clipPath = undefined
            img._pixxelHasMask = false
            img.pixxelHasMask = false
            removeOverlay({ render: false })
            canvasEditor.requestRenderAll()
            return
        }

        if (empty && skipClip) {
            removeOverlay({ render: false })
            canvasEditor.requestRenderAll()
            return
        }

        // When skipClip is true (deferApply mode), only update the overlay preview
        // without applying the clipPath — pixels stay visible under the red overlay.
        if (!skipClip) {
            const clipImg = createMaskClipPath(FabricImage, maskCanvas, { feather: featherRef.current })
            img.clipPath = clipImg
            img._pixxelHasMask = true
            img.pixxelHasMask = true
            img._pixxelMaskCanvas = maskCanvas
            img.pixxelMaskFeather = featherRef.current
            img._pixxelMaskFeather = featherRef.current
            img.set?.('dirty', true)
            img.setCoords?.()
        }

        if (shouldShowOverlay) updateOverlay(img, maskCanvas)
        else removeOverlay({ render: false })
        canvasEditor.requestRenderAll()
    }, [canvasEditor, removeOverlay, updateOverlay])

    /* ─── undo / redo ─── */

    // History snapshots are stored in the compact RLE form (encodeMaskCanvas)
    // instead of raw full-res ImageData, so a 40-deep stack on a large image no
    // longer pins tens of MB of RGBA buffers on the Fabric object. We keep the
    // canvas dimensions alongside the encoding so applySnapshot can validate (and
    // if needed scale) the decode against the live mask canvas. `encoded` is null
    // for a blank (all-white) mask — that is a valid state we must restore, so we
    // never collapse it into a missing snapshot.
    const snapshot = useCallback(() => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return null
        return {
            width: maskCanvas.width,
            height: maskCanvas.height,
            encoded: encodeMaskCanvas(maskCanvas),
        }
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
        const ctx = maskCanvas.getContext('2d')
        // A null encoding means the snapshot was a blank (all-white) mask: reset.
        if (!snap.encoded) {
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height)
            return
        }
        const decoded = decodeMaskCanvas(snap.encoded)
        if (!decoded) return
        // If the snapshot was authored at a different resolution than the live
        // mask canvas (image rehydrated to a different-res source), blindly
        // putImageData would corrupt/misalign the mask — scale the decode to fit.
        if (decoded.width === maskCanvas.width && decoded.height === maskCanvas.height) {
            ctx.putImageData(decoded.getContext('2d').getImageData(0, 0, decoded.width, decoded.height), 0, 0)
        } else {
            ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
            ctx.drawImage(decoded, 0, 0, maskCanvas.width, maskCanvas.height)
        }
    }, [])

    const createPendingSelectionMask = useCallback(() => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return null

        const w = maskCanvas.width
        const h = maskCanvas.height
        const currentData = maskCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data

        let beforeCanvas = null
        const snap = preCommitSnapshotRef.current
        if (snap) {
            beforeCanvas = snap.encoded ? decodeMaskCanvas(snap.encoded) : createMaskCanvas(w, h)
            if (beforeCanvas && (beforeCanvas.width !== w || beforeCanvas.height !== h)) {
                const scaled = createMaskCanvas(w, h)
                scaled.getContext('2d').drawImage(beforeCanvas, 0, 0, w, h)
                beforeCanvas = scaled
            }
        }

        const beforeData = beforeCanvas
            ? beforeCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data
            : null
        const selection = createMaskCanvas(w, h)
        const selectionCtx = selection.getContext('2d')
        const selectionImage = selectionCtx.createImageData(w, h)
        const output = selectionImage.data
        let affected = 0

        for (let i = 0; i < currentData.length; i += 4) {
            const currentLum = currentData[i]
            const beforeLum = beforeData ? beforeData[i] : 255
            const delta = Math.max(0, beforeLum - currentLum)
            const selected = currentLum < MASK_EMPTY_THRESHOLD && (!beforeData || delta > 2)
            const lum = selected ? Math.max(0, 255 - delta) : 255
            output[i] = lum
            output[i + 1] = lum
            output[i + 2] = lum
            output[i + 3] = 255
            if (selected) affected += 1
        }

        if (!affected) return null
        selectionCtx.putImageData(selectionImage, 0, 0)
        return selection
    }, [])

    const undo = useCallback(() => {
        if (undoStackRef.current.length === 0) return false
        const current = snapshot()
        const prev = undoStackRef.current.pop()
        if (current) redoStackRef.current.push(current)
        applySnapshot(prev)
        setUndoDepth(undoStackRef.current.length)
        setRedoDepth(redoStackRef.current.length)
        if (deferApplyRef.current && preCommitSnapshotRef.current) {
            // Stay in preview mode — update overlay only, don't apply clipPath
            syncMaskToImage(targetImageRef.current, { skipClip: true })
            // If we've undone back to the pre-commit state, clear hasPending
            const atPreCommit = undoStackRef.current.length <= (preCommitUndoDepthRef.current ?? 0)
            setHasPending(!atPreCommit)
        } else {
            syncMaskToImage(targetImageRef.current)
            commitMaskChange(canvasEditor, targetImageRef.current)
        }
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
        if (deferApplyRef.current && preCommitSnapshotRef.current) {
            // Stay in preview mode — update overlay only, don't apply clipPath
            syncMaskToImage(targetImageRef.current, { skipClip: true })
            setHasPending(true)
        } else {
            syncMaskToImage(targetImageRef.current)
            commitMaskChange(canvasEditor, targetImageRef.current)
        }
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

    /**
     * Apply an external mask from a PNG blob (e.g. AI segmentation result).
     * White = keep, black = erase. The blob is loaded as an image, then drawn
     * onto the mask canvas at the correct dimensions.
     */
    const applyExternalMaskBlob = useCallback(async (blob, { invert: invertMask = false } = {}) => {
        const img = targetImageRef.current
        const maskCanvas = maskCanvasRef.current
        if (!img || !maskCanvas || !blob) return false

        const objectUrl = URL.createObjectURL(blob)
        try {
            const el = await new Promise((resolve, reject) => {
                const image = new Image()
                image.crossOrigin = 'anonymous'
                image.onload = () => resolve(image)
                image.onerror = () => reject(new Error('Failed to load mask image'))
                image.src = objectUrl
            })

            pushUndo()
            const ctx = maskCanvas.getContext('2d')
            ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
            // Fill white first (keep all), then draw segmentation mask
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height)
            // Draw the AI mask — it's white for subject, black for background
            // We want: subject = keep (white in mask), background = erase (black in mask)
            // So we draw as-is. If invertMask, we invert afterward.
            ctx.drawImage(el, 0, 0, maskCanvas.width, maskCanvas.height)

            if (invertMask) {
                const data = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
                for (let i = 0; i < data.data.length; i += 4) {
                    const v = 255 - data.data[i]
                    data.data[i] = v
                    data.data[i + 1] = v
                    data.data[i + 2] = v
                    data.data[i + 3] = 255
                }
                ctx.putImageData(data, 0, 0)
            }

            syncMaskToImage(img)
            commitMaskChange(canvasEditor, img)
            return true
        } finally {
            URL.revokeObjectURL(objectUrl)
        }
    }, [pushUndo, syncMaskToImage, canvasEditor])

    /**
     * Select all pixels within a color tolerance of the given RGB color.
     * Entirely client-side — compares each pixel in the source image to
     * the target color using Euclidean distance in RGB space.
     */
    const applyColorRangeMask = useCallback(({ r, g, b, tolerance = 30, additive = false } = {}) => {
        const img = targetImageRef.current
        const maskCanvas = maskCanvasRef.current
        if (!img || !maskCanvas || r == null) return false

        const sourceEl = getImageSourceElement(img)
        if (!sourceEl) return false

        const w = maskCanvas.width
        const h = maskCanvas.height
        const sample = document.createElement('canvas')
        sample.width = w
        sample.height = h
        const sCtx = sample.getContext('2d', { willReadFrequently: true })
        try {
            sCtx.drawImage(sourceEl, 0, 0, w, h)
        } catch { return false }

        const src = sCtx.getImageData(0, 0, w, h).data
        const tol = Math.max(1, tolerance)
        const tolSq = tol * tol * 3 // scale by channels

        pushUndo()
        const ctx = maskCanvas.getContext('2d', { willReadFrequently: true })
        const maskData = additive
            ? ctx.getImageData(0, 0, w, h)
            : ctx.createImageData(w, h)
        const md = maskData.data

        if (!additive) {
            // Start with all-white (keep everything)
            for (let i = 0; i < md.length; i += 4) {
                md[i] = 255; md[i + 1] = 255; md[i + 2] = 255; md[i + 3] = 255
            }
        }

        for (let i = 0; i < src.length; i += 4) {
            const dr = src[i] - r
            const dg = src[i + 1] - g
            const db = src[i + 2] - b
            const distSq = dr * dr + dg * dg + db * db
            if (distSq <= tolSq) {
                // This pixel matches the color → erase it (black in mask)
                md[i] = 0; md[i + 1] = 0; md[i + 2] = 0; md[i + 3] = 255
            }
        }

        ctx.putImageData(maskData, 0, 0)
        syncMaskToImage(img)
        commitMaskChange(canvasEditor, img)
        return true
    }, [pushUndo, syncMaskToImage, canvasEditor])

    /**
     * Select pixels by luminance (brightness) range.
     * Pixels with luminance between minLuma and maxLuma are ERASED (black in mask).
     */
    const applyLuminanceRangeMask = useCallback(({ minLuma = 0, maxLuma = 128, additive = false } = {}) => {
        const img = targetImageRef.current
        const maskCanvas = maskCanvasRef.current
        if (!img || !maskCanvas) return false

        const sourceEl = getImageSourceElement(img)
        if (!sourceEl) return false

        const w = maskCanvas.width
        const h = maskCanvas.height
        const sample = document.createElement('canvas')
        sample.width = w
        sample.height = h
        const sCtx = sample.getContext('2d', { willReadFrequently: true })
        try {
            sCtx.drawImage(sourceEl, 0, 0, w, h)
        } catch { return false }

        const src = sCtx.getImageData(0, 0, w, h).data

        pushUndo()
        const ctx = maskCanvas.getContext('2d', { willReadFrequently: true })
        const maskData = additive
            ? ctx.getImageData(0, 0, w, h)
            : ctx.createImageData(w, h)
        const md = maskData.data

        if (!additive) {
            for (let i = 0; i < md.length; i += 4) {
                md[i] = 255; md[i + 1] = 255; md[i + 2] = 255; md[i + 3] = 255
            }
        }

        for (let i = 0; i < src.length; i += 4) {
            const luma = 0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2]
            if (luma >= minLuma && luma <= maxLuma) {
                md[i] = 0; md[i + 1] = 0; md[i + 2] = 0; md[i + 3] = 255
            }
        }

        ctx.putImageData(maskData, 0, 0)
        syncMaskToImage(img)
        commitMaskChange(canvasEditor, img)
        return true
    }, [pushUndo, syncMaskToImage, canvasEditor])

    /**
     * Apply a linear gradient mask. Direction is one of:
     * 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'
     * Position (0–100) controls where the gradient center is.
     * Feather (0–100) controls how wide the transition zone is.
     */
    const applyLinearGradientMask = useCallback(({ direction = 'bottom', position = 50, featherPct = 30 } = {}) => {
        const img = targetImageRef.current
        const maskCanvas = maskCanvasRef.current
        if (!img || !maskCanvas) return false

        const w = maskCanvas.width
        const h = maskCanvas.height

        pushUndo()
        const ctx = maskCanvas.getContext('2d')
        ctx.clearRect(0, 0, w, h)

        // Calculate gradient start and end points based on direction
        let x0, y0, x1, y1
        switch (direction) {
            case 'top':       x0 = w / 2; y0 = 0; x1 = w / 2; y1 = h; break
            case 'bottom':    x0 = w / 2; y0 = h; x1 = w / 2; y1 = 0; break
            case 'left':      x0 = 0; y0 = h / 2; x1 = w; y1 = h / 2; break
            case 'right':     x0 = w; y0 = h / 2; x1 = 0; y1 = h / 2; break
            case 'top-left':  x0 = 0; y0 = 0; x1 = w; y1 = h; break
            case 'top-right': x0 = w; y0 = 0; x1 = 0; y1 = h; break
            case 'bottom-left':  x0 = 0; y0 = h; x1 = w; y1 = 0; break
            case 'bottom-right': x0 = w; y0 = h; x1 = 0; y1 = 0; break
            default:          x0 = w / 2; y0 = h; x1 = w / 2; y1 = 0; break
        }

        const pos = Math.max(0, Math.min(100, position)) / 100
        const feath = Math.max(5, Math.min(100, featherPct)) / 100
        // The gradient goes from black (erase) to white (keep).
        // Position controls where the 50% point is; feather controls the ramp width.
        const rampStart = Math.max(0, pos - feath / 2)
        const rampEnd = Math.min(1, pos + feath / 2)

        const grad = ctx.createLinearGradient(x0, y0, x1, y1)
        grad.addColorStop(0, '#000000')                                  // fully erased
        grad.addColorStop(Math.max(0, rampStart), '#000000')             // still erased
        grad.addColorStop(Math.min(1, rampEnd), '#ffffff')               // fully kept
        grad.addColorStop(1, '#ffffff')                                  // kept

        ctx.fillStyle = grad
        ctx.fillRect(0, 0, w, h)

        syncMaskToImage(img)
        commitMaskChange(canvasEditor, img)
        return true
    }, [pushUndo, syncMaskToImage, canvasEditor])

    const createCleanupCanvas = useCallback(() => {
        const img = targetImageRef.current
        if (!img) return null
        const sourceEl = getImageSourceElement(img)
        if (!sourceEl) return null
        const selectionMask = createPendingSelectionMask()
        if (!selectionMask) return null
        return createContentAwareFillCanvas(sourceEl, selectionMask, {
            threshold: MASK_EMPTY_THRESHOLD,
            smoothingPasses: 3,
            cropX: img.cropX || 0,
            cropY: img.cropY || 0,
        })
    }, [createPendingSelectionMask])

    const createInpaintCanvases = useCallback(() => {
        const img = targetImageRef.current
        if (!img) return null
        const sourceEl = getImageSourceElement(img)
        if (!sourceEl) return null
        const selectionMask = createPendingSelectionMask()
        if (!selectionMask) return null

        const w = selectionMask.width
        const h = selectionMask.height
        const imageCanvas = document.createElement('canvas')
        imageCanvas.width = w
        imageCanvas.height = h
        const imageCtx = imageCanvas.getContext('2d')
        try {
            imageCtx.drawImage(sourceEl, 0, 0, w, h)
        } catch {
            return null
        }

        const sourceMask = selectionMask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h)
        const maskCanvas = createMaskCanvas(w, h, '#000000')
        const maskCtx = maskCanvas.getContext('2d')
        const maskImage = maskCtx.createImageData(w, h)
        const input = sourceMask.data
        const output = maskImage.data

        for (let i = 0; i < input.length; i += 4) {
            const eraseStrength = Math.max(0, 255 - input[i])
            const value = eraseStrength > 4 ? 255 : 0
            output[i] = value
            output[i + 1] = value
            output[i + 2] = value
            output[i + 3] = 255
        }
        maskCtx.putImageData(maskImage, 0, 0)

        return { imageCanvas, maskCanvas }
    }, [createPendingSelectionMask])

    const commitCleanupUrl = useCallback(async (url) => {
        const img = targetImageRef.current
        if (!canvasEditor || !img || !url) return false

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
            cropX: img.cropX,
            cropY: img.cropY,
        }

        await img.setSrc(url, { crossOrigin: 'anonymous' })
        img.set?.(geometry)

        const previousMask = preCommitSnapshotRef.current
        ensureMaskCanvas(img)
        if (previousMask) {
            applySnapshot(previousMask)
        } else {
            const maskCanvas = maskCanvasRef.current
            const ctx = maskCanvas?.getContext('2d')
            if (ctx) {
                ctx.fillStyle = '#ffffff'
                ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height)
            }
        }
        if (typeof preCommitUndoDepthRef.current === 'number') {
            undoStackRef.current = undoStackRef.current.slice(0, preCommitUndoDepthRef.current)
        }
        if (preCommitRedoStackRef.current) {
            redoStackRef.current = preCommitRedoStackRef.current
        }
        setUndoDepth(undoStackRef.current.length)
        setRedoDepth(redoStackRef.current.length)

        preCommitSnapshotRef.current = null
        preCommitUndoDepthRef.current = null
        preCommitRedoStackRef.current = null
        setHasPending(false)
        syncMaskToImage(img, { showOverlay: false })
        removeOverlay({ render: false })
        img.setCoords?.()
        commitMaskChange(canvasEditor, img)
        return true
    }, [canvasEditor, ensureMaskCanvas, applySnapshot, syncMaskToImage, removeOverlay])

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
        // GPU-composited transform (no layout/reflow) so the ring tracks the
        // pointer in real time even while a stroke repaints the overlay. The
        // translate(-50%,-50%) centres the ring on the point (moved here from
        // CSS so the whole transform is one composited property).
        el.style.transform = `translate3d(${clientX}px, ${clientY}px, 0) translate(-50%, -50%)`
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

    // Grow the per-frame dirty bbox so the overlay only repaints what changed.
    const markStrokeDirty = useCallback((minX, minY, maxX, maxY) => {
        const pad = 2 // soft-edge + anti-alias margin
        const r = strokeDirtyRectRef.current
        if (!r) {
            strokeDirtyRectRef.current = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
            return
        }
        if (minX - pad < r.minX) r.minX = minX - pad
        if (minY - pad < r.minY) r.minY = minY - pad
        if (maxX + pad > r.maxX) r.maxX = maxX + pad
        if (maxY + pad > r.maxY) r.maxY = maxY + pad
    }, [])

    const brushAt = useCallback((x, y) => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return
        const r = Math.max(0.5, brushSizeRef.current / 2)
        stampMask(maskCanvas.getContext('2d'), x, y, {
            radius: r,
            hardness: hardnessRef.current / 100,
            flow: flowRef.current / 100,
            mode: effectiveMode(),
        })
        markStrokeDirty(x - r, y - r, x + r, y + r)
    }, [effectiveMode, markStrokeDirty])

    const strokeTo = useCallback((x1, y1, x2, y2) => {
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return
        const r = Math.max(0.5, brushSizeRef.current / 2)
        strokeMaskSegment(maskCanvas, x1, y1, x2, y2, {
            radius: r,
            hardness: hardnessRef.current / 100,
            flow: flowRef.current / 100,
            mode: effectiveMode(),
        })
        markStrokeDirty(Math.min(x1, x2) - r, Math.min(y1, y2) - r, Math.max(x1, x2) + r, Math.max(y1, y2) + r)
    }, [effectiveMode, markStrokeDirty])

    const inferRegionFromCurrentStroke = useCallback(() => {
        if (!inferRegionRef.current || effectiveMode() !== 'erase') return 0
        const maskCanvas = maskCanvasRef.current
        const img = targetImageRef.current
        const points = strokePointsRef.current
        if (!maskCanvas || !img || points.length === 0) return 0
        const sourceEl = getImageSourceElement(img)
        if (!sourceEl) return 0
        return growMaskRegionFromStroke(maskCanvas, sourceEl, points, {
            radius: Math.max(0.5, brushSizeRef.current / 2),
            tolerance: toleranceRef.current,
            mode: effectiveMode(),
            cropX: img.cropX || 0,
            cropY: img.cropY || 0,
        })
    }, [effectiveMode])

    /* ─── live (in-stroke) sync ───
     * Two-tier pipeline, the key to a lag-free brush:
     *
     * FAST PATH (during a stroke): the live preview is composited on Fabric's
     * TOP CANVAS (`contextTop`) — the same layer Fabric's own freehand brush
     * draws on. The scene below is static while painting, so we never call
     * requestRenderAll mid-stroke: no full-scene redraw, no re-draw of the
     * (uncached, full-res) overlay object, and no `after:render` viewport-
     * chrome DOM sync per frame. Per frame the work is just (a) a dirty-rect
     * repaint of the overlay bitmap and (b) one composited blit to the top
     * canvas. The Fabric overlay object is hidden for the stroke's duration
     * (see onMouseDown) so the tint isn't double-composited.
     *
     * SLOW PATH (stroke end / no contextTop): the existing object-based
     * overlay + one full render. The full clipPath/feather rebuild still only
     * happens on mouse:up via syncMaskToImage().
     *
     * When deferApply is true, we ONLY update the overlay preview — no
     * clipPath is applied, so pixels stay visible beneath the red selection. */
    const renderStrokePreviewTop = useCallback((img) => {
        const canvas = canvasEditor
        const ctxTop = canvas?.contextTop
        const overlay = overlayCanvasRef.current
        if (!ctxTop || !overlay || typeof img?.calcTransformMatrix !== 'function') return false
        try {
            canvas.clearContext(ctxTop)
            ctxTop.save()
            const retina = canvas.getRetinaScaling?.() || 1
            const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
            ctxTop.setTransform(
                retina * vpt[0], retina * vpt[1],
                retina * vpt[2], retina * vpt[3],
                retina * vpt[4], retina * vpt[5],
            )
            // calcTransformMatrix is centre-based: the bitmap's local origin
            // sits at (-width/2, -height/2) in object space.
            const m = img.calcTransformMatrix()
            ctxTop.transform(m[0], m[1], m[2], m[3], m[4], m[5])
            ctxTop.drawImage(overlay, -img.width / 2, -img.height / 2)
            ctxTop.restore()
            return true
        } catch {
            try { ctxTop.restore() } catch { /* unbalanced save */ }
            return false
        }
    }, [canvasEditor])

    const liveSync = useCallback((img) => {
        if (!canvasEditor || !img) return
        if (!livePreviewRef.current || !showOverlayRef.current) return
        const maskCanvas = maskCanvasRef.current
        if (!maskCanvas) return
        if (!hasMaskRef.current) setHasMask(true)
        // Repaint only the brush's dirty footprint (set by brushAt/strokeTo),
        // then clear it. Falls back to a full repaint when nothing tracked it.
        const dirty = strokeDirtyRectRef.current
        const rect = dirty
            ? { x: dirty.minX, y: dirty.minY, w: dirty.maxX - dirty.minX, h: dirty.maxY - dirty.minY }
            : null
        strokeDirtyRectRef.current = null

        if (isDrawingRef.current) {
            const overlayCanvas = overlayCanvasRef.current
            if (overlayCanvas) {
                paintOverlayFromMask(maskCanvas, overlayCanvas, { threshold: MASK_EMPTY_THRESHOLD, rect })
                if (renderStrokePreviewTop(img)) return
            }
        }
        updateOverlay(img, maskCanvas, rect)
        canvasEditor.requestRenderAll()
    }, [canvasEditor, renderStrokePreviewTop, updateOverlay])

    const scheduleLiveSync = useCallback((img) => {
        if (deferApplyRef.current && inferRegionRef.current) {
            const now = Date.now()
            const elapsed = now - lastDeferredLiveSyncRef.current
            if (elapsed < DEFERRED_REGION_PREVIEW_MS) {
                if (deferredLiveSyncTimerRef.current) return
                deferredLiveSyncTimerRef.current = setTimeout(() => {
                    deferredLiveSyncTimerRef.current = null
                    lastDeferredLiveSyncRef.current = Date.now()
                    liveSync(img)
                }, DEFERRED_REGION_PREVIEW_MS - elapsed)
                return
            }
            lastDeferredLiveSyncRef.current = now
        }
        if (liveSyncRafRef.current) return
        liveSyncRafRef.current = requestAnimationFrame(() => {
            liveSyncRafRef.current = null
            liveSync(img)
        })
    }, [liveSync])

    /* ─── AI object click (SAM 2) ───
     * One click = the whole object under the pointer, segmented by SAM 2 and
     * composited into the erase mask ADDITIVELY — so clicking several subjects
     * erases each of them in turn (multi-subject by accumulation). The
     * composite is GPU-blended (darken/lighten), no pixel readbacks. */

    const setObjectSelect = useCallback((value) => {
        const v = Boolean(value)
        setObjectSelectState(v)
        if (v) setMagic(false)
    }, [])

    const setMagicExclusive = useCallback((value) => {
        const v = Boolean(value)
        setMagic(v)
        if (v) setObjectSelectState(false)
    }, [])

    const doObjectErase = useCallback(async (local) => {
        const img = targetImageRef.current
        const maskCanvas = maskCanvasRef.current
        const sourceEl = img ? getImageSourceElement(img) : null
        if (!img || !maskCanvas || !sourceEl) return
        if (isObjectRunningRef.current) {
            toast('Still segmenting the previous click…', { icon: '⏳' })
            return
        }

        try { objectAbortRef.current?.abort() } catch { /* ignore */ }
        const controller = new AbortController()
        objectAbortRef.current = controller
        isObjectRunningRef.current = true
        setIsObjectRunning(true)

        try {
            // The mask canvas and `local` both live in the image's CROPPED
            // bitmap space (getImageBitmapSize → img.width/height, which is the
            // crop size for a cropped Fabric image). Build the SAM upload, the
            // click, and (downstream) the returned mask in that SAME frame so
            // everything aligns — for a cropped image the naïve full-bitmap
            // upload would misplace both the click and the result.
            const { width: bw, height: bh } = getImageBitmapSize(img)
            const cropX = img.cropX || 0
            const cropY = img.cropY || 0
            // An <img> mid-load reports naturalWidth 0; a not-yet-ready bitmap
            // collapses to a 1px size. Either way SAM would get garbage.
            const srcW = sourceEl.naturalWidth || sourceEl.width || 0
            const srcH = sourceEl.naturalHeight || sourceEl.height || 0
            if (srcW < 1 || srcH < 1 || bw < 2 || bh < 2) {
                throw new Error('Image is still loading — try again in a moment')
            }
            const scale = Math.min(1, 1024 / Math.max(bw, bh))
            const up = document.createElement('canvas')
            up.width = Math.max(1, Math.round(bw * scale))
            up.height = Math.max(1, Math.round(bh * scale))
            const upCtx = up.getContext('2d')
            if (!upCtx) throw new Error('Could not allocate an upload canvas')
            upCtx.drawImage(sourceEl, cropX, cropY, bw, bh, 0, 0, up.width, up.height)
            let blob
            try {
                blob = await new Promise((res, rej) =>
                    up.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/jpeg', 0.85))
            } catch (e) {
                // A canvas drawn from a cross-origin image without CORS is
                // tainted, so toBlob throws SecurityError — say so plainly.
                if (e?.name === 'SecurityError') {
                    throw new Error('This image is from another site without CORS, so it can’t be read for AI selection')
                }
                throw e
            }

            const form = new FormData()
            form.append('image', blob, 'image.jpg')
            form.append('clicks', JSON.stringify([[
                Math.min(up.width - 1, Math.max(0, local.x * scale)),
                Math.min(up.height - 1, Math.max(0, local.y * scale)),
                1,
            ]]))

            const resp = await fetch('/api/ai/sam2', { method: 'POST', body: form, signal: controller.signal })
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}))
                throw new Error(err.error || `Object detection failed (${resp.status})`)
            }
            const maskBlob = await resp.blob()
            const decoded = await new Promise((resolve, reject) => {
                const url = URL.createObjectURL(maskBlob)
                const image = new Image()
                image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
                image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('mask decode failed')) }
                image.src = url
            })
            if (controller.signal.aborted) return

            // Did SAM actually find an object under the click? An all-black
            // mask composites to a no-op (darken-with-white / lighten-with-
            // black), so a miss would silently do nothing yet still push a junk
            // undo state and a misleading toast. Detect the empty result first.
            const matteFraction = sampleMaskCoverage(decoded)
            if (matteFraction < 0.0008) {
                toast('No object found there — click directly on the thing you want to remove', { icon: '🤔' })
                return
            }

            // The image (and its mask canvas) can change WHILE SAM runs — the
            // user might delete/replace it, or undo past it. The `decoded` mask
            // belongs to the bitmap we uploaded, so applying it to a different
            // image now would composite the wrong shape. Bail if the target
            // moved on or left the canvas.
            if (targetImageRef.current !== img
                || maskCanvasRef.current !== maskCanvas
                || !(canvasEditor?.getObjects?.() || []).includes(img)) {
                return
            }

            // Pre-commit snapshot for the deferred-session revert path (same
            // contract as doMagic).
            if (deferApplyRef.current && !preCommitSnapshotRef.current) {
                preCommitSnapshotRef.current = snapshot()
                preCommitUndoDepthRef.current = undoStackRef.current.length
                preCommitRedoStackRef.current = redoStackRef.current.slice()
            }
            pushUndo()

            const w = maskCanvas.width
            const h = maskCanvas.height
            const ctx = maskCanvas.getContext('2d')
            ctx.save()
            if (effectiveMode() === 'erase') {
                // erase = min(mask, NOT object): invert the object mask, then
                // darken-blend so object pixels go black and the rest is kept.
                const inv = document.createElement('canvas')
                inv.width = w
                inv.height = h
                const ictx = inv.getContext('2d')
                ictx.fillStyle = '#ffffff'
                ictx.fillRect(0, 0, w, h)
                ictx.globalCompositeOperation = 'difference'
                ictx.drawImage(decoded, 0, 0, w, h)
                ctx.globalCompositeOperation = 'darken'
                ctx.drawImage(inv, 0, 0)
            } else {
                // restore = max(mask, object).
                ctx.globalCompositeOperation = 'lighten'
                ctx.drawImage(decoded, 0, 0, w, h)
            }
            ctx.restore()

            if (deferApplyRef.current) {
                syncMaskToImage(img, { skipClip: true })
                setHasPending(true)
            } else {
                syncMaskToImage(img)
                commitMaskChange(canvasEditor, img)
            }
            if (matteFraction > 0.97) {
                // SAM occasionally grabs the whole frame (e.g. a click on flat
                // background). Don't block it — the user may want it — but flag
                // it so an accidental "erase everything" is obvious.
                toast(effectiveMode() === 'erase'
                    ? 'That selected almost the entire image — press undo if it wasn’t what you meant'
                    : 'That restored almost the entire image — press undo if it wasn’t what you meant',
                    { icon: '⚠️', duration: 6000 })
            } else {
                toast.success(effectiveMode() === 'erase' ? 'Object erased — click another to remove more' : 'Object restored')
            }
        } catch (err) {
            if (err?.name !== 'AbortError') {
                toast.error(err?.message || 'Object detection failed')
            }
        } finally {
            if (objectAbortRef.current === controller) {
                objectAbortRef.current = null
                isObjectRunningRef.current = false
                setIsObjectRunning(false)
            }
        }
    }, [effectiveMode, pushUndo, snapshot, syncMaskToImage, canvasEditor])

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
        // so switching tools and back doesn't silently discard the stack — but only
        // if the stashed snapshots match the current bitmap size (a rehydrate to a
        // different-resolution source would make them corrupt the mask on apply).
        const { width: seedW, height: seedH } = getImageBitmapSize(targetImage)
        const seedStackFits = (stack) =>
            Array.isArray(stack) &&
            stack.every((snap) => snap?.width === seedW && snap?.height === seedH)
        undoStackRef.current = seedStackFits(targetImage._pixxelUndoStack) ? targetImage._pixxelUndoStack : []
        redoStackRef.current = seedStackFits(targetImage._pixxelRedoStack) ? targetImage._pixxelRedoStack : []
        setUndoDepth(undoStackRef.current.length)
        setRedoDepth(redoStackRef.current.length)
        lockCanvas(canvasEditor, targetImage)
        syncMaskToImage(targetImage)
        setReady(true)

        // Build the floating brush-cursor ring (outer ring + inner hardness ring).
        const cursorEl = document.createElement('div')
        cursorEl.className = 'pixxel-brush-cursor'
        // Seed the transform off-screen so the ring can never flash at (0,0)
        // before the first positionCursor() call sets its real location.
        cursorEl.style.transform = 'translate3d(-9999px, -9999px, 0) translate(-50%, -50%)'
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
            // for the click modes (magic flood / AI object — no brush size there).
            el.style.cursor = (magicRef.current || objectSelectRef.current)
                ? 'crosshair'
                : (overCanvasRef.current ? 'none' : 'crosshair')
        }

        const onWindowMouseMove = (e) => {
            const inside = pointInCanvas(e.clientX, e.clientY)
            overCanvasRef.current = inside
            lastClientRef.current = { x: e.clientX, y: e.clientY }
            applyCanvasCursor()
            if (inside && !magicRef.current && !objectSelectRef.current) {
                positionCursor(e.clientX, e.clientY)
                // The ring's SIZE only changes with brush/zoom, not on move —
                // skip the restyle while painting so a heavy stroke can't stall
                // the cursor. styleCursor still runs on hover + on param change.
                if (!isDrawingRef.current) styleCursor()
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
            // Capture a pre-commit snapshot the FIRST time we paint in a deferred
            // session, so discardPending() can revert to the pre-paint state.
            if (deferApplyRef.current && !preCommitSnapshotRef.current) {
                preCommitSnapshotRef.current = snapshot()
                preCommitUndoDepthRef.current = undoStackRef.current.length
                preCommitRedoStackRef.current = redoStackRef.current.slice()
            }
            // Snapshot BEFORE mutating, but only commit it to the undo stack (and clear
            // redo) if the flood actually changed something — a no-op click must not
            // wipe the redo stack.
            const before = snapshot()
            const affected = floodFillMask(maskCanvas, sourceEl, local.x, local.y, {
                tolerance: toleranceRef.current,
                mode: effectiveMode(),
                cropX: img.cropX || 0,
                cropY: img.cropY || 0,
            })
            if (affected > 0) {
                if (before) {
                    undoStackRef.current.push(before)
                    if (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift()
                    redoStackRef.current = []
                    setUndoDepth(undoStackRef.current.length)
                    setRedoDepth(0)
                }
                if (deferApplyRef.current) {
                    // Preview only — overlay shows the selection, clipPath is NOT applied.
                    syncMaskToImage(img, { skipClip: true })
                    setHasPending(true)
                } else {
                    syncMaskToImage(img)
                    commitMaskChange(canvasEditor, img)
                }
            }
        }

        const localFromEvent = (e) => pointToImageSpace(targetImageRef.current, getScenePoint(e))

        const onMouseDown = (opt) => {
            if (!opt?.e) return
            // When another tool (e.g. the smart brush) has taken over the
            // canvas, the pixel tool is a passive observer — it stays
            // mounted so its undo/redo + brush-size UI keep working, but
            // its pointer handlers do nothing. Without this gate, two
            // brushes would fire on the same click.
            if (disabledRef.current) return
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

            // Snap the ring to the stroke origin immediately so it never trails
            // (or flashes from a stale hover position) on the first dab.
            if (!magicRef.current && !objectSelectRef.current) {
                overCanvasRef.current = true
                positionCursor(opt.e.clientX, opt.e.clientY)
                setCursorVisible(true)
            }

            if (objectSelectRef.current) {
                strokePointsRef.current = []
                doObjectErase(local)
                return
            }

            if (magicRef.current) {
                strokePointsRef.current = []
                doMagic(local)
                return
            }

            // Capture a pre-commit snapshot the FIRST time we paint in a deferred
            // session, so discardPending() can revert to the pre-paint state.
            if (deferApplyRef.current && !preCommitSnapshotRef.current) {
                preCommitSnapshotRef.current = snapshot()
                preCommitUndoDepthRef.current = undoStackRef.current.length
                preCommitRedoStackRef.current = redoStackRef.current.slice()
            }
            pushUndo()
            isDrawingRef.current = true
            lastPointRef.current = local
            strokePointsRef.current = [local]
            strokeDirtyRectRef.current = null
            // Hide the object-based overlay for the stroke's duration — the
            // live preview is composited on contextTop instead (see liveSync),
            // so leaving the object visible would double-tint painted pixels.
            // One render here is the ONLY full-scene render until mouse:up.
            const overlayObj = overlayImageRef.current
            if (overlayObj && overlayObj.visible !== false
                && canvasEditor.getObjects?.().includes(overlayObj)) {
                overlayObj.visible = false
                canvasEditor.requestRenderAll()
            }
            brushAt(local.x, local.y)
            scheduleLiveSync(targetImageRef.current)
        }

        const onMouseMove = (opt) => {
            if (!isDrawingRef.current || !opt?.e) return
            if (spaceRef.current) return
            // Keep the ring glued to the pointer BEFORE the (heavier) paint work
            // in this same handler — a cheap composited transform, so the cursor
            // never trails the stroke.
            if (!magicRef.current && overCanvasRef.current) positionCursor(opt.e.clientX, opt.e.clientY)

            // High-polling mice/styluses deliver several samples per dispatched
            // pointermove. Stroke through EVERY coalesced sample so fast curves
            // stay smooth (no chord-cutting between 60Hz frames) — painting a
            // dab into the mask bitmap is cheap; the visual sync below is still
            // coalesced to one per animation frame.
            const events = typeof opt.e.getCoalescedEvents === 'function'
                ? opt.e.getCoalescedEvents()
                : null
            const samples = events && events.length ? events : [opt.e]

            let painted = false
            for (const ev of samples) {
                const local = localFromEvent(ev)
                if (!isPointInImage(local, targetImageRef.current)) {
                    // Pointer briefly left the image bounds mid-stroke. Do NOT
                    // clear lastPointRef — keeping the last in-bounds point means
                    // the next in-bounds sample strokes a continuous segment back
                    // into the image instead of dropping a disconnected dab.
                    continue
                }
                if (lastPointRef.current) {
                    strokeTo(lastPointRef.current.x, lastPointRef.current.y, local.x, local.y)
                } else {
                    brushAt(local.x, local.y)
                }
                lastPointRef.current = local
                strokePointsRef.current.push(local)
                painted = true
            }
            if (!painted) return
            opt.e.preventDefault?.()
            opt.e.stopPropagation?.()
            scheduleLiveSync(targetImageRef.current)
        }

        const onMouseUp = () => {
            if (!isDrawingRef.current) return
            isDrawingRef.current = false
            lastPointRef.current = null
            // The stroke preview lived on contextTop — clear it before the full
            // sync re-renders the scene with the (re-shown) overlay object.
            try { canvasEditor.clearContext?.(canvasEditor.contextTop) } catch { /* ignore */ }
            // Cancel any pending cheap frame and run the full sync (feather + emptiness
            // check + overlay) once, then commit to history.
            if (liveSyncRafRef.current) {
                cancelAnimationFrame(liveSyncRafRef.current)
                liveSyncRafRef.current = null
            }
            if (deferredLiveSyncTimerRef.current) {
                clearTimeout(deferredLiveSyncTimerRef.current)
                deferredLiveSyncTimerRef.current = null
            }
            // NOTE: inferRegionFromCurrentStroke() disabled — it runs a flood-fill
            // over a large area on every mouse-up, freezing the screen on big images.
            // The brush paints exactly what the user draws (standard behavior).
            strokePointsRef.current = []
            if (deferApplyRef.current) {
                // Preview only — show overlay but don't apply clipPath or commit.
                syncMaskToImage(targetImageRef.current, { skipClip: true })
                setHasPending(true)
            } else {
                syncMaskToImage(targetImageRef.current)
                commitMaskChange(canvasEditor, targetImageRef.current)
            }
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
                // Discard any stashed history whose snapshots were authored at a
                // different bitmap size than the freshly-restored image — applying
                // a mismatched-resolution snapshot would corrupt the mask.
                const { width: nextW, height: nextH } = getImageBitmapSize(next)
                const stackFits = (stack) =>
                    Array.isArray(stack) &&
                    stack.every((snap) => snap?.width === nextW && snap?.height === nextH)
                undoStackRef.current = stackFits(next._pixxelUndoStack) ? next._pixxelUndoStack : []
                redoStackRef.current = stackFits(next._pixxelRedoStack) ? next._pixxelRedoStack : []
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

        // Expose the mask-aware undo/redo so the TOPBAR's Undo/Redo buttons
        // (which otherwise always hit the global canvas history) route through
        // the SAME per-stroke stack as Cmd+Z while this tool is mounted. Without
        // this, the ⌘Z path and the toolbar button gave two different results
        // for one visible action — e.g. after "Select Subject" the button hit
        // global history while the real undo state lived on the mask stack, so
        // the image wouldn't come back. Cleared on unmount so other tools fall
        // back to the global history.
        canvasEditor.__maskToolUndo = onMaskUndo
        canvasEditor.__maskToolRedo = onMaskRedo

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
            if (deferredLiveSyncTimerRef.current) { clearTimeout(deferredLiveSyncTimerRef.current); deferredLiveSyncTimerRef.current = null }
            if (reattachRafRef.current) { cancelAnimationFrame(reattachRafRef.current); reattachRafRef.current = null }
            // Stash the local undo/redo stacks on the image so re-entering the tool
            // (or switching Erase↔Mask) keeps the history.
            const stashImg = targetImageRef.current
            if (stashImg && canvasEditor.getObjects?.().includes(stashImg)) {
                // Cap what we retain and avoid pinning empty arrays on the image:
                // when there's nothing to keep, drop the refs entirely so the
                // (RLE-encoded) snapshots can be garbage-collected.
                const undoTail = undoStackRef.current.slice(-MAX_HISTORY)
                const redoTail = redoStackRef.current.slice(-MAX_HISTORY)
                if (undoTail.length) stashImg._pixxelUndoStack = undoTail
                else delete stashImg._pixxelUndoStack
                if (redoTail.length) stashImg._pixxelRedoStack = redoTail
                else delete stashImg._pixxelRedoStack
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
            // Only relinquish the topbar routing if it's still ours (guards the
            // rare Mask↔Erase remount overlap from deleting the new handler).
            if (canvasEditor.__maskToolUndo === onMaskUndo) delete canvasEditor.__maskToolUndo
            if (canvasEditor.__maskToolRedo === onMaskRedo) delete canvasEditor.__maskToolRedo
            // Drop the mask-stack availability flags so the topbar buttons fall
            // back to the global history once no pixel tool is mounted.
            delete canvasEditor.__maskCanUndo
            delete canvasEditor.__maskCanRedo
            try { window.dispatchEvent(new CustomEvent('pixxel:mask-history-changed')) } catch { /* SSR */ }
            // A tool switch can unmount mid-stroke — never leave a stale
            // stroke preview on the top compositing layer.
            try { canvasEditor.clearContext?.(canvasEditor.contextTop) } catch { /* ignore */ }
            isDrawingRef.current = false
            try { objectAbortRef.current?.abort() } catch { /* ignore */ }
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
        doObjectErase,
        inferRegionFromCurrentStroke,
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

    /* ─── deferApply: commit / discard ─── */

    /** Apply the painted selection to the clipPath, actually hiding the pixels. */
    const commitErase = useCallback(() => {
        const img = targetImageRef.current
        if (!img) return
        // Apply the full mask (with feather) to the clipPath now, then clear the
        // red preview so the user sees the committed transparency/result.
        syncMaskToImage(img, { showOverlay: false })
        removeOverlay({ render: false })
        commitMaskChange(canvasEditor, img)
        setHasPending(false)
        preCommitSnapshotRef.current = null
        preCommitUndoDepthRef.current = null
        preCommitRedoStackRef.current = null
    }, [syncMaskToImage, removeOverlay, canvasEditor])

    /** Discard the pending selection, reverting the mask to its pre-paint state. */
    const discardPending = useCallback(() => {
        const img = targetImageRef.current
        if (!img) return
        const snap = preCommitSnapshotRef.current
        if (snap) {
            applySnapshot(snap)
        }
        if (typeof preCommitUndoDepthRef.current === 'number') {
            undoStackRef.current = undoStackRef.current.slice(0, preCommitUndoDepthRef.current)
        }
        if (preCommitRedoStackRef.current) {
            redoStackRef.current = preCommitRedoStackRef.current
        }
        setUndoDepth(undoStackRef.current.length)
        setRedoDepth(redoStackRef.current.length)
        preCommitSnapshotRef.current = null
        preCommitUndoDepthRef.current = null
        preCommitRedoStackRef.current = null
        // Rebuild clipPath from the reverted mask (or remove it if empty)
        syncMaskToImage(img, { showOverlay: false })
        removeOverlay({ render: false })
        setHasPending(false)
    }, [applySnapshot, syncMaskToImage, removeOverlay])

    return {
        ready,
        mainImage,
        mode, setMode,
        brushSize, setBrushSize,
        hardness, setHardness,
        flow, setFlow,
        feather, setFeather,
        magic, setMagic: setMagicExclusive,
        objectSelect, setObjectSelect, isObjectRunning,
        tolerance, setTolerance,
        altActive,
        hasMask, undoDepth, redoDepth,
        undo, redo, invert, clear, applyAlphaMask,
        applyExternalMaskBlob, applyColorRangeMask, applyLuminanceRangeMask, applyLinearGradientMask,
        createCleanupCanvas, createInpaintCanvases, commitCleanupUrl,
        supportsMagic,
        // deferApply extras
        hasPending, commitErase, discardPending,
    }
}
