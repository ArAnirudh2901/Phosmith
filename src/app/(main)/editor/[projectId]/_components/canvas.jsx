"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import { useCanvas } from "../../../../../../context/context"
import { useDatabaseMutation } from "../../../../../../hooks/useDatabaseQuery"
import { api } from "@/lib/neon-api";
import { Hand, Maximize2, ZoomIn, ZoomOut } from "lucide-react"
import {
    Canvas,
    FabricImage,
    InteractiveFabricObject,
    Point,
    config as fabricConfig,
} from "fabric"
// Side-effect import: registers PixxelCurves filter in Fabric's classRegistry so
// loadFromJSON can rehydrate saved canvas state that contains it.
import "../../../../../lib/curves-filter"

// Force the Canvas2D filter backend instead of WebGL. The custom curves LUT filter
// has a WebGL fragment-shader path that worked in isolation but had subtle issues
// in real filter chains (corrupted source texture state on some images, leading to
// black canvases and other downstream filters not visibly applying). 2D is slower
// for large images but correct in every chain shape.
if (typeof window !== "undefined" && fabricConfig) {
    fabricConfig.enableGLFiltering = false
}

// Neo-brutalist defaults for selected-object controls (corners, border, padding,
// rotation handle). Fabric reads InteractiveFabricObject.ownDefaults at object
// construction, so this needs to run before any FabricImage / Rect / etc. is
// created — at module init, before Canvas mounts.
if (typeof window !== "undefined" && InteractiveFabricObject?.ownDefaults) {
    InteractiveFabricObject.ownDefaults = {
        ...InteractiveFabricObject.ownDefaults,
        // Square cyan corners with a hard cream stroke — same palette as the
        // editor's Projects header, preview controls, and resolution HUD.
        cornerStyle: "rect",
        cornerColor: "#06B8D4",
        cornerStrokeColor: "#F4F4F5",
        cornerSize: 11,
        touchCornerSize: 22,
        transparentCorners: false,
        cornerDashArray: null,
        // Solid cream marquee border with a slight float-off-the-image padding.
        // Thicker than default so it reads at any zoom.
        borderColor: "#F4F4F5",
        borderScaleFactor: 1.6,
        borderDashArray: null,
        borderOpacityWhenMoving: 0.9,
        padding: 6,
    }
}
import { normalizeCanvasState, serializeCanvasState } from "../../../../../lib/canvas-state"
import { hydrateCanvasImages, restoreCanvasFromHistory } from "../../../../../lib/canvas-history"
import { isExpansionFrameLike, removeExpansionFramesFromCanvas } from "../../../../../lib/expansion-pipeline"
import { addImageFilesToCanvas } from "../../../../../lib/canvas-images"
import {
    createDebouncedFlusher,
    fetchCachedSnapshot,
    flushToNeon,
    snapshotToCache,
} from "../../../../../lib/canvas-cache"
import { isPixxelMaskOverlay } from "../../../../../lib/canvas-mask"
import { syncBackgroundGrade } from "../../../../../lib/canvas-background"
import AuroraLoader from "./AuroraLoader"

const MIN_ZOOM = 0.05
const MAX_ZOOM = 64
const MIN_PREVIEW_ZOOM_PERCENT = 5
const MAX_PREVIEW_ZOOM_PERCENT = 300
const PREVIEW_ZOOM_STEP_PERCENT = 1
const VIEWPORT_PADDING = 32
const MAX_PERSISTED_HISTORY = 30
const MAX_NEON_STATE_CHARS = 900_000
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
const readPreviewZoomPercent = (canvas) => Math.round((canvas?.getZoom?.() || 1) * 100)
const getPrimaryRemoteImageUrl = (canvas) => {
    const image = canvas
        ?.getObjects?.()
        ?.find((object) => object?.type?.toLowerCase() === 'image')
    const src =
        image?.getSrc?.() ||
        image?._originalElement?.src ||
        image?._element?.src ||
        image?.src ||
        ''

    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return null
    return src.startsWith('http') ? src : null
}

