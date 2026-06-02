"use client"

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
    ArrowDown, ArrowDownLeft, ArrowDownRight, ArrowLeft, ArrowRight,
    ArrowUp, ArrowUpLeft, ArrowUpRight,
    Blend, ChevronDown, ChevronRight, Circle, Crosshair, Layers,
    Loader2, Mountain, MousePointer, Palette, Paintbrush, Plus, RotateCcw, Scissors, Sparkles, Sun, Wand2, X,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Circle as FabricCircle, Ellipse, FabricImage, Line } from 'fabric'
import { toast } from 'sonner'
import { useCanvas } from '../../../../../../../context/context'
import usePixelMaskTool, { MIN_BRUSH, MAX_BRUSH } from '../../../../../../../hooks/usePixelMaskTool'
import useMaskLayers from '../../../../../../../hooks/useMaskLayers'
import { computeImageHistogram, getHistogramSourceElement } from '@/lib/image-histogram'
import { rgbToHsb } from '@/lib/color-utils'
import { setMaskTexture } from '@/lib/megashader'
import {
    BrushSizeControl,
    LabeledSlider,
    LuminanceHistogram,
    MaskActionButtons,
    MaskChainCard,
    ModeToggle,
    TipCard,
    ToolEmptyState,
} from './_pixel-tool-ui'

/* ─── collapsible section ─── */
const Section = ({ title, icon: Icon, defaultOpen = false, children, badge }) => {
    const [open, setOpen] = useState(defaultOpen)
    return (
        <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                className="flex w-full items-center gap-2 py-2.5 px-1 text-left group"
                style={{ color: 'var(--text-secondary)' }}
            >
                {Icon && <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />}
                <span className="text-xs font-semibold flex-1 tracking-wide uppercase">{title}</span>
                {badge && (
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                        style={{ background: 'rgba(6,184,212,0.12)', color: 'var(--accent-primary)' }}>
                        {badge}
                    </span>
                )}
                {open
                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform" style={{ color: 'var(--text-muted)' }} />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform" style={{ color: 'var(--text-muted)' }} />
                }
            </button>
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: 'easeInOut' }}
                        className="overflow-hidden"
                    >
                        <div className="pb-3 space-y-3 px-0.5">
                            {children}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

/* ─── gradient direction icons ─── */
const DIRECTIONS = [
    { id: 'top', icon: ArrowUp, label: 'Top → Bottom' },
    { id: 'bottom', icon: ArrowDown, label: 'Bottom → Top' },
    { id: 'left', icon: ArrowLeft, label: 'Left → Right' },
    { id: 'right', icon: ArrowRight, label: 'Right → Left' },
    { id: 'top-left', icon: ArrowUpLeft, label: 'Top-Left' },
    { id: 'top-right', icon: ArrowUpRight, label: 'Top-Right' },
    { id: 'bottom-left', icon: ArrowDownLeft, label: 'Bottom-Left' },
    { id: 'bottom-right', icon: ArrowDownRight, label: 'Bottom-Right' },
]

/* ─── color swatch component ─── */
const ColorSwatch = ({ color, size = 24 }) => {
    if (!color) return null
    return (
        <div
            className="rounded border shrink-0"
            style={{
                width: size, height: size,
                background: `rgb(${color.r}, ${color.g}, ${color.b})`,
                borderColor: 'var(--border-subtle)',
            }}
        />
    )
}

