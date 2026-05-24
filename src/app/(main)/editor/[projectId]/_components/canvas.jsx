"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import { useCanvas } from "../../../../../../context/context"
import { useConvexMutation } from "../../../../../../hooks/useConvexQuery"
import { api } from "../../../../../../convex/_generated/api"
import { Hand, Maximize2, ZoomIn, ZoomOut } from "lucide-react"
import { Canvas, FabricImage, Point } from "fabric"
import { normalizeCanvasState, serializeCanvasState } from "../../../../../lib/canvas-state"
import { hydrateCanvasImages, restoreCanvasFromHistory } from "../../../../../lib/canvas-history"
import { isExpansionFrameLike, removeExpansionFramesFromCanvas } from "../../../../../lib/expansion-pipeline"
import { addImageFilesToCanvas } from "../../../../../lib/canvas-images"

const MIN_ZOOM = 0.05
const MAX_ZOOM = 64
const MIN_PREVIEW_ZOOM_PERCENT = 5
const MAX_PREVIEW_ZOOM_PERCENT = 400
const PREVIEW_ZOOM_STEP_PERCENT = 10
const VIEWPORT_PADDING = 88
const MAX_PERSISTED_HISTORY = 30
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

    const { canvasEditor, setCanvasEditor, activeTool, expansionPreview } = useCanvas()
    const activeToolRef = useRef(activeTool)
    activeToolRef.current = activeTool
    const { mutate: updateProject } = useConvexMutation(api.projects.updateProject)

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

        const safeW = Math.max(canvasW - VIEWPORT_PADDING * 2, canvasW * 0.72, 1)
        const safeH = Math.max(canvasH - VIEWPORT_PADDING * 2, canvasH * 0.72, 1)
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

    const saveCanvasState = useCallback(async () => {
        const canvas = canvasInstanceRef.current
        const proj = projectRef.current
        if (!canvas || !proj) return
        try {
            const canvasJSON = serializeCanvasState(canvas)
            const currentImageUrl = getPrimaryRemoteImageUrl(canvas)
            await updateProject({
                projectId: proj._id,
                canvasState: {
                    ...canvasJSON,
                    history: historyRef.current.slice(-MAX_PERSISTED_HISTORY),
                    historyIndex: historyIndexRef.current,
                },
                ...(currentImageUrl ? { currentImageUrl } : {}),
            })
        } catch (error) { console.error("Error saving canvas state ", error) }
    }, [updateProject])

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

            const rawCanvasState = project.canvasState
            const canvasState = normalizeCanvasState(rawCanvasState)
            const persistedHistory = Array.isArray(rawCanvasState?.history) ? rawCanvasState.history : null
            let hasRestoredViewport = false

            if (!canvasState && (project.currentImageUrl || project.originalImageUrl)) {
                try {
                    const imageUrl = project.currentImageUrl || project.originalImageUrl
                    const fabricImage = await FabricImage.fromURL(imageUrl, { crossOrigin: "anonymous" })
                    fitImageInsideProject(fabricImage, project)
                    canvas.add(fabricImage)
                } catch (error) { console.error("Error loading project image:", error) }
            }

            if (canvasState) {
                try {
                    await canvas.loadFromJSON(canvasState.canvas || canvasState)
                    removeExpansionFramesFromCanvas(canvas)
                    if (canvasState.viewport) { setViewportState(canvas, canvasState.viewport, { x: project.width / 2, y: project.height / 2 }); hasRestoredViewport = true }
                    const imageUrl = project.currentImageUrl || project.originalImageUrl
                    await hydrateCanvasImages(canvas, imageUrl, {
                        forcePrimaryImageUrl: true,
                        canvasSize: { width: project.width, height: project.height },
                    })
                    for (const obj of canvas.getObjects()) {
                        if (obj?.type?.toLowerCase() === 'image' && obj.filters?.length) {
                            try { obj.applyFilters?.() } catch { /* ignore */ }
                        }
                    }
                    canvas.requestRenderAll()
                } catch (error) { console.error("Error loading canvas state: ", error) }
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
                    canvas.upperCanvasEl.style.cursor = 'grabbing'
                    canvas.requestRenderAll()
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
            canvas.__saveCanvasState = () => saveCanvasState()
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

    useEffect(() => {
        const canvas = canvasInstanceRef.current
        const imageUrl = project?.currentImageUrl || project?.originalImageUrl
        if (!canvas || !imageUrl) return

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
        if (activeTool !== 'draw' && activeTool !== 'ai_extender') {
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
        if (!canvas || activeToolRef.current === 'ai_extender') return
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

                const nextWidth = containerRef.current.clientWidth
                const nextHeight = containerRef.current.clientHeight
                if (!nextWidth || !nextHeight) return

                if (canvas.getWidth() === nextWidth && canvas.getHeight() === nextHeight) {
                    canvas.calcOffset()
                    return
                }

                const viewportState = getViewportState(canvas)
                canvas.setDimensions({ width: nextWidth, height: nextHeight }, { backstoreOnly: false })
                setViewportState(canvas, viewportState)
                canvas.calcOffset()
                canvas.requestRenderAll()
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

            {isProjectFrameVisible && (
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

            {isProjectFrameVisible && (
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
                    step="5"
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

            {project?.width && project?.height && (
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

            {isLoading &&
                <div className='absolute inset-0 flex items-center justify-center z-10' style={{ background: 'rgba(7,9,14,0.85)', backdropFilter: 'blur(8px)' }}>
                    <div className='flex flex-col items-center gap-4'>
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center animate-pulse-glow"
                            style={{ background: 'rgba(6, 184, 212, 0.15)' }}>
                            <div className="w-5 h-5 rounded" style={{ background: 'var(--accent-primary)' }} />
                        </div>
                        <p className='text-xs' style={{ color: 'var(--text-muted)' }}>Loading canvas...</p>
                    </div>
                </div>
            }
        </div>
    )
}

export default CanvasEditor
