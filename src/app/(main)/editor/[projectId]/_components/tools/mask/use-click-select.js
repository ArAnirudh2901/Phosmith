import { useCallback, useEffect, useRef, useState } from 'react'
import { Circle as FabricCircle, Rect as FabricRect } from 'fabric'
import { toast } from 'sonner'
import { clientSamBox, clientSamClick } from '@/lib/client-ai'
import { getMaskTexture, setMaskTexture } from '@/lib/megashader'
import { toUserMessage } from '@/lib/user-error'
import { REFINABLE_KINDS, asDrawable, sourceNaturalSize } from '../mask/geometry'

// Click / box select: SAM prompts, the run, refine-into-layer and adding the result as a layer.
export function useClickSelect({
    addChainLayer,
    canvasEditor,
    chainStackRef,
    imageToDisplay,
    pointerToImage,
    selectedLayer,
    selectedLayerIdRef,
    tool,
    updateLayer,
}) {
    // Uncompiled, like the component it was cut from.
    'use no memo'

    /* ─── Semantic (SlimSAM) click-to-select (Step 5) ─── */

    // Active click-mode flag — when true, mouse clicks on the canvas are
    // captured as SlimSAM click points (positive by default, negative with
    // the Alt key held). Disabled while another tool (color picker,
    // spatial draft) is active so handlers don't fight over mouse:down.
    const [semanticActive, setSemanticActive] = useState(false)
    // List of `[x, y, label]` clicks in *original* (natural) image-pixel
    // coordinates. We accumulate here, then send the whole array to
    // one SlimSAM run when the user hits "Run".
    const [semanticClicks, setSemanticClicks] = useState(/** @type {Array<[number, number, 0 | 1]>} */ ([]))
    const [isSemanticRunning, setIsSemanticRunning] = useState(false)
    const isSemanticRunningRef = useRef(false)
    const [boxDragging, setBoxDragging] = useState(false)
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

    // BOX prompt — the strongest single prompt for whole-object
    // selection. When armed, the next drag on the canvas defines the box
    // (in natural image-pixel coords, [x0, y0, x1, y1]); it can be combined
    // with clicks to refine. One box at a time — a new drag replaces it.
    const [semanticBox, setSemanticBox] = useState(/** @type {[number,number,number,number] | null} */ (null))
    const [boxArmed, setBoxArmed] = useState(false)
    const boxArmedRef = useRef(false)
    boxArmedRef.current = boxArmed
    const boxDraftRef = useRef(/** @type {{x:number,y:number} | null} */ (null))
    const boxRectRef = useRef(/** @type {any} */ (null))

    const handleSemanticClick = useCallback((e) => {
        if (!semanticActive || !tool.mainImage) return
        if (boxArmedRef.current) return // a box drag owns the pointer right now
        const fabricCanvas = canvasEditor
        if (!fabricCanvas) return
        const pos = pointerToImage(fabricCanvas, e)
        if (!pos) return
        // The route validates bounds server-side, but rejecting obvious
        // out-of-bounds clicks here saves a roundtrip + 400 response.
        const { w, h } = sourceNaturalSize(tool.mainImage)
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
        const fabricCanvas = canvasEditor
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

    // Box-drag capture. While armed, mouse:down anchors the box, mouse:move
    // resizes a dashed live rect (display coords), mouse:up commits the box
    // in natural image coords and disarms. The rect marker itself persists
    // (mirroring semanticBox) until reset/stop.
    useEffect(() => {
        const fabricCanvas = canvasEditor
        if (!fabricCanvas || !semanticActive || !boxArmed) return undefined
        fabricCanvas.defaultCursor = 'crosshair'
        const onDown = (e) => {
            const pos = pointerToImage(fabricCanvas, e)
            if (!pos) return
            boxDraftRef.current = { x: pos.x, y: pos.y }
            setBoxDragging(true)
        }
        const onMove = (e) => {
            if (!boxDraftRef.current) return
            const pos = pointerToImage(fabricCanvas, e)
            if (!pos) return
            const x0 = Math.min(boxDraftRef.current.x, pos.x)
            const y0 = Math.min(boxDraftRef.current.y, pos.y)
            const x1 = Math.max(boxDraftRef.current.x, pos.x)
            const y1 = Math.max(boxDraftRef.current.y, pos.y)
            setSemanticBox([x0, y0, x1, y1])
        }
        const onUp = () => {
            if (!boxDraftRef.current) return
            boxDraftRef.current = null
            setBoxDragging(false)
            setBoxArmed(false)
            setSemanticBox((b) => {
                // Discard degenerate boxes (a stray click instead of a drag).
                if (!b || b[2] - b[0] < 4 || b[3] - b[1] < 4) return null
                return b
            })
        }
        fabricCanvas.on('mouse:down', onDown)
        fabricCanvas.on('mouse:move', onMove)
        fabricCanvas.on('mouse:up', onUp)
        return () => {
            fabricCanvas.defaultCursor = 'default'
            fabricCanvas.off('mouse:down', onDown)
            fabricCanvas.off('mouse:move', onMove)
            fabricCanvas.off('mouse:up', onUp)
            if (boxDraftRef.current) setBoxDragging(false)
            boxDraftRef.current = null
        }
    }, [semanticActive, boxArmed, canvasEditor, pointerToImage])

    // Dashed live rect mirroring `semanticBox` (display coords).
    useEffect(() => {
        const fabricCanvas = canvasEditor
        if (!fabricCanvas || !tool.mainImage) return undefined
        if (boxRectRef.current) {
            try { fabricCanvas.remove(boxRectRef.current) } catch { /* gone */ }
            boxRectRef.current = null
        }
        if (!semanticActive || !semanticBox) {
            fabricCanvas.requestRenderAll()
            return undefined
        }
        const tl = imageToDisplay(semanticBox[0], semanticBox[1])
        const br = imageToDisplay(semanticBox[2], semanticBox[3])
        if (!tl || !br) return undefined
        const rect = new FabricRect({
            // Fabric 7 defaults to a centre origin; these coords are the corner.
            originX: 'left',
            originY: 'top',
            left: Math.min(tl.x, br.x),
            top: Math.min(tl.y, br.y),
            width: Math.abs(br.x - tl.x),
            height: Math.abs(br.y - tl.y),
            fill: 'rgba(6, 184, 212, 0.08)',
            stroke: 'rgba(6, 184, 212, 0.95)',
            strokeWidth: 1.5,
            strokeDashArray: [5, 4],
            strokeUniform: true,
            selectable: false,
            evented: false,
            excludeFromExport: true,
        })
        fabricCanvas.add(rect)
        boxRectRef.current = rect
        fabricCanvas.requestRenderAll()
        return () => {
            if (boxRectRef.current) {
                try { fabricCanvas.remove(boxRectRef.current) } catch { /* gone */ }
                boxRectRef.current = null
                fabricCanvas.requestRenderAll()
            }
        }
    }, [semanticActive, semanticBox, canvasEditor, tool.mainImage, imageToDisplay])

    // Live markers — one small Fabric circle per click. Cyan = positive
    // (include), red = negative (exclude). Mirrors the click list so
    // removing a click from the list removes its marker too.
    useEffect(() => {
        const fabricCanvas = canvasEditor
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
        setSemanticBox(null)
        setBoxArmed(false)
        setLastSemanticMask(null)
        setLastSemanticPreview(null)
    }, [])

    const handleSemanticStop = useCallback(() => {
        setSemanticActive(false)
        setSemanticClicks([])
        setSemanticBox(null)
        setBoxArmed(false)
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

    // Sticky latch: server 501/404/503 (SAM absent or service down) is permanent
    // for the
    // session — skip server on later clicks instead of 429-storming the proxy.
    // Explicit "Server" routing still forces a try; a server success clears it.

    // Refine mode: composite each SAM result onto the SELECTED layer's mask
    // (add = lighten, remove = inverted multiply) instead of staging a new one.
    const [semanticRefine, setSemanticRefine] = useState(false)
    const [semanticRefineMode, setSemanticRefineMode] = useState('add')
    const semanticRefineRef = useRef(false)
    semanticRefineRef.current = semanticRefine
    const semanticRefineModeRef = useRef('add')
    semanticRefineModeRef.current = semanticRefineMode
    const refineTargetLayer = (selectedLayer && REFINABLE_KINDS.includes(selectedLayer.kind)
        && selectedLayer.maskTextureKey) ? selectedLayer : null
    useEffect(() => { if (!refineTargetLayer) setSemanticRefine(false) }, [refineTargetLayer])

    // Prompted selection runs on SlimSAM in the browser — the one selection
    // model this editor uses. Each call supersedes the previous one (live
    // per-interaction refine). Each call supersedes the previous (live per-interaction refine).
    // Merge a selection canvas into a texture layer (add = lighten, remove =
    // multiply by its inverse) under a new key, re-basing the edge controls.
    const compositeIntoLayer = useCallback((target, canvas, mode) => {
        const cur = asDrawable(getMaskTexture(target.maskTextureKey))
        const w = cur?.width || canvas.width
        const h = cur?.height || canvas.height
        const out = document.createElement('canvas')
        out.width = w
        out.height = h
        const octx = out.getContext('2d')
        if (cur) octx.drawImage(cur, 0, 0, w, h)
        if (mode === 'remove') {
            const inv = document.createElement('canvas')
            inv.width = w
            inv.height = h
            const ictx = inv.getContext('2d')
            ictx.fillStyle = '#fff'
            ictx.fillRect(0, 0, w, h)
            ictx.globalCompositeOperation = 'difference'
            ictx.drawImage(canvas, 0, 0, w, h)
            octx.globalCompositeOperation = 'multiply'
            octx.drawImage(inv, 0, 0, w, h)
        } else {
            octx.globalCompositeOperation = 'lighten'
            octx.drawImage(canvas, 0, 0, w, h)
        }
        const key = `${target.id}::c${Date.now().toString(36)}`
        setMaskTexture(key, out)
        updateLayer(target.id, { maskTextureKey: key, baseTextureKey: key, growPx: 0, edgeSmooth: 0, edgeContrast: 0 })
        return key
    }, [updateLayer])

    const handleSemanticRun = useCallback(async () => {
        if (!tool.mainImage) return
        const clicks = semanticClicks
        const box = semanticBox
        if (clicks.length === 0 && !box) return
        // SAM must see the original photo: _element becomes the graded, masked
        // (possibly red-overlaid) filtered canvas once a mask renders.
        const sourceEl = tool.mainImage._originalElement || tool.mainImage._element || tool.mainImage.getElement?.()
        if (!sourceEl) return
        const origW = sourceEl.naturalWidth || sourceEl.width || 0
        const origH = sourceEl.naturalHeight || sourceEl.height || 0
        if (origW < 1 || origH < 1) return // <img> still loading — a later change re-fires

        // Supersede any in-flight request so a fast click burst can't race.
        try { semanticAbortRef.current?.abort() } catch { /* ignore */ }
        const abortController = new AbortController()
        semanticAbortRef.current = abortController
        isSemanticRunningRef.current = true
        setIsSemanticRunning(true)

        const points = clicks.map(([x, y]) => [x, y])
        const labels = clicks.map(([, , l]) => l)
        const dims = { width: origW, height: origH }
        let canvas = null
        let lastErr = null
        try {
            canvas = box
                ? await clientSamBox(sourceEl, box, dims)
                : await clientSamClick(sourceEl, points, labels, dims)
        } catch (err) {
            if (err?.name === 'AbortError') return
            lastErr = err
        }
        try {
            // A newer request superseded us while we were running — bail.
            if (semanticAbortRef.current !== abortController) return
            if (!canvas) throw lastErr || new Error('AI selection failed')
            // Refine: composite straight onto the selected layer, re-base, done.
            const targetId = semanticRefineRef.current ? selectedLayerIdRef.current : null
            const target = targetId
                ? chainStackRef.current?.chain?.find((e) => e.layer.id === targetId)?.layer
                : null
            if (target && REFINABLE_KINDS.includes(target.kind) && target.maskTextureKey) {
                compositeIntoLayer(target, canvas, semanticRefineModeRef.current === 'remove' ? 'remove' : 'add')
                setLastSemanticMask(null)
                setLastSemanticPreview(null)
                return
            }
            const ctx = canvas.getContext('2d', { willReadFrequently: true })
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
            setLastSemanticMask(imageData)
            setLastSemanticPreview(canvas.toDataURL('image/png'))
        } catch (err) {
            if (err?.name === 'AbortError') return
            console.error('[mask] SAM selection failed:', err)
            toast.error(toUserMessage(err, 'AI selection failed'))
        } finally {
            if (semanticAbortRef.current === abortController) {
                isSemanticRunningRef.current = false
                setIsSemanticRunning(false)
            }
        }
    }, [tool.mainImage, semanticClicks, semanticBox, compositeIntoLayer])

    // Live per-interaction selection: re-run SAM (debounced) whenever the click
    // points or box change, so each click/drag immediately updates the preview
    // — the cumulative-point refine SAM is designed for.
    // Keyed on the interaction inputs only: depending on handleSemanticRun made
    // every result's re-render rebuild it and re-fire SAM, and each re-run
    // aborted the previous one, so the selection looped forever uncommitted.
    const handleSemanticRunRef = useRef(handleSemanticRun)
    handleSemanticRunRef.current = handleSemanticRun
    useEffect(() => {
        if (!semanticActive) return undefined
        // A box being dragged updates semanticBox every move; segment once on
        // release instead of re-running SAM for every rubber-band frame.
        if (boxDragging) return undefined
        if (semanticClicks.length === 0 && !semanticBox) return undefined
        const t = setTimeout(() => { handleSemanticRunRef.current() }, 80)
        return () => clearTimeout(t)
    }, [semanticActive, semanticClicks, semanticBox, boxDragging])

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
        const id = addChainLayer('semantic', { maskTextureKey: key, baseTextureKey: key, growPx: 0, feather: 0.1, label: 'AI Subject' })
        if (id) toast.success('Semantic layer added to chain')
        // Clear the working state so the user knows the layer is now
        // managed by the chain (and so they don't accidentally add
        // the same mask twice).
        setLastSemanticMask(null)
        setLastSemanticPreview(null)
        setSemanticClicks([])
        setSemanticActive(false)
    }, [lastSemanticMask, addChainLayer])

    return { boxArmed, compositeIntoLayer, decodeMaskBlob, handleAddSemanticLayer, handleSemanticReset, handleSemanticRun, handleSemanticStop, isSemanticRunning, lastSemanticMask, lastSemanticPreview, refineTargetLayer, semanticAbortRef, semanticActive, semanticBox, semanticClicks, semanticRefine, semanticRefineMode, setBoxArmed, setSemanticActive, setSemanticBox, setSemanticClicks, setSemanticRefine, setSemanticRefineMode }
}
