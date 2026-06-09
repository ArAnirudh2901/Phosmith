// Live-canvas flattening — the single source of truth for "what the image
// currently looks like".
//
// The editor's true current image is the LIVE Fabric canvas: the original
// bitmap PLUS every non-destructive edit layered on top (adjust/erase filters,
// the megashader mask, draw paths, text, and multi-image composition). Reading
// an image's `_originalElement` (as the fingerprint/feature extractors do by
// default) sees NONE of that — so anything that needs the edited result must
// render the canvas to real pixels first.
//
// This module owns that render. Export (PNG/JPEG/WebP download + clipboard) and
// the AI agent's image-context capture both flow through here, so they can never
// disagree about what the canvas looks like. It is UI-decoupled (plain functions
// over a Fabric canvas) so the command-registry / agent layer can call it without
// the React topbar.

import { isPixxelMaskOverlay } from "@/lib/canvas-mask"

// Transient objects that must never appear in a flattened render: the mask
// tool's live overlay and anything explicitly flagged excludeFromExport.
export const isExportTransientObject = (obj) =>
    obj?.excludeFromExport ||
    isPixxelMaskOverlay(obj)

export const isTaintError = (error) =>
    /taint|insecure|securityerror|cross-?origin/i.test(
        `${error?.name || ""} ${error?.message || error || ""}`
    )

// Recover from a tainted-canvas read: re-load every remote image element with
// crossOrigin "anonymous" so the canvas becomes readable. Geometry + filters are
// preserved (same src, just a CORS-clean fetch). Used as a one-shot retry when
// toBlob/toDataURL/getImageData throws a SecurityError on a session whose images
// were loaded without CORS (e.g. a background applied before the crossOrigin fix).
export const reloadCanvasImagesWithCors = async (canvas) => {
    if (!canvas) return
    const reloadOne = (obj) => {
        if (!obj || obj.type?.toLowerCase?.() !== "image") return null
        const el = obj._originalElement || obj._element
        const src = obj.getSrc?.() || el?.src || obj.src
        if (!src || src.startsWith("data:") || src.startsWith("blob:")) return null
        if (el?.crossOrigin === "anonymous") return null // already CORS-clean
        if (typeof obj.setSrc !== "function") return null
        const geometry = {
            left: obj.left, top: obj.top, scaleX: obj.scaleX, scaleY: obj.scaleY,
            angle: obj.angle, originX: obj.originX, originY: obj.originY,
            flipX: obj.flipX, flipY: obj.flipY, cropX: obj.cropX, cropY: obj.cropY,
            width: obj.width, height: obj.height,
        }
        return obj
            .setSrc(src, { crossOrigin: "anonymous" })
            .then(() => {
                obj.set(geometry)
                obj.applyFilters?.()
                obj.setCoords?.()
            })
            .catch(() => { /* leave as-is; retry will surface the original error */ })
    }
    const tasks = []
    for (const obj of canvas.getObjects?.() || []) {
        const task = reloadOne(obj)
        if (task) tasks.push(task)
    }
    const bgTask = reloadOne(canvas.backgroundImage)
    if (bgTask) tasks.push(bgTask)
    await Promise.all(tasks)
    canvas.requestRenderAll()
}