const MaskControls = ({ dominantColor }) => {
    const { canvasEditor } = useCanvas()
    // The pixel brush is the default manual eraser, but it must hand
    // off to the smart brush (Step 7) when the user enters that mode
    // — both write to different masks (clipPath vs texture cache) and
    // a single click would otherwise fire both. The pixel tool's undo
    // stack + brush-size UI stay live; only its pointer handlers are
    // suppressed via the `disabled` prop. We mirror `brushActive` into
    // `pixelToolDisabled` via an effect (declared below, after the
    // `brushActive` useState) so the hook body never needs to read
    // `brushActive` directly — avoiding a temporal-dead-zone error.
    const [pixelToolDisabled, setPixelToolDisabled] = useState(false)
    const tool = usePixelMaskTool({ canvasEditor, defaultMode: 'erase', supportsMagic: false, disabled: pixelToolDisabled })

    // AI Subject Selection state
    const [isSegmenting, setIsSegmenting] = useState(false)
    // Ref-mirrors of the "running" flags. The `useCallback` closures for
    // `handleSelectSubject` / `handleSemanticRun` / `handleDepthRun` capture
    // the React state at render time, so a fast double-click (or two clicks
    // landing in the same batched render) could otherwise launch two
    // concurrent fetches and race to write the same state. The refs are
    // always current and are also the only place we read the in-flight
    // state from.
    const isSegmentingRef = useRef(false)
    // AbortController for the most recent in-flight request per tool.
    // When a new request is fired, the previous one is cancelled so the
    // older fetch can't resolve later and clobber fresher state.
    const segmentAbortRef = useRef(/** @type {AbortController | null} */ (null))

    // Color Range state
    const [colorPickerActive, setColorPickerActive] = useState(false)
    const [pickedColor, setPickedColor] = useState(null)
    const [colorTolerance, setColorTolerance] = useState(35)
    const colorPickerRef = useRef(null)

    // Luminance Range state
    const [lumaMin, setLumaMin] = useState(0)
    const [lumaMax, setLumaMax] = useState(128)

    // Gradient state
    const [gradDirection, setGradDirection] = useState('bottom')
    const [gradPosition, setGradPosition] = useState(50)
    const [gradFeather, setGradFeather] = useState(30)

    // Megashader chain state (independent from brush+clipPath). Step 2 keeps
    // this per-component; module-scope persistence is Step 7. See AGENTS.md
    // notes in hooks/useMaskLayers.js.
    const chain = useMaskLayers()
    const {
        stack, addLayer: addChainLayer, removeLayer, updateLayer,
        setLayerOp, moveLayer, clearAll,
    } = chain

    // Lightroom-style histogram for the luminance panel. Computed lazily on
    // the next tick after mainImage changes (the source <img> must be
    // decoded before drawImage is safe). Null while loading.
    const [histogram, setHistogram] = useState(null)
    useEffect(() => {
        const el = getHistogramSourceElement(tool.mainImage)
        if (!el) { setHistogram(null); return undefined }
        let cancelled = false
        // Yield to the next frame so React's commit is done before we touch
        // the DOM. The histogram walk is ~10ms on a 1MP image; on a 5MP+ image
        // it can take 50-200ms. The await keeps the UI responsive.
        Promise.resolve().then(() => {
            if (cancelled) return
            try {
                const h = computeImageHistogram(el)
                if (!cancelled) setHistogram(h)
            } catch {
                if (!cancelled) setHistogram(null)
            }
        })
        return () => { cancelled = true }
    }, [tool.mainImage])

    // Cancel any in-flight AI requests on unmount (or when the mask tool
    // itself is torn down). Without this, a slow request that resolves
    // after unmount would call setState on an unmounted component, and
    // we'd leak the AbortController plus its underlying fetch socket.
    useEffect(() => {
        return () => {
            try { segmentAbortRef.current?.abort() } catch { /* ignore */ }
            try { semanticAbortRef.current?.abort() } catch { /* ignore */ }
            try { depthAbortRef.current?.abort() } catch { /* ignore */ }
            segmentAbortRef.current = null
            semanticAbortRef.current = null
            depthAbortRef.current = null
        }
    }, [])

    /* ─── Spatial draft mode (Step 3) ─── */

    // Image dimensions of the source image (not the displayed scaled size).
    // Used to default new linear/radial layers to a full-image line/ellipse.
    // MUST come from the underlying HTMLImageElement's naturalWidth/Height —
    // falling back to fabric's `width/height` would be the *scaled* size,
    // which would put the layer's p1/p2 in scaled pixels while the GLSL's
    // uImageSize (uploaded from sourceCanvas.width/height) is in natural
    // pixels. The mismatch would be invisible until the user drags.
    const imageSize = (() => {
        if (!tool.mainImage) return null
        const sourceEl = tool.mainImage._element || tool.mainImage.getElement?.()
        const w = sourceEl?.naturalWidth || 0
        const h = sourceEl?.naturalHeight || 0
        return w > 0 && h > 0 ? { width: w, height: h } : null
    })()

    // activeDraft is the layer that's currently being placed on the canvas.
    // Set by the "Add Linear/Radial to Mask Layers" buttons; cleared on
    // mouse-up (commit) or Esc (cancel — also removes the layer).
    const [activeDraft, setActiveDraft] = useState(null)
    // dragStateRef holds the in-progress drag's start point (image-pixel
    // coords) and the active flag. We use a ref because the drag fires
    // faster than React's render cycle (window-level mousemove).
    const dragStateRef = useRef(null)
    // overlayRef holds the Fabric overlay object so we can remove it
    // when the draft ends (or when the component re-creates the overlay
    // on layer updates).
    const overlayRef = useRef(null)

    // Convert a fabric event's pointer to image-pixel coordinates. The
    // fabric canvas uses display-space; the user wants to set the layer
    // geometry in image-space pixels (so the GLSL's `vTextureCoord *
    // uImageSize` matches what the user pointed at).
    const pointerToImage = useCallback((fabricCanvas, e) => {
        if (!tool.mainImage || !fabricCanvas) return null
        const pointer = fabricCanvas.getPointer(e.e || e)
        const fabricObj = tool.mainImage
        const objLeft = fabricObj.left || 0
        const objTop = fabricObj.top || 0
        const objScaleX = fabricObj.scaleX || 1
        const objScaleY = fabricObj.scaleY || 1
        return {
            x: (pointer.x - objLeft) / objScaleX,
            y: (pointer.y - objTop) / objScaleY,
        }
    }, [tool.mainImage])

    // Convert image-pixel coordinates to display-space (where Fabric
    // objects live). Used for drawing the live preview overlay so it
    // sits exactly on top of the corresponding image pixel.
    const imageToDisplay = useCallback((imageX, imageY) => {
        if (!tool.mainImage) return null
        const fabricObj = tool.mainImage
        return {
            x: imageX * (fabricObj.scaleX || 1) + (fabricObj.left || 0),
            y: imageY * (fabricObj.scaleY || 1) + (fabricObj.top || 0),
        }
    }, [tool.mainImage])

    // Begin a spatial drag. Snaps the layer's anchor to the click point
    // and prepares the dragStateRef for the move handler.
    const handleSpatialDragStart = useCallback((e) => {
        if (!activeDraft) return
        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas) return
        const pos = pointerToImage(fabricCanvas, e)
        if (!pos) return
        dragStateRef.current = { startX: pos.x, startY: pos.y }
        if (activeDraft.kind === 'linear') {
            updateLayer(activeDraft.layerId, {
                p1: { x: pos.x, y: pos.y },
                p2: { x: pos.x, y: pos.y },
            })
        } else if (activeDraft.kind === 'radial') {
            updateLayer(activeDraft.layerId, {
                center: { x: pos.x, y: pos.y },
                radius: { x: 0.001, y: 0.001 },
            })
        }
    }, [activeDraft, canvasEditor, pointerToImage, updateLayer])

    // Update the layer as the user drags. Linear uses start→current as
    // the line endpoints; radial derives center (midpoint) + radius
    // (half the drag distance per axis) + rotation (atan2 of the drag).
    const handleSpatialDragMove = useCallback((e) => {
        if (!activeDraft || !dragStateRef.current) return
        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas) return
        const pos = pointerToImage(fabricCanvas, e)
        if (!pos) return
        if (activeDraft.kind === 'linear') {
            updateLayer(activeDraft.layerId, {
                p1: { x: dragStateRef.current.startX, y: dragStateRef.current.startY },
                p2: { x: pos.x, y: pos.y },
            })
        } else if (activeDraft.kind === 'radial') {
            const cx = (dragStateRef.current.startX + pos.x) / 2
            const cy = (dragStateRef.current.startY + pos.y) / 2
            const dx = pos.x - dragStateRef.current.startX
            const dy = pos.y - dragStateRef.current.startY
            const rx = Math.max(0.001, Math.abs(dx) / 2)
            const ry = Math.max(0.001, Math.abs(dy) / 2)
            const rot = Math.atan2(dy, dx)
            updateLayer(activeDraft.layerId, {
                center: { x: cx, y: cy },
                radius: { x: rx, y: ry },
                rotation: rot,
            })
        }
    }, [activeDraft, canvasEditor, pointerToImage, updateLayer])

    // Commit the draft. The layer keeps whatever geometry it has.
    // Only clears `activeDraft` if a drag actually started — clicking
    // outside the canvas (e.g. on a UI button) before clicking the canvas
    // should NOT silently commit a layer with default p1/p2.
    const handleSpatialDragEnd = useCallback(() => {
        if (!activeDraft) return
        if (dragStateRef.current) {
            dragStateRef.current = null
            setActiveDraft(null)
        }
    }, [activeDraft])

    // Cancel the draft (Esc key). The just-added layer is removed so the
    // chain stays clean — the user opted out.
    const handleSpatialCancel = useCallback(() => {
        if (!activeDraft) return
        removeLayer(activeDraft.layerId)
        setActiveDraft(null)
        dragStateRef.current = null
    }, [activeDraft, removeLayer])

    // Wire fabric's mouse:down when a draft is active. We use
    // window-level mousemove/mouseup (added in a separate effect) so
    // drags that escape the canvas still finalise.
    useEffect(() => {
        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas || !activeDraft) return
        fabricCanvas.defaultCursor = 'crosshair'
        fabricCanvas.selection = false
        const onDown = (e) => handleSpatialDragStart(e)
        fabricCanvas.on('mouse:down', onDown)
        return () => {
            fabricCanvas.defaultCursor = 'default'
            fabricCanvas.selection = true
            fabricCanvas.off('mouse:down', onDown)
        }
    }, [activeDraft, canvasEditor, handleSpatialDragStart])

    // Window-level move + up so off-canvas drags still update + commit.
    useEffect(() => {
        if (!activeDraft) return
        const onMove = (e) => {
            // Build a fabric-event-shaped object so pointerToImage can
            // use the same getPointer() API. We synthesise `e.e` with the
            // raw DOM event so the conversion is uniform.
            const fakeEvent = { e }
            handleSpatialDragMove(fakeEvent)
        }
        const onUp = () => handleSpatialDragEnd()
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        return () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
        }
    }, [activeDraft, handleSpatialDragMove, handleSpatialDragEnd])

    // Esc cancels the active draft. We use a ref for the cancel handler
    // so the keydown listener is only attached/detached when the draft
    // itself appears or disappears. If we listed `handleSpatialCancel`
    // in the deps directly, its identity changes on every stack mutation
    // (because `removeLayer` closes over `stack`), and that fires on
    // every mousemove tick of the drag — the listener would be detached
    // and re-added per pixel of movement.
    const handleSpatialCancelRef = useRef(handleSpatialCancel)
    handleSpatialCancelRef.current = handleSpatialCancel
    useEffect(() => {
        if (!activeDraft) return
        const onKey = (e) => { if (e.key === 'Escape') handleSpatialCancelRef.current() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [activeDraft])

    /* ─── Semantic (SAM 2) click-to-select (Step 5) ─── */

    // Active click-mode flag — when true, mouse clicks on the canvas are
    // captured as SAM 2 click points (positive by default, negative with
    // the Alt key held). Disabled while another tool (color picker,
    // spatial draft) is active so handlers don't fight over mouse:down.
    const [semanticActive, setSemanticActive] = useState(false)
    // List of `[x, y, label]` clicks in *original* (natural) image-pixel
    // coordinates. We accumulate here, then send the whole array to
    // /api/ai/sam2 in one request when the user hits "Run".
    const [semanticClicks, setSemanticClicks] = useState(/** @type {Array<[number, number, 0 | 1]>} */ ([]))
    const [isSemanticRunning, setIsSemanticRunning] = useState(false)
    const isSemanticRunningRef = useRef(false)
    const semanticAbortRef = useRef(/** @type {AbortController | null} */ (null))
    // Decoded mask ImageData for the most recent successful run, kept
    // around so the user can re-add it as a megashader layer without
    // re-hitting the API. Cleared on reset.
    const [lastSemanticMask, setLastSemanticMask] = useState(null)
    // Live preview of the decoded mask, rendered as an HTMLCanvasElement
    // so the user sees what they got before committing to a layer.
    const [lastSemanticPreview, setLastSemanticPreview] = useState(/** @type {string | null} */ (null))
    // Refs to the live preview marker dots (one Fabric Circle per click)
    // so we can draw/erase them in lockstep with `semanticClicks`.
    const semanticMarkerRefs = useRef(/** @type {Array<any>} */ ([]))

    const handleSemanticClick = useCallback((e) => {
        if (!semanticActive || !tool.mainImage) return
        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas) return
        const pos = pointerToImage(fabricCanvas, e)
        if (!pos) return
        // The route validates bounds server-side, but rejecting obvious
        // out-of-bounds clicks here saves a roundtrip + 400 response.
        const sourceEl = tool.mainImage._element || tool.mainImage.getElement?.()
        const w = sourceEl?.naturalWidth || 0
        const h = sourceEl?.naturalHeight || 0
        if (w > 0 && h > 0 && (pos.x < 0 || pos.y < 0 || pos.x >= w || pos.y >= h)) {
            toast('Click is outside the image bounds', { icon: '⚠️' })
            return
        }
        // Alt-click = negative (exclude) click. e.e.altKey is the DOM
        // event alt modifier; fall back to false for synthetic events.
        const isNegative = Boolean(e?.e?.altKey)
        const x = Math.round(pos.x * 100) / 100
        const y = Math.round(pos.y * 100) / 100
        setSemanticClicks((prev) => [...prev, [x, y, isNegative ? 0 : 1]])
    }, [semanticActive, tool.mainImage, canvasEditor, pointerToImage])

    // Wire the canvas click handler whenever semantic mode is active.
    // The cleanup is critical — without it, a leaked mouse:down handler
    // would keep capturing clicks after the user leaves the tool.
    useEffect(() => {
        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas) return
        if (!semanticActive) return
        fabricCanvas.defaultCursor = 'crosshair'
        const onDown = (e) => handleSemanticClick(e)
        fabricCanvas.on('mouse:down', onDown)
        return () => {
            fabricCanvas.defaultCursor = 'default'
            fabricCanvas.off('mouse:down', onDown)
        }
    }, [semanticActive, canvasEditor, handleSemanticClick])

    // Live markers — one small Fabric circle per click. Cyan = positive
    // (include), red = negative (exclude). Mirrors the click list so
    // removing a click from the list removes its marker too.
    useEffect(() => {
        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas || !tool.mainImage) return
        for (const m of semanticMarkerRefs.current) {
            try { fabricCanvas.remove(m) } catch { /* canvas gone */ }
        }
        semanticMarkerRefs.current = []
        if (!semanticActive) return
        for (const [x, y, label] of semanticClicks) {
            const d = imageToDisplay(x, y)
            if (!d) continue
            const marker = new FabricCircle({
                left: d.x,
                top: d.y,
                radius: 6,
                fill: label === 1 ? 'rgba(6, 184, 212, 0.85)' : 'rgba(239, 68, 68, 0.85)',
                stroke: '#ffffff',
                strokeWidth: 1.5,
                originX: 'center',
                originY: 'center',
                selectable: false,
                evented: false,
                excludeFromExport: true,
            })
            fabricCanvas.add(marker)
            semanticMarkerRefs.current.push(marker)
        }
        fabricCanvas.requestRenderAll()
        return () => {
            for (const m of semanticMarkerRefs.current) {
                try { fabricCanvas.remove(m) } catch { /* canvas gone */ }
            }
            semanticMarkerRefs.current = []
            fabricCanvas.requestRenderAll()
        }
    }, [semanticActive, semanticClicks, canvasEditor, tool.mainImage, imageToDisplay])

    const handleSemanticReset = useCallback(() => {
        setSemanticClicks([])
        setLastSemanticMask(null)
        setLastSemanticPreview(null)
    }, [])

    const handleSemanticStop = useCallback(() => {
        setSemanticActive(false)
        setSemanticClicks([])
        setLastSemanticMask(null)
        setLastSemanticPreview(null)
    }, [])

    // Decode a Blob (PNG) to an HTMLImageElement + ImageData. The
    // ImageData is what we store in the mask texture cache; the
    // HTMLImageElement is what we draw to a 2D canvas to get the
    // ImageData (canvas can't read PNGs directly). We return both so
    // the caller can also produce a small preview data URL.
    const decodeMaskBlob = useCallback(async (blob) => {
        const objectUrl = URL.createObjectURL(blob)
        try {
            const img = await new Promise((resolve, reject) => {
                const image = new Image()
                image.crossOrigin = 'anonymous'
                image.onload = () => resolve(image)
                image.onerror = () => reject(new Error('Failed to decode mask PNG'))
                image.src = objectUrl
            })
            const c = document.createElement('canvas')
            c.width = img.naturalWidth || img.width
            c.height = img.naturalHeight || img.height
            const ctx = c.getContext('2d', { willReadFrequently: true })
            if (!ctx) throw new Error('Could not get 2D context for mask decode')
            ctx.drawImage(img, 0, 0)
            const imageData = ctx.getImageData(0, 0, c.width, c.height)
            return { imageData, width: c.width, height: c.height, dataUrl: c.toDataURL('image/png') }
        } finally {
            URL.revokeObjectURL(objectUrl)
        }
    }, [])

    const handleSemanticRun = useCallback(async () => {
        if (!tool.mainImage) return
        // Read the in-flight flag from a ref, not from closure-captured
        // state — a fast double-click can otherwise launch two concurrent
        // fetches and race to overwrite the decoded mask.
        if (isSemanticRunningRef.current) return
        if (semanticClicks.length === 0) {
            toast('Add at least one click first')
            return
        }
        const sourceEl = tool.mainImage._element || tool.mainImage.getElement?.()
        if (!sourceEl) {
            toast.error('Image not ready')
            return
        }
        // Cancel any earlier in-flight request so it can't resolve and
        // clobber our state if it was slower than us.
        try { semanticAbortRef.current?.abort() } catch { /* ignore */ }
        const abortController = new AbortController()
        semanticAbortRef.current = abortController
        isSemanticRunningRef.current = true
        setIsSemanticRunning(true)
        try {
            // Resize source for the upload (matches the route's MAX_MODEL_SIDE
            // so we don't burn bandwidth shipping 12MP images over the wire).
            const origW = sourceEl.naturalWidth || sourceEl.width
            const origH = sourceEl.naturalHeight || sourceEl.height
            const MAX_UPLOAD_SIDE = 1024
            const scale = Math.min(1, MAX_UPLOAD_SIDE / Math.max(origW, origH))
            const uploadW = Math.max(1, Math.round(origW * scale))
            const uploadH = Math.max(1, Math.round(origH * scale))

            const c = document.createElement('canvas')
            c.width = uploadW
            c.height = uploadH
            const ctx = c.getContext('2d')
            if (!ctx) throw new Error('Could not allocate upload canvas')
            ctx.drawImage(sourceEl, 0, 0, uploadW, uploadH)
            const blob = await new Promise((resolve, reject) => {
                c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.85)
            })

            // The route expects clicks in *original* image-pixel space;
            // it scales them to the prepared (resized) image internally
            // and returns a mask at original resolution. So we just send
            // the raw click coords.
            const form = new FormData()
            form.append('image', blob, 'image.jpg')
            form.append('clicks', JSON.stringify(semanticClicks))

            const resp = await fetch('/api/ai/sam2', { method: 'POST', body: form, signal: abortController.signal })
            if (!resp.ok) {
                const errJson = await resp.json().catch(() => ({}))
                throw new Error(errJson.error || `SAM 2 request failed (${resp.status})`)
            }
            const maskBlob = await resp.blob()
            const decoded = await decodeMaskBlob(maskBlob)

            // If a newer request was kicked off while we were decoding,
            // its results supersede ours — bail without writing state.
            if (semanticAbortRef.current !== abortController) return
            setLastSemanticMask(decoded.imageData)
            setLastSemanticPreview(decoded.dataUrl)
            toast.success(`Subject selected (${decoded.width}×${decoded.height})`)
        } catch (err) {
            // AbortError is the expected outcome of a user-initiated
            // cancel; don't surface it as a failure toast.
            if (err?.name === 'AbortError') return
            console.error('[mask] SAM 2 selection failed:', err)
            toast.error(err?.message || 'AI selection failed')
        } finally {
            // Only clear the running flag if we're still the latest
            // request — a newer one will manage its own lifecycle.
            if (semanticAbortRef.current === abortController) {
                isSemanticRunningRef.current = false
                setIsSemanticRunning(false)
            }
        }
    }, [tool, semanticClicks, decodeMaskBlob])

    // Add the most recent decoded mask as a megashader layer. The
    // texture is stored in the module-level mask cache under a freshly
    // minted key, then the layer is pushed through the normal
    // `addLayer` path so all the existing dispatch / state machinery
    // works unchanged.
    const handleAddSemanticLayer = useCallback(() => {
        if (!lastSemanticMask) {
            toast('Run the click selection first')
            return
        }
        const key = `semantic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        setMaskTexture(key, lastSemanticMask)
        const id = addChainLayer('semantic', { maskTextureKey: key, feather: 0.1, label: 'AI Subject' })
        if (id) toast.success('Semantic layer added to chain')
        // Clear the working state so the user knows the layer is now
        // managed by the chain (and so they don't accidentally add
        // the same mask twice).
        setLastSemanticMask(null)
        setLastSemanticPreview(null)
        setSemanticClicks([])
        setSemanticActive(false)
    }, [lastSemanticMask, addChainLayer])

    /* ─── Depth (Depth Anything V2) (Step 6) ─── */

    // Single-shot depth state. Unlike SAM 2 there's no click accumulation
    // — the user hits "Generate" once, gets a whole-image depth map, and
    // can then add it to the chain with custom min/max/softness.
    const [isDepthRunning, setIsDepthRunning] = useState(false)
    const isDepthRunningRef = useRef(false)
    const depthAbortRef = useRef(/** @type {AbortController | null} */ (null))
    const [lastDepthMap, setLastDepthMap] = useState(null)
    const [lastDepthPreview, setLastDepthPreview] = useState(/** @type {string | null} */ (null))
    // Per-add depth range settings. Re-used for the next "Add to Mask
    // Layers" — reset on add so the next generation starts fresh.
    const [depthMin, setDepthMin] = useState(0)
    const [depthMax, setDepthMax] = useState(0.5)
    const [depthSoftness, setDepthSoftness] = useState(0.1)

    // Keep the min slider below the max slider in real time. Without this,
    // a user dragging min past max would see a layer with an empty range
    // (the factory silently swaps them, but the sliders stay crossed,
    // and the visual result won't match what the UI is showing). The 0.01
    // floor on the gap matches the slider's `step` so the result is a
    // legal [min, max] pair for the factory.
    const setDepthMinBounded = useCallback((v) => {
        setDepthMin((cur) => {
            const upper = depthMax
            if (v >= upper) return Math.max(0, upper - 0.01)
            return v
        })
    }, [depthMax])
    const setDepthMaxBounded = useCallback((v) => {
        setDepthMax((cur) => {
            const lower = depthMin
            if (v <= lower) return Math.min(1, lower + 0.01)
            return v
        })
    }, [depthMin])

    const handleDepthRun = useCallback(async () => {
        if (!tool.mainImage) return
        if (isDepthRunningRef.current) return
        const sourceEl = tool.mainImage._element || tool.mainImage.getElement?.()
        if (!sourceEl) {
            toast.error('Image not ready')
            return
        }
        try { depthAbortRef.current?.abort() } catch { /* ignore */ }
        const abortController = new AbortController()
        depthAbortRef.current = abortController
        isDepthRunningRef.current = true
        setIsDepthRunning(true)
        try {
            // Cap to 1024 for upload size — depth model runs at 518×518
            // internally so anything bigger is wasted bandwidth.
            const origW = sourceEl.naturalWidth || sourceEl.width
            const origH = sourceEl.naturalHeight || sourceEl.height
            const MAX_UPLOAD_SIDE = 1024
            const scale = Math.min(1, MAX_UPLOAD_SIDE / Math.max(origW, origH))
            const uploadW = Math.max(1, Math.round(origW * scale))
            const uploadH = Math.max(1, Math.round(origH * scale))

            const c = document.createElement('canvas')
            c.width = uploadW
            c.height = uploadH
            const ctx = c.getContext('2d')
            if (!ctx) throw new Error('Could not allocate upload canvas')
            ctx.drawImage(sourceEl, 0, 0, uploadW, uploadH)
            const blob = await new Promise((resolve, reject) => {
                c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.85)
            })

            const form = new FormData()
            form.append('image', blob, 'image.jpg')

            const resp = await fetch('/api/ai/depth', { method: 'POST', body: form, signal: abortController.signal })
            if (!resp.ok) {
                const errJson = await resp.json().catch(() => ({}))
                throw new Error(errJson.error || `Depth request failed (${resp.status})`)
            }
            const depthBlob = await resp.blob()
            const decoded = await decodeMaskBlob(depthBlob)

            if (depthAbortRef.current !== abortController) return
            setLastDepthMap(decoded.imageData)
            setLastDepthPreview(decoded.dataUrl)
            const elapsed = resp.headers.get('x-elapsed-ms') || '?'
            toast.success(`Depth map generated (${decoded.width}×${decoded.height}, ${elapsed}ms)`)
        } catch (err) {
            if (err?.name === 'AbortError') return
            console.error('[mask] Depth generation failed:', err)
            toast.error(err?.message || 'Depth generation failed')
        } finally {
            if (depthAbortRef.current === abortController) {
                isDepthRunningRef.current = false
                setIsDepthRunning(false)
            }
        }
    }, [tool, decodeMaskBlob])

    // Add the most recent depth map as a megashader layer with the user's
    // current min/max/softness. The texture lives in the same module-level
    // cache as semantic masks, so the renderer can pick it up by key.
    const handleAddDepthLayer = useCallback(() => {
        if (!lastDepthMap) {
            toast('Generate a depth map first')
            return
        }
        const key = `depth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        setMaskTexture(key, lastDepthMap)
        const id = addChainLayer('depth', {
            depthMapKey: key,
            min: depthMin,
            max: depthMax,
            softness: depthSoftness,
            label: 'Depth range',
        })
        if (id) toast.success('Depth layer added to chain')
        // Clear the working state so the user knows the layer is now
        // managed by the chain.
        setLastDepthMap(null)
        setLastDepthPreview(null)
    }, [lastDepthMap, addChainLayer, depthMin, depthMax, depthSoftness])

    const handleDepthReset = useCallback(() => {
        setLastDepthMap(null)
        setLastDepthPreview(null)
    }, [])

    /* ─── Smart Brush (Step 7) ─── */
    //
    // The user paints an alpha stroke on an offscreen HTMLCanvasElement
    // that lives in the source image's natural pixel space. The canvas
    // is uploaded to the megashader as a sampler2D, where the GLSL body
    // runs a bilateral filter so the stroke "snaps" to colour edges in
    // the source image rather than bleeding across them.
    //
    // Lifecycle:
    //   1. User clicks "Start Painting" — we allocate the brush canvas
    //      (matching the image's natural size), add a FabricImage live
    //      preview, and lock the canvas cursor to a crosshair.
    //   2. User drags on the canvas — pointer events stamp soft radial
    //      alpha circles onto the brush canvas. The live overlay's
    //      element is the same brush canvas, so updates are instant.
    //   3. User clicks "Add to Mask Layers" — we put the brush canvas
    //      into the mask texture cache, push a smartBrushLayer onto
    //      the chain with the current filter parameters, then reset
    //      the brush canvas and exit paint mode.
    //
    // The brush size / hardness / filter settings are local state
    // (not chain state) — they only become "real" when the user adds
    // the layer. After adding, the user can still tweak filter params
    // via the chain card's `KindParamEditor` (already supports per-layer
    // params via the smartBrushLayer factory's clamps).

    const [brushActive, setBrushActive] = useState(false)
    const [brushSize, setBrushSize] = useState(40)
    const [brushHardness, setBrushHardness] = useState(0.8)
    const [filterRadius, setFilterRadius] = useState(3)
    const [sigmaColor, setSigmaColor] = useState(0.15)
    const [sigmaSpace, setSigmaSpace] = useState(2)
    const [brushHasContent, setBrushHasContent] = useState(false)

    // Refs (so pointer handlers and effects read consistent values
    // without re-binding effects on every slider tweak).
    const brushCanvasRef = useRef(/** @type {HTMLCanvasElement | null} */ (null))
    const brushOverlayRef = useRef(/** @type {any} */ (null))
    const isPaintingRef = useRef(false)
    const lastBrushPointRef = useRef(null)
    const brushSizeRef = useRef(brushSize)
    const brushHardnessRef = useRef(brushHardness)
    const filterRadiusRef = useRef(filterRadius)
    const sigmaColorRef = useRef(sigmaColor)
    const sigmaSpaceRef = useRef(sigmaSpace)

    // Step 10.1: cap the brush canvas to 2048×2048 max. A 4K image
    // would otherwise allocate a 33 MB RGBA brush canvas (and an 8K
    // image, 132 MB). The cap preserves the aspect ratio of the
    // source image — `brushScale` is the factor (1.0 for ≤2048 long
    // edge, <1.0 for larger). Pointer events and stamp radii are
    // pre-multiplied by `brushScale` when handed to the brush canvas
    // 2D context, so the brush state is in brush-canvas space while
    // the UI's slider value remains in image-pixel space.
    //
    // The GLSL doesn't need to know about `brushScale` — it samples
    // the brush texture using normalized UV (`vTextureCoord`), so a
    // 2048×2048 brush canvas is correctly mapped onto a 4K render
    // output via the GPU's default linear filtering. The visible
    // difference is a slightly softer brush at high zoom, which is
    // the natural trade-off for ~16× less memory.
    const BRUSH_CANVAS_MAX_DIM = 2048
    const brushScaleRef = useRef(1)

    useEffect(() => { brushSizeRef.current = brushSize }, [brushSize])
    useEffect(() => { brushHardnessRef.current = brushHardness }, [brushHardness])
    useEffect(() => { filterRadiusRef.current = filterRadius }, [filterRadius])
    useEffect(() => { sigmaColorRef.current = sigmaColor }, [sigmaColor])
    useEffect(() => { sigmaSpaceRef.current = sigmaSpace }, [sigmaSpace])

    // Push the live `brushActive` flag into `pixelToolDisabled` so the
    // pixel tool's pointer handlers short-circuit. Without this, a
    // single click in smart-brush mode would fire BOTH brushes — the
    // pixel tool would write a clipPath dab AND the smart brush would
    // write a texture dab, leaving the user with two unrelated masks
    // for one click. Declaring this effect after the `brushActive`
    // `useState` is intentional: it satisfies the temporal-dead-zone
    // rule (the variable is in scope on this line of source) and the
    // effect itself just runs once on mount with the current value.
    useEffect(() => { setPixelToolDisabled(brushActive) }, [brushActive])

    // Allocate a fresh brush canvas, capped to BRUSH_CANVAS_MAX_DIM on
    // the long edge. Called both on entering brush mode (if the image
    // is ready) and on adding a layer (to clear the slate for the
    // next stroke).
    //
    // The cap preserves aspect ratio: for a 3840×2160 (4K) image, the
    // long edge is 3840; scale = 2048/3840 ≈ 0.5333; the brush canvas
    // becomes 2048×1152. For an 8K (7680×4320) image, scale ≈ 0.2667;
    // the brush canvas becomes 2048×1152 — a 16× memory reduction
    // (33 MB → 2 MB). For images already at or below 2048 on the
    // long edge, scale = 1 and behaviour is unchanged.
    const ensureBrushCanvas = useCallback(() => {
        if (!imageSize) return null
        const longEdge = Math.max(imageSize.width, imageSize.height)
        const scale = longEdge > BRUSH_CANVAS_MAX_DIM
            ? BRUSH_CANVAS_MAX_DIM / longEdge
            : 1
        const targetW = Math.max(1, Math.round(imageSize.width * scale))
        const targetH = Math.max(1, Math.round(imageSize.height * scale))
        if (brushCanvasRef.current
            && brushCanvasRef.current.width === targetW
            && brushCanvasRef.current.height === targetH) {
            brushScaleRef.current = scale
            return brushCanvasRef.current
        }
        const c = document.createElement('canvas')
        c.width = targetW
        c.height = targetH
        brushCanvasRef.current = c
        brushScaleRef.current = scale
        return c
    }, [imageSize])

    // Paint a single soft alpha stamp at (x, y) with the given radius
    // and hardness (0..1). Hardness controls the size of the opaque
    // inner disc relative to the full stamp radius — a soft brush
    // (hardness=0) is a pure radial gradient; a hard brush
    // (hardness=1) is a full opaque disc.
    const stampBrush = useCallback((ctx, x, y, radius, hardness) => {
        if (!ctx || radius <= 0) return
        const h = Math.max(0, Math.min(1, hardness))
        if (h >= 0.999) {
            // Hard brush: single fill (faster, no gradient).
            ctx.fillStyle = 'rgba(255, 255, 255, 1)'
            ctx.beginPath()
            ctx.arc(x, y, radius, 0, Math.PI * 2)
            ctx.fill()
            return
        }
        const grad = ctx.createRadialGradient(x, y, 0, x, y, radius)
        grad.addColorStop(0, 'rgba(255, 255, 255, 1)')
        grad.addColorStop(h, 'rgba(255, 255, 255, 1)')
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(x, y, radius, 0, Math.PI * 2)
        ctx.fill()
    }, [])

    // Interpolate stamps along a line from (x1, y1) → (x2, y2) so fast
    // drags don't show gaps. The step is `radius / 3` — three stamps
    // per diameter gives smooth coverage without overdraw.
    const strokeBrush = useCallback((ctx, x1, y1, x2, y2, radius, hardness) => {
        if (!ctx) return
        const dx = x2 - x1
        const dy = y2 - y1
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < 0.5) {
            // Sub-pixel drag — single stamp.
            stampBrush(ctx, x2, y2, radius, hardness)
            return
        }
        const step = Math.max(1, radius / 3)
        const n = Math.max(1, Math.ceil(dist / step))
        for (let i = 1; i <= n; i += 1) {
            const t = i / n
            stampBrush(ctx, x1 + dx * t, y1 + dy * t, radius, hardness)
        }
    }, [stampBrush])

    // Mark the brush canvas as "has content" (drives the Add button
    // enable state). Called from a `useEffect` that observes the
    // overlay's `dirty` flag via a polling tick — too lazy but cheap.
    // A `requestAnimationFrame` after each stamp is more idiomatic; see
    // the pointer move handler below.
    const markBrushChanged = useCallback(() => {
        setBrushHasContent(true)
    }, [])

    /* ─── Brush pointer handlers (active only while `brushActive`) ─── */

    const handleBrushDown = useCallback((e) => {
        if (!brushActive || !imageSize) return
        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas) return
        const pos = pointerToImage(fabricCanvas, e)
        if (!pos) return
        // Reject clicks outside the image bounds (the brush canvas is
        // sized to the image, so out-of-bounds clicks would silently
        // no-op the stamp, which is confusing).
        if (pos.x < 0 || pos.y < 0 || pos.x >= imageSize.width || pos.y >= imageSize.height) return
        const canvas = ensureBrushCanvas()
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        isPaintingRef.current = true
        lastBrushPointRef.current = { x: pos.x, y: pos.y }
        // Step 10.1: scale the stamp position and radius into
        // brush-canvas space. `brushScale` is 1.0 for images already
        // at or below 2048 on the long edge, <1.0 for higher-res
        // sources. The UI's `brushSize` slider stays in image-pixel
        // units, so this is the only place the scaling happens.
        const s = brushScaleRef.current
        const r = Math.max(0.5, brushSizeRef.current / 2) * s
        stampBrush(ctx, pos.x * s, pos.y * s, r, brushHardnessRef.current)
        markBrushChanged()
        if (brushOverlayRef.current) {
            brushOverlayRef.current.set('dirty', true)
            fabricCanvas.requestRenderAll()
        }
    }, [brushActive, imageSize, canvasEditor, pointerToImage, ensureBrushCanvas, stampBrush, markBrushChanged])

    const handleBrushMove = useCallback((e) => {
        if (!isPaintingRef.current || !brushActive) return
        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas) return
        const pos = pointerToImage(fabricCanvas, e)
        if (!pos) return
        // Clamp to image bounds so a drag past the edge doesn't paint
        // outside the brush canvas (which would be clipped to transparent
        // by `destination-out` in the stamp).
        const w = imageSize?.width || 0
        const h = imageSize?.height || 0
        const cx = w > 0 ? Math.max(0, Math.min(w, pos.x)) : pos.x
        const cy = h > 0 ? Math.max(0, Math.min(h, pos.y)) : pos.y
        const canvas = ensureBrushCanvas()
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const last = lastBrushPointRef.current || { x: cx, y: cy }
        // Step 10.1: scale into brush-canvas space. `last` is stored
        // in image-pixel space (so the deltas across moves are
        // consistent), but `strokeBrush` is called with scaled
        // coordinates so the 2D context stamps the right pixels.
        const s = brushScaleRef.current
        const r = Math.max(0.5, brushSizeRef.current / 2) * s
        strokeBrush(ctx, last.x * s, last.y * s, cx * s, cy * s, r, brushHardnessRef.current)
        lastBrushPointRef.current = { x: cx, y: cy }
        markBrushChanged()
        if (brushOverlayRef.current) {
            brushOverlayRef.current.set('dirty', true)
            // Throttle the render to one per frame — without this, fast
            // drags fire dozens of mousemoves per frame and the GL
            // context sputters.
            fabricCanvas.requestRenderAll()
        }
    }, [brushActive, imageSize, canvasEditor, pointerToImage, ensureBrushCanvas, strokeBrush, markBrushChanged])

    const handleBrushUp = useCallback(() => {
        if (!isPaintingRef.current) return
        isPaintingRef.current = false
        lastBrushPointRef.current = null
    }, [])

    // Wire the pointer events when brush mode is active. Window-level
    // move + up so a drag that escapes the canvas still finalises.
    useEffect(() => {
        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas || !brushActive) return
        fabricCanvas.defaultCursor = 'crosshair'
        fabricCanvas.hoverCursor = 'crosshair'
        fabricCanvas.selection = false
        const onDown = (e) => handleBrushDown(e)
        const onMove = (e) => {
            const fake = { e }
            handleBrushMove(fake)
        }
        const onUp = () => handleBrushUp()
        fabricCanvas.on('mouse:down', onDown)
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        return () => {
            fabricCanvas.defaultCursor = 'default'
            fabricCanvas.hoverCursor = 'move'
            fabricCanvas.selection = true
            fabricCanvas.off('mouse:down', onDown)
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
        }
    }, [brushActive, canvasEditor, handleBrushDown, handleBrushMove, handleBrushUp])

    // Add / remove the live-preview FabricImage when brush mode toggles.
    // The overlay shares the brush canvas as its `_element` — any draw
    // to the canvas is visible on the next render with no extra sync.
    useEffect(() => {
        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas || !tool.mainImage) return
        if (!brushActive) {
            if (brushOverlayRef.current) {
                try { fabricCanvas.remove(brushOverlayRef.current) } catch { /* canvas gone */ }
                brushOverlayRef.current = null
                fabricCanvas.requestRenderAll()
            }
            return
        }
        const brushCanvas = ensureBrushCanvas()
        if (!brushCanvas) return
        // The brush canvas is in image-pixel space; mirror the main
        // image's transform so the overlay sits exactly on top of the
        // corresponding image pixels.
        const img = tool.mainImage
        const overlay = new FabricImage(brushCanvas, {
            left: img.left,
            top: img.top,
            scaleX: img.scaleX,
            scaleY: img.scaleY,
            angle: img.angle,
            originX: img.originX,
            originY: img.originY,
            flipX: img.flipX,
            flipY: img.flipY,
            selectable: false,
            evented: false,
            hasControls: false,
            hasBorders: false,
            objectCaching: false,
            excludeFromExport: true,
            opacity: 0.6,
        })
        fabricCanvas.add(overlay)
        // Move the overlay above the image but below the markers.
        // We just add it at the end — Fabric's z-order is the add order,
        // so the overlay sits on top of the image. The user's selection
        // handles still take priority (Fabric draws those last).
        brushOverlayRef.current = overlay
        fabricCanvas.requestRenderAll()
        return () => {
            if (brushOverlayRef.current) {
                try { fabricCanvas.remove(brushOverlayRef.current) } catch { /* canvas gone */ }
                brushOverlayRef.current = null
            }
        }
    }, [brushActive, canvasEditor, tool.mainImage, ensureBrushCanvas])

    // Re-position the overlay when the image's transform changes (pan,
    // zoom, rotate, flip). The overlay's `_element` doesn't change, so
    // we just patch the geometry fields. This effect is independent of
    // the add/remove effect above so pan-during-paint works.
    //
    // Why we depend on the transform fields explicitly (not just the
    // image reference): Fabric mutates the same FabricImage object on
    // zoom/rotate — the *reference* doesn't change, but `scaleX`/
    // `scaleY`/`angle`/`flipX`/`flipY`/`left`/`top` do. Subscribing to
    // the reference alone would miss those edits. We also depend on
    // the canvas viewport transform (indices 4 and 5) for pure pan
    // (where the image itself doesn't move, only the viewport does).
    const img = tool.mainImage
    const imgLeft = img?.left ?? 0
    const imgTop = img?.top ?? 0
    const imgScaleX = img?.scaleX ?? 1
    const imgScaleY = img?.scaleY ?? 1
    const imgAngle = img?.angle ?? 0
    const imgFlipX = !!img?.flipX
    const imgFlipY = !!img?.flipY
    const fabricViewport = canvasEditor?.canvas?.viewportTransform
    const panX = fabricViewport?.[4] ?? 0
    const panY = fabricViewport?.[5] ?? 0
    useEffect(() => {
        const overlay = brushOverlayRef.current
        const liveImg = tool.mainImage
        const fabricCanvas = canvasEditor?.canvas
        if (!overlay || !liveImg || !fabricCanvas) return
        overlay.set({
            left: liveImg.left,
            top: liveImg.top,
            scaleX: liveImg.scaleX,
            scaleY: liveImg.scaleY,
            angle: liveImg.angle,
            originX: liveImg.originX,
            originY: liveImg.originY,
            flipX: liveImg.flipX,
            flipY: liveImg.flipY,
        })
        overlay.setCoords?.()
        fabricCanvas.requestRenderAll()
    }, [
        tool.mainImage,
        brushActive,
        canvasEditor?.canvas,
        // Image transform fields — cover zoom, rotate, flip, move
        imgLeft, imgTop, imgScaleX, imgScaleY, imgAngle, imgFlipX, imgFlipY,
        // Viewport translate — covers pure pan (image not moving)
        panX, panY,
    ])

    const handleStartBrush = useCallback(() => {
        if (!imageSize) {
            toast.error('Image not ready yet')
            return
        }
        // Cancel any other click-mode so its handler doesn't fire.
        setColorPickerActive(false)
        setSemanticActive(false)
        handleSemanticStop()
        if (activeDraft) {
            toast('Finish or cancel the current draft first', { icon: 'ℹ️' })
            return
        }
        ensureBrushCanvas()
        // Reset stale "hasContent" state from a prior session — without
        // this, the Add button would be enabled before the user painted
        // anything (the flag was left true from the previous stroke).
        setBrushHasContent(false)
        isPaintingRef.current = false
        lastBrushPointRef.current = null
        setBrushActive(true)
        toast('Paint on the canvas. Click "Add to Mask Layers" when done.')
    }, [imageSize, ensureBrushCanvas, activeDraft, handleSemanticStop])

    const handleStopBrush = useCallback(() => {
        setBrushActive(false)
        isPaintingRef.current = false
        lastBrushPointRef.current = null
    }, [])

    const handleClearBrush = useCallback(() => {
        const c = brushCanvasRef.current
        if (!c) return
        const ctx = c.getContext('2d')
        if (!ctx) return
        ctx.clearRect(0, 0, c.width, c.height)
        setBrushHasContent(false)
        if (brushOverlayRef.current) {
            brushOverlayRef.current.set('dirty', true)
            canvasEditor?.canvas?.requestRenderAll?.()
        }
    }, [canvasEditor])

    // Commit the current brush canvas as a smart-brush megashader layer.
    // The brush canvas is stored in the mask texture cache (same cache
    // as semantic + depth); the factory uses `brushTextureKey` to look
    // it up at render time.
    const handleAddBrushLayer = useCallback(() => {
        const brushCanvas = brushCanvasRef.current
        if (!brushCanvas) {
            toast('Start painting first')
            return
        }
        const ctx = brushCanvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return
        // Empty check: scan a small grid of pixels (the brush canvas
        // defaults to fully transparent; if no sampled pixel has any
        // alpha, don't add the layer). We scan the *full* image with
        // a small stride so a single-click stroke of any size is
        // reliably detected. The cost is at most a few hundred getImageData
        // calls — each is a 4-byte read and the whole sweep is <10ms.
        let anyPainted = false
        const W = brushCanvas.width
        const H = brushCanvas.height
        const stride = 2
        outer: for (let y = 0; y < H; y += stride) {
            for (let x = 0; x < W; x += stride) {
                try {
                    const d = ctx.getImageData(x, y, 1, 1).data
                    if (d[3] > 0) { anyPainted = true; break outer }
                } catch { /* read error → assume painted */ anyPainted = true; break outer }
            }
        }
        if (!anyPainted) {
            toast('Paint something first')
            return
        }
        const key = `brush-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        setMaskTexture(key, brushCanvas)
        const id = addChainLayer('smartBrush', {
            brushTextureKey: key,
            filterRadius,
            sigmaColor,
            sigmaSpace,
            label: 'Smart brush',
        })
        if (id) {
            toast.success('Smart brush added to chain')
            // Reset the brush canvas for the next stroke. We allocate
            // a fresh canvas rather than clearing in place — the old
            // canvas is still referenced by the just-added layer, and
            // clearing it would mutate a cached texture.
            brushCanvasRef.current = null
            setBrushHasContent(false)
            setBrushActive(false)
            isPaintingRef.current = false
            lastBrushPointRef.current = null
        }
    }, [addChainLayer, filterRadius, sigmaColor, sigmaSpace])

    // Live preview overlay: a thin dashed line/ellipse on the canvas
    // that tracks the layer's current geometry. Re-rendered on every
    // stack change so the user sees the preview update mid-drag.
    useEffect(() => {
        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas) return
        if (overlayRef.current) {
            fabricCanvas.remove(overlayRef.current)
            overlayRef.current = null
        }
        if (!activeDraft) return
        const layer = stack.chain.find((e) => e.layer.id === activeDraft.layerId)?.layer
        if (!layer) return

        let overlay = null
        if (activeDraft.kind === 'linear' && layer.p1 && layer.p2) {
            const p1 = imageToDisplay(layer.p1.x, layer.p1.y)
            const p2 = imageToDisplay(layer.p2.x, layer.p2.y)
            if (p1 && p2) {
                overlay = new Line([p1.x, p1.y, p2.x, p2.y], {
                    stroke: '#06b8d4',
                    strokeWidth: 2,
                    strokeDashArray: [5, 5],
                    selectable: false,
                    evented: false,
                    excludeFromExport: true,
                })
            }
        } else if (activeDraft.kind === 'radial' && layer.center && layer.radius) {
            const c = imageToDisplay(layer.center.x, layer.center.y)
            if (c) {
                const scaleX = tool.mainImage?.scaleX || 1
                const scaleY = tool.mainImage?.scaleY || 1
                overlay = new Ellipse({
                    left: c.x,
                    top: c.y,
                    rx: layer.radius.x * scaleX,
                    ry: layer.radius.y * scaleY,
                    fill: 'rgba(6, 184, 212, 0.12)',
                    stroke: '#06b8d4',
                    strokeWidth: 2,
                    strokeDashArray: [5, 5],
                    originX: 'center',
                    originY: 'center',
                    angle: ((layer.rotation || 0) * 180) / Math.PI,
                    selectable: false,
                    evented: false,
                    excludeFromExport: true,
                })
            }
        }

        if (overlay) {
            fabricCanvas.add(overlay)
            overlayRef.current = overlay
            fabricCanvas.requestRenderAll()
        }
        return () => {
            if (overlayRef.current) {
                try { fabricCanvas.remove(overlayRef.current) } catch { /* canvas gone */ }
                overlayRef.current = null
                fabricCanvas.requestRenderAll()
            }
        }
    }, [activeDraft, stack, canvasEditor, imageToDisplay, tool.mainImage])

    /* ─── AI Subject Selection ─── */
    const handleSelectSubject = useCallback(async () => {
        if (!tool.mainImage) return
        if (isSegmentingRef.current) return
        try { segmentAbortRef.current?.abort() } catch { /* ignore */ }
        const abortController = new AbortController()
        segmentAbortRef.current = abortController
        isSegmentingRef.current = true
        setIsSegmenting(true)

        try {
            // Get the source image as a blob
            const fabricObj = tool.mainImage
            const sourceEl = fabricObj?._element || fabricObj?.getElement?.()
            if (!sourceEl) throw new Error('Cannot access image element')

            // Draw source to canvas and export as blob
            const c = document.createElement('canvas')
            const origW = sourceEl.naturalWidth || sourceEl.width || fabricObj.width
            const origH = sourceEl.naturalHeight || sourceEl.height || fabricObj.height
            // Cap to 1024 for upload size
            const scale = Math.min(1, 1024 / Math.max(origW, origH))
            c.width = Math.round(origW * scale)
            c.height = Math.round(origH * scale)
            const ctx = c.getContext('2d')
            ctx.drawImage(sourceEl, 0, 0, c.width, c.height)

            const blob = await new Promise((resolve, reject) => {
                c.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', 0.85)
            })

            const form = new FormData()
            form.append('image', blob, 'image.jpg')

            const resp = await fetch('/api/ai/segment', { method: 'POST', body: form, signal: abortController.signal })
            if (!resp.ok) {
                const errJson = await resp.json().catch(() => ({}))
                throw new Error(errJson.error || `Segmentation failed (${resp.status})`)
            }

            const maskBlob = await resp.blob()
            if (segmentAbortRef.current !== abortController) return
            const applied = await tool.applyExternalMaskBlob(maskBlob)
            if (applied) {
                toast.success('Subject selected! Use brush to refine.')
            } else {
                toast.error('Could not apply subject mask')
            }
        } catch (err) {
            if (err?.name === 'AbortError') return
            console.error('[mask] AI subject selection failed:', err)
            toast.error(err?.message || 'AI subject selection failed')
        } finally {
            if (segmentAbortRef.current === abortController) {
                isSegmentingRef.current = false
                setIsSegmenting(false)
            }
        }
    }, [tool])

    /* ─── Color Range ─── */
    const handleColorPick = useCallback((e) => {
        if (!colorPickerActive || !tool.mainImage) return

        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas) return

        // Get the pixel color at click position from the canvas
        const pointer = fabricCanvas.getPointer(e.e || e)
        const fabricObj = tool.mainImage
        const sourceEl = fabricObj?._element || fabricObj?.getElement?.()
        if (!sourceEl) return

        // Transform pointer to image coordinates
        const imgW = sourceEl.naturalWidth || sourceEl.width || fabricObj.width
        const imgH = sourceEl.naturalHeight || sourceEl.height || fabricObj.height
        const objLeft = fabricObj.left || 0
        const objTop = fabricObj.top || 0
        const objScaleX = fabricObj.scaleX || 1
        const objScaleY = fabricObj.scaleY || 1

        const localX = (pointer.x - objLeft) / objScaleX
        const localY = (pointer.y - objTop) / objScaleY

        if (localX < 0 || localY < 0 || localX >= imgW || localY >= imgH) return

        // Read the pixel color
        const c = document.createElement('canvas')
        c.width = imgW
        c.height = imgH
        const ctx = c.getContext('2d', { willReadFrequently: true })
        try { ctx.drawImage(sourceEl, 0, 0) } catch { return }

        const pixel = ctx.getImageData(Math.floor(localX), Math.floor(localY), 1, 1).data
        const color = { r: pixel[0], g: pixel[1], b: pixel[2] }
        setPickedColor(color)
        setColorPickerActive(false)

        // Apply the color range mask
        tool.applyColorRangeMask({ ...color, tolerance: colorTolerance })
    }, [colorPickerActive, tool, canvasEditor, colorTolerance])

    // Attach/detach canvas click listener for color picker
    React.useEffect(() => {
        const fabricCanvas = canvasEditor?.canvas
        if (!fabricCanvas) return

        if (colorPickerActive) {
            fabricCanvas.defaultCursor = 'crosshair'
            fabricCanvas.on('mouse:down', handleColorPick)
            return () => {
                fabricCanvas.defaultCursor = 'default'
                fabricCanvas.off('mouse:down', handleColorPick)
            }
        }
    }, [colorPickerActive, canvasEditor, handleColorPick])

    const handleApplyColorRange = useCallback(() => {
        if (!pickedColor) return
        tool.applyColorRangeMask({ ...pickedColor, tolerance: colorTolerance })
    }, [tool, pickedColor, colorTolerance])

    /* ─── Luminance Range ─── */
    const handleApplyLuminance = useCallback(() => {
        tool.applyLuminanceRangeMask({ minLuma: lumaMin, maxLuma: lumaMax })
    }, [tool, lumaMin, lumaMax])

    /* ─── Add to Mask Layers (megashader, non-destructive) ─── */

    // Push the current luminance settings onto the megashader chain as a
    // new layer, rather than baking them into the brush clipPath. The
    // megashader renders through the WebGL2 filter and composes
    // independently of the brush — both stay live until cleared.
    const handleAddLuminanceLayer = useCallback(() => {
        const min = Math.min(lumaMin, lumaMax - 1) / 255
        const max = Math.max(lumaMin + 1, lumaMax) / 255
        addChainLayer('luminance', { min, max, softness: 0.1 })
        toast.success('Luminance layer added')
    }, [addChainLayer, lumaMin, lumaMax])

    // Convert picked {r,g,b} (0..255) to HSB (0..360, 0..1, 0..1) so the
    // megashader can match against the same colour space the GLSL uses.
    // Tolerance maps from the 5..100 slider to the megashader's 0..1 range.
    const handleAddColorLayer = useCallback(() => {
        if (!pickedColor) return
        const target = rgbToHsb(pickedColor.r, pickedColor.g, pickedColor.b)
        const tolerance = Math.max(0.01, Math.min(0.5, colorTolerance / 100))
        addChainLayer('color', {
            target,
            tolerance,
            softness: 0.1,
        })
        toast.success('Color layer added')
    }, [addChainLayer, pickedColor, colorTolerance])

    const handleAddGradientLayer = useCallback(() => {
        // Linear gradient: adds a real linear layer to the megashader chain
        // and enters draft mode. The user then drags on the canvas to set
        // p1 (start) → p2 (end) of the line. Esc cancels, mouse-up commits.
        if (activeDraft) {
            toast('Finish or cancel the current draft first', { icon: 'ℹ️' })
            return
        }
        if (!imageSize) {
            toast.error('Image not ready yet')
            return
        }
        // Cancel color-picker mode so its mouse:down handler doesn't fire
        // alongside the spatial drag's mouse:down on the same canvas click.
        setColorPickerActive(false)
        const id = addChainLayer('linear', { imageSize, label: 'Linear gradient' })
        if (id) {
            setActiveDraft({ kind: 'linear', layerId: id })
            toast('Drag on the canvas to set the line (Esc to cancel)')
        }
    }, [activeDraft, addChainLayer, imageSize])

    const handleAddRadialLayer = useCallback(() => {
        // Radial gradient: adds a real radial layer and enters draft mode.
        // The user drags a bounding box; center = midpoint, rx/ry = half the
        // drag distance per axis, rotation = atan2 of the drag vector.
        if (activeDraft) {
            toast('Finish or cancel the current draft first', { icon: 'ℹ️' })
            return
        }
        if (!imageSize) {
            toast.error('Image not ready yet')
            return
        }
        setColorPickerActive(false)
        const id = addChainLayer('radial', { imageSize, label: 'Radial gradient' })
        if (id) {
            setActiveDraft({ kind: 'radial', layerId: id })
            toast('Drag on the canvas to set the ellipse (Esc to cancel)')
        }
    }, [activeDraft, addChainLayer, imageSize])

    /* ─── Gradient ─── */
    const handleApplyGradient = useCallback(() => {
        tool.applyLinearGradientMask({
            direction: gradDirection,
            position: gradPosition,
            featherPct: gradFeather,
        })
    }, [tool, gradDirection, gradPosition, gradFeather])

    if (!canvasEditor) {
        return (
            <div className="p-4">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Canvas not ready</p>
            </div>
        )
    }

    if (!tool.mainImage) {
        return (
            <ToolEmptyState
                icon={Scissors}
                title="No image on canvas"
                subtitle="Add an image first, then use the mask tool"
            />
        )
    }

    return (
        <div className="space-y-0 overflow-y-auto pr-1 panel-scroll">
            {/* ────────── AI Masking ────────── */}
            <Section title="AI Masking" icon={Sparkles} defaultOpen={true} badge="AI">
                <motion.button
                    type="button"
                    onClick={handleSelectSubject}
                    disabled={isSegmenting}
                    whileTap={{ scale: 0.97 }}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-50"
                    style={{
                        background: 'linear-gradient(135deg, rgba(6,184,212,0.15) 0%, rgba(124,58,237,0.12) 100%)',
                        border: '1px solid rgba(6,184,212,0.25)',
                        color: 'var(--accent-primary)',
                    }}
                >
                    {isSegmenting ? (
                        <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Detecting Subject…
                        </>
                    ) : (
                        <>
                            <Sparkles className="h-4 w-4" />
                            Select Subject
                        </>
                    )}
                </motion.button>
                <p className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>
                    AI detects and masks the main subject
                </p>
            </Section>

            {/* ────────── Click-to-Select (SAM 2) ────────── */}
            <Section title="Click to Select" icon={MousePointer} badge="STEP 5">
                <div className="space-y-2">
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        Click to mark the subject, then run SAM 2. Hold{' '}
                        <kbd className="px-1 rounded text-[9px]" style={{ background: 'var(--bg-elevated)' }}>Alt</kbd>{' '}
                        to mark background (negative click).
                    </p>

                    <div className="flex items-center gap-1.5">
                        {!semanticActive ? (
                            <motion.button
                                type="button"
                                onClick={() => {
                                    setColorPickerActive(false)
                                    if (activeDraft) {
                                        toast('Finish or cancel the current draft first', { icon: 'ℹ️' })
                                        return
                                    }
                                    setSemanticActive(true)
                                    toast('Click the subject on the canvas')
                                }}
                                whileTap={{ scale: 0.97 }}
                                className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: 'rgba(124,58,237,0.08)',
                                    border: '1px solid rgba(124,58,237,0.25)',
                                    color: '#A78BFA',
                                }}
                            >
                                <Crosshair className="h-3.5 w-3.5" />
                                Start Clicking
                            </motion.button>
                        ) : (
                            <motion.button
                                type="button"
                                onClick={handleSemanticStop}
                                whileTap={{ scale: 0.97 }}
                                className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: 'rgba(239,68,68,0.10)',
                                    border: '1px solid rgba(239,68,68,0.30)',
                                    color: '#FCA5A5',
                                }}
                            >
                                <X className="h-3.5 w-3.5" />
                                Stop
                            </motion.button>
                        )}
                        <motion.button
                            type="button"
                            onClick={handleSemanticReset}
                            disabled={!semanticActive || (semanticClicks.length === 0 && !lastSemanticMask)}
                            whileTap={{ scale: 0.97 }}
                            className="flex items-center justify-center gap-1 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive disabled:opacity-40"
                            style={{
                                background: 'var(--bg-elevated)',
                                border: '1px solid var(--border-subtle)',
                                color: 'var(--text-secondary)',
                            }}
                            title="Clear clicks and last result"
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                        </motion.button>
                    </div>

                    {/* Click list — cyan dot = positive, red = negative */}
                    {semanticActive && semanticClicks.length > 0 && (
                        <div
                            className="rounded-md p-1.5 flex flex-wrap gap-1"
                            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                        >
                            {semanticClicks.map((c, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    onClick={() => setSemanticClicks((prev) => prev.filter((_, j) => j !== i))}
                                    className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded"
                                    title={`${c[0].toFixed(0)}, ${c[1].toFixed(0)} — click to remove`}
                                    style={{
                                        background: c[2] === 1 ? 'rgba(6,184,212,0.15)' : 'rgba(239,68,68,0.15)',
                                        color: c[2] === 1 ? 'var(--accent-primary)' : '#FCA5A5',
                                        border: `1px solid ${c[2] === 1 ? 'rgba(6,184,212,0.35)' : 'rgba(239,68,68,0.35)'}`,
                                    }}
                                >
                                    <span>{c[2] === 1 ? '+' : '−'}</span>
                                    <span>({c[0].toFixed(0)}, {c[1].toFixed(0)})</span>
                                </button>
                            ))}
                        </div>
                    )}

                    <motion.button
                        type="button"
                        onClick={handleSemanticRun}
                        disabled={isSemanticRunning || semanticClicks.length === 0}
                        whileTap={{ scale: 0.97 }}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold editor-interactive disabled:opacity-40"
                        style={{
                            background: 'linear-gradient(135deg, rgba(6,184,212,0.20) 0%, rgba(124,58,237,0.18) 100%)',
                            border: '1px solid rgba(6,184,212,0.35)',
                            color: 'var(--accent-primary)',
                        }}
                    >
                        {isSemanticRunning ? (
                            <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Running SAM 2…
                            </>
                        ) : (
                            <>
                                <Wand2 className="h-3.5 w-3.5" />
                                Run ({semanticClicks.length})
                            </>
                        )}
                    </motion.button>

                    {/* Mask preview + add-to-chain */}
                    {lastSemanticPreview && (
                        <div
                            className="rounded-md p-2 space-y-1.5"
                            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                        >
                            <div className="flex items-center gap-2">
                                <img
                                    src={lastSemanticPreview}
                                    alt="SAM 2 mask preview"
                                    className="rounded"
                                    style={{ width: 64, height: 64, objectFit: 'contain', background: '#000' }}
                                />
                                <div className="flex-1 text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                                    <div className="font-semibold mb-0.5" style={{ color: 'var(--text-secondary)' }}>
                                        Mask ready
                                    </div>
                                    White = keep, black = remove. The mask is at the
                                    original image&apos;s resolution.
                                </div>
                            </div>
                            <motion.button
                                type="button"
                                onClick={handleAddSemanticLayer}
                                whileTap={{ scale: 0.97 }}
                                className="flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: 'rgba(6,184,212,0.10)',
                                    border: '1px solid rgba(6,184,212,0.30)',
                                    color: 'var(--accent-primary)',
                                }}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                Add to Mask Layers
                            </motion.button>
                        </div>
                    )}
                </div>
            </Section>

            {/* ────────── Smart Brush (Step 7) ────────── */}
            <Section title="Smart Brush" icon={Paintbrush} badge="STEP 7">
                <div className="space-y-2">
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        Paint on the canvas. A bilateral filter snaps the
                        stroke to underlying edges so it doesn&apos;t bleed
                        past object boundaries.
                    </p>

                    <BrushSizeControl
                        value={brushSize}
                        setValue={setBrushSize}
                        min={2}
                        max={200}
                        dominantColor={dominantColor}
                    />
                    <LabeledSlider
                        label="Hardness"
                        value={Math.round(brushHardness * 100)}
                        min={0}
                        max={100}
                        suffix="%"
                        onChange={(v) => setBrushHardness(Math.max(0, Math.min(1, v / 100)))}
                        dominantColor={dominantColor}
                    />

                    <div className="grid grid-cols-2 gap-1.5 pt-1">
                        {!brushActive ? (
                            <motion.button
                                type="button"
                                onClick={handleStartBrush}
                                whileTap={{ scale: 0.97 }}
                                className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: 'rgba(124,58,237,0.10)',
                                    border: '1px solid rgba(124,58,237,0.30)',
                                    color: '#A78BFA',
                                }}
                            >
                                <Paintbrush className="h-3.5 w-3.5" />
                                Start Painting
                            </motion.button>
                        ) : (
                            <motion.button
                                type="button"
                                onClick={handleStopBrush}
                                whileTap={{ scale: 0.97 }}
                                className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: 'rgba(239,68,68,0.10)',
                                    border: '1px solid rgba(239,68,68,0.30)',
                                    color: '#FCA5A5',
                                }}
                            >
                                <X className="h-3.5 w-3.5" />
                                Stop
                            </motion.button>
                        )}
                        <motion.button
                            type="button"
                            onClick={handleClearBrush}
                            disabled={!brushHasContent && !brushActive}
                            whileTap={{ scale: 0.97 }}
                            className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive disabled:opacity-40"
                            style={{
                                background: 'var(--bg-elevated)',
                                border: '1px solid var(--border-subtle)',
                                color: 'var(--text-secondary)',
                            }}
                            title="Clear the painted stroke"
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Clear
                        </motion.button>
                    </div>

                    {/* Filter settings — these become the layer's params
                        at add time. Defaults match the schema. */}
                    <div className="space-y-1.5 pt-1">
                        <LabeledSlider
                            label="Filter Radius"
                            value={filterRadius}
                            min={1}
                            max={8}
                            step={1}
                            onChange={setFilterRadius}
                            format={(v) => `${v} px`}
                        />
                        <LabeledSlider
                            label="Color Sigma (edge strictness)"
                            value={sigmaColor}
                            min={0.01}
                            max={1}
                            step={0.01}
                            onChange={setSigmaColor}
                            format={(v) => v.toFixed(2)}
                        />
                        <LabeledSlider
                            label="Space Sigma (spatial spread)"
                            value={sigmaSpace}
                            min={0.5}
                            max={8}
                            step={0.1}
                            onChange={setSigmaSpace}
                            format={(v) => v.toFixed(1)}
                        />
                    </div>

                    <motion.button
                        type="button"
                        onClick={handleAddBrushLayer}
                        disabled={!brushHasContent}
                        whileTap={{ scale: 0.97 }}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold editor-interactive disabled:opacity-40"
                        style={{
                            background: 'linear-gradient(135deg, rgba(6,184,212,0.20) 0%, rgba(124,58,237,0.18) 100%)',
                            border: '1px solid rgba(6,184,212,0.35)',
                            color: 'var(--accent-primary)',
                        }}
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Add to Mask Layers
                    </motion.button>
                </div>
            </Section>

            {/* ────────── Depth Range (Depth Anything V2) ────────── */}
            <Section title="Depth Range" icon={Mountain} badge="STEP 6">
                <div className="space-y-2">
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        Generate a per-pixel depth map, then add it as a
                        non-destructive layer with a custom depth range.
                    </p>

                    <div className="flex items-center gap-1.5">
                        <motion.button
                            type="button"
                            onClick={handleDepthRun}
                            disabled={isDepthRunning}
                            whileTap={{ scale: 0.97 }}
                            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive disabled:opacity-40"
                            style={{
                                background: 'linear-gradient(135deg, rgba(6,184,212,0.20) 0%, rgba(20,184,166,0.18) 100%)',
                                border: '1px solid rgba(6,184,212,0.35)',
                                color: 'var(--accent-primary)',
                            }}
                        >
                            {isDepthRunning ? (
                                <>
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    Generating…
                                </>
                            ) : (
                                <>
                                    <Mountain className="h-3.5 w-3.5" />
                                    Generate Depth Map
                                </>
                            )}
                        </motion.button>
                        <motion.button
                            type="button"
                            onClick={handleDepthReset}
                            disabled={!lastDepthMap}
                            whileTap={{ scale: 0.97 }}
                            className="flex items-center justify-center gap-1 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive disabled:opacity-40"
                            style={{
                                background: 'var(--bg-elevated)',
                                border: '1px solid var(--border-subtle)',
                                color: 'var(--text-secondary)',
                            }}
                            title="Clear last result"
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                        </motion.button>
                    </div>

                    {/* Depth preview + range controls + add-to-chain */}
                    {lastDepthPreview && (
                        <div
                            className="rounded-md p-2 space-y-1.5"
                            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                        >
                            <div className="flex items-center gap-2">
                                <img
                                    src={lastDepthPreview}
                                    alt="Depth map preview"
                                    className="rounded"
                                    style={{ width: 64, height: 64, objectFit: 'contain', background: '#000' }}
                                />
                                <div className="flex-1 text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                                    <div className="font-semibold mb-0.5" style={{ color: 'var(--text-secondary)' }}>
                                        Depth map ready
                                    </div>
                                    White = near, black = far. Use the sliders
                                    below to select a range.
                                </div>
                            </div>

                            <div className="space-y-1.5 pt-1">
                                <LabeledSlider
                                    label="Min (near floor)"
                                    value={depthMin}
                                    onChange={setDepthMinBounded}
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    format={(v) => v.toFixed(2)}
                                />
                                <LabeledSlider
                                    label="Max (far ceiling)"
                                    value={depthMax}
                                    onChange={setDepthMaxBounded}
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    format={(v) => v.toFixed(2)}
                                />
                                <LabeledSlider
                                    label="Softness (edge width)"
                                    value={depthSoftness}
                                    onChange={setDepthSoftness}
                                    min={0}
                                    max={0.5}
                                    step={0.01}
                                    format={(v) => v.toFixed(2)}
                                />
                            </div>

                            <motion.button
                                type="button"
                                onClick={handleAddDepthLayer}
                                whileTap={{ scale: 0.97 }}
                                className="flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: 'rgba(6,184,212,0.10)',
                                    border: '1px solid rgba(6,184,212,0.30)',
                                    color: 'var(--accent-primary)',
                                }}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                Add to Mask Layers
                            </motion.button>
                        </div>
                    )}
                </div>
            </Section>

            {/* ────────── Mask Layers (megashader chain) ────────── */}
            <Section
                title="Mask Layers"
                icon={Layers}
                defaultOpen={true}
                badge={stack.chain.length > 0 ? `${stack.chain.length}` : null}
            >
                <div className="space-y-1.5">
                    <AnimatePresence>
                        {stack.chain.map((entry, i) => (
                            <MaskChainCard
                                key={entry.layer.id}
                                entry={entry}
                                index={i}
                                total={stack.chain.length}
                                isFirst={i === 0}
                                imageSize={imageSize}
                                onUpdate={(patch) => updateLayer(entry.layer.id, patch)}
                                onRemove={removeLayer}
                                onMove={moveLayer}
                                onSetOp={setLayerOp}
                                dominantColor={dominantColor}
                            />
                        ))}
                    </AnimatePresence>

                    {stack.chain.length === 0 && (
                        <p
                            className="text-[10px] text-center py-3 rounded-md"
                            style={{ color: 'var(--text-muted)', border: '1px dashed var(--border-subtle)' }}
                        >
                            No layers yet. Use the buttons in Luminance, Color, or
                            Gradient below to add one.
                        </p>
                    )}

                    {stack.chain.length > 0 && (
                        <button
                            type="button"
                            onClick={clearAll}
                            className="flex w-full items-center justify-center gap-1.5 text-[10px] py-1.5"
                            style={{ color: '#EF4444' }}
                        >
                            Clear all layers
                        </button>
                    )}
                </div>
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Non-destructive chain rendered by the megashader filter.
                    Composes on top of the brush mask.
                </p>
            </Section>

            {/* ────────── Color Range ────────── */}
            <Section title="Color Range" icon={Palette}>
                <div className="flex items-center gap-2">
                    <motion.button
                        type="button"
                        onClick={() => setColorPickerActive(v => !v)}
                        whileTap={{ scale: 0.95 }}
                        className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive flex-1"
                        style={{
                            background: colorPickerActive
                                ? 'rgba(6,184,212,0.12)'
                                : 'var(--bg-elevated)',
                            border: `1px solid ${colorPickerActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                            color: colorPickerActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
                        }}
                    >
                        <Crosshair className="h-3.5 w-3.5" />
                        {colorPickerActive ? 'Click image to pick…' : 'Pick Color'}
                    </motion.button>
                    {pickedColor && <ColorSwatch color={pickedColor} />}
                </div>

                {pickedColor && (
                    <div className="space-y-2">
                        <LabeledSlider
                            label="Tolerance"
                            value={colorTolerance}
                            min={5}
                            max={100}
                            suffix=""
                            onChange={setColorTolerance}
                            dominantColor={dominantColor}
                        />
                        <div className="grid grid-cols-2 gap-1.5">
                            <motion.button
                                type="button"
                                onClick={handleApplyColorRange}
                                whileTap={{ scale: 0.97 }}
                                className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: 'var(--bg-elevated)',
                                    border: '1px solid var(--border-subtle)',
                                    color: 'var(--text-secondary)',
                                }}
                            >
                                <Palette className="h-3.5 w-3.5" />
                                Apply (bake)
                            </motion.button>
                            <motion.button
                                type="button"
                                onClick={handleAddColorLayer}
                                whileTap={{ scale: 0.97 }}
                                className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                                style={{
                                    background: 'rgba(6,184,212,0.10)',
                                    border: '1px solid rgba(6,184,212,0.3)',
                                    color: 'var(--accent-primary)',
                                }}
                                title="Add as a live megashader layer"
                            >
                                <Layers className="h-3.5 w-3.5" />
                                Add to Mask Layers
                            </motion.button>
                        </div>
                    </div>
                )}
            </Section>

            {/* ────────── Luminance Range ────────── */}
            <Section title="Luminance Range" icon={Sun}>
                <div className="space-y-2">
                    <LuminanceHistogram
                        histogram={histogram}
                        min={lumaMin / 255}
                        max={lumaMax / 255}
                        softness={0.1}
                    />
                    <LabeledSlider
                        label="Min Brightness"
                        value={lumaMin}
                        min={0}
                        max={254}
                        suffix=""
                        onChange={(v) => { setLumaMin(Math.min(v, lumaMax - 1)) }}
                        dominantColor={dominantColor}
                    />
                    <LabeledSlider
                        label="Max Brightness"
                        value={lumaMax}
                        min={1}
                        max={255}
                        suffix=""
                        onChange={(v) => { setLumaMax(Math.max(v, lumaMin + 1)) }}
                        dominantColor={dominantColor}
                    />
                    <div className="grid grid-cols-2 gap-1.5">
                        <motion.button
                            type="button"
                            onClick={handleApplyLuminance}
                            whileTap={{ scale: 0.97 }}
                            className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                            style={{
                                background: 'var(--bg-elevated)',
                                border: '1px solid var(--border-subtle)',
                                color: 'var(--text-secondary)',
                            }}
                        >
                            <Sun className="h-3.5 w-3.5" />
                            Apply (bake)
                        </motion.button>
                        <motion.button
                            type="button"
                            onClick={handleAddLuminanceLayer}
                            whileTap={{ scale: 0.97 }}
                            className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium editor-interactive"
                            style={{
                                background: 'rgba(6,184,212,0.10)',
                                border: '1px solid rgba(6,184,212,0.3)',
                                color: 'var(--accent-primary)',
                            }}
                            title="Add as a live megashader layer"
                        >
                            <Layers className="h-3.5 w-3.5" />
                            Add to Mask Layers
                        </motion.button>
                    </div>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        Apply (bake) writes to the brush mask. Add to Mask Layers
                        keeps it as a live, editable megashader layer.
                    </p>
                </div>
            </Section>

            {/* ────────── Linear Gradient ────────── */}
            <Section title="Linear Gradient" icon={Blend}>
                <div className="space-y-3">
                    {/* Direction grid */}
                    <div>
                        <label className="text-[10px] block mb-1.5" style={{ color: 'var(--text-muted)' }}>Direction</label>
                        <div className="grid grid-cols-4 gap-1">
                            {DIRECTIONS.map(d => {
                                const DirIcon = d.icon
                                const active = gradDirection === d.id
                                return (
                                    <motion.button
                                        key={d.id}
                                        type="button"
                                        onClick={() => setGradDirection(d.id)}
                                        whileTap={{ scale: 0.9 }}
                                        className="flex items-center justify-center rounded-md p-1.5 editor-interactive"
                                        style={{
                                            background: active ? 'rgba(6,184,212,0.12)' : 'var(--bg-elevated)',
                                            border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                            color: active ? 'var(--accent-primary)' : 'var(--text-muted)',
                                        }}
                                        title={d.label}
                                    >
                                        <DirIcon className="h-3.5 w-3.5" />
                                    </motion.button>
                                )
                            })}
                        </div>
                    </div>

                    <LabeledSlider
                        label="Position"
                        value={gradPosition}
                        min={10}
                        max={90}
                        suffix="%"
                        onChange={setGradPosition}
                        dominantColor={dominantColor}
                    />
                    <LabeledSlider
                        label="Feather"
                        value={gradFeather}
                        min={5}
                        max={80}
                        suffix="%"
                        onChange={setGradFeather}
                        dominantColor={dominantColor}
                    />
                    <motion.button
                        type="button"
                        onClick={handleApplyGradient}
                        whileTap={{ scale: 0.97 }}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
                        style={{
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border-subtle)',
                            color: 'var(--text-secondary)',
                        }}
                    >
                        <Blend className="h-3.5 w-3.5" />
                        Apply Gradient Mask
                    </motion.button>
                    <motion.button
                        type="button"
                        onClick={handleAddGradientLayer}
                        whileTap={{ scale: 0.97 }}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
                        style={{
                            background: 'rgba(124,58,237,0.08)',
                            border: '1px solid rgba(124,58,237,0.25)',
                            color: '#A78BFA',
                        }}
                        title="Adds a linear megashader layer — drag on canvas to set p1/p2"
                    >
                        <Layers className="h-3.5 w-3.5" />
                        Add Linear to Mask Layers
                        <span className="text-[8px] font-bold px-1 rounded ml-1" style={{ background: 'rgba(124,58,237,0.2)', color: '#A78BFA' }}>STEP 3</span>
                    </motion.button>
                </div>
            </Section>

            {/* ────────── Radial Gradient ────────── */}
            <Section title="Radial Gradient" icon={Circle}>
                <div className="space-y-3">
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        Drag a bounding box on the canvas to define the ellipse.
                        Center, radii, and rotation are derived from the drag.
                    </p>
                    <motion.button
                        type="button"
                        onClick={handleAddRadialLayer}
                        whileTap={{ scale: 0.97 }}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
                        style={{
                            background: 'rgba(124,58,237,0.08)',
                            border: '1px solid rgba(124,58,237,0.25)',
                            color: '#A78BFA',
                        }}
                        title="Adds a radial megashader layer — drag on canvas to set the bounding box"
                    >
                        <Layers className="h-3.5 w-3.5" />
                        Add Radial to Mask Layers
                        <span className="text-[8px] font-bold px-1 rounded ml-1" style={{ background: 'rgba(124,58,237,0.2)', color: '#A78BFA' }}>STEP 3</span>
                    </motion.button>
                </div>
            </Section>

            {/* ────────── Brush (manual) ────────── */}
            <Section title="Brush" icon={Scissors} defaultOpen={true}>
                <ModeToggle mode={tool.mode} setMode={tool.setMode} altActive={tool.altActive} />
                <BrushSizeControl
                    value={tool.brushSize}
                    setValue={tool.setBrushSize}
                    min={MIN_BRUSH}
                    max={MAX_BRUSH}
                    dominantColor={dominantColor}
                />
                <LabeledSlider label="Hardness" value={tool.hardness} min={1} max={100} suffix="%" onChange={tool.setHardness} dominantColor={dominantColor} />
                <LabeledSlider label="Flow" value={tool.flow} min={5} max={100} suffix="%" onChange={tool.setFlow} dominantColor={dominantColor} />
                <LabeledSlider label="Edge Feather" value={tool.feather} min={0} max={50} suffix="px" onChange={tool.setFeather} dominantColor={dominantColor} />
            </Section>

            {/* ────────── Actions ────────── */}
            <div style={{ paddingTop: '4px' }}>
                <MaskActionButtons
                    hasMask={tool.hasMask}
                    undoDepth={tool.undoDepth}
                    redoDepth={tool.redoDepth}
                    onUndo={tool.undo}
                    onRedo={tool.redo}
                    onInvert={tool.invert}
                    onClear={tool.clear}
                />
            </div>

            <TipCard>
                <p>• <strong>Select Subject</strong> uses AI to mask the main object</p>
                <p>• <strong>Click to Select</strong> marks a point — SAM 2 segments around it (Alt-click = background)</p>
                <p>• <strong>Smart Brush</strong> paints a freehand stroke that snaps to edges (bilateral filter)</p>
                <p>• <strong>Depth Range</strong> selects pixels by depth (Depth Anything V2)</p>
                <p>• <strong>Color Range</strong> selects pixels by color (click to sample)</p>
                <p>• <strong>Luminance</strong> selects by brightness level</p>
                <p>• <strong>Gradient</strong> creates a smooth directional mask</p>
                <p>• <strong>Add to Mask Layers</strong> stacks live, editable megashader layers</p>
                <p>• <strong>Brush</strong> for manual fine-tuning</p>
                <p>• All masks can be refined with <strong>Erase/Restore</strong> brush</p>
            </TipCard>
        </div>
    )
}

export default MaskControls