const fitImageInsideProject = (image, projectSize) => {
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

const CanvasEditor = ({ project }) => {
    const [isLoading, setIsLoading] = useState(true)
    const canvasRef = useRef()
    const containerRef = useRef()
    const canvasInstanceRef = useRef(null)
    const isPanningRef = useRef(false)
    const ctrlPressedRef = useRef(false)
    const spacePressedRef = useRef(false)
    const handToolActiveRef = useRef(false)
    const [isHandToolActive, setIsHandToolActive] = useState(false)
    const [isProjectFrameVisible, setIsProjectFrameVisible] = useState(false)
    const [previewZoomPercent, setPreviewZoomPercent] = useState(100)
    const projectFrameStyleRef = useRef({ left: 0, top: 0, width: 0, height: 0 })
    const [projectFrameStyle, setProjectFrameStyle] = useState({ left: 0, top: 0, width: 0, height: 0 })
    const [imageNativeSize, setImageNativeSize] = useState(null)
    const lastPointerRef = useRef(null)
    const historyRef = useRef([])
    const historyIndexRef = useRef(-1)
    const isRestoringRef = useRef(false)
    const resizeFrameRef = useRef(null)
    const initGenerationRef = useRef(0)
    const previewZoomPercentRef = useRef(100)
    const projectRef = useRef(project)
    projectRef.current = project

    const { canvasEditor, setCanvasEditor, activeTool, expansionPreview, processingMessage } = useCanvas()
    // Hide the floating canvas chrome (zoom bar, hand tool, resolution HUD) any
    // time we're showing a full-screen processing overlay or the initial canvas
    // loader. Otherwise those controls bleed through the blurred background.
    const isBusy = Boolean(processingMessage) || isLoading
    const activeToolRef = useRef(activeTool)
    activeToolRef.current = activeTool
    const { mutate: updateProject } = useDatabaseMutation(api.projects.updateProject)

    const disposeCanvasInstance = useCallback(() => {
        const existing = canvasInstanceRef.current
        if (existing) {
            existing.__cleanupInfiniteWorkspace?.()
            try {
                existing.dispose()
            } catch {
                /* already disposed */
            }
            canvasInstanceRef.current = null
        }
        setCanvasEditor(null)
    }, [setCanvasEditor])

    const getContainerSize = () => {
        if (typeof window === 'undefined' || !containerRef.current) return { width: 0, height: 0 }
        return { width: containerRef.current.clientWidth, height: containerRef.current.clientHeight }
    }

    const getViewportState = (canvas) => {
        const viewportTransform = canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
        const zoom = viewportTransform[0] || 1
        return {
            zoom,
            center: { x: (canvas.getWidth() / 2 - viewportTransform[4]) / zoom, y: (canvas.getHeight() / 2 - viewportTransform[5]) / zoom },
        }
    }

    const setViewportState = (canvas, viewportState, fallbackCenter) => {
        const zoom = clamp(viewportState?.zoom || 1, MIN_ZOOM, MAX_ZOOM)
        const center = viewportState?.center || fallbackCenter
        if (!center) return
        canvas.setViewportTransform([zoom, 0, 0, zoom, canvas.getWidth() / 2 - center.x * zoom, canvas.getHeight() / 2 - center.y * zoom])
    }

    const syncPreviewZoomState = (canvas) => {
        const nextPercent = readPreviewZoomPercent(canvas)
        if (previewZoomPercentRef.current === nextPercent) return
        previewZoomPercentRef.current = nextPercent
        setPreviewZoomPercent(nextPercent)
    }

    const setCanvasPreviewZoom = (canvas, percent) => {
        if (!canvas) return
        const viewportState = getViewportState(canvas)
        setViewportState(canvas, {
            ...viewportState,
            zoom: clamp(Number(percent) / 100, MIN_ZOOM, MAX_ZOOM),
        })
        canvas.calcOffset()
        canvas.requestRenderAll()
        syncPreviewZoomState(canvas)
    }

    const fitProjectToViewport = (canvas, size = project) => {
        const canvasW = canvas.getWidth()
        const canvasH = canvas.getHeight()
        const projectW = Math.max(1, size?.width || project?.width || 1)
        const projectH = Math.max(1, size?.height || project?.height || 1)
        if (!canvasW || !canvasH || !projectW || !projectH) return

        // Use 92% of canvas area as the safe zone. This gives a tighter fit
        // on small screens (13" MacBook Air) while still having breathing room.
        // The fixed VIEWPORT_PADDING acts as a minimum margin.
        const safeW = Math.max(canvasW * 0.92, canvasW - VIEWPORT_PADDING * 2, 1)
        const safeH = Math.max(canvasH * 0.92, canvasH - VIEWPORT_PADDING * 2, 1)
        const fitZoom = Math.min(safeW / projectW, safeH / projectH)
        setViewportState(canvas, {
            zoom: clamp(fitZoom || 1, MIN_ZOOM, MAX_ZOOM),
            center: { x: projectW / 2, y: projectH / 2 },
        })
    }

    const createInitialViewport = (canvas) => fitProjectToViewport(canvas)

    const emitHistoryChange = (canvas) => {
        if (!canvas) return
        canvas.fire('history:changed', {
            canUndo: historyIndexRef.current > 0,
            canRedo: historyIndexRef.current < historyRef.current.length - 1,
            index: historyIndexRef.current,
            length: historyRef.current.length,
        })
    }

    const pushHistoryState = useCallback((canvas) => {
        if (!canvas || isRestoringRef.current) return
        const nextState = serializeCanvasState(canvas)
        if (!nextState?.canvas) return
        const nextSignature = JSON.stringify(nextState)
        const currentState = historyRef.current[historyIndexRef.current]
        const currentSignature = currentState ? JSON.stringify(currentState) : null
        if (nextSignature === currentSignature) return
        historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1)
        historyRef.current.push(nextState)
        while (historyRef.current.length > MAX_PERSISTED_HISTORY) {
            historyRef.current.shift()
            historyIndexRef.current = Math.max(0, historyIndexRef.current - 1)
        }
        historyIndexRef.current = historyRef.current.length - 1
        emitHistoryChange(canvas)
    }, [])

    const restoreCanvasState = useCallback(async (canvas, state) => {
        if (!canvas || !state) return
        const proj = projectRef.current
        isRestoringRef.current = true
        try {
            const imageUrl = proj?.currentImageUrl || proj?.originalImageUrl
            await restoreCanvasFromHistory(canvas, state, {
                imageUrl,
                setViewportState,
                fallbackCenter: { x: proj.width / 2, y: proj.height / 2 },
            })
        } finally {
            isRestoringRef.current = false
            emitHistoryChange(canvas)
        }
    }, [])

    const undoCanvasState = useCallback(async () => {
        const canvas = canvasInstanceRef.current
        if (!canvas || historyIndexRef.current <= 0) return false
        historyIndexRef.current -= 1
        await restoreCanvasState(canvas, historyRef.current[historyIndexRef.current])
        return true
    }, [restoreCanvasState])

    const redoCanvasState = useCallback(async () => {
        const canvas = canvasInstanceRef.current
        if (!canvas || historyIndexRef.current >= historyRef.current.length - 1) return false
        historyIndexRef.current += 1
        await restoreCanvasState(canvas, historyRef.current[historyIndexRef.current])
        return true
    }, [restoreCanvasState])

    // Write-behind cache flusher, lazily created per project. Holds its debounce
    // timer in closure state. We never let two flushers exist for the same project
    // simultaneously — see the useEffect below that recreates it when projectId
    // changes.
    const flusherRef = useRef(null)

    const saveCanvasState = useCallback(async ({ rethrow = false, immediate = false } = {}) => {
        const canvas = canvasInstanceRef.current
        const proj = projectRef.current
        if (!canvas || !proj) return

        const canvasJSON = serializeCanvasState(canvas)
        const currentImageUrl = getPrimaryRemoteImageUrl(canvas)
        let fullState = {
            ...canvasJSON,
            history: historyRef.current.slice(-MAX_PERSISTED_HISTORY),
            historyIndex: historyIndexRef.current,
        }
        if (fullState.history.length > 0 && JSON.stringify(fullState).length > MAX_NEON_STATE_CHARS) {
            fullState = {
                ...canvasJSON,
                history: [],
                historyIndex: -1,
            }
        }

        // Strategy:
        //   - Always write to the server cache first (fast in-memory store, no DB hit).
        //   - For autosave (default): schedule a debounced flush to Neon. Lots of
        //     edits coalesce into one DB write.
        //   - For manual Save or `immediate: true` / `rethrow: true`: flush right
        //     now so the user gets a hard guarantee the state is persisted.
        //   - If the cache write fails for any reason, fall back to direct Neon
        //     so no edit is ever lost.
        const cached = await snapshotToCache(proj._id, fullState, currentImageUrl)

        const writeDirect = async () => {
            await updateProject({
                projectId: proj._id,
                canvasState: fullState,
                ...(currentImageUrl ? { currentImageUrl } : {}),
            })
        }

        try {
            if (!cached) {
                // Cache unavailable — fall back to the legacy direct-write path.
                await writeDirect()
                return
            }

            if (immediate || rethrow) {
                // Manual Save or explicit immediate request: flush the cached state
                // through to Neon right now and wait for the result.
                const flushed = await flushToNeon(proj._id)
                if (!flushed && rethrow) {
                    // Cache had nothing new to flush OR flush failed — write
                    // directly so the user's Save-button click isn't a no-op.
                    await writeDirect()
                }
                flusherRef.current?.cancel()
            } else {
                // Autosave: defer the DB write. Coalesces N rapid edits into 1
                // mutation after ~8s of idle (or sooner on critical events).
                flusherRef.current?.schedule()
            }
        } catch (error) {
            console.error("Error saving canvas state ", error)
            // Best-effort recovery: try direct write before bubbling up.
            try { await writeDirect() } catch (fallbackError) {
                if (rethrow) throw fallbackError
                return
            }
            if (rethrow) throw error
        }
    }, [updateProject])

    // Manage one debounced flusher per project. On unmount or projectId change,
    // flush any pending writes synchronously (best-effort) so the next editor
    // session doesn't see stale data.
    useEffect(() => {
        const projectId = project?._id
        if (!projectId) return
        const flusher = createDebouncedFlusher(projectId, 8000)
        flusherRef.current = flusher
        return () => {
            flusher.flushNow()
            if (flusherRef.current === flusher) flusherRef.current = null
        }
    }, [project?._id])

    // beforeunload + pagehide: force-flush the cache to Neon before the user
    // navigates away. `keepalive` lets the fetch survive the page unloading.
    useEffect(() => {
        const projectId = project?._id
        if (!projectId) return
        const handler = () => {
            try { flusherRef.current?.cancel() } catch { /* ignore */ }
            // Fire and forget. The browser will let this request finish even
            // though the page is going away thanks to keepalive.
            flushToNeon(projectId, { keepalive: true })
        }
        window.addEventListener("beforeunload", handler)
        window.addEventListener("pagehide", handler)
        return () => {
            window.removeEventListener("beforeunload", handler)
            window.removeEventListener("pagehide", handler)
        }
    }, [project?._id])

    useEffect(() => {
        if (!canvasRef.current || !project) return

        const initGen = ++initGenerationRef.current
        let mounted = true

        disposeCanvasInstance()
        historyRef.current = []
        historyIndexRef.current = -1

        const initializeCanvas = async () => {
            if (initGen !== initGenerationRef.current || !mounted) return

            setIsLoading(true)
            const { width, height } = getContainerSize()
            const el = canvasRef.current
            if (!el) return

            const canvas = new Canvas(el, {
                width: width || project.width, height: height || project.height,
                backgroundColor: "transparent",
                preserveObjectStacking: true, controlsAboveOverlay: true, selection: true,
                hoverCursor: "move", moveCursor: "move", defaultCursor: "default",
                allowTouchScrolling: false, renderOnAddRemove: false, skipTargetFind: false,
            })

            if (initGen !== initGenerationRef.current || !mounted) {
                canvas.dispose()
                return
            }

            canvasInstanceRef.current = canvas
            canvas.setDimensions({ width: width || project.width, height: height || project.height }, { backstoreOnly: false })

            // Read-through: if the server cache has a newer snapshot than what's
            // in Neon (because a previous session ended with pending debounced
            // writes that haven't been flushed yet), prefer that. Otherwise the
            // user would see an old version of their work after a reload.
            let rawCanvasState = project.canvasState
            let effectiveCurrentImageUrl = project.currentImageUrl
            try {
                const cachedSnapshot = await fetchCachedSnapshot(project._id)
                if (cachedSnapshot?.canvasState) {
                    const projectUpdatedAt = Number(project.updatedAt) || 0
                    const cachedUpdatedAt = Number(cachedSnapshot.updatedAt) || 0
                    if (cachedUpdatedAt > projectUpdatedAt) {
                        rawCanvasState = cachedSnapshot.canvasState
                        if (cachedSnapshot.currentImageUrl) {
                            effectiveCurrentImageUrl = cachedSnapshot.currentImageUrl
                        }
                    }
                }
            } catch (cacheError) {
                console.warn("[canvas] cached snapshot lookup failed:", cacheError?.message || cacheError)
            }

            const canvasState = normalizeCanvasState(rawCanvasState)
            const persistedHistory = Array.isArray(rawCanvasState?.history) ? rawCanvasState.history : null
            let hasRestoredViewport = false

            if (!canvasState && (effectiveCurrentImageUrl || project.originalImageUrl)) {
                try {
                    const imageUrl = effectiveCurrentImageUrl || project.originalImageUrl
                    const fabricImage = await FabricImage.fromURL(imageUrl, { crossOrigin: "anonymous" })
                    fitImageInsideProject(fabricImage, project)
                    canvas.add(fabricImage)
                } catch (error) { console.error("Error loading project image:", error) }
            }

            if (canvasState) {
                let loadedFromState = false
                try {
                    await canvas.loadFromJSON(canvasState.canvas || canvasState)
                    // Restore the "grade background" intent so it keeps tracking after reload.
                    canvas.__pixxelGradeBackground = Boolean(canvasState.gradeBackground)
                    removeExpansionFramesFromCanvas(canvas)
                    if (canvasState.viewport) { setViewportState(canvas, canvasState.viewport, { x: project.width / 2, y: project.height / 2 }); hasRestoredViewport = true }
                    const imageUrl = effectiveCurrentImageUrl || project.originalImageUrl
                    await hydrateCanvasImages(canvas, imageUrl, {
                        forcePrimaryImageUrl: true,
                        canvasSize: { width: project.width, height: project.height },
                    })
                    for (const obj of canvas.getObjects()) {
                        if (obj?.type?.toLowerCase() === 'image' && obj.filters?.length) {
                            try {
                                obj.applyFilters?.()
                            } catch (filterError) {
                                // Silently swallowing here once hid a real curves regression
                                // for hours. Keep going (don't break the load) but log so
                                // the next failure is diagnosable.
                                console.error('[canvas] applyFilters failed for image:', filterError)
                            }
                        }
                    }
                    canvas.requestRenderAll()
                    loadedFromState = canvas.getObjects().length > 0
                } catch (error) { console.error("Error loading canvas state: ", error) }

                // Fallback: if loadFromJSON threw or produced an empty canvas (e.g. a
                // saved filter type Fabric can no longer enliven), still show the project
                // image so the user doesn't stare at a blank canvas.
                if (!loadedFromState) {
                    const imageUrl = effectiveCurrentImageUrl || project.originalImageUrl
                    if (imageUrl && canvas.getObjects().length === 0) {
                        try {
                            const fallbackImage = await FabricImage.fromURL(imageUrl, { crossOrigin: "anonymous" })
                            fitImageInsideProject(fallbackImage, project)
                            canvas.add(fallbackImage)
                            canvas.requestRenderAll()
                        } catch (error) { console.error("Fallback image load failed:", error) }
                    }
                }
            }

            if (!hasRestoredViewport) createInitialViewport(canvas)
            if (initGen !== initGenerationRef.current || !mounted) {
                canvas.dispose()
                canvasInstanceRef.current = null
                return
            }

            canvas.renderOnAddRemove = true
            canvas.calcOffset()
            canvas.requestRenderAll()
            setCanvasEditor(canvas)

            const isExpansionMode = () =>
                activeToolRef.current === 'ai_extender' ||
                Boolean(canvas.__expansionMode)

            const isTypingTarget = (target) => {
                if (!target) return false
                const tag = target.tagName
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
                if (target.isContentEditable) return true
                return false
            }

            const isPanModifierActive = () =>
                spacePressedRef.current ||
                handToolActiveRef.current

            const isMiddleButtonDrag = (event) =>
                event?.button === 1 ||
                event?.buttons === 4

            const shouldStartPan = (opt) => {
                if (isExpansionMode()) return false
                const event = opt?.e
                if (isMiddleButtonDrag(event)) return true
                if (opt?.target) return false
                return isPanModifierActive()
            }

            const applyCursorForMode = () => {
                if (isExpansionMode()) {
                    canvas.skipTargetFind = false
                    canvas.defaultCursor = 'default'
                    canvas.hoverCursor = 'default'
                    canvas.moveCursor = 'default'
                    canvas.upperCanvasEl.style.cursor = 'default'
                    return
                }
                const wantsPan = isPanModifierActive()
                canvas.skipTargetFind = false
                canvas.defaultCursor = wantsPan ? 'grab' : 'default'
                canvas.hoverCursor = 'move'
                canvas.moveCursor = 'move'
                canvas.upperCanvasEl.style.cursor = wantsPan ? 'grab' : 'default'
            }

            const endPanning = () => {
                isPanningRef.current = false
                lastPointerRef.current = null
                applyCursorForMode()
            }

            const resetPanInputState = ({ resetHandTool = false } = {}) => {
                isPanningRef.current = false
                lastPointerRef.current = null
                ctrlPressedRef.current = false
                spacePressedRef.current = false
                if (resetHandTool) {
                    handToolActiveRef.current = false
                    setIsHandToolActive(false)
                }
                applyCursorForMode()
            }

            const handleKeyDown = (event) => {
                if (isExpansionMode()) return
                if (event.key === ' ' && !event.repeat && !isTypingTarget(event.target)) {
                    spacePressedRef.current = true
                    applyCursorForMode()
                    event.preventDefault()
                    return
                }
                if (event.key === 'Control' && !event.repeat) {
                    ctrlPressedRef.current = true
                }
            }
            const handleKeyUp = (event) => {
                if (event.key === ' ') {
                    spacePressedRef.current = false
                    endPanning()
                    return
                }
                if (event.key === 'Control') {
                    ctrlPressedRef.current = false
                }
            }
            const handleMouseDown = (opt) => {
                if (shouldStartPan(opt)) {
                    isPanningRef.current = true
                    lastPointerRef.current = { x: opt.e.clientX, y: opt.e.clientY }
                    // Cursor is a DOM style change (no canvas render needed). The
                    // viewport hasn't moved yet, so a render here would paint nothing
                    // new — the first mouse:move pans and renders.
                    canvas.upperCanvasEl.style.cursor = 'grabbing'
                    opt.e.preventDefault()
                    opt.e.stopPropagation()
                }
            }
            const handleMouseMove = (opt) => {
                if (isExpansionMode() || !isPanningRef.current || !lastPointerRef.current) return
                const deltaX = opt.e.clientX - lastPointerRef.current.x
                const deltaY = opt.e.clientY - lastPointerRef.current.y
                canvas.relativePan(new Point(deltaX, deltaY))
                lastPointerRef.current = { x: opt.e.clientX, y: opt.e.clientY }
                canvas.requestRenderAll()
            }
            const handleMouseUp = () => {
                if (isExpansionMode()) return
                endPanning()
            }
            canvas.__setHandToolActive = (active) => {
                handToolActiveRef.current = Boolean(active)
                applyCursorForMode()
            }
            canvas.__syncPanCursor = applyCursorForMode
            const handleMouseWheel = (opt) => {
                if (isExpansionMode()) return
                if (!(opt.e.ctrlKey || ctrlPressedRef.current)) return
                opt.e.preventDefault()
                const zoom = clamp(canvas.getZoom() * Math.pow(0.999, opt.e.deltaY), MIN_ZOOM, MAX_ZOOM)
                const pointer = canvas.getViewportPoint(opt.e)
                canvas.zoomToPoint(new Point(pointer.x, pointer.y), zoom)
                canvas.requestRenderAll()
            }
            const handleWindowPointerUp = () => endPanning()
            const handleWindowBlur = () => resetPanInputState({ resetHandTool: true })
            const handleVisibilityChange = () => {
                if (document.visibilityState === 'hidden') {
                    resetPanInputState({ resetHandTool: true })
                }
            }

            window.addEventListener('keydown', handleKeyDown)
            window.addEventListener('keyup', handleKeyUp)
            window.addEventListener('pointerup', handleWindowPointerUp)
            window.addEventListener('blur', handleWindowBlur)
            document.addEventListener('visibilitychange', handleVisibilityChange)
            canvas.on('mouse:down', handleMouseDown)
            canvas.on('mouse:move', handleMouseMove)
            canvas.on('mouse:up', handleMouseUp)
            canvas.on('mouse:wheel', handleMouseWheel)

            canvas.__cleanupInfiniteWorkspace = () => {
                window.removeEventListener('keydown', handleKeyDown)
                window.removeEventListener('keyup', handleKeyUp)
                window.removeEventListener('pointerup', handleWindowPointerUp)
                window.removeEventListener('blur', handleWindowBlur)
                document.removeEventListener('visibilitychange', handleVisibilityChange)
                canvas.off('mouse:down', handleMouseDown)
                canvas.off('mouse:move', handleMouseMove)
                canvas.off('mouse:up', handleMouseUp)
                canvas.off('mouse:wheel', handleMouseWheel)
                canvas.off('after:render', syncViewportChrome)
                delete canvas.__syncPanCursor
            }
            canvas.__undoCanvasState = () => undoCanvasState()
            canvas.__redoCanvasState = () => redoCanvasState()
            canvas.__pushHistoryState = () => pushHistoryState(canvas)
            canvas.__saveCanvasState = (opts) => saveCanvasState(opts)
            canvas.__getHistoryState = () => ({
                canUndo: historyIndexRef.current > 0,
                canRedo: historyIndexRef.current < historyRef.current.length - 1,
            })
            canvas.__fitCanvasToProject = (size) => {
                fitProjectToViewport(canvas, size)
                canvas.calcOffset()
                canvas.requestRenderAll()
                syncProjectFrame()
                syncPreviewZoomState(canvas)
            }
            canvas.__resetCanvasView = () => {
                fitProjectToViewport(canvas)
                canvas.calcOffset()
                canvas.requestRenderAll()
                syncProjectFrame()
                syncPreviewZoomState(canvas)
            }
            canvas.__setPreviewZoom = (percent) => setCanvasPreviewZoom(canvas, percent)
            canvas.__getPreviewZoom = () => readPreviewZoomPercent(canvas)

            const syncProjectFrame = () => {
                const proj = projectRef.current
                if (!proj?.width || !proj?.height) {
                    if (projectFrameStyleRef.current.width !== 0) {
                        projectFrameStyleRef.current = { left: 0, top: 0, width: 0, height: 0 }
                        setProjectFrameStyle(projectFrameStyleRef.current)
                        setIsProjectFrameVisible(false)
                    }
                    return
                }
                const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
                const zoom = vpt[0] || 1
                const left = vpt[4]
                const top = vpt[5]
                const width = proj.width * zoom
                const height = proj.height * zoom
                const previous = projectFrameStyleRef.current
                if (
                    previous.left === left &&
                    previous.top === top &&
                    previous.width === width &&
                    previous.height === height
                ) return
                projectFrameStyleRef.current = { left, top, width, height }
                setProjectFrameStyle(projectFrameStyleRef.current)
                setIsProjectFrameVisible(true)
            }
            canvas.__syncProjectFrame = syncProjectFrame
            const syncViewportChrome = () => {
                syncProjectFrame()
                syncPreviewZoomState(canvas)
            }
            canvas.on('after:render', syncViewportChrome)
            syncViewportChrome()

            if (persistedHistory?.length) {
                historyRef.current = persistedHistory.slice(-MAX_PERSISTED_HISTORY)
                historyIndexRef.current = Math.min(
                    Math.max(0, rawCanvasState.historyIndex ?? historyRef.current.length - 1),
                    historyRef.current.length - 1
                )
            } else {
                pushHistoryState(canvas)
            }
            emitHistoryChange(canvas)
            setIsLoading(false)
        }

        initializeCanvas()
        return () => {
            mounted = false
            initGenerationRef.current += 1
            disposeCanvasInstance()
        }
    }, [project?._id, disposeCanvasInstance])

    useEffect(() => {
        const canvas = canvasInstanceRef.current
        if (!canvas) return
        canvas.__undoCanvasState = () => undoCanvasState()
        canvas.__redoCanvasState = () => redoCanvasState()
        canvas.__pushHistoryState = () => pushHistoryState(canvas)
        canvas.__saveCanvasState = () => saveCanvasState()
        canvas.__getHistoryState = () => ({
            canUndo: historyIndexRef.current > 0,
            canRedo: historyIndexRef.current < historyRef.current.length - 1,
        })
    }, [canvasEditor, undoCanvasState, redoCanvasState, pushHistoryState, saveCanvasState])

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

    useEffect(() => {
        if (!canvasEditor) return
        const readPrimaryImageSize = () => {
            const objects = canvasEditor.getObjects?.() || []
            const image = objects.find((obj) => obj?.type?.toLowerCase() === 'image')
            if (!image) {
                setImageNativeSize(null)
                return
            }
            const w = Math.round(image._originalElement?.naturalWidth || image.width || 0)
            const h = Math.round(image._originalElement?.naturalHeight || image.height || 0)
            if (!w || !h) {
                setImageNativeSize(null)
                return
            }
            setImageNativeSize((prev) => (prev?.width === w && prev?.height === h ? prev : { width: w, height: h }))
        }
        readPrimaryImageSize()
        canvasEditor.on('object:added', readPrimaryImageSize)
        canvasEditor.on('object:removed', readPrimaryImageSize)
        canvasEditor.on('object:modified', readPrimaryImageSize)
        return () => {
            canvasEditor.off('object:added', readPrimaryImageSize)
            canvasEditor.off('object:removed', readPrimaryImageSize)
            canvasEditor.off('object:modified', readPrimaryImageSize)
        }
    }, [canvasEditor])

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

            const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'))
            if (files.length === 0) return

            await addImageFilesToCanvas(canvas, files, project)
        }

        container.addEventListener('dragover', handleDragOver)
        container.addEventListener('drop', handleDrop)
        return () => {
            container.removeEventListener('dragover', handleDragOver)
            container.removeEventListener('drop', handleDrop)
        }
    }, [canvasEditor, project?.width, project?.height])

    useEffect(() => {
        if (!canvasEditor) return
        let saveTimeout
        let historyTimeout

        const scheduleHistoryPush = () => {
            clearTimeout(historyTimeout)
            historyTimeout = setTimeout(() => pushHistoryState(canvasEditor), 0)
        }

        const handleCanvasChange = (event) => {
            if (isExpansionFrameLike(event?.target)) return
            if (isPixxelMaskOverlay(event?.target)) return
            // When "color grade background" is on, mirror the photo's grade onto the
            // canvas background. Gated to image edits (skip text/shape moves) and to
            // when a background actually exists; change-detected inside.
            if (
                canvasEditor.__pixxelGradeBackground &&
                canvasEditor.backgroundImage &&
                event?.target?.type?.toLowerCase?.() === 'image'
            ) {
                try { syncBackgroundGrade(canvasEditor, true) } catch { /* ignore */ }
            }
            scheduleHistoryPush()
            clearTimeout(saveTimeout)
            saveTimeout = setTimeout(() => { saveCanvasState() }, 2000)
        }

        canvasEditor.on("object:modified", handleCanvasChange)
        canvasEditor.on("object:added", handleCanvasChange)
        canvasEditor.on("object:removed", handleCanvasChange)
        canvasEditor.on("text:changed", handleCanvasChange)

        return () => {
            clearTimeout(saveTimeout)
            clearTimeout(historyTimeout)
            canvasEditor.off("object:modified", handleCanvasChange)
            canvasEditor.off("object:added", handleCanvasChange)
            canvasEditor.off("object:removed", handleCanvasChange)
            canvasEditor.off("text:changed", handleCanvasChange)
        }
    }, [canvasEditor, project?._id, pushHistoryState])

    useEffect(() => {
        const handleResize = () => {
            if (resizeFrameRef.current) cancelAnimationFrame(resizeFrameRef.current)
            resizeFrameRef.current = requestAnimationFrame(() => {
                resizeFrameRef.current = null
                const canvas = canvasInstanceRef.current
                if (!canvas || !project || !containerRef.current) return

                const prevWidth = canvas.getWidth()
                const prevHeight = canvas.getHeight()
                const nextWidth = containerRef.current.clientWidth
                const nextHeight = containerRef.current.clientHeight
                if (!nextWidth || !nextHeight) return

                if (prevWidth === nextWidth && prevHeight === nextHeight) {
                    canvas.calcOffset()
                    return
                }

                // Capture the current viewport state BEFORE resizing the canvas
                // element so we can preserve the user's pan position and scale
                // the zoom proportionally to the container size change. This
                // avoids the jarring snap-to-fit that __fitCanvasToProject does.
                const currentViewport = getViewportState(canvas)
                const scaleRatio = Math.min(
                    nextWidth / (prevWidth || 1),
                    nextHeight / (prevHeight || 1),
                )

                canvas.setDimensions({ width: nextWidth, height: nextHeight }, { backstoreOnly: false })

                // Scale zoom proportionally but keep the same logical center
                // point. The effect is a smooth proportional resize rather than
                // a full recomputation from project dimensions.
                const adjustedZoom = clamp(
                    currentViewport.zoom * scaleRatio,
                    MIN_ZOOM,
                    MAX_ZOOM,
                )
                setViewportState(canvas, {
                    zoom: adjustedZoom,
                    center: currentViewport.center,
                })
                canvas.calcOffset()
                canvas.requestRenderAll()

                // Sync the project frame overlay and the zoom percentage HUD
                if (typeof canvas.__syncProjectFrame === 'function') {
                    canvas.__syncProjectFrame()
                }
                syncPreviewZoomState(canvas)
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
        }
    }, [project?.width, project?.height])

    useEffect(() => {
        const canvas = canvasInstanceRef.current
        if (!canvas || !project?.width || !project?.height) return
        fitProjectToViewport(canvas)
        canvas.calcOffset()
        canvas.requestRenderAll()
    }, [project?.width, project?.height])

    const previewSliderValue = clamp(previewZoomPercent, MIN_PREVIEW_ZOOM_PERCENT, MAX_PREVIEW_ZOOM_PERCENT)
    const canAdjustPreview = Boolean(canvasEditor)

    const applyPreviewZoomPercent = (percent) => {
        const nextPercent = clamp(Number(percent) || 100, MIN_PREVIEW_ZOOM_PERCENT, MAX_PREVIEW_ZOOM_PERCENT)
        setCanvasPreviewZoom(canvasInstanceRef.current, nextPercent)
    }

    const adjustPreviewZoomPercent = (delta) => {
        applyPreviewZoomPercent(previewZoomPercentRef.current + delta)
    }

    const handlePreviewZoomChange = (event) => {
        applyPreviewZoomPercent(event.target.value)
    }

    const stopPreviewControlPropagation = (event) => {
        event.stopPropagation()
    }

    return (
        <div ref={containerRef} className='relative h-full min-h-0 w-full overflow-hidden editor-canvas-host'>
            {/* Dot grid */}
            <div className='absolute inset-0 pointer-events-none editor-canvas-grid' />

            {isProjectFrameVisible && !isBusy && (
                <div
                    className="editor-canvas-project-texture pointer-events-none absolute"
                    style={{
                        left: `${projectFrameStyle.left}px`,
                        top: `${projectFrameStyle.top}px`,
                        width: `${projectFrameStyle.width}px`,
                        height: `${projectFrameStyle.height}px`,
                    }}
                />
            )}

            <div className='absolute inset-0 editor-canvas-fabric-layer'>
                <canvas id='canvas' className='rounded-xl editor-canvas-surface' ref={canvasRef} />
            </div>

            {!isBusy && (
                <button
                    type="button"
                    onClick={toggleHandTool}
                    className="editor-icon-button absolute z-10 flex items-center justify-center"
                    style={{
                        bottom: 16,
                        right: 16,
                        width: 36,
                        height: 36,
                        background: isHandToolActive ? 'var(--accent-primary)' : 'var(--bg-elevated)',
                        color: isHandToolActive ? '#03050A' : 'var(--text-primary)',
                        borderColor: isHandToolActive ? 'var(--accent-primary)' : 'var(--border-default)',
                    }}
                    title={isHandToolActive ? 'Hand tool on — click to exit (H or Space)' : 'Hand tool — pan the canvas (H or hold Space)'}
                    aria-pressed={isHandToolActive}
                >
                    <Hand className="h-4 w-4" />
                </button>
            )}

            {isProjectFrameVisible && !isBusy && (
                <div
                    className="editor-canvas-project-frame pointer-events-none absolute"
                    style={{
                        left: `${projectFrameStyle.left}px`,
                        top: `${projectFrameStyle.top}px`,
                        width: `${projectFrameStyle.width}px`,
                        height: `${projectFrameStyle.height}px`,
                    }}
                />
            )}

            <div
                className="editor-canvas-preview-controls"
                aria-label="Preview size"
                onPointerDown={stopPreviewControlPropagation}
                onMouseDown={stopPreviewControlPropagation}
                hidden={isBusy}
                style={isBusy ? { display: 'none' } : undefined}
            >
                <button
                    type="button"
                    className="editor-canvas-preview-button"
                    onClick={() => adjustPreviewZoomPercent(-PREVIEW_ZOOM_STEP_PERCENT)}
                    disabled={!canAdjustPreview}
                    title="Shrink preview"
                    aria-label="Shrink preview"
                >
                    <ZoomOut className="h-3.5 w-3.5" />
                </button>
                <input
                    className="editor-canvas-preview-slider"
                    type="range"
                    min={MIN_PREVIEW_ZOOM_PERCENT}
                    max={MAX_PREVIEW_ZOOM_PERCENT}
                    step="1"
                    value={previewSliderValue}
                    onChange={handlePreviewZoomChange}
                    disabled={!canAdjustPreview}
                    aria-label="Preview size"
                />
                <button
                    type="button"
                    className="editor-canvas-preview-button"
                    onClick={() => adjustPreviewZoomPercent(PREVIEW_ZOOM_STEP_PERCENT)}
                    disabled={!canAdjustPreview}
                    title="Enlarge preview"
                    aria-label="Enlarge preview"
                >
                    <ZoomIn className="h-3.5 w-3.5" />
                </button>
                <button
                    type="button"
                    className="editor-canvas-preview-button"
                    onClick={() => canvasInstanceRef.current?.__resetCanvasView?.()}
                    disabled={!canAdjustPreview}
                    title="Fit preview"
                    aria-label="Fit preview"
                >
                    <Maximize2 className="h-3.5 w-3.5" />
                </button>
                <output className="editor-canvas-preview-percent" aria-live="polite">
                    {previewZoomPercent}%
                </output>
            </div>

            {!isBusy && project?.width && project?.height && (
                <div className="editor-canvas-resolution-hud">
                    <span>{imageNativeSize ? "Image Resolution" : "Document"}</span>
                    <strong>
                        {activeTool === "ai_extender" && expansionPreview?.targetWidth
                            ? `${expansionPreview.targetWidth} × ${expansionPreview.targetHeight} px`
                            : imageNativeSize
                                ? `${imageNativeSize.width} × ${imageNativeSize.height} px`
                                : `${project.width} × ${project.height} px`}
                    </strong>
                </div>
            )}

            {isLoading && (
                <div className='neo-loader-surface absolute inset-0 z-40 flex items-center justify-center'>
                    <AuroraLoader message="Loading canvas" />
                </div>
            )}
        </div>
    )
}

export default React.memo(CanvasEditor)
