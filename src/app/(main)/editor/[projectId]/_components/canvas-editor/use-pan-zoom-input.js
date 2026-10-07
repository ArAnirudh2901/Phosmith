import { useEffect, useRef } from "react"
import { setDomainHost } from "@/lib/agent/domain-host"
import { bindDoodlesToImage, followDoodles } from "@/lib/canvas-doodle-bind"
import { ensureCanvasFilters } from "@/lib/canvas-filter-registry"
import { hydrateCanvasImages } from "../../../../../../lib/canvas-history"
import { isPhosmithMaskOverlay } from "../../../../../../lib/canvas-mask"

// Wheel / pinch zoom and pointer panning on the Fabric canvas.
export function usePanZoomInput({
    activeTool,
    canvasEditor,
    canvasInstanceRef,
    ctrlPressedRef,
    handToolActiveRef,
    isPanningRef,
    lastPointerRef,
    project,
    projectRef,
    setIsHandToolActive,
    spacePressedRef,
}) {
    // Uncompiled, like the component it was cut from.
    "use no memo"

    // Publish accessors; the agent panel loads the domains on first use
    // (lib/agent/domain-host.js).
    useEffect(() => {
        const getPrimaryImage = () => {
            const canvas = canvasInstanceRef.current
            if (!canvas) return null
            const objects = canvas.getObjects?.() || []
            return objects.find(
                (obj) => obj?.type?.toLowerCase?.() === 'image' && !isPhosmithMaskOverlay(obj)
            ) || null
        }
        return setDomainHost({
            getPrimaryImage,
            getCanvas: () => canvasInstanceRef.current,
            getProject: () => projectRef.current,
        })
    }, [])

    // Warm the filter classes when idle, so a project that loaded without them still
    // has them before the first grade.
    useEffect(() => {
        const warm = () => { ensureCanvasFilters().catch(() => { /* retried on demand */ }) }
        if (typeof window.requestIdleCallback === 'function') {
            const id = window.requestIdleCallback(warm, { timeout: 4000 })
            return () => window.cancelIdleCallback?.(id)
        }
        const id = window.setTimeout(warm, 1500)
        return () => window.clearTimeout(id)
    }, [])

    // Track the last-hydrated URL so we skip redundant re-hydrations when
    // the parent re-renders (e.g. during sidebar resize) without the image
    // URL actually changing. This prevents the "image refreshing" flicker.
    const lastHydratedUrlRef = useRef(null)

    useEffect(() => {
        const canvas = canvasInstanceRef.current
        const imageUrl = project?.currentImageUrl || project?.originalImageUrl
        if (!canvas || !imageUrl) return

        // Guard: skip if we've already hydrated this exact URL
        if (lastHydratedUrlRef.current === imageUrl) return
        lastHydratedUrlRef.current = imageUrl

        let cancelled = false
        hydrateCanvasImages(canvas, imageUrl, {
            forcePrimaryImageUrl: true,
            canvasSize: { width: project.width, height: project.height },
        }).then(() => {
            if (!cancelled) canvas.requestRenderAll()
        })

        return () => {
            cancelled = true
        }
    }, [canvasEditor, project?.currentImageUrl, project?.originalImageUrl, project?.width, project?.height])

    useEffect(() => {
        const canvas = canvasInstanceRef.current
        if (!canvas?.upperCanvasEl) return

        if (activeTool === 'ai_extender') {
            isPanningRef.current = false
            ctrlPressedRef.current = false
            spacePressedRef.current = false
            handToolActiveRef.current = false
            setIsHandToolActive(false)
            lastPointerRef.current = null
            canvas.__expansionMode = true
            canvas.skipTargetFind = false
            canvas.defaultCursor = 'default'
            canvas.hoverCursor = 'default'
            canvas.moveCursor = 'default'
            if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = 'default'
        } else if (canvas.__expansionMode) {
            canvas.__expansionMode = false
            canvas.__syncPanCursor?.()
        }

        // Drawing mode management (handled in draw.jsx useEffect, but ensure cleanup here)
        if (activeTool !== 'draw' && canvas.isDrawingMode) {
            canvas.isDrawingMode = false
        }
        // Mask/Erase manage their own crosshair + skipTargetFind via
        // usePixelMaskTool's canvas lock; don't stomp it here or the brush cursor
        // flickers back to the move cursor on tool entry.
        if (
            activeTool !== 'draw' &&
            activeTool !== 'ai_extender' &&
            activeTool !== 'mask' &&
            activeTool !== 'erase'
        ) {
            canvas.skipTargetFind = false
            canvas.hoverCursor = 'move'
            canvas.moveCursor = 'move'
            canvas.__syncPanCursor?.()
        }
    }, [activeTool, canvasEditor])

    // Keep doodles glued to the image they were drawn on. On pointer-down over an
    // image we snapshot every stroke sitting on it (relative to the image); as the
    // image is dragged/scaled/rotated we replay that relationship so the strokes
    // travel with the photo as one. The programmatic Resize tool handles its own
    // bind/follow via canvas.__bindDoodles / __followDoodles.
    useEffect(() => {
        if (!canvasEditor) return undefined
        const onPointerDown = (opt) => {
            if (opt?.target?.type?.toLowerCase() === 'image') {
                bindDoodlesToImage(canvasEditor, opt.target)
            }
        }
        const onImageTransform = (opt) => {
            if (opt?.target?.type?.toLowerCase() === 'image') {
                followDoodles(canvasEditor, opt.target)
            }
        }
        canvasEditor.on('mouse:down', onPointerDown)
        canvasEditor.on('object:moving', onImageTransform)
        canvasEditor.on('object:scaling', onImageTransform)
        canvasEditor.on('object:rotating', onImageTransform)
        canvasEditor.on('object:modified', onImageTransform)
        return () => {
            canvasEditor.off('mouse:down', onPointerDown)
            canvasEditor.off('object:moving', onImageTransform)
            canvasEditor.off('object:scaling', onImageTransform)
            canvasEditor.off('object:rotating', onImageTransform)
            canvasEditor.off('object:modified', onImageTransform)
        }
    }, [canvasEditor])
}
