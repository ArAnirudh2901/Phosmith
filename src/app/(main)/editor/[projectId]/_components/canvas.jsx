"use client"

import React, { useEffect, useRef, useState } from "react"
import { useCanvas } from "../../../../../../context/context"
import { useConvexMutation } from "../../../../../../hooks/useConvexQuery"
import { api } from "../../../../../../convex/_generated/api"
import { Loader2 } from "lucide-react"
import { Canvas, FabricImage, Point } from "fabric"
import { normalizeCanvasState, serializeCanvasState } from "../../../../../lib/canvas-state"

const MIN_ZOOM = 0.05
const MAX_ZOOM = 64
const VIEWPORT_PADDING = 88
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const CanvasEditor = ({ project }) => {
    const [isLoading, setIsLoading] = useState(true)
    const canvasRef = useRef()
    const containerRef = useRef()
    const canvasInstanceRef = useRef(null)
    const isPanningRef = useRef(false)
    const ctrlPressedRef = useRef(false)
    const lastPointerRef = useRef(null)
    const historyRef = useRef([])
    const historyIndexRef = useRef(-1)
    const isRestoringRef = useRef(false)
    const resizeFrameRef = useRef(null)

    const { canvasEditor, setCanvasEditor } = useCanvas()
    const { mutate: updateProject } = useConvexMutation(api.projects.updateProject)

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

    const pushHistoryState = (canvas) => {
        if (!canvas || isRestoringRef.current) return
        const nextState = serializeCanvasState(canvas)
        const nextSignature = JSON.stringify(nextState)
        const currentState = historyRef.current[historyIndexRef.current]
        const currentSignature = currentState ? JSON.stringify(currentState) : null
        if (nextSignature === currentSignature) return
        historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1)
        historyRef.current.push(nextState)
        historyIndexRef.current = historyRef.current.length - 1
    }

    const restoreCanvasState = async (canvas, state) => {
        if (!canvas || !state) return
        isRestoringRef.current = true
        try {
            const nextState = normalizeCanvasState(state)
            await canvas.loadFromJSON(nextState.canvas || nextState)
            if (nextState.viewport) setViewportState(canvas, nextState.viewport, { x: project.width / 2, y: project.height / 2 })
            canvas.calcOffset()
            canvas.requestRenderAll()
        } finally { isRestoringRef.current = false }
    }

    const undoCanvasState = async () => {
        const canvas = canvasInstanceRef.current
        if (!canvas || historyIndexRef.current <= 0) return
        historyIndexRef.current -= 1
        await restoreCanvasState(canvas, historyRef.current[historyIndexRef.current])
    }

    const redoCanvasState = async () => {
        const canvas = canvasInstanceRef.current
        if (!canvas || historyIndexRef.current >= historyRef.current.length - 1) return
        historyIndexRef.current += 1
        await restoreCanvasState(canvas, historyRef.current[historyIndexRef.current])
    }

    useEffect(() => {
        if (!canvasRef.current || !project || canvasInstanceRef.current) return
        let mounted = true

        const initializeCanvas = async () => {
            setIsLoading(true)
            const { width, height } = getContainerSize()
            const canvas = new Canvas(canvasRef.current, {
                width: width || project.width, height: height || project.height,
                backgroundColor: "transparent",
                preserveObjectStacking: true, controlsAboveOverlay: true, selection: true,
                hoverCursor: "move", moveCursor: "move", defaultCursor: "default",
                allowTouchScrolling: false, renderOnAddRemove: false, skipTargetFind: false,
            })
            canvasInstanceRef.current = canvas
            canvas.setDimensions({ width: width || project.width, height: height || project.height }, { backstoreOnly: false })

            const canvasState = normalizeCanvasState(project.canvasState)
            if (project.currentImageUrl || project.originalImageUrl) {
                try {
                    const imageUrl = project.currentImageUrl || project.originalImageUrl
                    const fabricImage = await FabricImage.fromURL(imageUrl, { crossOrigin: "anonymous" })
                    const imageAspectRatio = fabricImage.width / fabricImage.height
                    const canvasAspectRatio = project.width / project.height
                    let scaleX, scaleY
                    if (imageAspectRatio > canvasAspectRatio) {
                        scaleX = project.width / fabricImage.width; scaleY = scaleX
                    } else {
                        scaleY = project.height / fabricImage.height; scaleX = scaleY
                    }
                    fabricImage.set({ left: project.width / 2, top: project.height / 2, originX: "center", originY: "center", scaleX, scaleY, selectable: true, evented: true })
                    canvas.add(fabricImage)
                    canvas.centerObject(fabricImage)
                } catch (error) { console.error("Error loading project image:", error) }
            }

            let hasRestoredViewport = false
            if (canvasState) {
                try {
                    await canvas.loadFromJSON(canvasState.canvas || canvasState)
                    const isStaleFrame = (obj) => {
                        if (obj._isExpansionFrame) return true
                        if (obj.type === 'rect' || obj.type === 'Rect') {
                            const fill = obj.fill === 'rgba(0, 229, 255, 0.04)'
                            const stroke = obj.stroke === 'rgba(0, 229, 255, 0.5)'
                            const dashed = Array.isArray(obj.strokeDashArray) && obj.strokeDashArray.length > 0
                            if (fill && stroke && dashed) return true
                        }
                        return false
                    }
                    canvas.getObjects().filter(isStaleFrame).forEach(f => canvas.remove(f))
                    if (canvasState.viewport) { setViewportState(canvas, canvasState.viewport, { x: project.width / 2, y: project.height / 2 }); hasRestoredViewport = true }
                    canvas.requestRenderAll()
                } catch (error) { console.error("Error loading canvas state: ", error) }
            }

            if (!hasRestoredViewport) createInitialViewport(canvas)
            if (!mounted) { canvas.dispose(); canvasInstanceRef.current = null; return }

            canvas.renderOnAddRemove = true
            canvas.calcOffset()
            canvas.requestRenderAll()
            setCanvasEditor(canvas)

            const handleKeyDown = (event) => {
                if (event.key !== 'Control' || event.repeat) return
                ctrlPressedRef.current = true
                canvas.skipTargetFind = true
                canvas.defaultCursor = 'grab'
                canvas.upperCanvasEl.style.cursor = 'grab'
                event.preventDefault()
            }
            const handleKeyUp = (event) => {
                if (event.key !== 'Control') return
                ctrlPressedRef.current = false
                isPanningRef.current = false
                lastPointerRef.current = null
                canvas.skipTargetFind = false
                canvas.defaultCursor = 'default'
                canvas.upperCanvasEl.style.cursor = 'default'
            }
            const handleMouseDown = (opt) => {
                if (opt.e.ctrlKey || ctrlPressedRef.current) {
                    isPanningRef.current = true
                    lastPointerRef.current = { x: opt.e.clientX, y: opt.e.clientY }
                    canvas.discardActiveObject()
                    canvas.requestRenderAll()
                    opt.e.preventDefault()
                    opt.e.stopPropagation()
                }
            }
            const handleMouseMove = (opt) => {
                if (!isPanningRef.current || !lastPointerRef.current) return
                const deltaX = opt.e.clientX - lastPointerRef.current.x
                const deltaY = opt.e.clientY - lastPointerRef.current.y
                canvas.relativePan(new Point(deltaX, deltaY))
                lastPointerRef.current = { x: opt.e.clientX, y: opt.e.clientY }
                canvas.requestRenderAll()
            }
            const handleMouseUp = () => {
                isPanningRef.current = false
                lastPointerRef.current = null
                canvas.upperCanvasEl.style.cursor = ctrlPressedRef.current ? 'grab' : 'default'
            }
            const handleMouseWheel = (opt) => {
                if (!(opt.e.ctrlKey || ctrlPressedRef.current)) return
                opt.e.preventDefault()
                const zoom = clamp(canvas.getZoom() * Math.pow(0.999, opt.e.deltaY), MIN_ZOOM, MAX_ZOOM)
                const pointer = canvas.getViewportPoint(opt.e)
                canvas.zoomToPoint(new Point(pointer.x, pointer.y), zoom)
                canvas.requestRenderAll()
            }

            window.addEventListener('keydown', handleKeyDown)
            window.addEventListener('keyup', handleKeyUp)
            canvas.on('mouse:down', handleMouseDown)
            canvas.on('mouse:move', handleMouseMove)
            canvas.on('mouse:up', handleMouseUp)
            canvas.on('mouse:wheel', handleMouseWheel)

            canvas.__cleanupInfiniteWorkspace = () => {
                window.removeEventListener('keydown', handleKeyDown)
                window.removeEventListener('keyup', handleKeyUp)
                canvas.off('mouse:down', handleMouseDown)
                canvas.off('mouse:move', handleMouseMove)
                canvas.off('mouse:up', handleMouseUp)
                canvas.off('mouse:wheel', handleMouseWheel)
            }
            canvas.__undoCanvasState = undoCanvasState
            canvas.__redoCanvasState = redoCanvasState
            canvas.__saveCanvasState = saveCanvasState
            canvas.__fitCanvasToProject = (size) => {
                fitProjectToViewport(canvas, size)
                canvas.calcOffset()
                canvas.requestRenderAll()
            }
            canvas.__resetCanvasView = () => {
                fitProjectToViewport(canvas)
                canvas.calcOffset()
                canvas.requestRenderAll()
            }

            pushHistoryState(canvas)
            setIsLoading(false)
        }

        initializeCanvas()
        return () => {
            mounted = false
            if (canvasInstanceRef.current) {
                canvasInstanceRef.current.__cleanupInfiniteWorkspace?.()
                canvasInstanceRef.current.dispose()
                canvasInstanceRef.current = null
            }
            setCanvasEditor(null)
        }
    }, [project?._id, project?.width, project?.height, project?.currentImageUrl, project?.originalImageUrl, setCanvasEditor])

    const saveCanvasState = async () => {
        if (!canvasEditor || !project) return
        try {
            const canvasJSON = serializeCanvasState(canvasEditor)
            await updateProject({ projectId: project._id, canvasState: canvasJSON })
        } catch (error) { console.error("Error saving canvas state ", error) }
    }

    useEffect(() => {
        if (!canvasEditor) return
        let saveTimeout
        const handleCanvasChange = (event) => {
            if (event?.target?._isExpansionFrame) return
            pushHistoryState(canvasEditor)
            clearTimeout(saveTimeout)
            saveTimeout = setTimeout(() => saveCanvasState(), 2000)
        }
        canvasEditor.on("object:modified", handleCanvasChange)
        canvasEditor.on("object:added", handleCanvasChange)
        canvasEditor.on("object:removed", handleCanvasChange)
        canvasEditor.on("text:changed", handleCanvasChange)
        return () => {
            clearTimeout(saveTimeout)
            canvasEditor.off("object:modified", handleCanvasChange)
            canvasEditor.off("object:added", handleCanvasChange)
            canvasEditor.off("object:removed", handleCanvasChange)
            canvasEditor.off("text:changed", handleCanvasChange)
        }
    }, [canvasEditor])

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
        window.addEventListener("resize", handleResize)
        handleResize()
        return () => {
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

    return (
        <div ref={containerRef} className='relative h-full min-h-0 w-full overflow-hidden editor-canvas-host'>
            {/* Dot grid */}
            <div className='absolute inset-0 pointer-events-none editor-canvas-grid' />

            {project?.width && project?.height && (
                <div className="editor-canvas-resolution-hud">
                    <span>Current Resolution</span>
                    <strong>{project.width} × {project.height} px</strong>
                </div>
            )}

            {isLoading &&
                <div className='absolute inset-0 flex items-center justify-center z-10' style={{ background: 'rgba(7,9,14,0.85)', backdropFilter: 'blur(8px)' }}>
                    <div className='flex flex-col items-center gap-4'>
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center animate-pulse-glow"
                            style={{ background: 'rgba(0, 229, 255, 0.15)' }}>
                            <div className="w-5 h-5 rounded" style={{ background: 'var(--accent-primary)' }} />
                        </div>
                        <p className='text-xs' style={{ color: 'var(--text-muted)' }}>Loading canvas...</p>
                    </div>
                </div>
            }

            <div className='absolute inset-0'>
                <canvas id='canvas' className='rounded-xl editor-canvas-surface' ref={canvasRef} />
            </div>
        </div>
    )
}

export default CanvasEditor