// Render the LIVE canvas to a detached HTMLCanvasElement in project space, with
// every layer/filter/mask/draw applied. Synchronous: it temporarily mutates the
// canvas viewport/dimensions and ALWAYS restores them in `finally`, so the live
// editor is untouched once this returns. The returned element is independent of
// the live canvas.
//
// - scale: resolution multiplier (export 2×/3×). Default 1.
// - maxEdge: cap the output's long edge to this many px (down-scales scale to
//   fit). Used for the agent's analysis render so 4K projects don't ship huge
//   payloads; omit for full-resolution export.
export const renderLiveCanvasElement = (canvasEditor, { project, scale = 1, maxEdge = null } = {}) => {
    if (!canvasEditor) throw new Error("renderLiveCanvasElement: no canvas")
    const previousActive = canvasEditor.getActiveObject?.()
    if (previousActive) canvasEditor.discardActiveObject()

    // Hoist viewport save variables so the finally block can always restore them.
    let savedVpt = null
    let savedW = null
    let savedH = null
    const hiddenForExport = []

    try {
        for (const obj of canvasEditor.getObjects?.() || []) {
            if (obj.visible !== false && isExportTransientObject(obj)) {
                hiddenForExport.push(obj)
                obj.set?.("visible", false)
            }
        }

        // Fabric.js v7 export fix: temporarily reset the viewport to identity
        // so objects render at their true project-space positions.
        savedVpt = [...canvasEditor.viewportTransform]
        savedW = canvasEditor.getWidth()
        savedH = canvasEditor.getHeight()

        canvasEditor.viewportTransform = [1, 0, 0, 1, 0, 0]
        canvasEditor.calcOffset()
        canvasEditor.renderAll()

        // When a canvas background (image or color) is present, the background
        // defines the frame, so export the FULL project rect — otherwise the
        // tight object bbox would crop the background to the photo's bounds.
        const bgColor = canvasEditor.backgroundColor
        const hasBackground =
            Boolean(canvasEditor.backgroundImage) ||
            (typeof bgColor === "string" && bgColor !== "" && bgColor !== "transparent")

        const objects = canvasEditor.getObjects().filter(o => o.visible !== false && !isExportTransientObject(o))
        if (!objects.length && !hasBackground) {
            throw new Error("No visible objects on the canvas to render")
        }

        // Tight bounding box around all visible non-transient objects.
        let objMinX = Infinity, objMinY = Infinity, objMaxX = -Infinity, objMaxY = -Infinity
        for (const obj of objects) {
            const rect = obj.getBoundingRect(true) // absolute coords, no viewport
            objMinX = Math.min(objMinX, rect.left)
            objMinY = Math.min(objMinY, rect.top)
            objMaxX = Math.max(objMaxX, rect.left + rect.width)
            objMaxY = Math.max(objMaxY, rect.top + rect.height)
        }

        let cropLeft
        let cropTop
        let cropW
        let cropH

        if (hasBackground) {
            // The background defines the frame, so include the full project rect —
            // but UNION it with the object bbox so objects extending past the canvas
            // aren't clipped. Fall back to the live canvas size if dims are missing.
            const frameW = Math.round(project?.width || savedW || 1)
            const frameH = Math.round(project?.height || savedH || 1)
            const hasObjects = objects.length > 0
            cropLeft = hasObjects ? Math.min(0, Math.floor(objMinX)) : 0
            cropTop = hasObjects ? Math.min(0, Math.floor(objMinY)) : 0
            const right = hasObjects ? Math.max(frameW, Math.ceil(objMaxX)) : frameW
            const bottom = hasObjects ? Math.max(frameH, Math.ceil(objMaxY)) : frameH
            cropW = right - cropLeft
            cropH = bottom - cropTop
        } else {
            // No background: tight content bbox, no empty project margin.
            cropLeft = Math.floor(objMinX)
            cropTop = Math.floor(objMinY)
            cropW = Math.ceil(objMaxX) - cropLeft
            cropH = Math.ceil(objMaxY) - cropTop
        }

        if (cropW < 1 || cropH < 1) {
            throw new Error("Object bounding box is empty")
        }

        const canvasSizeW = Math.max(cropLeft + cropW, savedW)
        const canvasSizeH = Math.max(cropTop + cropH, savedH)
        canvasEditor.setDimensions({ width: canvasSizeW, height: canvasSizeH })
        canvasEditor.calcOffset()
        canvasEditor.renderAll()

        // Cap the output's long edge when requested (analysis render). This only
        // ever reduces scale — export passes no maxEdge and keeps its 1×/2×/3×.
        const effectiveScale = maxEdge
            ? Math.min(scale, maxEdge / Math.max(cropW, cropH))
            : scale

        // Pass scale through to fabric so high-res renders re-render at higher
        // resolution rather than upscaling the already-rasterized snapshot.
        const canvasElement = canvasEditor.toCanvasElement(effectiveScale, {
            width: cropW,
            height: cropH,
            left: cropLeft,
            top: cropTop,
        })

        return { canvasElement, cropW, cropH, scale: effectiveScale }
    } finally {
        // Always restore viewport dimensions and transform, even if render failed.
        for (const obj of hiddenForExport) {
            try { obj.set?.("visible", true) } catch { /* object may have been removed */ }
        }
        if (savedVpt && typeof savedW === "number" && typeof savedH === "number") {
            try {
                canvasEditor.setDimensions({ width: savedW, height: savedH })
                canvasEditor.viewportTransform = savedVpt
                canvasEditor.calcOffset()
            } catch { /* canvas may have been disposed */ }
        }
        // Restore the prior selection only if that object STILL EXISTS on the
        // canvas — otherwise setActiveObject would attach a stale fabric reference
        // whose internal state has been torn down, leading to "cacheCanvas is null"
        // errors on next click.
        const stillExists = previousActive && canvasEditor.getObjects?.().includes?.(previousActive)
        if (stillExists && canvasEditor.contextContainer) {
            try { canvasEditor.setActiveObject(previousActive) } catch { /* selection may have been removed */ }
        }
        canvasEditor.requestRenderAll()
    }
}

