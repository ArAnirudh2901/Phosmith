import { useCallback, useEffect } from "react"

// Hold-to-compare against the state the editor opened with.
export function useCompare({
    activeTool,
    applyProjectFrameStyle,
    canvasEditor,
    canvasInstanceRef,
    compareBaselineUrl,
    isBusy,
    isComparing,
    isLoading,
    isProjectFrameVisible,
    projectFrameStyleRef,
    setCompareBaselineUrl,
    setIsComparing,
}) {
    // Uncompiled, like the component it was cut from.
    "use no memo"

    // Capture the current on-screen project frame as the compare baseline. We
    // grab the region straight from Fabric's already-composited lower canvas
    // (the "after" pixels the user sees) rather than re-rendering — so capture
    // never disturbs the live canvas and the baseline aligns 1:1 with the
    // projectFrameStyle rect used to position the overlay. Selection handles /
    // brush previews live on the upper canvas, so the lower canvas is clean.
    const captureCompareBaseline = useCallback(() => {
        const canvas = canvasInstanceRef.current
        const frame = projectFrameStyleRef.current
        if (!canvas || !frame?.width || !frame?.height) {
            setCompareBaselineUrl(null)
            return
        }
        try {
            const el = canvas.getElement?.() || canvas.lowerCanvasEl
            if (!el?.width) { setCompareBaselineUrl(null); return }
            // Backing store may be devicePixelRatio-scaled vs the CSS width Fabric
            // reports; map screen-space frame rect into backing-store pixels.
            const scale = el.width / (canvas.getWidth() || el.width)
            const sx = Math.max(0, Math.round(frame.left * scale))
            const sy = Math.max(0, Math.round(frame.top * scale))
            const sw = Math.min(el.width - sx, Math.round(frame.width * scale))
            const sh = Math.min(el.height - sy, Math.round(frame.height * scale))
            if (sw < 1 || sh < 1) { setCompareBaselineUrl(null); return }
            const off = document.createElement("canvas")
            off.width = sw
            off.height = sh
            off.getContext("2d").drawImage(el, sx, sy, sw, sh, 0, 0, sw, sh)
            setCompareBaselineUrl(off.toDataURL("image/png"))
        } catch (err) {
            // Tainted canvas (non-CORS image) or disposed canvas — disable compare.
            console.warn("[canvas] compare baseline capture failed:", err?.message || err)
            setCompareBaselineUrl(null)
        }
    }, [])

    // Re-capture the session baseline whenever the active tool changes (or the
    // canvas first finishes loading). "Before" = the state the current tool
    // inherited; "After" = whatever the user does next. Deferred to the next
    // frame so any pending render/fit has settled and projectFrameStyleRef is
    // current. Leaving compare mode on tool switch avoids a stale overlay.
    useEffect(() => {
        setIsComparing(false)
        if (!canvasEditor || isLoading) return undefined
        const raf = requestAnimationFrame(() => captureCompareBaseline())
        return () => cancelAnimationFrame(raf)
    }, [activeTool, canvasEditor, isLoading, captureCompareBaseline])

    // Safety net: releasing the pointer anywhere ends a hold-to-compare, even if
    // the pointerup lands outside the button.
    useEffect(() => {
        if (!isComparing) return undefined
        const end = () => setIsComparing(false)
        window.addEventListener("pointerup", end)
        window.addEventListener("pointercancel", end)
        return () => {
            window.removeEventListener("pointerup", end)
            window.removeEventListener("pointercancel", end)
        }
    }, [isComparing])

    // The overlays mount and unmount with the frame's visibility and with Compare,
    // so a node that has just appeared carries no geometry until the next canvas
    // render — which may be seconds away on an idle canvas. Place it now.
    useEffect(() => {
        applyProjectFrameStyle()
    }, [applyProjectFrameStyle, isProjectFrameVisible, isComparing, compareBaselineUrl, isBusy])

    const canCompare = Boolean(compareBaselineUrl) && !isBusy && isProjectFrameVisible
    const startCompare = useCallback((event) => {
        event.preventDefault()
        event.stopPropagation()
        // Capture the pointer so holding then sliding off the button keeps the
        // before-view up until release (no premature flip on a small jiggle).
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* ignore */ }
        setIsComparing(true)
    }, [])
    const endCompare = useCallback(() => setIsComparing(false), [])
    const handleCompareKeyDown = useCallback((event) => {
        if (event.key === " " || event.key === "Enter") {
            event.preventDefault()
            setIsComparing(true)
        }
    }, [])

    // Perf hook: window.__phosmith.megashaderBench({ size: '4k', counts: [1,4,8] }).
    // Imported on call, so the benchmark never lands in the editor chunk.
    useEffect(() => {
        if (typeof window === "undefined") return undefined
        const ns = (window.__phosmith = window.__phosmith || {})
        ns.megashaderBench = (opts) => import("@/lib/megashader/bench").then((m) => m.megashaderBench(opts))
        ns.megashaderParity = (opts) => import("@/lib/megashader/bench").then((m) => m.megashaderParity(opts))
        ns.megashaderFoldParity = (opts) => import("@/lib/megashader/bench").then((m) => m.megashaderFoldParity(opts))
        ns.megashaderEditBench = (opts) => import("@/lib/megashader/bench").then((m) => m.megashaderEditBench(opts))
        return () => {
            delete ns.megashaderBench
            delete ns.megashaderParity
            delete ns.megashaderFoldParity
            delete ns.megashaderEditBench
        }
    }, [])

    return { canCompare, endCompare, handleCompareKeyDown, startCompare }
}
