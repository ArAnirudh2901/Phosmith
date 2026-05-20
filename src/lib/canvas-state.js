export const getCanvasViewportState = (canvas) => {
    if (!canvas) return null

    const viewportTransform = canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
    const zoom = viewportTransform[0] || 1
    const canvasWidth = canvas.getWidth()
    const canvasHeight = canvas.getHeight()

    return {
        zoom,
        center: {
            x: (canvasWidth / 2 - viewportTransform[4]) / zoom,
            y: (canvasHeight / 2 - viewportTransform[5]) / zoom,
        },
    }
}

export const serializeCanvasState = (canvas) => {
    if (!canvas) return null

    const json = canvas.toJSON()

    // Strip inline Base64 image data from objects to keep payload under Convex's 1MB limit.
    // Remote URLs (http/https) are preserved as-is.
    // If an image only has a Base64 data URL, we skip it to avoid breaking the canvas restore.
    if (json?.objects) {
        // Filter out temporary UI elements (expansion frames, etc.)
        json.objects = json.objects.filter((obj) => {
            // Remove expansion frame Rects — they are temporary UI, not part of the design
            if (obj._isExpansionFrame) return false
            // Also detect by visual properties (custom props may not survive toJSON)
            if ((obj.type === 'rect' || obj.type === 'Rect') &&
                obj.fill === 'rgba(108, 99, 255, 0.04)' &&
                obj.stroke === 'rgba(108, 99, 255, 0.5)' &&
                Array.isArray(obj.strokeDashArray) && obj.strokeDashArray.length > 0) {
                return false
            }
            return true
        })

        json.objects = json.objects.map((obj) => {
            if (obj.type === 'image' || obj.type === 'Image') {
                const cleaned = { ...obj }

                // Only strip if the src is a Base64 data URL (can be several MB)
                if (cleaned.src && cleaned.src.startsWith('data:')) {
                    // Try to find a remote URL from the canvas object
                    const canvasObjects = canvas.getObjects?.() || []
                    const matchingObj = canvasObjects.find(
                        (o) => (o.type === 'image' || o.type === 'Image') &&
                               o.left === cleaned.left && o.top === cleaned.top
                    )
                    const remoteSrc = matchingObj?._originalElement?.src ||
                                      matchingObj?.getSrc?.()

                    if (remoteSrc && !remoteSrc.startsWith('data:')) {
                        // Use the remote URL instead of the Base64 blob
                        cleaned.src = remoteSrc
                    } else {
                        // No remote URL available — keep the data but truncate if gigantic (> 500KB)
                        if (cleaned.src.length > 500_000) {
                            // Drop the src entirely — it would blow the Convex limit anyway
                            // The image will be reloaded from project.currentImageUrl on next init
                            delete cleaned.src
                        }
                    }
                }

                // Strip _originalElement (non-serializable DOM node)
                if (cleaned._originalElement) {
                    delete cleaned._originalElement
                }

                return cleaned
            }
            return obj
        })
    }

    return {
        canvas: json,
        viewport: getCanvasViewportState(canvas),
    }
}

export const normalizeCanvasState = (canvasState) => {
    if (!canvasState) return null

    if (typeof canvasState === 'object' && (canvasState.canvas || canvasState.viewport)) {
        return canvasState
    }

    return {
        canvas: canvasState,
        viewport: null,
    }
}