// Flatten the live canvas to an encoded blob (PNG/JPEG/WebP) — the export path.
export const snapshotCanvasToBlob = async (canvasEditor, { project, scale = 1, format = "png", quality = 1 } = {}) => {
    const { canvasElement } = renderLiveCanvasElement(canvasEditor, { project, scale })

    let finalCanvas = canvasElement
    // Only JPEG lacks an alpha channel, so only it needs a flattened background.
    // PNG and WebP both support transparency — preserve the erased/masked alpha
    // for them instead of filling it white.
    if (format === "jpeg") {
        finalCanvas = document.createElement("canvas")
        finalCanvas.width = canvasElement.width
        finalCanvas.height = canvasElement.height
        const ctx = finalCanvas.getContext("2d")
        const bg = canvasEditor.backgroundColor
        const isRealColor = typeof bg === "string" && bg !== "transparent" && bg !== ""
        ctx.fillStyle = isRealColor ? bg : "#ffffff"
        ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height)
        ctx.drawImage(canvasElement, 0, 0)
    }

    const mimeType = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png"

    // toBlob (vs toDataURL) avoids materializing the full base64 string into JS
    // memory — important for full-resolution exports of 4K+ images.
    const blob = await new Promise((resolve, reject) => {
        finalCanvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("Canvas encoding failed"))),
            mimeType,
            quality,
        )
    })
    return { blob, mimeType }
}

// Export with one-shot tainted-canvas recovery: if encoding throws a SecurityError
// because an image was loaded without CORS, reload images with crossOrigin
// "anonymous" and try once more.
export const snapshotCanvasToBlobSafe = async (canvasEditor, opts) => {
    try {
        return await snapshotCanvasToBlob(canvasEditor, opts)
    } catch (error) {
        if (!isTaintError(error)) throw error
        await reloadCanvasImagesWithCors(canvasEditor)
        return await snapshotCanvasToBlob(canvasEditor, opts)
    }
}

// Flatten the live canvas for AI analysis: returns BOTH the rendered element (to
// derive a fingerprint/perceptual-hash/feature-vector that reflect manual edits —
// a plain canvas has no `_originalElement`, so the extractors read the live pixels)
// AND a capped JPEG base64 to send to the vision model. Recovers from a tainted
// canvas once; returns null if it still can't be read (caller falls back to the
// raw FabricImage).
export const flattenLiveCanvasForAnalysis = async (canvasEditor, { project, maxEdge = 1024, quality = 0.85 } = {}) => {
    if (!canvasEditor) return null
    const renderOnce = () => {
        const { canvasElement } = renderLiveCanvasElement(canvasEditor, { project, scale: 1, maxEdge })
        // toDataURL throws SecurityError on a tainted canvas — this is our taint probe.
        const dataUrl = canvasElement.toDataURL("image/jpeg", quality)
        return { canvasElement, dataUrl }
    }

    let rendered
    try {
        rendered = renderOnce()
    } catch (error) {
        if (!isTaintError(error)) return null
        try {
            await reloadCanvasImagesWithCors(canvasEditor)
            rendered = renderOnce()
        } catch {
            return null
        }
    }

    const commaIdx = rendered.dataUrl.indexOf(",")
    if (commaIdx < 0) return null
    return {
        canvasElement: rendered.canvasElement,
        base64: rendered.dataUrl.slice(commaIdx + 1),
        mimeType: "image/jpeg",
        width: rendered.canvasElement.width,
        height: rendered.canvasElement.height,
    }
}

// Render a single Fabric object (one image layer) WITH its filters/masks applied
// to a detached canvas element, capped to maxEdge. Used by the multi-layer agent
// path so each layer's fingerprint/features/thumbnail reflect manual edits rather
// than the original bitmap. Returns null on failure (caller falls back to the
// raw FabricImage).
export const renderFabricObjectElement = (obj, { maxEdge = 1280 } = {}) => {
    if (!obj || typeof obj.toCanvasElement !== "function") return null
    try {
        const w = (obj.width || 0) * (obj.scaleX || 1)
        const h = (obj.height || 0) * (obj.scaleY || 1)
        const longEdge = Math.max(w, h)
        const multiplier = maxEdge && longEdge > 0 ? Math.min(1, maxEdge / longEdge) : 1
        return obj.toCanvasElement({ multiplier })
    } catch (error) {
        // Tainted/WebGL layer or unexpected failure — the caller falls back to the
        // raw FabricImage (which reads the original bitmap), so log for visibility.
        console.warn("[canvas-snapshot] per-layer render failed; falling back to original bitmap:", error?.message || error)
        return null
    }
}
