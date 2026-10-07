import { useCallback, useEffect, useRef, useState } from 'react'
import { Circle as FabricCircle, Ellipse, Line } from 'fabric'
import { pointToImageSpace } from '@/lib/canvas-mask'

// On-canvas handles for the selected linear / radial layer.
export function useGradientGizmos({
    activeDraft,
    brushActive,
    canvasEditor,
    cleanPreview,
    colorPickerActive,
    imageToDisplay,
    imgAngle,
    imgLeft,
    imgScaleX,
    imgScaleY,
    imgTop,
    isGradientSelected,
    lassoActive,
    overlayRef,
    selKind,
    selectedLayer,
    selectedLayerId,
    semanticActive,
    stack,
    tool,
    updateLayer,
}) {
    // Uncompiled, like the component it was cut from.
    'use no memo'

    /* ─── Re-editable gradient handles (linear / radial) ─── */

    // Point-based inverse of imageToDisplay — converts a scene/display point
    // back to image-pixel space for handle drags. Uses the same centre-based
    // transform inversion as pointerToImage (the image origin is 'center', so
    // a plain (x - left) / scale would land handles half an image off).
    const displayToImage = useCallback((x, y) => {
        if (!tool.mainImage) return null
        return pointToImageSpace(tool.mainImage, { x, y })
    }, [tool.mainImage])

    // Latest selected layer, read inside drag handlers via a ref so the
    // handle-build effect does NOT depend on geometry (which would tear down
    // and rebuild the handles mid-drag). `selectedLayer`/`selKind`/
    // `isGradientSelected` are computed once near the top of the component.
    const selectedLayerRef = useRef(selectedLayer)
    selectedLayerRef.current = selectedLayer
    const gradientHandlesRef = useRef(/** @type {Array<any>} */ ([]))
    const draggingHandleRef = useRef(false)
    const [handleTick, setHandleTick] = useState(0)
    // Handles rebuild on selection/drag-end only, so undo/redo or a panel edit
    // left them drawn at the old geometry. Rebuild when geometry changes outside
    // a handle drag (during one, reflow already tracks it).
    const gizmoGeom = selectedLayer && (selectedLayer.kind === 'radial' || selectedLayer.kind === 'linear')
        ? JSON.stringify([selectedLayer.center, selectedLayer.radius, selectedLayer.rotation, selectedLayer.p1, selectedLayer.p2])
        : null
    useEffect(() => {
        if (gizmoGeom && !draggingHandleRef.current) setHandleTick((t) => t + 1)
    }, [gizmoGeom])

    const clearGradientHandles = useCallback(() => {
        const c = canvasEditor
        for (const o of gradientHandlesRef.current) {
            try { c?.remove(o) } catch { /* canvas gone */ }
        }
        gradientHandlesRef.current = []
    }, [canvasEditor])

    const captureActive = brushActive || colorPickerActive || semanticActive || lassoActive || !!activeDraft

    useEffect(() => {
        const fabricCanvas = canvasEditor
        clearGradientHandles()
        if (!fabricCanvas || !tool.mainImage) return undefined
        if (!isGradientSelected || captureActive || cleanPreview) return undefined
        const layer = selectedLayerRef.current
        if (!layer) return undefined

        const sx = tool.mainImage.scaleX || 1
        const sy = tool.mainImage.scaleY || 1
        // Gizmo objects live in scene units, so divide by the viewport zoom to
        // keep handles grabbable at any zoom (a raw radius of 7 rendered ~1px
        // at the 18% fit zoom of a large photo).
        const z = fabricCanvas.getZoom?.() || 1
        const px = (n) => n / z
        // The Mask tool runs with skipTargetFind on, which made every handle inert.
        fabricCanvas.__maskGizmoActive = true
        fabricCanvas.skipTargetFind = false

        const makeHandle = (imgPt, onDrag) => {
            const d = imageToDisplay(imgPt.x, imgPt.y)
            if (!d) return null
            const h = new FabricCircle({
                left: d.x, top: d.y, radius: px(7),
                fill: 'rgba(6,184,212,0.95)', stroke: '#ffffff', strokeWidth: px(2),
                originX: 'center', originY: 'center',
                hasControls: false, hasBorders: false, selectable: true, evented: true,
                hoverCursor: 'grab', moveCursor: 'grabbing',
                excludeFromExport: true, objectCaching: false,
            })
            h.on('mousedown', () => { draggingHandleRef.current = true })
            h.on('moving', () => {
                const p = displayToImage(h.left, h.top)
                if (p) onDrag(p)
            })
            fabricCanvas.add(h)
            gradientHandlesRef.current.push(h)
            return h
        }

        if (layer.kind === 'linear' && layer.p1 && layer.p2) {
            const p1d = imageToDisplay(layer.p1.x, layer.p1.y)
            const p2d = imageToDisplay(layer.p2.x, layer.p2.y)
            let line = null
            let h1 = null
            let h2 = null
            let hM = null
            const reflowLine = () => {
                const l = selectedLayerRef.current
                if (!l?.p1 || !l?.p2) return
                const d1 = imageToDisplay(l.p1.x, l.p1.y)
                const d2 = imageToDisplay(l.p2.x, l.p2.y)
                if (!d1 || !d2) return
                if (h1) { h1.set({ left: d1.x, top: d1.y }); h1.setCoords?.() }
                if (h2) { h2.set({ left: d2.x, top: d2.y }); h2.setCoords?.() }
                if (hM) { hM.set({ left: (d1.x + d2.x) / 2, top: (d1.y + d2.y) / 2 }); hM.setCoords?.() }
                if (line) { line.set({ x1: d1.x, y1: d1.y, x2: d2.x, y2: d2.y }); line.setCoords?.() }
            }
            if (p1d && p2d) {
                line = new Line([p1d.x, p1d.y, p2d.x, p2d.y], {
                    stroke: '#06b8d4', strokeWidth: px(1.5), strokeDashArray: [px(5), px(5)],
                    selectable: false, evented: false, excludeFromExport: true, objectCaching: false,
                })
                fabricCanvas.add(line)
                gradientHandlesRef.current.push(line)
            }
            h1 = makeHandle(layer.p1, (p) => { updateLayer(layer.id, { p1: { x: p.x, y: p.y } }); reflowLine() })
            h2 = makeHandle(layer.p2, (p) => { updateLayer(layer.id, { p2: { x: p.x, y: p.y } }); reflowLine() })
            // Midpoint: drag both endpoints together (move the whole gradient).
            hM = makeHandle(
                { x: (layer.p1.x + layer.p2.x) / 2, y: (layer.p1.y + layer.p2.y) / 2 },
                (p) => {
                    const l = selectedLayerRef.current
                    const mx = (l.p1.x + l.p2.x) / 2
                    const my = (l.p1.y + l.p2.y) / 2
                    const dx = p.x - mx
                    const dy = p.y - my
                    updateLayer(layer.id, {
                        p1: { x: l.p1.x + dx, y: l.p1.y + dy },
                        p2: { x: l.p2.x + dx, y: l.p2.y + dy },
                    })
                    reflowLine()
                },
            )
        } else if (layer.kind === 'radial' && layer.center && layer.radius) {
            let ell = null
            let cH = null
            const edges = {}   // e/w/n/s resize handles
            let rotH = null
            const ROT_OFF = 26 / Math.max(0.0001, sy * z) // lollipop offset beyond N, ~const px
            // Edge positions on the rotated axes (screen-y-down): E=+x, W=−x,
            // S=+y, N=−y of the local frame.
            const edgePos = (l, axis) => {
                const rot = l.rotation || 0
                const co = Math.cos(rot)
                const si = Math.sin(rot)
                const { x: cx, y: cy } = l.center
                if (axis === 'e') return { x: cx + co * l.radius.x, y: cy + si * l.radius.x }
                if (axis === 'w') return { x: cx - co * l.radius.x, y: cy - si * l.radius.x }
                if (axis === 's') return { x: cx - si * l.radius.y, y: cy + co * l.radius.y }
                if (axis === 'n') return { x: cx + si * l.radius.y, y: cy - co * l.radius.y }
                // rot lollipop: beyond N
                const ny = l.radius.y + ROT_OFF
                return { x: cx + si * ny, y: cy - co * ny }
            }
            // Reposition outline + handles from the latest layer. For the
            // dragged handle it's a round-trip identity, so it never fights.
            const reflow = () => {
                const l = selectedLayerRef.current
                if (!l || !l.center || !l.radius) return
                const rot = l.rotation || 0
                const cc = imageToDisplay(l.center.x, l.center.y)
                if (ell && cc) { ell.set({ left: cc.x, top: cc.y, rx: Math.max(1, l.radius.x * sx), ry: Math.max(1, l.radius.y * sy), angle: rot * 180 / Math.PI }); ell.setCoords?.() }
                if (cH && cc) { cH.set({ left: cc.x, top: cc.y }); cH.setCoords?.() }
                for (const axis of ['e', 'w', 'n', 's']) {
                    const h = edges[axis]
                    if (!h) continue
                    const d = imageToDisplay(edgePos(l, axis).x, edgePos(l, axis).y)
                    if (d) { h.set({ left: d.x, top: d.y }); h.setCoords?.() }
                }
                if (rotH) {
                    const d = imageToDisplay(edgePos(l, 'rot').x, edgePos(l, 'rot').y)
                    if (d) { rotH.set({ left: d.x, top: d.y }); rotH.setCoords?.() }
                }
            }
            const center = layer.center
            const radius = layer.radius
            const rotation = layer.rotation || 0
            const cd = imageToDisplay(center.x, center.y)
            if (cd) {
                ell = new Ellipse({
                    left: cd.x, top: cd.y,
                    rx: Math.max(1, radius.x * sx), ry: Math.max(1, radius.y * sy),
                    angle: rotation * 180 / Math.PI,
                    fill: 'rgba(6,184,212,0.08)', stroke: '#06b8d4', strokeWidth: px(1.5), strokeDashArray: [px(5), px(5)],
                    originX: 'center', originY: 'center',
                    selectable: false, evented: false, excludeFromExport: true, objectCaching: false,
                })
                fabricCanvas.add(ell)
                gradientHandlesRef.current.push(ell)
            }
            cH = makeHandle(center, (p) => {
                updateLayer(layer.id, { center: { x: p.x, y: p.y } })
                reflow()
            })
            // 4-way resize on the rotated axes — resize only, no rotation
            // coupling (the lollipop owns rotation, studio-style).
            const onResize = (axis) => (p) => {
                const l = selectedLayerRef.current
                const rot = l.rotation || 0
                const dx = p.x - l.center.x
                const dy = p.y - l.center.y
                const lx = dx * Math.cos(rot) + dy * Math.sin(rot)
                const ly = -dx * Math.sin(rot) + dy * Math.cos(rot)
                const radiusNext = (axis === 'e' || axis === 'w')
                    ? { x: Math.max(2, Math.abs(lx)), y: l.radius.y }
                    : { x: l.radius.x, y: Math.max(2, Math.abs(ly)) }
                updateLayer(layer.id, { radius: radiusNext })
                reflow()
            }
            for (const axis of ['e', 'w', 'n', 's']) {
                edges[axis] = makeHandle(edgePos(layer, axis), onResize(axis))
            }
            // Rotate lollipop (green, above N): straight-up = 0.
            rotH = makeHandle(edgePos(layer, 'rot'), (p) => {
                const l = selectedLayerRef.current
                const rot = Math.atan2(p.y - l.center.y, p.x - l.center.x) + Math.PI / 2
                updateLayer(layer.id, { rotation: rot })
                reflow()
            })
            if (rotH) rotH.set({ fill: 'rgba(155,249,91,0.95)', radius: px(6) })
        }

        // On drag end, snap the gizmo to the final geometry with a clean
        // rebuild (and re-enable normal interaction).
        const onUp = () => {
            if (draggingHandleRef.current) {
                draggingHandleRef.current = false
                setHandleTick((t) => t + 1)
            }
        }
        fabricCanvas.on('mouse:up', onUp)
        const onRender = () => {
            if (!draggingHandleRef.current && (fabricCanvas.getZoom?.() || 1) !== z) setHandleTick((t) => t + 1)
        }
        fabricCanvas.on('after:render', onRender)
        fabricCanvas.requestRenderAll()
        return () => {
            fabricCanvas.off('mouse:up', onUp)
            fabricCanvas.off('after:render', onRender)
            fabricCanvas.__maskGizmoActive = false
            if (fabricCanvas.__pixelToolActive) fabricCanvas.skipTargetFind = true
            clearGradientHandles()
        }
        // Geometry is intentionally NOT a dependency (drag handlers reposition
        // imperatively); the image transform + handleTick drive rebuilds.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedLayerId, selKind, isGradientSelected, captureActive, cleanPreview, canvasEditor, tool.mainImage,
        imgLeft, imgTop, imgScaleX, imgScaleY, imgAngle, handleTick])

    // Live preview overlay: a thin dashed line/ellipse on the canvas
    // that tracks the layer's current geometry. Re-rendered on every
    // stack change so the user sees the preview update mid-drag.
    useEffect(() => {
        const fabricCanvas = canvasEditor
        if (!fabricCanvas) return
        if (overlayRef.current) {
            fabricCanvas.remove(overlayRef.current)
            overlayRef.current = null
        }
        if (!activeDraft) return
        const layer = stack.chain.find((e) => e.layer.id === activeDraft.layerId)?.layer
        if (!layer) return

        let overlay = null
        const dz = canvasEditor?.getZoom?.() || 1
        if (activeDraft.kind === 'linear' && layer.p1 && layer.p2) {
            const p1 = imageToDisplay(layer.p1.x, layer.p1.y)
            const p2 = imageToDisplay(layer.p2.x, layer.p2.y)
            if (p1 && p2) {
                overlay = new Line([p1.x, p1.y, p2.x, p2.y], {
                    stroke: '#06b8d4',
                    strokeWidth: 2 / dz,
                    strokeDashArray: [5 / dz, 5 / dz],
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
                    strokeWidth: 2 / dz,
                    strokeDashArray: [5 / dz, 5 / dz],
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
}
