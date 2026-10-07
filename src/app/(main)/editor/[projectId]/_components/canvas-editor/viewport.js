export const MIN_ZOOM = 0.05

export const MAX_ZOOM = 64

export const MIN_PREVIEW_ZOOM_PERCENT = 5

export const MAX_PREVIEW_ZOOM_PERCENT = 300

// Button zoom walks preset stops (Photoshop-style); the slider stays 1% fine.
export const PREVIEW_ZOOM_STOPS = [5, 8, 10, 12, 16, 20, 25, 33, 40, 50, 67, 75, 100, 125, 150, 200, 250, 300]

export const nextPreviewZoomStop = (percent, dir) => {
    const p = Math.round(Number(percent) || 100)
    return dir > 0
        ? PREVIEW_ZOOM_STOPS.find((z) => z > p) ?? MAX_PREVIEW_ZOOM_PERCENT
        : [...PREVIEW_ZOOM_STOPS].reverse().find((z) => z < p) ?? MIN_PREVIEW_ZOOM_PERCENT
}

export const VIEWPORT_PADDING = 32

// How long after the last resize step the deferred chrome catches up. Long enough
// that a drag never crosses it, short enough to read as instant on release.
export const RESIZE_SETTLE_MS = 150

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

export const readPreviewZoomPercent = (canvas) => Math.round((canvas?.getZoom?.() || 1) * 100)

export const fitImageInsideProject = (image, projectSize) => {
    const projectW = Math.max(1, projectSize?.width || image?.width || 1)
    const projectH = Math.max(1, projectSize?.height || image?.height || 1)
    const imageW = Math.max(1, image?.width || projectW)
    const imageH = Math.max(1, image?.height || projectH)
    const scale = Math.min(projectW / imageW, projectH / imageH)

    image.set({
        left: projectW / 2,
        top: projectH / 2,
        originX: "center",
        originY: "center",
        scaleX: scale,
        scaleY: scale,
        selectable: true,
        evented: true,
    })
    image.setCoords()
}
