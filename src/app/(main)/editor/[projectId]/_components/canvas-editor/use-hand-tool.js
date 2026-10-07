import { useCallback, useEffect } from "react"
import { addImageFilesToCanvas } from "../../../../../../lib/canvas-images"
import { isRawFile } from "../../../../../../lib/raw-preview"

// Hand tool: H toggles it, holding Space borrows it.
export function useHandTool({
    activeToolRef,
    canvasEditor,
    canvasInstanceRef,
    containerRef,
    handToolActiveRef,
    project,
    projectRef,
    setIsHandToolActive,
}) {
    // Uncompiled, like the component it was cut from.
    "use no memo"

    const toggleHandTool = useCallback(() => {
        const canvas = canvasInstanceRef.current
        // Disabled while painting (Mask/Erase) or expanding — the hand tool would
        // pan-drag while the brush is also painting. Hold Space to pan instead.
        if (
            !canvas ||
            activeToolRef.current === 'ai_extender' ||
            activeToolRef.current === 'mask' ||
            activeToolRef.current === 'erase'
        ) return
        const next = !handToolActiveRef.current
        canvas.__setHandToolActive?.(next)
        setIsHandToolActive(next)
    }, [])

    useEffect(() => {
        const handleHandHotkey = (event) => {
            if (event.repeat) return
            if (event.key !== 'h' && event.key !== 'H') return
            const target = event.target
            if (
                target &&
                (target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.tagName === 'SELECT' ||
                    target.isContentEditable)
            ) return
            if (event.metaKey || event.ctrlKey || event.altKey) return
            event.preventDefault()
            toggleHandTool()
        }
        window.addEventListener('keydown', handleHandHotkey)
        return () => window.removeEventListener('keydown', handleHandHotkey)
    }, [toggleHandTool])

    // ─── Image drag-and-drop onto canvas ───
    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const handleDragOver = (e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
        }

        const handleDrop = async (e) => {
            e.preventDefault()
            const canvas = canvasInstanceRef.current
            if (!canvas) return

            const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/') || isRawFile(f))
            if (files.length === 0) return

            // Use a ref so this handler always sees the latest project, even if the
            // effect isn't re-bound (e.g. switching projects with same dimensions).
            await addImageFilesToCanvas(canvas, files, projectRef.current)
        }

        container.addEventListener('dragover', handleDragOver)
        container.addEventListener('drop', handleDrop)
        return () => {
            container.removeEventListener('dragover', handleDragOver)
            container.removeEventListener('drop', handleDrop)
        }
    }, [canvasEditor, project?.width, project?.height])

    return { toggleHandTool }
}
