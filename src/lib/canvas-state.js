import { isExpansionFrameLike } from './expansion-pipeline'

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
        json.objects = json.objects.filter((obj) => !isExpansionFrameLike(obj))
        const canvasObjects = canvas.getObjects?.() || []

        json.objects = json.objects.map((obj, index) => {
            const indexedObj = canvasObjects[index]
            if (
                indexedObj?._pixxelAdjustmentOverlay ||
                indexedObj?.pixxelAdjustmentOverlay ||
                indexedObj?.name === 'pixxel-vignette-overlay'
            ) {
                return {
                    ...obj,
                    name: indexedObj.name || 'pixxel-vignette-overlay',
                    pixxelAdjustmentOverlay:
                        indexedObj.pixxelAdjustmentOverlay ||
                        indexedObj._pixxelAdjustmentOverlay ||
                        'vignette',
                    ...(indexedObj.pixxelAdjustmentTargetId || indexedObj._pixxelAdjustmentTargetId
                        ? {
                            pixxelAdjustmentTargetId:
                                indexedObj.pixxelAdjustmentTargetId ||
                                indexedObj._pixxelAdjustmentTargetId,
                        }
                        : {}),
                }
            }

            if (obj.type === 'image' || obj.type === 'Image') {
                const cleaned = { ...obj }
                const matchingObj =
                    canvasObjects.find(
                        (o) =>
                            (o.type === 'image' || o.type === 'Image') &&
                            Math.abs((o.left || 0) - (cleaned.left || 0)) < 0.5 &&
                            Math.abs((o.top || 0) - (cleaned.top || 0)) < 0.5
                    ) ||
                    canvasObjects.find((o) => o.type === 'image' || o.type === 'Image')

                if (matchingObj?.pixxelAdjustValues || matchingObj?._pixxelAdjustValues) {
                    cleaned.pixxelAdjustValues =
                        matchingObj.pixxelAdjustValues || matchingObj._pixxelAdjustValues
                }

                if (matchingObj?.pixxelAdjustmentId || matchingObj?._pixxelAdjustmentId) {
                    cleaned.pixxelAdjustmentId =
                        matchingObj.pixxelAdjustmentId || matchingObj._pixxelAdjustmentId
                }

                if (matchingObj?.pixxelImageKitAdjustBaseSrc || matchingObj?._pixxelImageKitAdjustBaseSrc) {
                    cleaned.pixxelImageKitAdjustBaseSrc =
                        matchingObj.pixxelImageKitAdjustBaseSrc ||
                        matchingObj._pixxelImageKitAdjustBaseSrc
                }

                if (matchingObj?.pixxelImageKitAdjustValues) {
                    cleaned.pixxelImageKitAdjustValues = matchingObj.pixxelImageKitAdjustValues
                }

                // Only strip if the src is a Base64 data URL (can be several MB)
                if (cleaned.src && cleaned.src.startsWith('data:')) {
                    const remoteSrc =
                        matchingObj?._originalElement?.src || matchingObj?.getSrc?.()

                    if (remoteSrc && !remoteSrc.startsWith('data:')) {
                        cleaned.src = remoteSrc
                    } else if (cleaned.src.length > 500_000) {
                        delete cleaned.src
                    }
                }

                if (matchingObj?.filters?.length) {
                    cleaned.filters = matchingObj.filters.map((filter) =>
                        typeof filter.toObject === 'function' ? filter.toObject() : filter
                    )
                }

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
