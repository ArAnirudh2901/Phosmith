"use client"

import React, { useEffect, useRef, useState } from 'react'
import { useCanvas } from '../../../../../../context/context'
import { useConvexMutation } from '../../../../../../hooks/useConvexQuery'
import { api } from '../../../../../../convex/_generated/api'
import { Loader2 } from 'lucide-react'
import { Canvas, FabricImage, Point } from 'fabric'
import { normalizeCanvasState, serializeCanvasState } from '../../../../../lib/canvas-state'

const MIN_ZOOM = 0.05
const MAX_ZOOM = 64
const INITIAL_VIEWPORT_MARGIN = 0.9

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

    const { canvasEditor, setCanvasEditor, activeTool, onToolChange } = useCanvas()

    const { mutate: updateProject } = useConvexMutation(api.projects.updateProject)

    const getContainerSize = () => {
        if (!containerRef.current) {
            return { width: 0, height: 0 }
        }

        return {
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight,
        }
    }

    const getViewportState = (canvas) => {
        const viewportTransform = canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
        const zoom = viewportTransform[0] || 1

        return {
            zoom,
            center: {
                x: (canvas.getWidth() / 2 - viewportTransform[4]) / zoom,
                y: (canvas.getHeight() / 2 - viewportTransform[5]) / zoom,
            },
        }
    }

    const setViewportState = (canvas, viewportState, fallbackCenter) => {
        const zoom = clamp(viewportState?.zoom || 1, MIN_ZOOM, MAX_ZOOM)
        const center = viewportState?.center || fallbackCenter

        if (!center) return

        canvas.setViewportTransform([
            zoom,
            0,
            0,
            zoom,
            canvas.getWidth() / 2 - center.x * zoom,
            canvas.getHeight() / 2 - center.y * zoom,
        ])
    }

    const createInitialViewport = (canvas) => {
        const { width, height } = getContainerSize()
        const widthRatio = width > 0 ? width / project.width : 1
        const heightRatio = height > 0 ? height / project.height : 1
        const fitZoom = Math.min(widthRatio, heightRatio) * INITIAL_VIEWPORT_MARGIN

        setViewportState(canvas, {
            zoom: clamp(fitZoom || 1, MIN_ZOOM, MAX_ZOOM),
            center: {
                x: project.width / 2,
                y: project.height / 2,
            },
        })
    }

    const pushHistoryState = (canvas) => {
        if (!canvas || isRestoringRef.current) return

        const nextState = serializeCanvasState(canvas)
        const nextSignature = JSON.stringify(nextState)
        const currentState = historyRef.current[historyIndexRef.current]
        const currentSignature = currentState ? JSON.stringify(currentState) : null

        if (nextSignature === currentSignature) {
            return
        }

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

            if (nextState.viewport) {
                setViewportState(canvas, nextState.viewport, {
                    x: project.width / 2,
                    y: project.height / 2,
                })
            }

            canvas.calcOffset()
            canvas.requestRenderAll()
        } finally {
            isRestoringRef.current = false
        }
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

        if (!canvasRef.current || !project || canvasInstanceRef.current)
            return

        let mounted = true

        const initializeCanvas = async () => {
            setIsLoading(true)

            const { width, height } = getContainerSize()

            const canvas = new Canvas(canvasRef.current, {
                width: width || project.width,
                height: height || project.height,

                backgroundColor: "transparent",

                preserveObjectStacking: true,   // Maintain object layer order
                controlsAboveOverlay: true,     // Show selection controls above overlay when an object is selected
                selection: true,                // Enable object selection

                hoverCursor: "move",            // Cursor when hovering over objects
                moveCursor: "move",             // Cursor when moving objects
                defaultCursor: "default",       // Default cursor  

                allowTouchScrolling: false,     // Disable touch scrolling (prevents conflicts)
                renderOnAddRemove: true,        // Auto-render when objects are added/removed
                skipTargetFind: false,          // Allow object targeting for interactions
            })
            canvasInstanceRef.current = canvas

            canvas.setDimensions(
                {
                    width: width || project.width,
                    height: height || project.height,
                },
                { backstoreOnly: false }
            )

            createInitialViewport(canvas)

            const canvasState = normalizeCanvasState(project.canvasState)

            if (project.currentImageUrl || project.originalImageUrl) {
                try {
                    // Use current image if available (may have transformations) or fallback to the original one
                    const imageUrl = project.currentImageUrl || project.originalImageUrl

                    const fabricImage = await FabricImage.fromURL(imageUrl, {
                        crossOrigin: "anonymous", // Handle CORS for external images
                    })

                    const imageAspectRatio = fabricImage.width / fabricImage.height
                    const canvasAspectRatio = project.width / project.height

                    let scaleX, scaleY

                    if (imageAspectRatio > canvasAspectRatio) {
                        // Image is wider than canvas - scale based on width
                        scaleX = project.width / fabricImage.width
                        scaleY = scaleX  // Maintain aspect ratio
                    }

                    else {
                        // Image is taller than canvas - scale based on height
                        scaleY = project.height / fabricImage.height
                        scaleX = scaleY  // Maintain the aspect ratio
                    }

                    fabricImage.set({
                        left: project.width / 2,     // Center horizontally
                        top: project.height / 2,     // Center vertically
                        originX: "center",          // Transform origin at center
                        originY: "center",          // Transform origin at center 
                        scaleX,                     // Horizontal scale factor
                        scaleY,                     // Vertical scale factor
                        selectable: true,           // Allow user to select/move image
                        evented: true,              // Enable mouse/touch events
                    })

                    // Add image to canvas and ensure that it's centered
                    canvas.add(fabricImage)
                    canvas.centerObject(fabricImage)
                }

                catch (error) {
                    console.error("Error loading project image:", error)
                }
            }

            if (canvasState) {
                try {
                    // Load JSON state - this will restore all objects and their properties
                    await canvas.loadFromJSON(canvasState.canvas || canvasState)

                    if (canvasState.viewport) {
                        setViewportState(canvas, canvasState.viewport, {
                            x: project.width / 2,
                            y: project.height / 2,
                        })
                    }

                    canvas.requestRenderAll()
                }
                catch (error) {
                    console.error("Error loading canvas state: ", error)
                }
            }

            if (!mounted) {
                canvas.dispose()
                canvasInstanceRef.current = null
                return
            }

            canvas.calcOffset()         // Recalculate canvas position for event handling
            canvas.requestRenderAll()   // Trigger initial render
            setCanvasEditor(canvas)     // Store canvas instance in context

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
                const event = opt.e

                if (event.ctrlKey || ctrlPressedRef.current) {
                    isPanningRef.current = true
                    lastPointerRef.current = {
                        x: event.clientX,
                        y: event.clientY,
                    }

                    canvas.discardActiveObject()
                    canvas.requestRenderAll()
                    event.preventDefault()
                    event.stopPropagation()
                }
            }

            const handleMouseMove = (opt) => {
                if (!isPanningRef.current || !lastPointerRef.current) return

                const event = opt.e
                const deltaX = event.clientX - lastPointerRef.current.x
                const deltaY = event.clientY - lastPointerRef.current.y

                canvas.relativePan(new Point(deltaX, deltaY))
                lastPointerRef.current = {
                    x: event.clientX,
                    y: event.clientY,
                }
                canvas.requestRenderAll()
            }

            const handleMouseUp = () => {
                isPanningRef.current = false
                lastPointerRef.current = null
                canvas.upperCanvasEl.style.cursor = ctrlPressedRef.current ? 'grab' : 'default'
            }

            const handleMouseWheel = (opt) => {
                const event = opt.e

                if (!(event.ctrlKey || ctrlPressedRef.current)) {
                    return
                }

                event.preventDefault()

                const zoom = clamp(
                    canvas.getZoom() * Math.pow(0.999, event.deltaY),
                    MIN_ZOOM,
                    MAX_ZOOM
                )

                const pointer = canvas.getViewportPoint(event)
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
            canvas.__resetCanvasView = () => {
                createInitialViewport(canvas)
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

        // Keep project.canvasState out of these deps so autosaves do not remount the Fabric canvas.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        project?._id,
        project?.width,
        project?.height,
        project?.currentImageUrl,
        project?.originalImageUrl,
        setCanvasEditor,
    ])

    const saveCanvasState = async () => {
        if (!canvasEditor || !project) return

        try {
            const canvasJSON = serializeCanvasState(canvasEditor)

            // Save to Convex Database
            await updateProject({
                projectId: project._id,
                canvasState: canvasJSON,
            })
        } catch (error) {
            console.error("Error saving canvas state ", error)
        }
    }

    useEffect(() => {
        if (!canvasEditor) return

        let saveTimeout

        // Debounced save function - waits 2 seconds after last change 
        const handleCanvasChange = () => {
            pushHistoryState(canvasEditor)
            clearTimeout(saveTimeout)
            saveTimeout = setTimeout(() => {
                saveCanvasState()
            }, 2000)        // Add a 2 second delay
        }

        // Listen for canvas modification events
        canvasEditor.on("object:modified", handleCanvasChange)      // Object transformed/moved
        canvasEditor.on("object:added", handleCanvasChange)         // New object added
        canvasEditor.on("object:removed", handleCanvasChange)       // Object deleted
        canvasEditor.on("text:changed", handleCanvasChange)         // Text edited in-place

        return () => {
            clearTimeout(saveTimeout)
            canvasEditor.off("object:modified", handleCanvasChange)
            canvasEditor.off("object:added", handleCanvasChange)
            canvasEditor.off("object:removed", handleCanvasChange)
            canvasEditor.off("text:changed", handleCanvasChange)
        }
        // Keep the original save flow; canvasEditor is the listener owner.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvasEditor])

    useEffect(() => {
        const handleResize = () => {
            const canvas = canvasInstanceRef.current

            if (!canvas || !project || !containerRef.current) return

            const viewportState = getViewportState(canvas)

            canvas.setDimensions(
                {
                    width: containerRef.current.clientWidth,
                    height: containerRef.current.clientHeight,
                },
                {
                    backstoreOnly: false
                }
            )

            setViewportState(canvas, viewportState)
            canvas.calcOffset()       // Update mouse event coordinates
            canvas.requestRenderAll() // Re-render with new dimensions
        }
        window.addEventListener("resize", handleResize)
        handleResize()

        return () => {
            window.removeEventListener("resize", handleResize)
        }
        // Keep project.canvasState out of these deps so autosaves do not trigger a resize cycle.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [project?.width, project?.height])

    return (
        <div ref={containerRef} className='relative w-full h-full overflow-hidden bg-secondary'>
            <div
                className='absolute inset-0 opacity-10 pointer-events-none'
                style={{
                    backgroundImage: `
                    linear-gradient(45deg, #64748b 25%, transparent 25%),
                    linear-gradient(-45deg, #64748b 25%, transparent 25%),
                    linear-gradient(45deg, transparent 75%, #64748b 75%),
                    linear-gradient(-45deg, transparent 75%, #64748b 75%)`,
                    backgroundSize: "20px 20px",
                    backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
                }}
            />

            {isLoading &&
                <div className='absolute inset-0 flex items-center justify-center bg-slate-800/80 z-10'>
                    <div className='flex flex-col items-center gap-4'>
                        <Loader2 className='animate-spin w-8 h-8' />{" "}
                        <p className='text-white/70 text-sm text-center'>
                            Loading Canvas...
                        </p>
                    </div>
                </div>
            }

            <div className='absolute inset-0 p-5'>
                <canvas id='canvas' className='border border-slate-600/50 rounded-md shadow-2xl' ref={canvasRef} />
            </div>
        </div>
    )
}

export default CanvasEditor
