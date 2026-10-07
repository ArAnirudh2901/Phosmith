"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { Circle as FabricCircle, FabricImage, Polygon, Polyline } from 'fabric'
import { toast } from 'sonner'
import { useCanvas } from '../../../../../../../context/context'
import usePixelMaskTool from '../../../../../../../hooks/usePixelMaskTool'
import useMaskLayers from '../../../../../../../hooks/useMaskLayers'
import { computeImageHistogram, getHistogramSourceElement } from '@/lib/image-histogram'
import { setMaskTexture, getMaskTexture, rasterisePath, smoothToBezier, MAX_LAYERS } from '@/lib/megashader'
import { buildMaskBoundary } from '@/lib/mask-boundary'
import { buildPackedLutFromCurves } from '@/lib/curve-lut'
import { expandLayerBoundary, beginLayerRefine, applyRefineStroke } from '@/lib/mask-grow'
import { AI_CAPABILITIES, getRoutingPolicy, subscribeRouting } from '@/lib/ai-routing'
import { getClientAIState, runClientAISelfTest, subscribeClientAI, clientSubjectMask, clientGroundPhrase, clientSubjectInstances } from '@/lib/client-ai'
import { checkMaskService } from '@/lib/mask-service-client'
import { cleanSubjectMatte } from '@/lib/subject-mask-cleanup'
import { magicWandMask } from '@/lib/magic-wand'
import { computeGradientMagnitude, snapToEdgePoint } from '@/lib/mask-edge-snap'
import { pointToImageSpace, getImageBitmapSize } from '@/lib/canvas-mask'
import { MaskActionButtons, TipCard, ToolEmptyState } from './_pixel-tool-ui'
import { toUserMessage } from '@/lib/user-error'
import { REFINABLE_KINDS, contrastFillFromHex, coverToCanvas, fillClosedBrushPath, marqueePoints, naturalVsObject, sourceNaturalSize, toNaturalPx, toObjectPx } from './mask/geometry'
import { CategoryHeader } from './mask/ui'
import LayersSection from './mask/layers-section'
import AiRoutingSection from './mask/ai-routing-section'
import SubjectSection from './mask/subject-section'
import ClickSelectSection from './mask/click-select-section'
import BrushSection from './mask/brush-section'
import LassoSection from './mask/lasso-section'
import WandSection from './mask/wand-section'
import MarqueeSection from './mask/marquee-section'
import DepthSection from './mask/depth-section'
import ColorRangeSection from './mask/color-range-section'
import LuminanceSection from './mask/luminance-section'
import LinearGradientSection from './mask/linear-gradient-section'
import RadialGradientSection from './mask/radial-gradient-section'
import QuickEraseSection from './mask/quick-erase-section'
import { useClickSelect } from './mask/use-click-select'
import { useDepthRange } from './mask/use-depth-range'
import { useGradientGizmos } from './mask/use-gradient-gizmos'
import { useRangeLayers } from './mask/use-range-layers'

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
    // Quick Erase (the destructive clipPath brush) is OFF by default. Opening
    // the Mask tool and painting must SELECT a region (non-destructive), not
    // erase the image — so the pixel tool only takes the pointer when the user
    // explicitly enables Quick Erase. See the `pixelToolDisabled` effect below.
    const [quickEraseActive, setQuickEraseActive] = useState(false)
    const tool = usePixelMaskTool({ canvasEditor, defaultMode: 'erase', supportsMagic: false, disabled: pixelToolDisabled })

    // AI Subject Selection state
    const [isSegmenting, setIsSegmenting] = useState(false)
    // Multi-subject (instance) detection state. Populated by the "Detect All
    // Subjects" button; persists until the image changes so the user can
    // re-select an individual subject without re-running BiRefNet + YOLO.
    const [isDetectingInstances, setIsDetectingInstances] = useState(false)
    const isDetectingInstancesRef = useRef(false)
    const instancesAbortRef = useRef(/** @type {AbortController | null} */ (null))
    const [subjectInstances, setSubjectInstances] = useState(/** @type {Array<any> | null} */ (null))
    const [activeInstanceIndex, setActiveInstanceIndex] = useState(/** @type {number | null} */ (null))
    const lastInstancesImageRef = useRef(/** @type {any} */ (null))
    // Id of the non-destructive megashader layer that currently holds the AI
    // subject selection. The "Select Subject" button (detect-all pass) / chip
    // picker all SELECT a region (they no longer erase the background); picking
    // a different subject SWAPS this single layer instead of stacking duplicates.
    const subjectLayerIdRef = useRef(/** @type {string | null} */ (null))
    // Ref-mirrors of the "running" flags. The `useCallback` closures for
    // `runSubjectSelection` / `handleSemanticRun` / `handleDepthRun` capture
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
        stack, addLayer: addChainLayerRaw, removeLayer, updateLayer,
        setLayerOp, setFillMode, moveLayer, clearAll,
        showMaskOverlay, setShowMaskOverlay, maskView, setMaskView, globalInvert, setGlobalInvert,
        selectedLayerId, selectLayer, setBase,
        // (base grade rides on stack.base)
        undo: undoChain, redo: redoChain, historyAt, canUndo, canRedo, hydrate,
    } = chain

    // Default new layers' fill tint to a colour that contrasts with the image,
    // so a 'fill' selection is visible immediately (see contrastFillFromHex).
    // Kept in a ref so the wrapped creator always reads the latest without
    // re-binding every callback that creates a layer.
    const autoFillColorRef = useRef(contrastFillFromHex(dominantColor))
    useEffect(() => { autoFillColorRef.current = contrastFillFromHex(dominantColor) }, [dominantColor])
    const addChainLayer = useCallback(
        (kind, opts = {}) => addChainLayerRaw(kind, { fillColor: autoFillColorRef.current, ...opts }),
        [addChainLayerRaw]
    )

    // Always-current mirror of the chain so async callbacks (which capture the
    // `stack` from the render where they were created) can check the LIVE layer
    // list — used by the subject-selection swap to see whether its tracked
    // layer still exists without re-binding on every chain edit.
    const chainStackRef = useRef(stack)
    useEffect(() => { chainStackRef.current = stack }, [stack])

    // Per-mask tone curves: build the packed 256×1 RGBA LUT from the curve
    // points (master/R/G/B), register it as a texture, and point the layer at
    // it via `curveLutKey`; identity curves clear the LUT so the engine skips
    // the lookup. Drives the `LayerGradeEditor`'s curve graph in each mask card
    // (gamma + colour wheels are plain layer fields and flow through onUpdate).
    const applyCurve = useCallback((id, curves) => {
        const { packed, identity } = buildPackedLutFromCurves(curves || {})
        if (id === 'base') {
            if (identity) { setBase({ curveLutKey: null, curves: null }); return }
            setMaskTexture('curve-base', new ImageData(new Uint8ClampedArray(packed), 256, 1))
            setBase({ curveLutKey: 'curve-base', curves })
            return
        }
        if (identity) {
            updateLayer(id, { curveLutKey: undefined, curves: undefined })
            return
        }
        const key = `curve-${id}`
        setMaskTexture(key, new ImageData(new Uint8ClampedArray(packed), 256, 1))
        updateLayer(id, { curveLutKey: key, curves })
    }, [updateLayer, setBase])

    // ⌘Z / ⌘⇧Z arrive via useEditorShortcuts → phosmith:mask-undo/redo, which
    // usePixelMaskTool routes through this chain stack. Ctrl+Y isn't bound there.
    useEffect(() => {
        if (!canvasEditor) return undefined
        const history = { undo: undoChain, redo: redoChain, at: historyAt }
        canvasEditor.__maskChainHistory = history
        const onKey = (e) => {
            const t = e.target
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
            if (!(e.metaKey || e.ctrlKey) || (e.key !== 'y' && e.key !== 'Y')) return
            e.preventDefault()
            window.dispatchEvent(new CustomEvent('phosmith:mask-redo'))
        }
        window.addEventListener('keydown', onKey)
        return () => {
            if (canvasEditor.__maskChainHistory === history) delete canvasEditor.__maskChainHistory
            window.removeEventListener('keydown', onKey)
        }
    }, [canvasEditor, undoChain, redoChain, historyAt])

    // Clean preview: hide gizmos + marching-ants to see the graded result.
    const [cleanPreview, setCleanPreview] = useState(false)

    const baseHasVisibleGrade = !!stack.base && (
        (typeof stack.base.gamma === 'number' && Math.abs(stack.base.gamma - 1) > 1e-3)
        || !!stack.base.curveLutKey
        || [stack.base.wheelShadows, stack.base.wheelMidtones, stack.base.wheelHighlights]
            .some((w) => Array.isArray(w) && w.some((n) => Number.isFinite(n) && n !== 0))
    )

    // Persistence rehydrate: if the primary image already carries a persisted
    // MegashaderFilter (restored from project state by loadFromJSON, with its
    // textures re-registered by MegashaderFilter.fromObject), seed the Mask
    // Layers UI from it once so the panel reflects the saved chain.
    const chainHydratedRef = useRef(false)
    useEffect(() => {
        if (chainHydratedRef.current) return
        const img = tool.mainImage
        if (!img || !Array.isArray(img.filters)) return
        const mega = img.filters.find((f) => f && f.type === 'Megashader')
        const persisted = Array.isArray(mega?.stack?.chain) ? mega.stack.chain : []
        const persistedBase = mega?.stack?.base || null
        // A base-only grade (no layers) must hydrate too, or the panel shows
        // identity and the next edit overwrites the saved grade.
        if ((persisted.length > 0 || persistedBase) && stack.chain.length === 0 && !stack.base) {
            hydrate(persisted, persistedBase)
            chainHydratedRef.current = true
        }
    }, [tool.mainImage, stack.chain.length, stack.base, hydrate])

    // Per-capability AI routing policy (Auto / Device / Server). Initialised
    // to all-auto and synced from localStorage AFTER mount — reading the
    // persisted policy during the first render would make SSR and client
    // markup disagree (hydration mismatch) whenever a custom policy is saved.
    const [routingPolicy, setRoutingPolicyState] = useState(() =>
        Object.fromEntries(Object.keys(AI_CAPABILITIES).map((cap) => [cap, 'auto'])))
    useEffect(() => {
        setRoutingPolicyState(getRoutingPolicy())
        return subscribeRouting(setRoutingPolicyState)
    }, [])
    const routingBadge = Object.values(routingPolicy).some((m) => m !== 'auto') ? 'Custom' : 'Auto'

    // On-device model download/readiness, surfaced so the background prefetch is
    // observable (per-capability "Ready" / "Downloading…" hints below).
    const [clientAI, setClientAI] = useState(getClientAIState)
    useEffect(() => {
        setClientAI(getClientAIState())
        return subscribeClientAI(setClientAI)
    }, [])
    // Map a routing capability to its in-browser readiness flag. Capabilities
    // with no browser model (maskPlan rule-parser, inpaint LaMa-on-service) are
    // absent — they need no download.
    const CLIENT_READY = {
        ground: clientAI.groundReady,
        subjects: clientAI.groundReady,
        segment: clientAI.segmentReady,
        sam: clientAI.samReady,
    }

    // On-device AI self-test: runs the REAL in-browser models on a synthetic
    // scene with a known answer (see runClientAISelfTest). First run also
    // downloads + caches the models, so it doubles as a warm-up.
    const [selfTest, setSelfTest] = useState({ running: false, progress: null, report: null })
    const handleSelfTest = useCallback(async () => {
        setSelfTest({ running: true, progress: 'Starting…', report: null })
        try {
            const report = await runClientAISelfTest({
                onProgress: (msg) => setSelfTest((s) => ({ ...s, progress: msg })),
            })
            setSelfTest({ running: false, progress: null, report })
            if (report.ok) {
                toast.success(`Device AI works — ${report.device.toUpperCase()}, ${(report.totalMs / 1000).toFixed(1)}s`)
            } else {
                toast.error('Device AI self-test found problems — see the AI Processing section')
            }
        } catch (err) {
            setSelfTest({
                running: false,
                progress: null,
                report: { ok: false, device: 'unknown', totalMs: 0, checks: [{ label: 'Self-test crashed', ok: false, detail: String(err?.message || err) }] },
            })
            toast.error(toUserMessage(err, 'Device AI self-test failed'))
        }
    }, [])

    // Selected layer — drives the re-editable gradient-handle gizmo (linear/
    // radial) and the brush pointer-arbitration (handles must suppress the
    // pixel brush so clicking the image doesn't paint while editing a gradient).
    const selectedLayer = stack.chain.find((e) => e.layer.id === selectedLayerId)?.layer || null
    const selectedLayerIdRef = useRef(selectedLayerId)
    selectedLayerIdRef.current = selectedLayerId
    const selKind = selectedLayer?.kind
    const isGradientSelected = selKind === 'linear' || selKind === 'radial'

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
                const h = computeImageHistogram(tool.mainImage)
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
        const { w, h } = sourceNaturalSize(tool.mainImage)
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
        // Fabric v7 removed Canvas#getPointer — the scene-space equivalent is
        // getScenePoint. Keep the getPointer fallback for older Fabric (same
        // compat shape as usePixelMaskTool.getScenePoint).
        const evt = e.e || e
        const pointer = typeof fabricCanvas.getScenePoint === 'function'
            ? fabricCanvas.getScenePoint(evt)
            : fabricCanvas.getPointer(evt)
        // The main image is placed with originX/originY 'center', so its
        // left/top is the CENTER — not the top-left corner. Invert the full
        // transform matrix (the same math the brush tool uses via
        // pointToImageSpace) so center-origin, rotation, and flip all map
        // correctly to top-left-origin image pixels. A naïve
        // (pointer - left) / scale here landed every click half an image
        // off, so the bounds check rejected them as "outside the image".
        const raw = pointToImageSpace(tool.mainImage, pointer)
        if (!raw) return null
        // `pointToImageSpace` works in the Fabric object's `width`/`height`
        // units (getImageBitmapSize → img.width). But the megashader's
        // uImageSize, the brush canvas, the layer geometry, and the SAM upload
        // dims are ALL in the source element's NATURAL pixels. When a Fabric
        // image's logical width diverges from the element's naturalWidth (a
        // resized/re-encoded image, or a chain restored from JSON), the two
        // spaces differ and every click/brush/box lands scaled-off — while the
        // marker/overlay still round-trip to the cursor (imageToDisplay uses
        // the same width), which is why the bug is "invisible until you drag".
        // Convert to natural pixels here; a no-op when width === naturalWidth
        // (the common case), so it can only correct the mismatch, never regress.
        const pos = toNaturalPx(tool.mainImage, raw)
        if (typeof window !== 'undefined' && window.__MASKDBG) {
            const img = tool.mainImage
            const el = img._element || img.getElement?.()
            console.log('[maskdbg]', JSON.stringify({
                pos: pos ? [Math.round(pos.x), Math.round(pos.y)] : null,
                rawObjSpace: [Math.round(raw.x), Math.round(raw.y)],
                imgWH: [img.width, img.height],
                natWH: [el?.naturalWidth, el?.naturalHeight],
                mismatch: img.width !== (el?.naturalWidth) || img.height !== (el?.naturalHeight),
                scale: [img.scaleX, img.scaleY], zoom: fabricCanvas.getZoom?.(),
            }))
        }
        return pos
    }, [tool.mainImage])

    // Convert image-pixel coordinates to display-space (where Fabric
    // objects live). Used for drawing the live preview overlay so it
    // sits exactly on top of the corresponding image pixel. This is the
    // exact forward inverse of pointerToImage: shift the top-left-origin
    // image pixel into the matrix's center-origin local space, then apply
    // the object's transform matrix.
    const imageToDisplay = useCallback((imageX, imageY) => {
        const fabricObj = tool.mainImage
        if (!fabricObj || typeof fabricObj.calcTransformMatrix !== 'function') return null
        const m = fabricObj.calcTransformMatrix()
        const { width, height } = getImageBitmapSize(fabricObj)
        // imageX/imageY arrive in NATURAL pixels (see pointerToImage). The
        // transform matrix operates in the object's width/height units, so map
        // back before applying it — a no-op when natural === object size, which
        // keeps the marker/overlay an exact inverse of pointerToImage.
        const objP = toObjectPx(fabricObj, { x: imageX, y: imageY })
        const lx = objP.x - width / 2
        const ly = objP.y - height / 2
        return {
            x: m[0] * lx + m[2] * ly + m[4],
            y: m[1] * lx + m[3] * ly + m[5],
        }
    }, [tool.mainImage])

    // Begin a spatial drag. Snaps the layer's anchor to the click point
    // and prepares the dragStateRef for the move handler.
    const handleSpatialDragStart = useCallback((e) => {
        if (!activeDraft) return
        const fabricCanvas = canvasEditor
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
    // (half the drag distance per axis); rotation stays 0 until the rotate handle.
    const handleSpatialDragMove = useCallback((e) => {
        if (!activeDraft || !dragStateRef.current) return
        const fabricCanvas = canvasEditor
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
            // The radii fit the dragged box, so rotating by the drag angle made
            // the ellipse stop matching what was drawn (a tall box tilted ~80°).
            updateLayer(activeDraft.layerId, {
                center: { x: cx, y: cy },
                radius: { x: rx, y: ry },
                rotation: 0,
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
        const fabricCanvas = canvasEditor
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

    const { boxArmed, compositeIntoLayer, decodeMaskBlob, handleAddSemanticLayer, handleSemanticReset, handleSemanticRun, handleSemanticStop, isSemanticRunning, lastSemanticMask, lastSemanticPreview, refineTargetLayer, semanticAbortRef, semanticActive, semanticBox, semanticClicks, semanticRefine, semanticRefineMode, setBoxArmed, setSemanticActive, setSemanticBox, setSemanticClicks, setSemanticRefine, setSemanticRefineMode } = useClickSelect({ addChainLayer, canvasEditor, chainStackRef, imageToDisplay, pointerToImage, selectedLayer, selectedLayerIdRef, tool, updateLayer })

    const { depthAbortRef, depthMax, depthMin, depthSoftness, handleAddDepthLayer, handleDepthReset, handleDepthRun, isDepthRunning, lastDepthMap, lastDepthPreview, setDepthMaxBounded, setDepthMinBounded, setDepthSoftness } = useDepthRange({ addChainLayer, decodeMaskBlob, tool })

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

    /* ─── Lasso selection (freehand + polygonal) ─── */
    // The lasso captures a closed polygon and turns it into a megashader
    // 'lasso' layer (Bug #12 kind). `lassoSink` picks the layer's output:
    // 'select' → fill mode (visible selection), 'erase' → erase mode (cut).
    // `lassoModifier` maps Shift/Alt + the modifier buttons to the chain
    // blend op so a second lasso can add/subtract/intersect with the first.
    const [lassoActive, setLassoActive] = useState(false)
    const [wandActive, setWandActive] = useState(false)
    const [wandTolerance, setWandTolerance] = useState(32)
    const [wandContiguous, setWandContiguous] = useState(true)
    const [wandAntiAlias, setWandAntiAlias] = useState(true)
    const [wandSample, setWandSample] = useState('point')
    const wandSourceRef = useRef(null)
    const [marqueeActive, setMarqueeActive] = useState(false)
    const [marqueeShape, setMarqueeShape] = useState('rect')
    const [marqueeFeather, setMarqueeFeather] = useState(0)
    const [marqueeOp, setMarqueeOp] = useState('new')
    const marqueeDragRef = useRef(null)
    const marqueeOverlayRef = useRef(null)
    // Every canvas click-mode is exclusive; assigned each render once all
    // stop handlers exist. `keep` names the mode being started.
    const stopModesRef = useRef(() => {})
    const [lassoMode, setLassoMode] = useState('freehand') // 'freehand' | 'polygonal' | 'magnetic'
    const [lassoSink, setLassoSink] = useState('select')   // 'select' | 'erase'
    const [lassoModifier, setLassoModifier] = useState('new') // new|add|subtract|intersect
    const [lassoFeather, setLassoFeather] = useState(0.04)
    // Pen mode: smooth the captured anchors into a Bézier 'path' layer (vs the
    // straight-edged 'lasso' layer). Reuses the whole lasso capture pipeline.
    const [lassoSmooth, setLassoSmooth] = useState(false)
    const [lassoVertexCount, setLassoVertexCount] = useState(0)
    // ─── Magnetic lasso (edge-snapping) options — Photoshop parity ───
    // Width = search radius (image px), Contrast = edge threshold (0..100),
    // Frequency = anchor spacing (image px). Refs mirror them so the
    // window-level pointer handlers read fresh values without re-binding.
    const [magneticWidth, setMagneticWidth] = useState(16)
    const [magneticContrast, setMagneticContrast] = useState(12)
    const [magneticFrequency, setMagneticFrequency] = useState(14)
    const magneticWidthRef = useRef(magneticWidth)
    const magneticContrastRef = useRef(magneticContrast)
    const magneticFrequencyRef = useRef(magneticFrequency)
    useEffect(() => { magneticWidthRef.current = magneticWidth }, [magneticWidth])
    useEffect(() => { magneticContrastRef.current = magneticContrast }, [magneticContrast])
    useEffect(() => { magneticFrequencyRef.current = magneticFrequency }, [magneticFrequency])
    // Cached Sobel gradient-magnitude map of the source image (0..1), used to
    // snap the magnetic lasso to edges. Rebuilt when the source/size changes.
    const gradientMapRef = useRef(/** @type {{mag:Float32Array,W:number,H:number,scale:number,token:string}|null} */ (null))
    const lassoPointsRef = useRef(/** @type {Array<{x:number,y:number}>} */ ([]))
    const lassoDrawingRef = useRef(false)
    const lassoCursorRef = useRef(/** @type {{x:number,y:number}|null} */ (null))
    const lassoOverlayRef = useRef(/** @type {any} */ (null))
    const lassoMarkerRefs = useRef(/** @type {Array<any>} */ ([]))
    const lassoModeRef = useRef(lassoMode)
    const lassoModifierRef = useRef(lassoModifier)
    useEffect(() => { lassoModeRef.current = lassoMode }, [lassoMode])
    useEffect(() => { lassoModifierRef.current = lassoModifier }, [lassoModifier])

    const [brushActive, setBrushActive] = useState(false)
    const [brushSize, setBrushSize] = useState(40)
    const [brushHardness, setBrushHardness] = useState(0.8)
    const [filterRadius, setFilterRadius] = useState(3)
    const [sigmaColor, setSigmaColor] = useState(0.15)
    const [sigmaSpace, setSigmaSpace] = useState(2)
    const [brushHasContent, setBrushHasContent] = useState(false)
    const [isShapeFilling, setIsShapeFilling] = useState(false)
    // Selection-brush output options (mirror the lasso). `brushSink` picks the
    // layer's fillMode (select → non-destructive 'adjust', erase → 'erase' knockout);
    // `brushModifier` maps to the chain blend op; `brushEdgeSnap` toggles the
    // edge-preserving bilateral filter (smartBrush kind) vs a plain brush kind.
    // `brushFeather` is baked PER-LAYER at add time, so each region keeps its
    // own soft edge regardless of the slider's later position.
    const [brushSink, setBrushSink] = useState('select')      // 'select' | 'erase'
    const [brushModifier, setBrushModifier] = useState('new') // new|add|subtract|intersect
    const [brushEdgeSnap, setBrushEdgeSnap] = useState(false)
    const [brushFeather, setBrushFeather] = useState(0)       // image px, baked per region
    // Brush-refine (ported from mask-studio): paint DIRECTLY on the selected
    // layer's mask — each released stroke is composited into the texture via
    // beginLayerRefine/applyRefineStroke (erase carves out, add unions in).
    // Armed by the layer cards' "Erase region" / "Add region" buttons; Alt
    // temporarily flips the stroke, like the studio.
    const [refineTarget, setRefineTarget] = useState(/** @type {{layerId: string, mode: 'erase' | 'add'} | null} */ (null))
    const refineSessionRef = useRef(/** @type {ReturnType<typeof beginLayerRefine> | null} */ (null))
    const refineModeRef = useRef(/** @type {'erase' | 'add' | null} */ (null))
    useEffect(() => { refineModeRef.current = refineTarget?.mode ?? null }, [refineTarget])
    // Erase/add decided at stroke START (mode or Alt), fixed for the drag.
    const strokeEraseRef = useRef(false)

    // Refs (so pointer handlers and effects read consistent values
    // without re-binding effects on every slider tweak).
    const brushCanvasRef = useRef(/** @type {HTMLCanvasElement | null} */ (null))
    const brushOverlayRef = useRef(/** @type {any} */ (null))
    const isPaintingRef = useRef(false)
    const lastBrushPointRef = useRef(null)
    const brushPointsRef = useRef(/** @type {Array<{x:number,y:number}>} */ ([]))
    const shapeFillTokenRef = useRef(0)
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
    // Bug #9 — central pointer arbitration. The pixel brush binds its own
    // mouse:down and paints a clipPath dab on every in-image click; it is
    // suppressed ONLY by this flag. Any other click-capturing mode (smart
    // brush, colour eyedropper, SAM2 click, spatial gradient draft, lasso)
    // MUST drive it true, or a single click would fire BOTH that mode's
    // handler AND the brush — placing a layer while painting a stray dab.
    useEffect(() => {
        // The destructive pixel brush only takes the pointer when the user has
        // explicitly turned on Quick Erase AND no other capture mode owns the
        // canvas. Anything else (incl. the default "nothing engaged" state)
        // suppresses it, so a stray click never erases image pixels.
        setPixelToolDisabled(!quickEraseActive || brushActive || colorPickerActive || semanticActive || lassoActive || wandActive || marqueeActive || !!activeDraft || isGradientSelected)
    }, [quickEraseActive, brushActive, colorPickerActive, semanticActive, lassoActive, wandActive, marqueeActive, activeDraft, isGradientSelected])

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
    // `color` is an "r, g, b" string — refine erase strokes preview red; the
    // stencil's ALPHA is what commits, so the tint is cosmetic.
    const stampBrush = useCallback((ctx, x, y, radius, hardness, color = '255, 255, 255') => {
        if (!ctx || radius <= 0) return
        const h = Math.max(0, Math.min(1, hardness))
        if (h >= 0.999) {
            // Hard brush: single fill (faster, no gradient).
            ctx.fillStyle = `rgba(${color}, 1)`
            ctx.beginPath()
            ctx.arc(x, y, radius, 0, Math.PI * 2)
            ctx.fill()
            return
        }
        const grad = ctx.createRadialGradient(x, y, 0, x, y, radius)
        grad.addColorStop(0, `rgba(${color}, 1)`)
        grad.addColorStop(h, `rgba(${color}, 1)`)
        grad.addColorStop(1, `rgba(${color}, 0)`)
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(x, y, radius, 0, Math.PI * 2)
        ctx.fill()
    }, [])

    // Interpolate stamps along a line from (x1, y1) → (x2, y2) so fast
    // drags don't show gaps. The step is `radius / 3` — three stamps
    // per diameter gives smooth coverage without overdraw.
    const strokeBrush = useCallback((ctx, x1, y1, x2, y2, radius, hardness, color) => {
        if (!ctx) return
        const dx = x2 - x1
        const dy = y2 - y1
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < 0.5) {
            // Sub-pixel drag — single stamp.
            stampBrush(ctx, x2, y2, radius, hardness, color)
            return
        }
        const step = Math.max(1, radius / 3)
        const n = Math.max(1, Math.ceil(dist / step))
        for (let i = 1; i <= n; i += 1) {
            const t = i / n
            stampBrush(ctx, x1 + dx * t, y1 + dy * t, radius, hardness, color)
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
        const fabricCanvas = canvasEditor
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
        brushPointsRef.current = [{ x: pos.x, y: pos.y }]
        // Refine mode: decide add vs erase at stroke START (Erase toggle or
        // Alt-drag, studio-style) and hold it for the whole drag.
        const evt = e?.e || e
        strokeEraseRef.current = !!refineSessionRef.current
            && (refineModeRef.current === 'erase' || !!evt?.altKey)
        // Step 10.1: scale the stamp position and radius into
        // brush-canvas space. `brushScale` is 1.0 for images already
        // at or below 2048 on the long edge, <1.0 for higher-res
        // sources. The UI's `brushSize` slider stays in image-pixel
        // units, so this is the only place the scaling happens.
        const s = brushScaleRef.current
        const r = Math.max(0.5, brushSizeRef.current / 2) * s
        stampBrush(ctx, pos.x * s, pos.y * s, r, brushHardnessRef.current,
            strokeEraseRef.current ? '248, 113, 113' : undefined)
        markBrushChanged()
        if (brushOverlayRef.current) {
            brushOverlayRef.current.set('dirty', true)
            fabricCanvas.requestRenderAll()
        }
    }, [brushActive, imageSize, canvasEditor, pointerToImage, ensureBrushCanvas, stampBrush, markBrushChanged])

    const handleBrushMove = useCallback((e) => {
        if (!isPaintingRef.current || !brushActive) return
        const fabricCanvas = canvasEditor
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
        strokeBrush(ctx, last.x * s, last.y * s, cx * s, cy * s, r, brushHardnessRef.current,
            strokeEraseRef.current ? '248, 113, 113' : undefined)
        lastBrushPointRef.current = { x: cx, y: cy }
        const pts = brushPointsRef.current
        const prev = pts[pts.length - 1]
        if (!prev || (cx - prev.x) * (cx - prev.x) + (cy - prev.y) * (cy - prev.y) >= 4) {
            pts.push({ x: cx, y: cy })
        }
        markBrushChanged()
        if (brushOverlayRef.current) {
            brushOverlayRef.current.set('dirty', true)
            // Throttle the render to one per frame — without this, fast
            // drags fire dozens of mousemoves per frame and the GL
            // context sputters.
            fabricCanvas.requestRenderAll()
        }
    }, [brushActive, imageSize, canvasEditor, pointerToImage, ensureBrushCanvas, strokeBrush, markBrushChanged])

    const drawShapeMaskBlob = useCallback(async (blob, token) => {
        const objectUrl = URL.createObjectURL(blob)
        try {
            const img = await new Promise((resolve, reject) => {
                const image = new Image()
                image.onload = () => resolve(image)
                image.onerror = () => reject(new Error('Failed to decode shape mask PNG'))
                image.src = objectUrl
            })
            if (shapeFillTokenRef.current !== token) return false
            const brushCanvas = brushCanvasRef.current
            if (!brushCanvas) return false
            const ctx = brushCanvas.getContext('2d')
            if (!ctx) return false
            ctx.save()
            ctx.globalCompositeOperation = 'source-over'
            ctx.drawImage(img, 0, 0, brushCanvas.width, brushCanvas.height)
            ctx.restore()
            markBrushChanged()
            if (brushOverlayRef.current) {
                brushOverlayRef.current.set('dirty', true)
                canvasEditor?.requestRenderAll?.()
            }
            return true
        } finally {
            URL.revokeObjectURL(objectUrl)
        }
    }, [canvasEditor, markBrushChanged])

    const requestPythonClosedShapeFill = useCallback(async (points, token) => {
        const brushCanvas = brushCanvasRef.current
        if (!brushCanvas || !Array.isArray(points) || points.length < 3) return false
        const scale = brushScaleRef.current || 1
        const scaledPoints = points.map((p) => [
            Math.round(p.x * scale * 100) / 100,
            Math.round(p.y * scale * 100) / 100,
        ])

        setIsShapeFilling(true)
        try {
            const response = await fetch('/api/ai/shape-mask', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    width: brushCanvas.width,
                    height: brushCanvas.height,
                    points: scaledPoints,
                }),
                signal: AbortSignal.timeout(8_000),
            })
            if (!response.ok) {
                const err = await response.json().catch(() => ({}))
                throw new Error(err.error || `shape mask failed (${response.status})`)
            }
            return drawShapeMaskBlob(await response.blob(), token)
        } catch (error) {
            console.warn('[mask] Python closed-shape fill unavailable; using canvas fallback:', error?.message)
            return false
        } finally {
            if (shapeFillTokenRef.current === token) setIsShapeFilling(false)
        }
    }, [drawShapeMaskBlob])

    const fillClosedBrushStroke = useCallback(() => {
        const brushCanvas = brushCanvasRef.current
        if (!brushCanvas) return false
        const ctx = brushCanvas.getContext('2d')
        if (!ctx) return false
        const points = brushPointsRef.current.slice()
        const filled = fillClosedBrushPath(
            ctx,
            points,
            brushScaleRef.current,
            brushSizeRef.current,
        )
        if (!filled) return false
        const token = shapeFillTokenRef.current + 1
        shapeFillTokenRef.current = token
        void requestPythonClosedShapeFill(points, token)
        markBrushChanged()
        if (brushOverlayRef.current) {
            brushOverlayRef.current.set('dirty', true)
            canvasEditor?.requestRenderAll?.()
        }
        return true
    }, [canvasEditor, markBrushChanged, requestPythonClosedShapeFill])

    const handleBrushUp = useCallback((e) => {
        if (!isPaintingRef.current) return
        if (e && canvasEditor) {
            const pos = pointerToImage(canvasEditor, e)
            const w = imageSize?.width || 0
            const h = imageSize?.height || 0
            if (pos && w > 0 && h > 0) {
                const cx = Math.max(0, Math.min(w, pos.x))
                const cy = Math.max(0, Math.min(h, pos.y))
                const pts = brushPointsRef.current
                const prev = pts[pts.length - 1]
                if (!prev || (cx - prev.x) * (cx - prev.x) + (cy - prev.y) * (cy - prev.y) >= 1) {
                    pts.push({ x: cx, y: cy })
                }
            }
        }
        // Refine mode: the released stroke lands on the layer's mask NOW
        // (studio-style live refine) — no closed-shape fill, no Add step.
        const session = refineSessionRef.current
        if (session) {
            isPaintingRef.current = false
            lastBrushPointRef.current = null
            brushPointsRef.current = []
            const brushCanvas = brushCanvasRef.current
            if (brushCanvas) {
                try {
                    applyRefineStroke(tool.mainImage, session, brushCanvas, { erase: strokeEraseRef.current })
                } catch (err) {
                    console.error('[mask] refine stroke failed:', err)
                    toast.error(toUserMessage(err, 'Could not apply the stroke'))
                }
                // Clear IN PLACE (the overlay uses this canvas as its element)
                // so the next stroke starts from an empty stencil.
                const bctx = brushCanvas.getContext('2d')
                bctx?.clearRect(0, 0, brushCanvas.width, brushCanvas.height)
                if (brushOverlayRef.current) {
                    brushOverlayRef.current.set('dirty', true)
                    canvasEditor?.requestRenderAll?.()
                }
            }
            setBrushHasContent(false)
            return
        }
        fillClosedBrushStroke()
        isPaintingRef.current = false
        lastBrushPointRef.current = null
        brushPointsRef.current = []
    }, [canvasEditor, imageSize, pointerToImage, fillClosedBrushStroke, tool.mainImage])

    // Wire the pointer events when brush mode is active. Window-level
    // move + up so a drag that escapes the canvas still finalises.
    useEffect(() => {
        const fabricCanvas = canvasEditor
        if (!fabricCanvas || !brushActive) return
        fabricCanvas.defaultCursor = 'crosshair'
        fabricCanvas.hoverCursor = 'crosshair'
        fabricCanvas.selection = false
        const onDown = (e) => handleBrushDown(e)
        const onMove = (e) => {
            const fake = { e }
            handleBrushMove(fake)
        }
        const onUp = (ev) => handleBrushUp({ e: ev })
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
        const fabricCanvas = canvasEditor
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
        // Scale includes the canvas→image factor (brush canvas is 2048-capped).
        const img = tool.mainImage
        const { width: natW, height: natH } = getImageBitmapSize(img)
        const overlay = new FabricImage(brushCanvas, {
            left: img.left,
            top: img.top,
            scaleX: img.scaleX * (natW / brushCanvas.width),
            scaleY: img.scaleY * (natH / brushCanvas.height),
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
    const fabricViewport = canvasEditor?.viewportTransform
    const panX = fabricViewport?.[4] ?? 0
    const panY = fabricViewport?.[5] ?? 0
    useEffect(() => {
        const overlay = brushOverlayRef.current
        const liveImg = tool.mainImage
        const fabricCanvas = canvasEditor
        if (!overlay || !liveImg || !fabricCanvas) return
        // Same canvas→image scale factor as the create effect (2048 cap).
        const { width: natW, height: natH } = getImageBitmapSize(liveImg)
        overlay.set({
            left: liveImg.left,
            top: liveImg.top,
            scaleX: liveImg.scaleX * (natW / (overlay.width || 1)),
            scaleY: liveImg.scaleY * (natH / (overlay.height || 1)),
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
        canvasEditor,
        // Image transform fields — cover zoom, rotate, flip, move
        imgLeft, imgTop, imgScaleX, imgScaleY, imgAngle, imgFlipX, imgFlipY,
        // Viewport translate — covers pure pan (image not moving)
        panX, panY,
    ])

    // Returns true when the brush actually armed (refine arming checks it).
    // `opts.silent` skips the instruction toast; an onClick event arg is
    // harmless (event.silent is undefined).
    const handleStartBrush = useCallback((opts = {}) => {
        if (!imageSize) {
            toast.error('Image not ready yet')
            return false
        }
        // Cancel any other click-mode (incl. Quick Erase) so its handler
        // doesn't fire and the destructive brush can't resume afterwards.
        stopModesRef.current('brush')
        if (activeDraft) {
            toast('Finish or cancel the current draft first', { icon: 'ℹ️' })
            return false
        }
        ensureBrushCanvas()
        // Reset stale "hasContent" state from a prior session — without
        // this, the Add button would be enabled before the user painted
        // anything (the flag was left true from the previous stroke).
        setBrushHasContent(false)
        isPaintingRef.current = false
        lastBrushPointRef.current = null
        brushPointsRef.current = []
        shapeFillTokenRef.current += 1
        setIsShapeFilling(false)
        refineSessionRef.current = null
        setRefineTarget(null)
        setBrushActive(true)
        if (!opts?.silent) {
            toast(brushSink === 'erase'
                ? 'Paint to mark the cut region, then "Add cut to layers". Nothing is erased until you add it.'
                : 'Paint a selection, then "Add selection to layers". Non-destructive.', { id: 'mask-tool-hint' })
        }
        return true
    }, [imageSize, ensureBrushCanvas, activeDraft, brushSink])

    const handleStopBrush = useCallback(() => {
        setBrushActive(false)
        refineSessionRef.current = null
        setRefineTarget(null)
        isPaintingRef.current = false
        lastBrushPointRef.current = null
        brushPointsRef.current = []
        shapeFillTokenRef.current += 1
        setIsShapeFilling(false)
    }, [])

    const handleClearBrush = useCallback(() => {
        const c = brushCanvasRef.current
        if (!c) return
        const ctx = c.getContext('2d')
        if (!ctx) return
        ctx.clearRect(0, 0, c.width, c.height)
        setBrushHasContent(false)
        brushPointsRef.current = []
        shapeFillTokenRef.current += 1
        setIsShapeFilling(false)
        if (brushOverlayRef.current) {
            brushOverlayRef.current.set('dirty', true)
            canvasEditor?.requestRenderAll?.()
        }
    }, [canvasEditor])

    /* ─── Brush-refine (mask-studio port) ───────────────────────────────────
     * Paint DIRECTLY on the selected layer's mask: drag adds coverage,
     * Alt-drag (or the Erase toggle) removes it, and every RELEASED stroke is
     * composited into the texture immediately via applyRefineStroke — no
     * separate Apply step. beginLayerRefine swaps the texture in under a new
     * key through the same direct-filter path as the Boundary slider.
     */
    const handleStopRefine = useCallback(() => {
        refineSessionRef.current = null
        setRefineTarget(null)
        handleClearBrush()
        setBrushActive(false)
        isPaintingRef.current = false
        lastBrushPointRef.current = null
    }, [handleClearBrush])

    // Arm the refine brush for a layer card's "Erase region" / "Add region".
    const handleStartRefine = useCallback((layerId, mode) => {
        const layer = chainStackRef.current?.chain?.find((e) => e.layer.id === layerId)?.layer
        if (!layer?.maskTextureKey && !layer?.brushTextureKey) {
            toast.error('This layer has no paintable mask region')
            return
        }
        if (layer.lock) {
            toast('Unlock the layer first', { icon: 'ℹ️' })
            return
        }
        if (!handleStartBrush({ silent: true })) return
        const brushCanvas = ensureBrushCanvas()
        if (!brushCanvas) return
        try {
            refineSessionRef.current = beginLayerRefine(tool.mainImage, layerId, {
                width: brushCanvas.width,
                height: brushCanvas.height,
            })
        } catch (err) {
            console.error('[mask] could not start refine:', err)
            toast.error(toUserMessage(err, 'Could not start refining this layer'))
            setBrushActive(false)
            return
        }
        selectLayer(layerId)
        setRefineTarget({ layerId, mode })
        toast(mode === 'erase'
            ? 'Drag to ERASE from the mask · Alt-drag to add back · Done to finish'
            : 'Drag to ADD to the mask · Alt-drag to erase · Done to finish')
    }, [handleStartBrush, ensureBrushCanvas, selectLayer, tool.mainImage])

    // Disarm if the target layer disappears (deleted / image swap).
    useEffect(() => {
        if (!refineTarget) return
        const present = (stack.chain || []).some((e) => e.layer.id === refineTarget.layerId)
        if (!present) handleStopRefine()
    }, [refineTarget, stack.chain, handleStopRefine])

    // Commit the painted brush canvas as a NON-DESTRUCTIVE megashader
    // selection layer. The painted alpha is stored in the mask texture cache
    // and referenced by the new layer (plain `brush` kind, or edge-preserving
    // `smartBrush` when "Snap to edges" is on). `brushSink` picks fill vs
    // erase; `brushModifier` maps to the chain blend op; `brushFeather` is
    // baked into the texture so each region keeps its own soft edge.
    const handleAddBrushLayer = useCallback(() => {
        if (isShapeFilling) {
            toast('Finishing the closed shape fill...')
            return
        }
        const brushCanvas = brushCanvasRef.current
        if (!brushCanvas) {
            toast('Start painting first')
            return
        }
        if (stack.chain.length >= MAX_LAYERS) {
            toast.error(`Mask layer limit reached (${MAX_LAYERS}). Remove a layer to add more.`)
            return
        }
        const ctx = brushCanvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return
        // Empty check: a single full-canvas read, scanning only the alpha
        // channel (one getImageData, not one per pixel).
        let anyPainted = false
        try {
            const data = ctx.getImageData(0, 0, brushCanvas.width, brushCanvas.height).data
            for (let i = 3; i < data.length; i += 4) { if (data[i] > 0) { anyPainted = true; break } }
        } catch { anyPainted = true /* tainted → assume painted */ }
        if (!anyPainted) {
            toast('Paint something first')
            return
        }

        // Bake the feather PER REGION (plain brush only — the smart brush's
        // bilateral filter is its own edge control). Blurring the painted
        // alpha into a fresh canvas means moving the slider later never
        // re-feathers already-committed regions.
        let textureCanvas = brushCanvas
        const featherPx = Math.max(0, Math.round(brushFeather * brushScaleRef.current))
        if (!brushEdgeSnap && featherPx > 0 && typeof document !== 'undefined') {
            try {
                const fc = document.createElement('canvas')
                fc.width = brushCanvas.width
                fc.height = brushCanvas.height
                const fctx = fc.getContext('2d')
                if (fctx) {
                    fctx.filter = `blur(${featherPx}px)`
                    fctx.drawImage(brushCanvas, 0, 0)
                    fctx.filter = 'none'
                    textureCanvas = fc
                }
            } catch { textureCanvas = brushCanvas }
        }

        const key = `brush-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        setMaskTexture(key, textureCanvas)
        // Select must not paint the photo (a fill tint exports); the traced
        // boundary shows the selection instead.
        const fillMode = brushSink === 'erase' ? 'erase' : 'adjust'
        const id = brushEdgeSnap
            ? addChainLayer('smartBrush', {
                brushTextureKey: key,
                baseTextureKey: key,
                growPx: 0,
                filterRadius,
                sigmaColor,
                sigmaSpace,
                fillMode,
                label: brushSink === 'erase' ? 'Brush cut (smart)' : 'Smart brush',
            })
            : addChainLayer('brush', {
                maskTextureKey: key,
                baseTextureKey: key,
                growPx: 0,
                fillMode,
                label: brushSink === 'erase' ? 'Brush cut' : 'Brush selection',
            })
        if (id) {
            if (brushModifier === 'add' || brushModifier === 'subtract' || brushModifier === 'intersect') {
                setLayerOp(id, brushModifier)
            }
            toast.success(brushSink === 'erase' ? 'Brush cut added to layers' : 'Brush selection added to layers')
            // Reset the brush canvas for the next stroke. We allocate
            // a fresh canvas rather than clearing in place — the old
            // canvas is still referenced by the just-added layer, and
            // clearing it would mutate a cached texture.
            brushCanvasRef.current = null
            setBrushHasContent(false)
            setBrushActive(false)
            isPaintingRef.current = false
            lastBrushPointRef.current = null
            brushPointsRef.current = []
            shapeFillTokenRef.current += 1
            setIsShapeFilling(false)
        }
    }, [addChainLayer, setLayerOp, stack.chain.length, brushSink, brushModifier, brushEdgeSnap, brushFeather, filterRadius, sigmaColor, sigmaSpace, isShapeFilling])

    /* ─── Lasso handlers ─── */

    // Remove the live lasso overlay (dashed polyline + vertex markers).
    const clearLassoOverlay = useCallback(() => {
        const fabricCanvas = canvasEditor
        if (!fabricCanvas) return
        if (lassoOverlayRef.current) {
            try { fabricCanvas.remove(lassoOverlayRef.current) } catch { /* canvas gone */ }
            lassoOverlayRef.current = null
        }
        for (const m of lassoMarkerRefs.current) {
            try { fabricCanvas.remove(m) } catch { /* canvas gone */ }
        }
        lassoMarkerRefs.current = []
    }, [canvasEditor])

    // Rebuild the dashed-polyline preview from the current points (plus a
    // rubber-band segment to the cursor in polygonal mode), and the vertex
    // markers. Recreated each redraw so Fabric positions the polyline at the
    // absolute point coords (mutating .points drifts the offset).
    const redrawLassoOverlay = useCallback(() => {
        const fabricCanvas = canvasEditor
        if (!fabricCanvas) return
        clearLassoOverlay()
        // Screen-constant sizes: scene units shrink to sub-pixel at low zoom.
        const z = fabricCanvas.getZoom?.() || 1
        const pts = lassoPointsRef.current
        const disp = (pts || []).map((p) => imageToDisplay(p.x, p.y)).filter(Boolean)
        const linePts = disp.slice()
        if ((lassoModeRef.current === 'polygonal' || lassoModeRef.current === 'magnetic') && lassoCursorRef.current && disp.length > 0) {
            const c = imageToDisplay(lassoCursorRef.current.x, lassoCursorRef.current.y)
            if (c) linePts.push(c)
        }
        if (linePts.length >= 2) {
            const poly = new Polyline(linePts, {
                stroke: '#06b8d4',
                strokeWidth: 1.5 / z,
                strokeDashArray: [4 / z, 4 / z],
                fill: 'rgba(6,184,212,0.10)',
                selectable: false,
                evented: false,
                excludeFromExport: true,
                objectCaching: false,
            })
            fabricCanvas.add(poly)
            lassoOverlayRef.current = poly
        }
        if (lassoModeRef.current === 'polygonal') {
            for (const d of disp) {
                const marker = new FabricCircle({
                    left: d.x, top: d.y, radius: 4 / z,
                    fill: '#06b8d4', stroke: '#ffffff', strokeWidth: 1 / z,
                    originX: 'center', originY: 'center',
                    selectable: false, evented: false, excludeFromExport: true,
                })
                fabricCanvas.add(marker)
                lassoMarkerRefs.current.push(marker)
            }
        }
        fabricCanvas.requestRenderAll()
    }, [canvasEditor, imageToDisplay, clearLassoOverlay])

    // Clear the in-progress path (points + overlay + cursor) but keep the
    // tool active so the user can draw another selection.
    const resetLassoPath = useCallback(() => {
        lassoPointsRef.current = []
        lassoCursorRef.current = null
        lassoDrawingRef.current = false
        setLassoVertexCount(0)
        clearLassoOverlay()
        canvasEditor?.requestRenderAll?.()
    }, [clearLassoOverlay, canvasEditor])

    // ── Marching-ants selection outline ─────────────────────────────────────
    // A thin animated dashed line traced along the ACTIVE mask layer's boundary,
    // so the user always sees exactly what's selected while adjusting it — even
    // when the fill tint blends into a same-hue photo. Drawn as Fabric objects
    // in scene space (via imageToDisplay), so it tracks zoom/pan automatically;
    // flagged phosmithMaskOverlay so canvas history ignores it and exports drop
    // it. Only texture-backed layers (AI subject/background, brush, lasso, depth)
    // can be traced — procedural range masks have no coverage bitmap.
    const outlineObjsRef = useRef([])
    const outlineRafRef = useRef(null)
    // True whenever a pointer is pressed anywhere (brush/lasso stroke, slider
    // drag). The ants animation skips its per-frame requestRenderAll while this
    // is set, so it can never trigger a full-scene render mid brush-stroke (the
    // in-stroke latency fast path in usePixelMaskTool/canvas.jsx must own that).
    const pointerActiveRef = useRef(false)
    useEffect(() => {
        const down = () => { pointerActiveRef.current = true }
        const up = () => { pointerActiveRef.current = false }
        window.addEventListener('pointerdown', down, true)
        window.addEventListener('pointerup', up, true)
        window.addEventListener('pointercancel', up, true)
        return () => {
            window.removeEventListener('pointerdown', down, true)
            window.removeEventListener('pointerup', up, true)
            window.removeEventListener('pointercancel', up, true)
        }
    }, [])

    const clearMaskOutline = useCallback(() => {
        if (outlineRafRef.current) { cancelAnimationFrame(outlineRafRef.current); outlineRafRef.current = null }
        const fc = canvasEditor
        if (fc && outlineObjsRef.current.length) {
            for (const o of outlineObjsRef.current) { try { fc.remove(o) } catch { /* canvas gone */ } }
            fc.requestRenderAll?.()
        }
        outlineObjsRef.current = []
    }, [canvasEditor])

    const drawMaskOutline = useCallback(() => {
        const fc = canvasEditor
        clearMaskOutline()
        const img = tool.mainImage
        if (!fc || !img) return
        const layer = chainStackRef.current?.chain?.find((e) => e.layer.id === selectedLayerIdRef.current)?.layer
        const key = layer?.maskTextureKey || layer?.brushTextureKey
        // Fill mode already paints the region, so an edge on top adds nothing.
        if (!key || layer.fillMode === 'fill') return
        const tex = getMaskTexture(key)
        const texW = tex?.width || tex?.naturalWidth || 0
        if (!texW) return
        const screenPxPerSourcePx = (img.getScaledWidth() * (fc.getZoom?.() || 1)) / texW
        let boundary
        try { boundary = buildMaskBoundary(tex, { screenPxPerSourcePx }) } catch { return }
        if (!boundary) return
        // Object width, not natural width: they differ when Fabric scales the
        // element, and the overlay must cover exactly the box the image draws.
        const overlay = new FabricImage(boundary, {
            left: img.left, top: img.top,
            scaleX: (img.width * img.scaleX) / boundary.width,
            scaleY: (img.height * img.scaleY) / boundary.height,
            angle: img.angle, originX: img.originX, originY: img.originY,
            flipX: img.flipX, flipY: img.flipY,
            selectable: false, evented: false, hasControls: false, hasBorders: false,
            objectCaching: false, excludeFromExport: true, phosmithMaskOverlay: true,
        })
        fc.add(overlay)
        outlineObjsRef.current = [overlay]
        fc.requestRenderAll()
    }, [canvasEditor, tool.mainImage, clearMaskOutline])

    // (Re)draw the outline when the active layer, its coverage texture, or its
    // grown boundary changes. Cleared on unmount / when nothing is selected.
    useEffect(() => {
        if (cleanPreview) { clearMaskOutline(); return undefined }
        drawMaskOutline()
        return () => clearMaskOutline()
    }, [drawMaskOutline, clearMaskOutline, selectedLayerId, selectedLayer?.maskTextureKey, selectedLayer?.growPx, selectedLayer?.fillMode, tool.mainImage, cleanPreview])

    // Rasterise the closed polygon to an offscreen alpha canvas (white
    // inside on opaque black, so Canvas2D anti-aliasing lands in the R
    // channel the lasso GLSL samples). Capped to BRUSH_CANVAS_MAX_DIM like
    // the smart brush; the GLSL samples by normalised UV so the cap is free.
    const rasterizeLasso = useCallback((points) => {
        if (!imageSize || !points || points.length < 3) return null
        const longEdge = Math.max(imageSize.width, imageSize.height)
        const scale = longEdge > BRUSH_CANVAS_MAX_DIM ? BRUSH_CANVAS_MAX_DIM / longEdge : 1
        const W = Math.max(1, Math.round(imageSize.width * scale))
        const H = Math.max(1, Math.round(imageSize.height * scale))
        const c = document.createElement('canvas')
        c.width = W
        c.height = H
        const ctx = c.getContext('2d')
        if (!ctx) return null
        ctx.fillStyle = '#000000'
        ctx.fillRect(0, 0, W, H)
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.moveTo(points[0].x * scale, points[0].y * scale)
        for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x * scale, points[i].y * scale)
        ctx.closePath()
        ctx.fill('evenodd')
        return c
    }, [imageSize])

    // Pen mode — smooth the captured anchors into a Bézier path and rasterise
    // it to the same capped-scale alpha canvas the lasso uses. Reuses the exact
    // capture pipeline; only the rasterisation (curves) and layer kind differ.
    const rasterizePenPath = useCallback((points) => {
        if (!imageSize || !points || points.length < 3) return null
        const longEdge = Math.max(imageSize.width, imageSize.height)
        const scale = longEdge > BRUSH_CANVAS_MAX_DIM ? BRUSH_CANVAS_MAX_DIM / longEdge : 1
        const W = Math.max(1, Math.round(imageSize.width * scale))
        const H = Math.max(1, Math.round(imageSize.height * scale))
        const anchors = smoothToBezier(points, { closed: true })
        const sc = (p) => (p ? { x: p.x * scale, y: p.y * scale } : undefined)
        const scaled = anchors.map((a) => ({ x: a.x * scale, y: a.y * scale, cOut: sc(a.cOut), cIn: sc(a.cIn) }))
        return rasterisePath(scaled, W, H, { closed: true })
    }, [imageSize])

    // ─── Magnetic lasso edge engine ───
    // Build (and cache) a Sobel gradient-magnitude map of the source image,
    // normalised to 0..1, at the SAME capped scale rasterizeLasso uses so the
    // snapped points line up exactly with the rasterised selection texture.
    const ensureGradientMap = useCallback(() => {
        if (!imageSize || !tool.mainImage) return null
        const sourceEl = tool.mainImage._originalElement || tool.mainImage._element || tool.mainImage.getElement?.()
        if (!sourceEl) return null
        const longEdge = Math.max(imageSize.width, imageSize.height)
        const scale = longEdge > BRUSH_CANVAS_MAX_DIM ? BRUSH_CANVAS_MAX_DIM / longEdge : 1
        const W = Math.max(1, Math.round(imageSize.width * scale))
        const H = Math.max(1, Math.round(imageSize.height * scale))
        const token = `${sourceEl.currentSrc || sourceEl.src || ''}|${W}x${H}`
        const cached = gradientMapRef.current
        if (cached && cached.token === token) return cached
        let data
        try {
            const c = document.createElement('canvas')
            c.width = W
            c.height = H
            const cx = c.getContext('2d', { willReadFrequently: true })
            if (!cx) return null
            cx.drawImage(sourceEl, 0, 0, W, H)
            data = cx.getImageData(0, 0, W, H).data
        } catch {
            return null // tainted canvas — magnetic snapping unavailable
        }
        const { mag } = computeGradientMagnitude(data, W, H)
        const result = { mag, W, H, scale, token }
        gradientMapRef.current = result
        return result
    }, [imageSize, tool.mainImage])

    // Snap an image-space point to the strongest edge within `magneticWidth`,
    // biased toward the cursor (proximity-dominant). Returns the input unchanged
    // when no edge clears the contrast threshold or the map is unavailable. The
    // search math is the shared, unit-tested engine in `@/lib/mask-edge-snap`.
    const snapToEdge = useCallback((imgX, imgY) => {
        const gm = ensureGradientMap()
        if (!gm) return { x: imgX, y: imgY }
        const radius = Math.max(1, magneticWidthRef.current * gm.scale)
        const threshold = Math.max(0, Math.min(1, magneticContrastRef.current / 100))
        const snapped = snapToEdgePoint(
            { mag: gm.mag, w: gm.W, h: gm.H },
            imgX * gm.scale,
            imgY * gm.scale,
            radius,
            threshold,
        )
        return { x: snapped.x / gm.scale, y: snapped.y / gm.scale }
    }, [ensureGradientMap])

    // Resolve the chain blend op from Shift/Alt on the closing event, or
    // (when no modifier is held) the modifier-button state.
    const resolveLassoModifier = useCallback((rawEvent) => {
        const shift = rawEvent?.shiftKey || rawEvent?.e?.shiftKey
        const alt = rawEvent?.altKey || rawEvent?.e?.altKey
        if (shift && alt) return 'intersect'
        if (shift) return 'add'
        if (alt) return 'subtract'
        return lassoModifierRef.current
    }, [])

    // Commit the current polygon → a megashader 'lasso' layer. `select`
    // sink uses fill mode (visible selection); `erase` uses erase mode
    // (cuts the region). The modifier maps to the chain blend op so a
    // second lasso composes with the first.
    const finishLassoSelection = useCallback((rawEvent) => {
        const pts = lassoPointsRef.current
        if (!pts || pts.length < 3) { resetLassoPath(); return }
        const usePen = lassoSmooth
        const canvas = usePen ? rasterizePenPath(pts) : rasterizeLasso(pts)
        if (!canvas) { resetLassoPath(); return }
        const prefix = usePen ? 'path' : 'lasso'
        const key = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        setMaskTexture(key, canvas)
        const id = addChainLayer(usePen ? 'path' : 'lasso', {
            maskTextureKey: key,
            baseTextureKey: key,
            growPx: 0,
            feather: lassoFeather,
            fillMode: lassoSink === 'erase' ? 'erase' : 'adjust',
            label: usePen
                ? (lassoSink === 'erase' ? 'Pen cut' : 'Pen path')
                : (lassoSink === 'erase' ? 'Lasso cut' : 'Lasso selection'),
        })
        if (id) {
            const mod = resolveLassoModifier(rawEvent)
            // 'new' leaves the default op (replace for the first layer, add
            // otherwise). add/subtract/intersect only apply to non-first
            // layers (setLayerOp is a no-op on slot 0).
            if (mod === 'add' || mod === 'subtract' || mod === 'intersect') {
                setLayerOp(id, mod)
            }
            toast.success(lassoSink === 'erase' ? 'Lasso cut added to layers' : 'Lasso selection added to layers')
        }
        resetLassoPath()
    }, [rasterizeLasso, rasterizePenPath, lassoSmooth, addChainLayer, setLayerOp, lassoFeather, lassoSink, resolveLassoModifier, resetLassoPath])

    const removeLastLassoVertex = useCallback(() => {
        if (lassoPointsRef.current.length === 0) return
        lassoPointsRef.current = lassoPointsRef.current.slice(0, -1)
        setLassoVertexCount(lassoPointsRef.current.length)
        redrawLassoOverlay()
    }, [redrawLassoOverlay])

    // Distance (image px) under which a polygonal click snaps to the first
    // vertex to close the loop — ~8 display px regardless of zoom.
    const lassoCloseThreshold = useCallback(() => {
        // Screen px per natural px includes canvas zoom and any downscaled source.
        const img = tool.mainImage
        const { natW, bw } = naturalVsObject(img)
        const perPx = Math.abs(img?.scaleX || 1) * (canvasEditor?.getZoom?.() || 1) * (natW ? bw / natW : 1)
        return 8 / Math.max(1e-4, perPx)
    }, [tool.mainImage, canvasEditor])

    const handleLassoDown = useCallback((e) => {
        if (!lassoActive || !imageSize) return
        const pos = pointerToImage(canvasEditor, e)
        if (!pos) return
        if (lassoModeRef.current === 'freehand') {
            lassoDrawingRef.current = true
            lassoPointsRef.current = [{ x: pos.x, y: pos.y }]
            setLassoVertexCount(1)
            redrawLassoOverlay()
            return
        }
        if (lassoModeRef.current === 'magnetic') {
            // First click starts the path; subsequent moves auto-lay snapped
            // points (no button held, Photoshop-style); clicks drop a manual
            // anchor; clicking near the first point (≥3 points) closes.
            const pts = lassoPointsRef.current
            if (pts.length >= 3) {
                const first = pts[0]
                const dx = pos.x - first.x
                const dy = pos.y - first.y
                if (Math.sqrt(dx * dx + dy * dy) <= lassoCloseThreshold()) {
                    finishLassoSelection(e)
                    return
                }
            }
            const snapped = snapToEdge(pos.x, pos.y)
            if (!lassoDrawingRef.current) {
                ensureGradientMap()
                lassoDrawingRef.current = true
                lassoPointsRef.current = [snapped]
            } else {
                lassoPointsRef.current = [...pts, snapped]
            }
            lassoCursorRef.current = snapped
            setLassoVertexCount(lassoPointsRef.current.length)
            redrawLassoOverlay()
            return
        }
        // polygonal: clicking near the first vertex (with ≥3 points) closes.
        const pts = lassoPointsRef.current
        if (pts.length >= 3) {
            const first = pts[0]
            const dx = pos.x - first.x
            const dy = pos.y - first.y
            if (Math.sqrt(dx * dx + dy * dy) <= lassoCloseThreshold()) {
                finishLassoSelection(e)
                return
            }
        }
        lassoPointsRef.current = [...pts, { x: pos.x, y: pos.y }]
        setLassoVertexCount(lassoPointsRef.current.length)
        redrawLassoOverlay()
    }, [lassoActive, imageSize, pointerToImage, canvasEditor, redrawLassoOverlay, lassoCloseThreshold, finishLassoSelection, snapToEdge, ensureGradientMap])

    const handleLassoMove = useCallback((e) => {
        if (!lassoActive) return
        const pos = pointerToImage(canvasEditor, e)
        if (!pos) return
        if (lassoModeRef.current === 'magnetic') {
            // Lay snapped points as the cursor moves (no button needed once
            // started). Append only every `frequency` px so the path stays
            // light; always update the rubber-band to the live snapped cursor.
            if (!lassoDrawingRef.current) return
            const snapped = snapToEdge(pos.x, pos.y)
            lassoCursorRef.current = snapped
            const pts = lassoPointsRef.current
            const last = pts[pts.length - 1]
            if (last) {
                const dx = snapped.x - last.x
                const dy = snapped.y - last.y
                const spacing = Math.max(3, magneticFrequencyRef.current)
                if (dx * dx + dy * dy >= spacing * spacing) {
                    lassoPointsRef.current = [...pts, snapped]
                    setLassoVertexCount(lassoPointsRef.current.length)
                }
            }
            redrawLassoOverlay()
            return
        }
        if (lassoModeRef.current === 'freehand') {
            if (!lassoDrawingRef.current) return
            const pts = lassoPointsRef.current
            const last = pts[pts.length - 1]
            if (last) {
                const dx = pos.x - last.x
                const dy = pos.y - last.y
                if (dx * dx + dy * dy < 4) return // min 2px image-space spacing
            }
            lassoPointsRef.current = [...pts, { x: pos.x, y: pos.y }]
            // Avoid a setState per sampled point on long strokes — only the
            // overlay needs updating live; the count is cosmetic.
            redrawLassoOverlay()
            return
        }
        // polygonal: rubber-band the segment to the cursor.
        lassoCursorRef.current = { x: pos.x, y: pos.y }
        if (lassoPointsRef.current.length > 0) redrawLassoOverlay()
    }, [lassoActive, pointerToImage, canvasEditor, redrawLassoOverlay, snapToEdge])

    const handleLassoUp = useCallback((rawEvent) => {
        if (!lassoActive) return
        if (lassoModeRef.current !== 'freehand') return
        if (!lassoDrawingRef.current) return
        lassoDrawingRef.current = false
        finishLassoSelection(rawEvent)
    }, [lassoActive, finishLassoSelection])

    // Wire fabric mouse:down + dblclick (canvas) and window move/up + keys
    // while the lasso is active.
    useEffect(() => {
        const fabricCanvas = canvasEditor
        if (!fabricCanvas || !lassoActive) return undefined
        fabricCanvas.defaultCursor = 'crosshair'
        fabricCanvas.hoverCursor = 'crosshair'
        fabricCanvas.selection = false
        const onDown = (opt) => handleLassoDown(opt)
        const onDbl = () => finishLassoSelection(null) // polygonal close
        const onMove = (ev) => handleLassoMove({ e: ev })
        const onUp = (ev) => handleLassoUp(ev)
        const onKey = (ev) => {
            const t = ev.target
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
            if (ev.key === 'Escape') { resetLassoPath() }
            else if (ev.key === 'Enter') { finishLassoSelection(ev) }
            else if (ev.key === 'Backspace') { ev.preventDefault(); removeLastLassoVertex() }
        }
        fabricCanvas.on('mouse:down', onDown)
        fabricCanvas.on('mouse:dblclick', onDbl)
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        window.addEventListener('keydown', onKey)
        return () => {
            fabricCanvas.defaultCursor = 'default'
            fabricCanvas.hoverCursor = 'move'
            fabricCanvas.selection = true
            fabricCanvas.off('mouse:down', onDown)
            fabricCanvas.off('mouse:dblclick', onDbl)
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            window.removeEventListener('keydown', onKey)
        }
    }, [lassoActive, canvasEditor, handleLassoDown, handleLassoMove, handleLassoUp, finishLassoSelection, resetLassoPath, removeLastLassoVertex])

    // Re-draw the lasso overlay when the image transform changes (pan/zoom)
    // so the in-progress selection stays glued to the photo.
    useEffect(() => {
        if (!lassoActive) return
        if (lassoPointsRef.current.length > 0) redrawLassoOverlay()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [imgLeft, imgTop, imgScaleX, imgScaleY, imgAngle, imgFlipX, imgFlipY, panX, panY])

    const handleStartLasso = useCallback(() => {
        if (!imageSize) { toast.error('Image not ready yet'); return }
        if (activeDraft) { toast('Finish or cancel the current draft first', { icon: 'ℹ️' }); return }
        // Cancel any other click-mode so handlers don't fight over the click.
        stopModesRef.current('lasso')
        resetLassoPath()
        if (lassoMode === 'magnetic') {
            // Build the edge map up front; warn if it can't be made (tainted /
            // cross-origin image) so the user knows snapping is off rather than
            // silently getting an un-snapped click-path.
            const gm = ensureGradientMap()
            if (!gm) toast('Magnetic snapping unavailable for this image — points won’t snap. Try Freehand or Polygonal.', { icon: '⚠️' })
        }
        setLassoActive(true)
        toast(lassoMode === 'freehand'
            ? 'Drag to draw a freehand selection'
            : lassoMode === 'magnetic'
                ? 'Click to start, move along an edge — the path snaps to it. Click to anchor, double-click or Enter to close.'
                : 'Click to add points, double-click or Enter to close', { id: 'mask-tool-hint' })
    }, [imageSize, activeDraft, resetLassoPath, lassoMode, ensureGradientMap])

    const handleStopLasso = useCallback(() => {
        setLassoActive(false)
        resetLassoPath()
    }, [resetLassoPath])

    // Quick Erase (destructive) — explicit opt-in. Cancels any selection mode
    // so the pixel-clipPath brush and the megashader selections never fight
    // over the same click.
    const handleStartQuickErase = useCallback(() => {
        stopModesRef.current('quickErase')
        setQuickEraseActive(true)
    }, [])
    const handleStopQuickErase = useCallback(() => setQuickEraseActive(false), [])

    // Screen px per natural image px (object scale × canvas zoom × source downscale).
    const screenPxPerImagePx = useCallback(() => {
        const img = tool.mainImage
        const { natW, bw } = naturalVsObject(img)
        return Math.abs(img?.scaleX || 1) * (canvasEditor?.getZoom?.() || 1) * (natW ? bw / natW : 1)
    }, [tool.mainImage, canvasEditor])

    // ── Magic Wand ─────────────────────────────────────────────────────────
    // Unfiltered source pixels at the texture working size, read once per image.
    const ensureWandSource = useCallback(() => {
        const img = tool.mainImage
        const sourceEl = img?._originalElement || img?._element || img?.getElement?.()
        if (!sourceEl || !imageSize) return null
        const cached = wandSourceRef.current
        if (cached && cached.el === sourceEl && cached.natW === imageSize.width && cached.natH === imageSize.height) return cached
        const scale = Math.min(1, BRUSH_CANVAS_MAX_DIM / Math.max(imageSize.width, imageSize.height))
        const W = Math.max(1, Math.round(imageSize.width * scale))
        const H = Math.max(1, Math.round(imageSize.height * scale))
        try {
            const c = document.createElement('canvas')
            c.width = W
            c.height = H
            const cx = c.getContext('2d', { willReadFrequently: true })
            cx.drawImage(sourceEl, 0, 0, W, H)
            wandSourceRef.current = { el: sourceEl, natW: imageSize.width, natH: imageSize.height, W, H, scale, data: cx.getImageData(0, 0, W, H).data }
            return wandSourceRef.current
        } catch {
            return null // tainted canvas
        }
    }, [tool.mainImage, imageSize])

    // Plain click = new selection layer; Shift adds to / Alt subtracts from the
    // selected texture layer (or starts an add/subtract layer when none fits).
    const runMagicWand = useCallback((pos, ev) => {
        const src = ensureWandSource()
        if (!src) { toast.error("Can't read this image's pixels for the Magic Wand"); return }
        const x = Math.floor(pos.x * (src.W / src.natW))
        const y = Math.floor(pos.y * (src.H / src.natH))
        if (x < 0 || y < 0 || x >= src.W || y >= src.H) return
        const { cover, count } = magicWandMask(src.data, src.W, src.H, x, y, {
            tolerance: wandTolerance,
            contiguous: wandContiguous,
            antiAlias: wandAntiAlias,
            sample: wandSample,
        })
        if (!count) { toast('Nothing matched — raise the Tolerance'); return }
        const canvas = coverToCanvas(cover, src.W, src.H)
        const add = !!ev?.shiftKey
        const sub = !!ev?.altKey
        const selected = chainStackRef.current?.chain?.find((e) => e.layer.id === selectedLayerIdRef.current)?.layer
        if ((add || sub) && selected && REFINABLE_KINDS.includes(selected.kind) && selected.maskTextureKey && !selected.lock) {
            compositeIntoLayer(selected, canvas, sub ? 'remove' : 'add')
            return
        }
        const key = `wand-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        setMaskTexture(key, canvas)
        const id = addChainLayer('lasso', { maskTextureKey: key, baseTextureKey: key, growPx: 0, feather: 0, label: 'Magic Wand', tool: 'wand' })
        if (id && (add || sub)) setLayerOp(id, sub ? 'subtract' : 'add')
    }, [ensureWandSource, wandTolerance, wandContiguous, wandAntiAlias, wandSample, compositeIntoLayer, addChainLayer, setLayerOp])

    const handleStartWand = useCallback(() => {
        if (!imageSize) { toast.error('Image not ready yet'); return }
        if (activeDraft) { toast('Finish or cancel the current draft first', { icon: 'ℹ️' }); return }
        stopModesRef.current('wand')
        if (!ensureWandSource()) { toast.error("Can't read this image's pixels for the Magic Wand"); return }
        setWandActive(true)
        toast('Click a colour to select it. Shift+click adds, Alt+click subtracts.', { id: 'mask-tool-hint' })
    }, [imageSize, activeDraft, ensureWandSource])

    useEffect(() => {
        const fc = canvasEditor
        if (!fc || !wandActive) return undefined
        fc.defaultCursor = 'crosshair'
        fc.hoverCursor = 'crosshair'
        fc.selection = false
        const onDown = (opt) => {
            if (opt?.e?.button > 0) return
            const pos = pointerToImage(fc, opt)
            if (pos) runMagicWand(pos, opt.e)
        }
        fc.on('mouse:down', onDown)
        return () => {
            fc.off('mouse:down', onDown)
            fc.defaultCursor = 'default'
            fc.hoverCursor = 'move'
            fc.selection = true
        }
    }, [canvasEditor, wandActive, pointerToImage, runMagicWand])

    // ── Marquee (rectangle / ellipse) ─────────────────────────────────────
    const clearMarqueeOverlay = useCallback(() => {
        if (marqueeOverlayRef.current && canvasEditor) canvasEditor.remove(marqueeOverlayRef.current)
        marqueeOverlayRef.current = null
    }, [canvasEditor])

    const drawMarqueeOverlay = useCallback((pts) => {
        const fc = canvasEditor
        if (!fc) return
        clearMarqueeOverlay()
        const disp = pts.map((p) => imageToDisplay(p.x, p.y)).filter(Boolean)
        if (disp.length >= 3) {
            const z = fc.getZoom?.() || 1
            const poly = new Polygon(disp, {
                stroke: '#06b8d4',
                strokeWidth: 1.5 / z,
                strokeDashArray: [5 / z, 4 / z],
                fill: 'rgba(6,184,212,0.10)',
                selectable: false,
                evented: false,
                excludeFromExport: true,
                objectCaching: false,
            })
            fc.add(poly)
            marqueeOverlayRef.current = poly
        }
        fc.requestRenderAll()
    }, [canvasEditor, imageToDisplay, clearMarqueeOverlay])

    const finishMarquee = useCallback((ev) => {
        const drag = marqueeDragRef.current
        marqueeDragRef.current = null
        clearMarqueeOverlay()
        canvasEditor?.requestRenderAll?.()
        if (!drag?.cur) return
        const pts = marqueePoints(drag.start, drag.cur, marqueeShape, !!ev?.shiftKey, !!ev?.altKey)
        const xs = pts.map((p) => p.x)
        const ys = pts.map((p) => p.y)
        const perPx = screenPxPerImagePx()
        // A click without a real drag isn't a selection.
        if ((Math.max(...xs) - Math.min(...xs)) * perPx < 3 || (Math.max(...ys) - Math.min(...ys)) * perPx < 3) return
        const canvas = rasterizeLasso(pts)
        if (!canvas) return
        const key = `marquee-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        setMaskTexture(key, canvas)
        const id = addChainLayer('lasso', {
            maskTextureKey: key,
            baseTextureKey: key,
            growPx: 0,
            feather: marqueeFeather,
            label: marqueeShape === 'ellipse' ? 'Elliptical marquee' : 'Rectangular marquee',
            tool: 'marquee',
        })
        if (id && marqueeOp !== 'new') setLayerOp(id, marqueeOp)
    }, [canvasEditor, clearMarqueeOverlay, marqueeShape, marqueeFeather, marqueeOp, screenPxPerImagePx, rasterizeLasso, addChainLayer, setLayerOp])

    const handleStartMarquee = useCallback(() => {
        if (!imageSize) { toast.error('Image not ready yet'); return }
        if (activeDraft) { toast('Finish or cancel the current draft first', { icon: 'ℹ️' }); return }
        stopModesRef.current('marquee')
        setMarqueeActive(true)
        toast('Drag to select. Shift = square/circle, Alt = from centre, Esc cancels.', { id: 'mask-tool-hint' })
    }, [imageSize, activeDraft])

    useEffect(() => {
        const fc = canvasEditor
        if (!fc || !marqueeActive) return undefined
        fc.defaultCursor = 'crosshair'
        fc.hoverCursor = 'crosshair'
        fc.selection = false
        let raf = 0
        const onDown = (opt) => {
            if (opt?.e?.button > 0) return
            const pos = pointerToImage(fc, opt)
            if (pos) marqueeDragRef.current = { start: pos, cur: null, shift: false, alt: false }
        }
        const onMove = (ev) => {
            const drag = marqueeDragRef.current
            if (!drag) return
            const pos = pointerToImage(fc, { e: ev })
            if (!pos) return
            drag.cur = pos
            drag.shift = ev.shiftKey
            drag.alt = ev.altKey
            if (raf) return
            raf = requestAnimationFrame(() => {
                raf = 0
                const d = marqueeDragRef.current
                if (d?.cur) drawMarqueeOverlay(marqueePoints(d.start, d.cur, marqueeShape, d.shift, d.alt))
            })
        }
        const onUp = (ev) => { if (marqueeDragRef.current) finishMarquee(ev) }
        const onKey = (ev) => {
            if (ev.key !== 'Escape' || !marqueeDragRef.current) return
            marqueeDragRef.current = null
            clearMarqueeOverlay()
            fc.requestRenderAll()
        }
        fc.on('mouse:down', onDown)
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('keydown', onKey)
        return () => {
            if (raf) cancelAnimationFrame(raf)
            fc.off('mouse:down', onDown)
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            window.removeEventListener('keydown', onKey)
            marqueeDragRef.current = null
            clearMarqueeOverlay()
            fc.defaultCursor = 'default'
            fc.hoverCursor = 'move'
            fc.selection = true
        }
    }, [canvasEditor, marqueeActive, marqueeShape, pointerToImage, drawMarqueeOverlay, finishMarquee, clearMarqueeOverlay])

    // Surface the centralized layer-cap rejection (useMaskLayers.addLayer
    // refuses past MAX_LAYERS and dispatches this) so every "Add ..." path
    // gives feedback instead of silently failing.
    useEffect(() => {
        const onLimit = (e) => {
            const max = e?.detail?.max || MAX_LAYERS
            toast.error(`Mask layer limit reached (${max}). Remove a layer to add more.`)
        }
        try { window.addEventListener('phosmith:mask-layer-limit', onLimit) } catch { /* SSR */ }
        return () => { try { window.removeEventListener('phosmith:mask-layer-limit', onLimit) } catch { /* SSR */ } }
    }, [])

    // Remove any stray lasso overlay objects when the canvas changes or the
    // tool unmounts (the wiring effect only restores the cursor + listeners).
    useEffect(() => () => { clearLassoOverlay() }, [clearLassoOverlay])

    useGradientGizmos({ activeDraft, brushActive, canvasEditor, cleanPreview, colorPickerActive, imageToDisplay, imgAngle, imgLeft, imgScaleX, imgScaleY, imgTop, isGradientSelected, lassoActive, overlayRef, selKind, selectedLayer, selectedLayerId, semanticActive, stack, tool, updateLayer })

    /* ─── AI Subject Selection ─── */

    // Turn a decoded AI subject mask (white = subject, black = background) into
    // a NON-DESTRUCTIVE selection: it's stored in the megashader texture cache
    // and added as a `semantic` chain layer (fillMode 'fill' → the subject is
    // tinted/visible while the background is left fully intact). This is the
    // same path SlimSAM / Lasso / Brush use, so the selection shows up in the
    // MASK LAYERS panel and stays editable (boundary, blend op, feather, and
    // add/subtract brush or lasso layers) "even after subject detection".
    //
    // Picking a different subject swaps the single tracked layer rather than
    // piling up duplicates — matching the radio-style chip picker.
    const applySubjectSelection = useCallback((imageData, label) => {
        if (!imageData) return null
        const key = `subject-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        setMaskTexture(key, imageData)
        // If our tracked selection layer still exists, swap its texture in
        // place — this keeps the layer's slot / blend op and sidesteps the
        // MAX_LAYERS cap, while resetting the boundary (growPx / baseTextureKey)
        // so the "Boundary" slider tracks the NEW subject's edge from 0.
        const existingId = subjectLayerIdRef.current
        const present = existingId && (chainStackRef.current?.chain || []).some((e) => e.layer.id === existingId)
        if (present) {
            updateLayer(existingId, { maskTextureKey: key, baseTextureKey: key, growPx: 0, edgeSmooth: 0, edgeContrast: 0, label: label || 'Subject' })
            return existingId
        }
        const id = addChainLayer('semantic', { maskTextureKey: key, baseTextureKey: key, growPx: 0, feather: 0.1, label: label || 'Subject' })
        subjectLayerIdRef.current = id
        return id
    }, [addChainLayer, updateLayer])

    // Matte tuning for the ON-DEVICE subject path (cleanSubjectMatte).
    const [subjectSensitivity, setSubjectSensitivity] = useState(50)
    const [subjectFillHoles, setSubjectFillHoles] = useState(true)
    const subjectSensitivityRef = useRef(50)
    subjectSensitivityRef.current = subjectSensitivity
    const subjectFillHolesRef = useRef(true)
    subjectFillHolesRef.current = subjectFillHoles

    // Subject / Background selection. Routes through the masking service
    // (SAM 3.1, with a saliency→box-seed upgrade when the service returns a
    // plain matte) and falls back to on-device RMBG per the 'segment' routing
    // policy. `invert` flips coverage so the WHOLE background (everything that
    // isn't the subject) is selected — the only reliable "select the sky"
    // because text grounding only binds the bright sky blob.
    const runSubjectSelection = useCallback(async ({ invert = false, label } = {}) => {
        if (!tool.mainImage) return
        if (isSegmentingRef.current) return
        const sourceEl = tool.mainImage?._originalElement || tool.mainImage?._element || tool.mainImage?.getElement?.()
        if (!sourceEl) { toast.error('Cannot access image element'); return }
        const origW = sourceEl.naturalWidth || sourceEl.width || tool.mainImage.width || 0
        const origH = sourceEl.naturalHeight || sourceEl.height || tool.mainImage.height || 0
        if (origW < 1 || origH < 1) { toast('Image is still loading — try again in a moment'); return }

        try { segmentAbortRef.current?.abort() } catch { /* ignore */ }
        const abortController = new AbortController()
        segmentAbortRef.current = abortController
        isSegmentingRef.current = true
        setIsSegmenting(true)
        const noun = invert ? 'Background' : 'Subject'
        const dims = { width: origW, height: origH }
        try {
            let maskCanvas
            try {
                maskCanvas = await clientSubjectMask(sourceEl, dims)
            } catch (err) {
                throw new Error(`${noun} detection failed — ${err?.message || err}`)
            }
            // Studio-parity matte cleanup: sensitivity → binarize
            // threshold, hole fill, luminance assist for backlit rims.
            try {
                const src = document.createElement('canvas')
                src.width = origW
                src.height = origH
                src.getContext('2d').drawImage(sourceEl, 0, 0, origW, origH)
                const cleaned = cleanSubjectMatte(maskCanvas, {
                    threshold: Math.min(0.95, Math.max(0.05, 1 - subjectSensitivityRef.current / 100)),
                    fillHoles: subjectFillHolesRef.current,
                    luminanceAssist: true,
                    sourceCanvas: src,
                })
                if (cleaned?.canvas) maskCanvas = cleaned.canvas
            } catch { /* raw matte */ }
            if (segmentAbortRef.current !== abortController) return
            const ctx = maskCanvas.getContext('2d', { willReadFrequently: true })
            const imageData = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
            if (invert) {
                const d = imageData.data
                for (let i = 0; i < d.length; i += 4) {
                    d[i] = 255 - d[i]
                    d[i + 1] = 255 - d[i + 1]
                    d[i + 2] = 255 - d[i + 2]
                }
            }
            const id = applySubjectSelection(imageData, label || (invert ? 'AI Background' : 'Subject'))
            if (id) {
                setActiveInstanceIndex(null)
                toast.success(invert
                    ? 'Background selected — everything except the subject. Refine in Mask Layers.'
                    : 'Subject selected — adjust it in Mask Layers, or add a brush/lasso to refine.')
            } else {
                toast.error(`Could not create ${noun.toLowerCase()} selection`)
            }
        } catch (err) {
            if (err?.name === 'AbortError') return
            console.error(`[mask] AI ${noun.toLowerCase()} selection failed:`, err)
            toast.error(err?.message || `AI ${noun.toLowerCase()} selection failed`)
        } finally {
            if (segmentAbortRef.current === abortController) {
                isSegmentingRef.current = false
                setIsSegmenting(false)
            }
        }
    }, [tool, applySubjectSelection])

    const handleSelectBackground = useCallback(() => runSubjectSelection({ invert: true }), [runSubjectSelection])

    // Free-text NL masking: bg-ish phrases → inverted subject (grounding only
    // binds the bright blob); else on-device CLIPSeg grounding.
    const [conceptPhrase, setConceptPhrase] = useState('')
    const [isGrounding, setIsGrounding] = useState(false)
    const groundAbortRef = useRef(/** @type {AbortController | null} */ (null))
    const runConcept = useCallback(async (rawPhrase) => {
        const phrase = String(rawPhrase ?? conceptPhrase).trim()
        if (!phrase || !tool.mainImage) return
        if (/\b(background|backdrop|scenery|behind)\b/i.test(phrase)) {
            runSubjectSelection({ invert: true, label: phrase })
            return
        }
        const sourceEl = tool.mainImage._originalElement || tool.mainImage._element || tool.mainImage.getElement?.()
        if (!sourceEl) return
        const origW = sourceEl.naturalWidth || sourceEl.width || 0
        const origH = sourceEl.naturalHeight || sourceEl.height || 0
        if (origW < 1 || origH < 1) return
        try { groundAbortRef.current?.abort() } catch { /* ignore */ }
        const abortController = new AbortController()
        groundAbortRef.current = abortController
        setIsGrounding(true)
        const dims = { width: origW, height: origH }
        try {
            // Returns { canvas, score, bbox } — the canvas is null when nothing matched.
            const { canvas } = await clientGroundPhrase(sourceEl, phrase, dims)
            if (groundAbortRef.current !== abortController) return
            if (!canvas) throw new Error(`No region matched "${phrase}"`)
            const ctx = canvas.getContext('2d', { willReadFrequently: true })
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
            const key = `concept-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
            setMaskTexture(key, imageData)
            const id = addChainLayer('semantic', { maskTextureKey: key, baseTextureKey: key, growPx: 0, feather: 0.1, label: phrase })
            if (id) {
                toast.success(`Masked "${phrase}" — refine it in Mask Layers`)
                setConceptPhrase('')
            }
        } catch (err) {
            if (err?.name === 'AbortError') return
            toast.error(err?.message || `Could not mask "${phrase}"`)
        } finally {
            if (groundAbortRef.current === abortController) setIsGrounding(false)
        }
    }, [conceptPhrase, tool, runSubjectSelection, addChainLayer])

    /* ─── Multi-Subject Detection (Detect All Subjects) ──────────────────────
     * Runs SlimSAM on device (clientSubjectInstances) to enumerate every subject
     * in the image and lets the user mask either the union or a specific instance with one
     * click. Results are cached on the Fabric image (one detection pass per
     * image) so re-clicking individual subjects is free.
     */
    const base64PngToBlob = useCallback((b64) => {
        const bin = atob(b64)
        const len = bin.length
        const arr = new Uint8Array(len)
        for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i)
        return new Blob([arr], { type: 'image/png' })
    }, [])

    const handleDetectAllSubjects = useCallback(async () => {
        if (!tool.mainImage) return
        if (isDetectingInstancesRef.current) return
        try { instancesAbortRef.current?.abort() } catch { /* ignore */ }
        const abortController = new AbortController()
        instancesAbortRef.current = abortController
        isDetectingInstancesRef.current = true
        setIsDetectingInstances(true)

        try {
            const fabricObj = tool.mainImage
            const sourceEl = fabricObj?._element || fabricObj?.getElement?.()
            if (!sourceEl) throw new Error('Cannot access image element')

            const origW = sourceEl.naturalWidth || sourceEl.width || fabricObj.width
            const origH = sourceEl.naturalHeight || sourceEl.height || fabricObj.height
            const data = await clientSubjectInstances(sourceEl, { width: origW, height: origH })
            if (instancesAbortRef.current !== abortController) return

            if (!data.instances?.length) {
                // No distinct instances (a single blended subject, or SlimSAM found
                // nothing) — fall back to the unified subject matte so the one
                // button always produces a selection.
                setSubjectInstances([])
                await runSubjectSelection({ invert: false })
                return
            }
            setSubjectInstances(data.instances)
            setActiveInstanceIndex(null)
            lastInstancesImageRef.current = fabricObj
            // Cache on the Fabric image so other tools (and the agent's
            // mask-commands cache) can reuse the same payload.
            try { fabricObj.__phosmithSubjectInstances = { ...data, instances: data.instances } } catch { /* ignore */ }

            // Auto-select the union (non-destructively) so the panel shows
            // immediate feedback — the user can then click a chip to swap to a
            // single subject. The background is never removed.
            if (data.unionPng) {
                const decoded = await decodeMaskBlob(base64PngToBlob(data.unionPng))
                if (instancesAbortRef.current !== abortController) return
                applySubjectSelection(decoded.imageData, `All subjects (${data.instances.length})`)
                setActiveInstanceIndex(-1)
            }
            toast.success(
                `Detected ${data.instances.length} subject${data.instances.length === 1 ? '' : 's'}` +
                (data.truncated ? ' (capped, refine to see more)' : ''),
            )
        } catch (err) {
            if (err?.name === 'AbortError') return
            // Fall back to the single subject matte so the button always
            // selects something. Only surface an error if that fails too.
            console.warn('[mask] detect-all-subjects failed, falling back to subject matte:', err?.message || err)
            setSubjectInstances([])
            try {
                await runSubjectSelection({ invert: false })
            } catch (fallbackErr) {
                console.error('[mask] subject fallback failed:', fallbackErr)
                toast.error(toUserMessage(err, 'Subject detection failed'))
            }
        } finally {
            if (instancesAbortRef.current === abortController) {
                isDetectingInstancesRef.current = false
                setIsDetectingInstances(false)
            }
        }
    }, [tool, base64PngToBlob, decodeMaskBlob, applySubjectSelection, runSubjectSelection])

    const handleApplyInstance = useCallback(async (instance) => {
        if (!tool.mainImage || !instance?.maskPng) return
        try {
            const blob = base64PngToBlob(instance.maskPng)
            const decoded = await decodeMaskBlob(blob)
            const label = `${instance.label || 'Subject'} #${(instance.index ?? 0) + 1}`
            const id = applySubjectSelection(decoded.imageData, label)
            if (id) {
                setActiveInstanceIndex(instance.index ?? null)
                toast.success(`Selected ${instance.label || `subject ${instance.index ?? ''}`}`)
            } else {
                toast.error('Could not create subject selection')
            }
        } catch (err) {
            console.error('[mask] apply-instance failed:', err)
            toast.error('Could not create subject selection')
        }
    }, [tool, base64PngToBlob, decodeMaskBlob, applySubjectSelection])

    const handleApplyAllSubjectsUnion = useCallback(async () => {
        if (!tool.mainImage) return
        const cached = tool.mainImage.__phosmithSubjectInstances || subjectInstances && { unionPng: null, instances: subjectInstances }
        if (cached?.unionPng) {
            try {
                const blob = base64PngToBlob(cached.unionPng)
                const decoded = await decodeMaskBlob(blob)
                const count = cached.instances?.length || subjectInstances?.length || ''
                const id = applySubjectSelection(decoded.imageData, `All subjects (${count})`)
                if (id) {
                    setActiveInstanceIndex(-1)
                    toast.success(`Selected all ${count} subjects`)
                } else {
                    toast.error('Could not create union selection')
                }
            } catch (err) {
                console.error('[mask] apply-union failed:', err)
                toast.error('Could not create union selection')
            }
        }
    }, [tool, subjectInstances, base64PngToBlob, decodeMaskBlob, applySubjectSelection])

    // Invalidate the multi-subject cache when the user switches to a
    // different image so the chips don't show stale data.
    useEffect(() => {
        if (lastInstancesImageRef.current && tool.mainImage !== lastInstancesImageRef.current) {
            setSubjectInstances(null)
            setActiveInstanceIndex(null)
            // The subject selection layer belonged to the previous image's chain;
            // drop the handle so the next selection adds a fresh layer.
            subjectLayerIdRef.current = null
            lastInstancesImageRef.current = tool.mainImage
        }
    }, [tool.mainImage])

    const { handleAddColorLayer, handleAddGradientLayer, handleAddLuminanceLayer, handleAddRadialLayer, handleApplyColorRange, handleApplyGradient, handleApplyLuminance } = useRangeLayers({ activeDraft, addChainLayer, canvasEditor, colorPickerActive, colorTolerance, gradDirection, gradFeather, gradPosition, imageSize, lumaMax, lumaMin, pickedColor, pointerToImage, setActiveDraft, setColorPickerActive, setPickedColor, tool })

    // Photoshop-style keys while the Mask tool is open: \ cycles mask view,
    // ⌘⇧I inverts, W wand, M marquee (⇧M ellipse/rect), L lasso, Delete removes
    // the selected layer. Q stays the editor-wide AI agent key.
    const shortcutRef = useRef(null)
    shortcutRef.current = (e) => {
        const t = e.target
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
        const k = e.key.toLowerCase()
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && k === 'i') {
            e.preventDefault()
            setGlobalInvert(!globalInvert)
            return
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return
        if (e.key === '\\' && stack.chain.length > 0) {
            if (!showMaskOverlay) { setMaskView('tint'); setShowMaskOverlay(true) }
            else if (maskView === 'tint') setMaskView('bw')
            else { setShowMaskOverlay(false); setMaskView('tint') }
        } else if (k === 'w' && !e.shiftKey) {
            if (wandActive) setWandActive(false)
            else handleStartWand()
        } else if (k === 'm') {
            if (e.shiftKey) setMarqueeShape((v) => (v === 'rect' ? 'ellipse' : 'rect'))
            else if (marqueeActive) setMarqueeActive(false)
            else handleStartMarquee()
        } else if (k === 'l' && !e.shiftKey) {
            if (lassoActive) handleStopLasso()
            else handleStartLasso()
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && !lassoActive && selectedLayerId) {
            const layer = stack.chain.find((c) => c.layer.id === selectedLayerId)?.layer
            if (!layer || layer.lock) return
            e.preventDefault()
            removeLayer(selectedLayerId)
        } else if (e.key === 'Escape' && (wandActive || marqueeActive)) {
            setWandActive(false)
            setMarqueeActive(false)
        }
    }
    useEffect(() => {
        const onKey = (e) => shortcutRef.current?.(e)
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])

    stopModesRef.current = (keep) => {
        if (keep !== 'picker') setColorPickerActive(false)
        if (keep !== 'semantic' && semanticActive) { setSemanticActive(false); handleSemanticStop() }
        if (keep !== 'brush') setBrushActive(false)
        if (keep !== 'quickErase') setQuickEraseActive(false)
        if (keep !== 'lasso' && lassoActive) { setLassoActive(false); resetLassoPath() }
        if (keep !== 'wand') setWandActive(false)
        if (keep !== 'marquee') setMarqueeActive(false)
    }

    // Test hooks: scriptable surface for Playwright / console driving
    // (window.__phosmith.mask, next to window.__phosmith.clientAI). Reinstalled
    // every render so closures stay fresh; removed on unmount.
    useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const ns = (window.__phosmith = window.__phosmith || {})
        ns.mask = {
            ready: !!tool.mainImage && !!imageSize,
            imageSize,
            chain: stack.chain,
            base: stack.base,
            layer: (id) => stack.chain.find((e) => e.layer.id === (id ?? selectedLayerId))?.layer || null,
            add: (kind, opts) => addChainLayer(kind, opts),
            update: (id, patch) => updateLayer(id, patch),
            remove: (id) => removeLayer(id),
            move: (id, dir) => moveLayer(id, dir),
            setOp: (id, op) => setLayerOp(id, op),
            setFillMode: (id, mode) => setFillMode(id, mode),
            select: (id) => selectLayer(id),
            applyCurve: (id, curves) => applyCurve(id, curves),
            setGamma: (id, gamma) => (id === 'base' ? setBase({ gamma }) : updateLayer(id, { gamma })),
            setWheel: (id, key, offset) => (id === 'base' ? setBase({ [key]: offset }) : updateLayer(id, { [key]: offset })),
            setBase: (patch) => setBase(patch),
            undo: () => undoChain(),
            redo: () => redoChain(),
            expandBoundary: (id, px, edge) => expandLayerBoundary(tool.mainImage, id, px, edge),
            refine: (on, mode) => { setSemanticRefine(!!on); if (mode) setSemanticRefineMode(mode) },
            runSubject: () => runSubjectSelection({ invert: false }),
            background: () => runSubjectSelection({ invert: true }),
            runDepth: () => handleDepthRun(),
            samBox: (x0, y0, x1, y1) => { setSemanticActive(true); setSemanticBox([x0, y0, x1, y1]) },
            clickSelect: (x, y, label = 1) => {
                setSemanticActive(true)
                setSemanticClicks((prev) => [...prev, [x, y, label ? 1 : 0]])
            },
            runConcept: (phrase) => runConcept(phrase),
            setSensitivity: (v) => setSubjectSensitivity(Number(v) <= 1 ? Math.round(Number(v) * 100) : Math.round(Number(v))),
            setFillHoles: (v) => setSubjectFillHoles(!!v),
            cleanPreview: (v) => setCleanPreview(!!v),
            invert: (v) => setGlobalInvert(!!v),
            aiState: () => getClientAIState(),
            // On-screen (client px) bounds of the main image, for pointer-driven tests.
            screenRect: () => {
                const img = tool.mainImage
                const el = canvasEditor?.upperCanvasEl?.getBoundingClientRect?.()
                if (!img?.aCoords || !el) return null
                const [a, b, c, d, e, f] = canvasEditor.viewportTransform
                const pts = Object.values(img.aCoords).map((p) => [a * p.x + c * p.y + e + el.left, b * p.x + d * p.y + f + el.top])
                const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1])
                return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
            },
            serviceStatus: () => checkMaskService(),
            pixels: (x, y, w = 1, h = 1) => {
                const el = tool.mainImage?._element || tool.mainImage?.getElement?.()
                if (!el) return null
                const c = document.createElement('canvas')
                c.width = w
                c.height = h
                const ctx = c.getContext('2d', { willReadFrequently: true })
                ctx.drawImage(el, x, y, w, h, 0, 0, w, h)
                return Array.from(ctx.getImageData(0, 0, w, h).data)
            },
        }
        return () => { delete ns.mask }
    })

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
                icon={ImageOff}
                title="No image on canvas"
                subtitle="Add an image first, then use the mask tool"
            />
        )
    }

    return (
        <div className="mask-panel space-y-0 overflow-y-auto pr-1 panel-scroll">
            {/* ────────── Mask Layers (megashader chain) — pinned to top ────────── */}
            <LayersSection
                applyCurve={applyCurve}
                baseHasVisibleGrade={baseHasVisibleGrade}
                canRedo={canRedo}
                canUndo={canUndo}
                cleanPreview={cleanPreview}
                clearAll={clearAll}
                dominantColor={dominantColor}
                globalInvert={globalInvert}
                handleStartRefine={handleStartRefine}
                handleStopRefine={handleStopRefine}
                histogram={histogram}
                imageSize={imageSize}
                maskView={maskView}
                moveLayer={moveLayer}
                redoChain={redoChain}
                refineTarget={refineTarget}
                removeLayer={removeLayer}
                selectLayer={selectLayer}
                selectedLayerId={selectedLayerId}
                setBase={setBase}
                setCleanPreview={setCleanPreview}
                setFillMode={setFillMode}
                setGlobalInvert={setGlobalInvert}
                setLayerOp={setLayerOp}
                setMaskView={setMaskView}
                setRefineTarget={setRefineTarget}
                setShowMaskOverlay={setShowMaskOverlay}
                showMaskOverlay={showMaskOverlay}
                stack={stack}
                tool={tool}
                undoChain={undoChain}
                updateLayer={updateLayer}
            />

            <CategoryHeader label="AI Tools" />

            {/* AI processing routing: per-capability choice of where each AI
                function runs — Auto (server first, device fallback), Device
                (in-browser models via transformers.js, downloaded once and
                cached), or Server (local mask service / Gemini). The NL-mask
                executor follows this policy with runtime fallback to the
                other side, so a misconfigured side degrades instead of
                failing (see src/lib/ai-routing.js). */}
            <AiRoutingSection
                CLIENT_READY={CLIENT_READY}
                clientAI={clientAI}
                handleSelfTest={handleSelfTest}
                routingBadge={routingBadge}
                routingPolicy={routingPolicy}
                selfTest={selfTest}
            />

            {/* ────────── AI Masking ────────── */}
            <SubjectSection
                activeInstanceIndex={activeInstanceIndex}
                conceptPhrase={conceptPhrase}
                dominantColor={dominantColor}
                handleApplyAllSubjectsUnion={handleApplyAllSubjectsUnion}
                handleApplyInstance={handleApplyInstance}
                handleDetectAllSubjects={handleDetectAllSubjects}
                handleSelectBackground={handleSelectBackground}
                isDetectingInstances={isDetectingInstances}
                isGrounding={isGrounding}
                isSegmenting={isSegmenting}
                runConcept={runConcept}
                setConceptPhrase={setConceptPhrase}
                setSubjectFillHoles={setSubjectFillHoles}
                setSubjectSensitivity={setSubjectSensitivity}
                subjectFillHoles={subjectFillHoles}
                subjectInstances={subjectInstances}
                subjectSensitivity={subjectSensitivity}
            />

            {/* ────────── Click-to-Select (SlimSAM) ────────── */}
            <ClickSelectSection
                activeDraft={activeDraft}
                boxArmed={boxArmed}
                clientAI={clientAI}
                handleAddSemanticLayer={handleAddSemanticLayer}
                handleSemanticReset={handleSemanticReset}
                handleSemanticRun={handleSemanticRun}
                handleSemanticStop={handleSemanticStop}
                isSemanticRunning={isSemanticRunning}
                lastSemanticMask={lastSemanticMask}
                lastSemanticPreview={lastSemanticPreview}
                refineTargetLayer={refineTargetLayer}
                semanticActive={semanticActive}
                semanticBox={semanticBox}
                semanticClicks={semanticClicks}
                semanticRefine={semanticRefine}
                semanticRefineMode={semanticRefineMode}
                setBoxArmed={setBoxArmed}
                setSemanticActive={setSemanticActive}
                setSemanticBox={setSemanticBox}
                setSemanticClicks={setSemanticClicks}
                setSemanticRefine={setSemanticRefine}
                setSemanticRefineMode={setSemanticRefineMode}
                stopModesRef={stopModesRef}
            />

            {/* ────────── Smart Brush (Step 7) ────────── */}
            <CategoryHeader label="Draw Selection" />

            <BrushSection
                brushActive={brushActive}
                brushEdgeSnap={brushEdgeSnap}
                brushFeather={brushFeather}
                brushHardness={brushHardness}
                brushHasContent={brushHasContent}
                brushModifier={brushModifier}
                brushSink={brushSink}
                brushSize={brushSize}
                dominantColor={dominantColor}
                filterRadius={filterRadius}
                handleAddBrushLayer={handleAddBrushLayer}
                handleClearBrush={handleClearBrush}
                handleStartBrush={handleStartBrush}
                handleStopBrush={handleStopBrush}
                isShapeFilling={isShapeFilling}
                refineTarget={refineTarget}
                setBrushEdgeSnap={setBrushEdgeSnap}
                setBrushFeather={setBrushFeather}
                setBrushHardness={setBrushHardness}
                setBrushModifier={setBrushModifier}
                setBrushSink={setBrushSink}
                setBrushSize={setBrushSize}
                setFilterRadius={setFilterRadius}
                setSigmaColor={setSigmaColor}
                setSigmaSpace={setSigmaSpace}
                sigmaColor={sigmaColor}
                sigmaSpace={sigmaSpace}
            />

            {/* ────────── Lasso (freehand + polygonal + magnetic) ────────── */}
            <LassoSection
                dominantColor={dominantColor}
                finishLassoSelection={finishLassoSelection}
                handleStartLasso={handleStartLasso}
                handleStopLasso={handleStopLasso}
                lassoActive={lassoActive}
                lassoFeather={lassoFeather}
                lassoMode={lassoMode}
                lassoModifier={lassoModifier}
                lassoSink={lassoSink}
                lassoSmooth={lassoSmooth}
                lassoVertexCount={lassoVertexCount}
                magneticContrast={magneticContrast}
                magneticFrequency={magneticFrequency}
                magneticWidth={magneticWidth}
                setLassoFeather={setLassoFeather}
                setLassoMode={setLassoMode}
                setLassoModifier={setLassoModifier}
                setLassoSink={setLassoSink}
                setLassoSmooth={setLassoSmooth}
                setMagneticContrast={setMagneticContrast}
                setMagneticFrequency={setMagneticFrequency}
                setMagneticWidth={setMagneticWidth}
            />

            {/* ────────── Magic Wand (colour flood fill) ────────── */}
            <WandSection
                dominantColor={dominantColor}
                handleStartWand={handleStartWand}
                setWandActive={setWandActive}
                setWandAntiAlias={setWandAntiAlias}
                setWandContiguous={setWandContiguous}
                setWandSample={setWandSample}
                setWandTolerance={setWandTolerance}
                wandActive={wandActive}
                wandAntiAlias={wandAntiAlias}
                wandContiguous={wandContiguous}
                wandSample={wandSample}
                wandTolerance={wandTolerance}
            />

            {/* ────────── Marquee (rectangle / ellipse) ────────── */}
            <MarqueeSection
                dominantColor={dominantColor}
                handleStartMarquee={handleStartMarquee}
                marqueeActive={marqueeActive}
                marqueeFeather={marqueeFeather}
                marqueeOp={marqueeOp}
                marqueeShape={marqueeShape}
                setMarqueeActive={setMarqueeActive}
                setMarqueeFeather={setMarqueeFeather}
                setMarqueeOp={setMarqueeOp}
                setMarqueeShape={setMarqueeShape}
            />

            {/* ────────── Depth Range (Depth Anything V2) ────────── */}
            <DepthSection
                depthMax={depthMax}
                depthMin={depthMin}
                depthSoftness={depthSoftness}
                handleAddDepthLayer={handleAddDepthLayer}
                handleDepthReset={handleDepthReset}
                handleDepthRun={handleDepthRun}
                isDepthRunning={isDepthRunning}
                lastDepthMap={lastDepthMap}
                lastDepthPreview={lastDepthPreview}
                setDepthMaxBounded={setDepthMaxBounded}
                setDepthMinBounded={setDepthMinBounded}
                setDepthSoftness={setDepthSoftness}
            />

            <CategoryHeader label="Range Selection" />

            {/* ────────── Color Range ────────── */}
            <ColorRangeSection
                colorPickerActive={colorPickerActive}
                colorTolerance={colorTolerance}
                dominantColor={dominantColor}
                handleAddColorLayer={handleAddColorLayer}
                handleApplyColorRange={handleApplyColorRange}
                pickedColor={pickedColor}
                setColorPickerActive={setColorPickerActive}
                setColorTolerance={setColorTolerance}
                stopModesRef={stopModesRef}
            />

            {/* ────────── Luminance Range ────────── */}
            <LuminanceSection
                dominantColor={dominantColor}
                handleAddLuminanceLayer={handleAddLuminanceLayer}
                handleApplyLuminance={handleApplyLuminance}
                histogram={histogram}
                lumaMax={lumaMax}
                lumaMin={lumaMin}
                setLumaMax={setLumaMax}
                setLumaMin={setLumaMin}
            />

            {/* ────────── Linear Gradient ────────── */}
            <LinearGradientSection
                dominantColor={dominantColor}
                gradDirection={gradDirection}
                gradFeather={gradFeather}
                gradPosition={gradPosition}
                handleAddGradientLayer={handleAddGradientLayer}
                handleApplyGradient={handleApplyGradient}
                setGradDirection={setGradDirection}
                setGradFeather={setGradFeather}
                setGradPosition={setGradPosition}
            />

            {/* ────────── Radial Gradient ────────── */}
            <RadialGradientSection handleAddRadialLayer={handleAddRadialLayer} />

            <CategoryHeader label="Destructive" />

            {/* ────────── Brush (manual) ────────── */}
            <QuickEraseSection
                dominantColor={dominantColor}
                handleStartQuickErase={handleStartQuickErase}
                handleStopQuickErase={handleStopQuickErase}
                quickEraseActive={quickEraseActive}
                tool={tool}
            />

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
                <p><strong>AI Tools</strong> — Select Subject (one-click), Click to Select (SlimSAM), and Depth Range use AI models to generate masks automatically.</p>
                <p><strong>Draw Selection</strong> — Selection Brush paints a region; Lasso draws freehand, polygonal, or edge-snapping (magnetic) outlines.</p>
                <p><strong>Range Selection</strong> — Color, Luminance, and Gradient masks select by pixel properties. Combine multiple methods into one mask.</p>
                <p>Each selection becomes its own <strong>Mask Layer</strong> with per-layer feather, blend mode, and fill / adjust / erase output.</p>
                <p>Shift = add, Alt = subtract while drawing to combine selections.</p>
            </TipCard>
        </div>
    )
}

export default MaskControls
