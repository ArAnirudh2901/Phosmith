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

    return {
        canvas: canvas.toJSON(),
        viewport: getCanvasViewportState(canvas),
    }
}

export const normalizeCanvasState = (canvasState) => {
    if (!canvasState) return null

    if (canvasState.canvas || canvasState.viewport) {
        return canvasState
    }

    return {
        canvas: canvasState,
        viewport: null,
    }
}