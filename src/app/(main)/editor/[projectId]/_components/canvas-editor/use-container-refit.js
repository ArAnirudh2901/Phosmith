import { useEffect } from "react"
import { RESIZE_SETTLE_MS } from "../canvas-editor/viewport"

// Refits the project when the canvas container resizes, without a React render per step.
export function useContainerRefit({
    canvasInstanceRef,
    containerRef,
    fitProjectToViewport,
    isResizingRef,
    previewZoomPercentRef,
    project,
    projectRef,
    resizeFrameRef,
    resizeSettleRef,
    setPreviewZoomPercent,
}) {
    // Uncompiled, like the component it was cut from.
    "use no memo"

    useEffect(() => {
        // A resize gesture is a burst: a sidebar drag or a window drag fires tens
        // of steps. Everything a human only reads at the end of it is deferred to
        // here, so a step costs one canvas render and no React render at all.
        const markResizing = () => {
            isResizingRef.current = true
            if (resizeSettleRef.current) clearTimeout(resizeSettleRef.current)
            resizeSettleRef.current = setTimeout(() => {
                resizeSettleRef.current = null
                isResizingRef.current = false
                setPreviewZoomPercent(previewZoomPercentRef.current)
            }, RESIZE_SETTLE_MS)
        }

        const handleResize = () => {
            if (resizeFrameRef.current) cancelAnimationFrame(resizeFrameRef.current)
            resizeFrameRef.current = requestAnimationFrame(() => {
                resizeFrameRef.current = null
                markResizing()
                const canvas = canvasInstanceRef.current
                const proj = projectRef.current
                if (!canvas || !proj || !containerRef.current) return

                const prevWidth = canvas.getWidth()
                const prevHeight = canvas.getHeight()
                const nextWidth = containerRef.current.clientWidth
                const nextHeight = containerRef.current.clientHeight
                if (!nextWidth || !nextHeight) return

                if (prevWidth === nextWidth && prevHeight === nextHeight) {
                    canvas.calcOffset()
                    return
                }

                canvas.setDimensions({ width: nextWidth, height: nextHeight }, { backstoreOnly: false })

                // Always re-fit the project to the new viewport so the canvas
                // content stays centered after sidebar resizes, tool panel
                // toggles, or window resizes.
                fitProjectToViewport(canvas)
                canvas.calcOffset()
                // Render SYNCHRONOUSLY (not requestRenderAll) here: setDimensions
                // above resets the <canvas> element size, which clears its bitmap.
                // requestRenderAll would repaint on the NEXT frame, leaving one
                // blank frame per resize step — visible as flicker while the user
                // drags the sidebar resizer. renderAll repaints in the same frame,
                // so the clear is never shown.
                canvas.renderAll()

                // No explicit chrome sync here: renderAll fires `after:render`,
                // which already ran syncProjectFrame and syncPreviewZoomState.
            })
        }

        const resizeObserver = typeof ResizeObserver !== "undefined" && containerRef.current
            ? new ResizeObserver(handleResize)
            : null

        resizeObserver?.observe(containerRef.current)
        window.addEventListener("resize", handleResize)
        handleResize()
        return () => {
            resizeObserver?.disconnect()
            window.removeEventListener("resize", handleResize)
            if (resizeFrameRef.current) cancelAnimationFrame(resizeFrameRef.current)
            resizeFrameRef.current = null
            if (resizeSettleRef.current) clearTimeout(resizeSettleRef.current)
            resizeSettleRef.current = null
            isResizingRef.current = false
        }
    }, [fitProjectToViewport, project?._id])

    useEffect(() => {
        const canvas = canvasInstanceRef.current
        const proj = projectRef.current
        if (!canvas || !proj?.width || !proj?.height) return
        fitProjectToViewport(canvas, proj)
        canvas.calcOffset()
        canvas.requestRenderAll()
    }, [fitProjectToViewport, project?._id, project?.width, project?.height])
}
