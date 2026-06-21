import { isExpansionFrameLike } from './expansion-pipeline'
import { encodeMaskCanvas, isMaskCanvasEmpty, isPhosmithMaskOverlay, maskCanvasFromClipPath } from './canvas-mask'

const isMaskOverlayLike = (serializedObj, liveObj) =>
    isPhosmithMaskOverlay(serializedObj) || isPhosmithMaskOverlay(liveObj)

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

    // Strip inline Base64 image data from objects to keep payload under Neon's 1MB limit.
    // Remote URLs (http/https) are preserved as-is.
    // If an image only has a Base64 data URL, we skip it to avoid breaking the canvas restore.
    if (json?.objects) {
        // CRITICAL: toJSON() already drops objects with excludeFromExport (the mask/
        // erase overlay sets it), so json.objects is SHORTER than canvas.getObjects().
        // We must zip json.objects against the SAME filtered, same-order live list —
        // otherwise indices shift past the overlay and layers above it get paired with
        // the wrong live object (and silently dropped on save).
        const canvasObjects = (canvas.getObjects?.() || []).filter((o) => !o.excludeFromExport)
        const objectPairs = json.objects
            .map((obj, index) => ({ obj, liveObj: canvasObjects[index] }))
            .filter(({ obj, liveObj }) => !isExpansionFrameLike(obj) && !isMaskOverlayLike(obj, liveObj))

        json.objects = objectPairs.map(({ obj, liveObj: indexedObj }) => {
            if (
                indexedObj?._phosmithAdjustmentOverlay ||
                indexedObj?.phosmithAdjustmentOverlay ||
                indexedObj?.name === 'phosmith-vignette-overlay'
            ) {
                return {
                    ...obj,
                    name: indexedObj.name || 'phosmith-vignette-overlay',
                    phosmithAdjustmentOverlay:
                        indexedObj.phosmithAdjustmentOverlay ||
                        indexedObj._phosmithAdjustmentOverlay ||
                        'vignette',
                    ...(indexedObj.phosmithAdjustmentTargetId || indexedObj._phosmithAdjustmentTargetId
                        ? {
                            phosmithAdjustmentTargetId:
                                indexedObj.phosmithAdjustmentTargetId ||
                                indexedObj._phosmithAdjustmentTargetId,
                        }
                        : {}),
                }
            }

            if (obj.type === 'image' || obj.type === 'Image') {
                const cleaned = { ...obj }
                // Prefer the index-paired live object (indexedObj) so per-image mask/
                // adjust/filter/src data binds to the SAME image it was serialized from.
                // Two images sharing a position would otherwise cross-attach via the
                // positional lookup, which we keep only as a fallback when indexedObj
                // is missing or isn't an image.
                const matchingObj =
                    (indexedObj && (indexedObj.type === 'image' || indexedObj.type === 'Image')
                        ? indexedObj
                        : null) ||
                    canvasObjects.find(
                        (o) =>
                            (o.type === 'image' || o.type === 'Image') &&
                            Math.abs((o.left || 0) - (cleaned.left || 0)) < 0.5 &&
                            Math.abs((o.top || 0) - (cleaned.top || 0)) < 0.5
                    ) ||
                    canvasObjects.find((o) => o.type === 'image' || o.type === 'Image')

                if (matchingObj?.phosmithAdjustValues || matchingObj?._phosmithAdjustValues) {
                    cleaned.phosmithAdjustValues =
                        matchingObj.phosmithAdjustValues || matchingObj._phosmithAdjustValues
                }

                if (matchingObj?.phosmithAdjustmentId || matchingObj?._phosmithAdjustmentId) {
                    cleaned.phosmithAdjustmentId =
                        matchingObj.phosmithAdjustmentId || matchingObj._phosmithAdjustmentId
                }

                if (matchingObj?.phosmithImageKitAdjustBaseSrc || matchingObj?._phosmithImageKitAdjustBaseSrc) {
                    cleaned.phosmithImageKitAdjustBaseSrc =
                        matchingObj.phosmithImageKitAdjustBaseSrc ||
                        matchingObj._phosmithImageKitAdjustBaseSrc
                }

                if (matchingObj?.phosmithImageKitAdjustValues) {
                    cleaned.phosmithImageKitAdjustValues = matchingObj.phosmithImageKitAdjustValues
                }

                if (matchingObj?.phosmithCollageSource || matchingObj?._phosmithCollageSource) {
                    cleaned.phosmithCollageSource =
                        matchingObj.phosmithCollageSource || matchingObj._phosmithCollageSource
                }

                const maskCanvas =
                    matchingObj?._phosmithMaskCanvas ||
                    (matchingObj?.clipPath
                        ? maskCanvasFromClipPath(matchingObj.clipPath, matchingObj.width || cleaned.width || 1, matchingObj.height || cleaned.height || 1)
                        : null)
                const encodedMask = maskCanvas && !isMaskCanvasEmpty(maskCanvas)
                    ? encodeMaskCanvas(maskCanvas)
                    : null
                if (encodedMask) {
                    cleaned.phosmithMask = encodedMask
                    cleaned.phosmithHasMask = true
                    const feather = matchingObj?.phosmithMaskFeather ?? matchingObj?._phosmithMaskFeather
                    if (feather) cleaned.phosmithMaskFeather = feather
                    delete cleaned.clipPath
                } else if (
                    // Detect the mask clip off the LIVE object — toJSON() emits no custom
                    // props, so the serialized clipPath has no marker. Without this a
                    // now-empty mask would leave a full raw-image clipPath in the JSON.
                    matchingObj?.clipPath?.phosmithMaskClipPath ||
                    matchingObj?.clipPath?.name === 'phosmith-mask-clip' ||
                    cleaned.clipPath?.phosmithMaskClipPath ||
                    cleaned.clipPath?.name === 'phosmith-mask-clip'
                ) {
                    delete cleaned.clipPath
                    delete cleaned.phosmithMask
                    delete cleaned.phosmithHasMask
                    delete cleaned.phosmithMaskFeather
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

    // Background image: keep only a remote URL. A data:/blob: background (e.g. the
    // AI-background route's upload-failure fallback) would bloat the payload past
    // Neon's 1 MB cap and break the save, so substitute the live remote src or drop it.
    if (json?.backgroundImage?.src && String(json.backgroundImage.src).startsWith('data:')) {
        const liveBg = canvas.backgroundImage
        const liveSrc = liveBg?._originalElement?.src || liveBg?.getSrc?.() || ''
        if (liveSrc && !String(liveSrc).startsWith('data:') && !String(liveSrc).startsWith('blob:')) {
            json.backgroundImage.src = liveSrc
        } else {
            delete json.backgroundImage
        }
    }

    return {
        canvas: json,
        viewport: getCanvasViewportState(canvas),
        // Persist the "grade background with the photo" intent so it keeps tracking
        // after reload (runtime flag set by the AI Background tool).
        gradeBackground: Boolean(canvas.__phosmithGradeBackground),
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
