"use client"

import React, { useEffect, useRef, useState, useCallback, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import {
    Sparkles,
    Maximize2,
    Loader2,
    RectangleHorizontal,
    Square,
    Smartphone,
    Monitor,
    Scaling,
    Trash2,
} from "lucide-react"
import { Rect } from "fabric"
import { useCanvas } from "../../../../../../../context/context"
import { useConvexMutation } from "../../../../../../../hooks/useConvexQuery"
import { api } from "../../../../../../../convex/_generated/api"
import { serializeCanvasState } from "../../../../../../lib/canvas-state"

/*
 * ─── Generative Expand Tool ───
 *
 * Overrides the default Fabric.js scaling behavior:
 *   → Dragging image handles EXPANDS a transparent bounding container
 *     instead of stretching/compressing the image pixels.
 *   → Supports aspect ratio locking (Free, 1:1, 16:9, 4:3, 9:16).
 *   → Generates a binary mask (black = preserve, white = generate)
 *     for outpainting AI pipelines.
 *
 * Adobe Generative Fill-inspired workflow.
 */

const ASPECT_RATIOS = [
    { id: "free", label: "Free", icon: Scaling, ratio: null },
    { id: "1:1", label: "1:1", icon: Square, ratio: 1 },
    { id: "16:9", label: "16:9", icon: Monitor, ratio: 16 / 9 },
    { id: "4:3", label: "4:3", icon: RectangleHorizontal, ratio: 4 / 3 },
    { id: "9:16", label: "9:16", icon: Smartphone, ratio: 9 / 16 },
]

const getMainImage = (canvas) => {
    if (!canvas) return null
    return (
        canvas
            .getObjects()
            .find((obj) => obj.type?.toLowerCase() === "image") || null
    )
}

const GenerativeExpand = ({ project, dominantColor, contrastingColor, lighterColor }) => {
    const { canvasEditor, setProcessingMessage } = useCanvas()
    const { mutate: updateProject } = useConvexMutation(
        api.projects.updateProject
    )

    const [prompt, setPrompt] = useState(
        "seamless background continuation, photorealistic"
    )
    const [selectedRatio, setSelectedRatio] = useState("free")
    const [isGenerating, setIsGenerating] = useState(false)
    const [expandRegion, setExpandRegion] = useState(null) // { left, top, width, height }
    const [maskPreviewUrl, setMaskPreviewUrl] = useState(null)

    const expandRectRef = useRef(null)
    const isDrawingRef = useRef(false)
    const startPointRef = useRef(null)
    const originalImageBoundsRef = useRef(null)

    const mainImage = useMemo(
        () => getMainImage(canvasEditor),
        [canvasEditor]
    )

    // ─── Cleanup expand rect when tool unmounts ───
    useEffect(() => {
        return () => {
            if (canvasEditor && expandRectRef.current) {
                canvasEditor.remove(expandRectRef.current)
                canvasEditor.requestRenderAll()
            }
        }
    }, [canvasEditor])

    // ─── Apply aspect ratio constraint ───
    const constrainToRatio = useCallback(
        (width, height) => {
            const ratio = ASPECT_RATIOS.find(
                (r) => r.id === selectedRatio
            )?.ratio
            if (!ratio) return { width, height } // Free mode

            const absW = Math.abs(width)
            const absH = Math.abs(height)

            // Determine dominant axis
            if (absW / ratio >= absH) {
                // Width dominant → constrain height
                return {
                    width,
                    height: Math.sign(height) * (absW / ratio),
                }
            } else {
                // Height dominant → constrain width
                return {
                    width: Math.sign(width) * (absH * ratio),
                    height,
                }
            }
        },
        [selectedRatio]
    )

    // ─── Draw expansion region on canvas ───
    const startDrawing = useCallback(() => {
        if (!canvasEditor || !mainImage) {
            toast.error("Add an image to the canvas first")
            return
        }

        // Store original image bounds
        const bounds = mainImage.getBoundingRect()
        originalImageBoundsRef.current = {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
        }

        // Clear existing expand rect
        if (expandRectRef.current) {
            canvasEditor.remove(expandRectRef.current)
            expandRectRef.current = null
        }

        // Disable interactive selection during drawing (but keep objects visible!)
        canvasEditor.selection = false
        canvasEditor.defaultCursor = "crosshair"
        canvasEditor.upperCanvasEl.style.cursor = "crosshair"
        canvasEditor.getObjects().forEach((obj) => {
            obj.set({ selectable: false, evented: false, hoverCursor: 'crosshair' })
        })
        canvasEditor.requestRenderAll()

        const handleMouseDown = (opt) => {
            const pointer = canvasEditor.getScenePoint(opt.e)
            startPointRef.current = { x: pointer.x, y: pointer.y }
            isDrawingRef.current = true

            // Create a transparent expand rect
            const rect = new Rect({
                left: pointer.x,
                top: pointer.y,
                width: 0,
                height: 0,
                fill: "rgba(0, 229, 255, 0.08)",
                stroke: "#00E5FF",
                strokeWidth: 2,
                strokeDashArray: [8, 4],
                selectable: false,
                evented: false,
                hasBorders: false,
                hasControls: false,
            })

            expandRectRef.current = rect
            canvasEditor.add(rect)
            canvasEditor.requestRenderAll()
        }

        const handleMouseMove = (opt) => {
            if (
                !isDrawingRef.current ||
                !startPointRef.current ||
                !expandRectRef.current
            )
                return

            const pointer = canvasEditor.getScenePoint(opt.e)
            let rawWidth = pointer.x - startPointRef.current.x
            let rawHeight = pointer.y - startPointRef.current.y

            // Apply aspect ratio constraint
            const constrained = constrainToRatio(rawWidth, rawHeight)
            rawWidth = constrained.width
            rawHeight = constrained.height

            const left =
                rawWidth >= 0
                    ? startPointRef.current.x
                    : startPointRef.current.x + rawWidth
            const top =
                rawHeight >= 0
                    ? startPointRef.current.y
                    : startPointRef.current.y + rawHeight

            expandRectRef.current.set({
                left,
                top,
                width: Math.abs(rawWidth),
                height: Math.abs(rawHeight),
            })
            expandRectRef.current.setCoords()
            canvasEditor.requestRenderAll()
        }

        const handleMouseUp = () => {
            isDrawingRef.current = false

            // Restore selection and interactivity
            canvasEditor.selection = true
            canvasEditor.defaultCursor = "default"
            canvasEditor.upperCanvasEl.style.cursor = "default"
            canvasEditor.getObjects().forEach((obj) => {
                if (obj !== expandRectRef.current) {
                    obj.set({ selectable: true, evented: true, hoverCursor: 'move' })
                }
            })
            canvasEditor.requestRenderAll()

            // Remove drawing listeners
            canvasEditor.off("mouse:down", handleMouseDown)
            canvasEditor.off("mouse:move", handleMouseMove)
            canvasEditor.off("mouse:up", handleMouseUp)

            // Store the expansion region
            if (expandRectRef.current) {
                const rect = expandRectRef.current
                if (rect.width > 10 && rect.height > 10) {
                    setExpandRegion({
                        left: Math.round(rect.left),
                        top: Math.round(rect.top),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                    })
                    toast.success("Expansion region defined")
                } else {
                    // Too small — remove it
                    canvasEditor.remove(rect)
                    expandRectRef.current = null
                    toast.info("Draw a larger region")
                }
            }
        }

        canvasEditor.on("mouse:down", handleMouseDown)
        canvasEditor.on("mouse:move", handleMouseMove)
        canvasEditor.on("mouse:up", handleMouseUp)

        toast.info("Click and drag to define the expansion region")
    }, [canvasEditor, mainImage, constrainToRatio])

    // ─── Clear expansion region ───
    const clearExpandRegion = useCallback(() => {
        if (canvasEditor && expandRectRef.current) {
            canvasEditor.remove(expandRectRef.current)
            canvasEditor.requestRenderAll()
        }
        expandRectRef.current = null
        setExpandRegion(null)
        setMaskPreviewUrl(null)
    }, [canvasEditor])

    // ─── Generate binary mask ───
    const generateMask = useCallback(() => {
        if (!expandRegion || !originalImageBoundsRef.current || !mainImage)
            return null

        const imgBounds = originalImageBoundsRef.current
        const region = expandRegion

        // Create off-screen canvas at the expansion region size
        const offCanvas = document.createElement("canvas")
        offCanvas.width = region.width
        offCanvas.height = region.height
        const ctx = offCanvas.getContext("2d")

        // Fill entirely white (generation zone)
        ctx.fillStyle = "#FFFFFF"
        ctx.fillRect(0, 0, region.width, region.height)

        // Calculate where the original image sits within the expansion region
        const imgLocalLeft = imgBounds.left - region.left
        const imgLocalTop = imgBounds.top - region.top

        // Fill the original image area with black (preserve zone)
        ctx.fillStyle = "#000000"
        ctx.fillRect(
            Math.max(0, imgLocalLeft),
            Math.max(0, imgLocalTop),
            Math.min(imgBounds.width, region.width - Math.max(0, imgLocalLeft)),
            Math.min(imgBounds.height, region.height - Math.max(0, imgLocalTop))
        )

        return offCanvas.toDataURL("image/png")
    }, [expandRegion, mainImage])

    // ─── Generate padded base image ───
    const generatePaddedImage = useCallback(() => {
        if (!expandRegion || !originalImageBoundsRef.current || !mainImage)
            return null

        const imgBounds = originalImageBoundsRef.current
        const region = expandRegion

        // Create off-screen canvas at the expansion region size
        const offCanvas = document.createElement("canvas")
        offCanvas.width = region.width
        offCanvas.height = region.height
        const ctx = offCanvas.getContext("2d")

        // Fill with transparent (alpha = 0)
        ctx.clearRect(0, 0, region.width, region.height)

        // Draw the original image into the correct position
        const imgEl = mainImage._originalElement || mainImage.getElement()
        if (imgEl) {
            const imgLocalLeft = imgBounds.left - region.left
            const imgLocalTop = imgBounds.top - region.top

            ctx.drawImage(
                imgEl,
                Math.max(0, imgLocalLeft),
                Math.max(0, imgLocalTop),
                imgBounds.width,
                imgBounds.height
            )
        }

        return offCanvas.toDataURL("image/png")
    }, [expandRegion, mainImage])

    // ─── Preview mask ───
    const handlePreviewMask = useCallback(() => {
        const mask = generateMask()
        if (mask) {
            setMaskPreviewUrl(mask)
            toast.success("Binary mask generated")
        } else {
            toast.error("Draw an expansion region first")
        }
    }, [generateMask])

    // ─── Execute generation with retry logic ───
    const handleGenerate = useCallback(async () => {
        if (isGenerating || !prompt.trim() || !expandRegion) return

        const maskBase64 = generateMask()
        const paddedImageBase64 = generatePaddedImage()

        if (!maskBase64 || !paddedImageBase64) {
            toast.error("Failed to generate mask data")
            return
        }

        setIsGenerating(true)
        setProcessingMessage("AI is generating the expanded image...")

        const MAX_RETRIES = 3
        const RETRY_BASE_DELAY = 5000

        const callOutpaint = async (attempt = 1) => {
            const response = await fetch("/api/ai/outpaint", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    prompt: prompt.trim(),
                    mask: maskBase64,
                    image: paddedImageBase64,
                    width: expandRegion.width,
                    height: expandRegion.height,
                }),
            })

            if (!response.ok) {
                const data = await response.json().catch(() => ({}))
                const errorMessage = data.error || data.message || `HTTP ${response.status}`

                // Auto-retry on 503 (model loading) or 429 (rate limited)
                if ((response.status === 503 || response.status === 429) && attempt <= MAX_RETRIES) {
                    const retryAfter = response.status === 429
                        ? parseInt(response.headers.get("retry-after") || "10", 10) * 1000
                        : RETRY_BASE_DELAY * attempt
                    setProcessingMessage(`Model is loading... retrying in ${Math.round(retryAfter / 1000)}s (attempt ${attempt}/${MAX_RETRIES})`)
                    await new Promise((resolve) => setTimeout(resolve, retryAfter))
                    setProcessingMessage("AI is generating the expanded image...")
                    return callOutpaint(attempt + 1)
                }

                throw new Error(errorMessage)
            }

            return response.json()
        }

        try {
            const data = await callOutpaint()

            if (!data?.imageUrl) {
                throw new Error("No image URL returned from outpainting API")
            }

            setProcessingMessage("Applying generated image to canvas...")

            // Apply the generated image to canvas
            const { FabricImage } = await import("fabric")
            const generatedImage = await FabricImage.fromURL(data.imageUrl, {
                crossOrigin: "anonymous",
            })

            generatedImage.set({
                left: expandRegion.left,
                top: expandRegion.top,
                scaleX: expandRegion.width / (generatedImage.width || 1),
                scaleY: expandRegion.height / (generatedImage.height || 1),
                selectable: true,
                evented: true,
            })

            // Remove the expand rect and add the generated image
            if (expandRectRef.current) {
                canvasEditor.remove(expandRectRef.current)
                expandRectRef.current = null
            }

            canvasEditor.add(generatedImage)
            canvasEditor.setActiveObject(generatedImage)
            canvasEditor.requestRenderAll()

            // Save state — wrapped separately so a save failure doesn't negate the canvas success
            try {
                await updateProject({
                    projectId: project._id,
                    canvasState: serializeCanvasState(canvasEditor),
                })
            } catch (saveError) {
                console.warn('Canvas state save failed (payload may be too large):', saveError)
                // Fallback: save without canvasState
                try {
                    await updateProject({
                        projectId: project._id,
                    })
                } catch (_) {
                    // Silent — the image is already on canvas
                }
            }

            setExpandRegion(null)
            setMaskPreviewUrl(null)
            toast.success("Generative expand complete!")
        } catch (error) {
            console.warn("Generative expand failed:", error)
            toast.error(error?.message || "Generation failed")
        } finally {
            setIsGenerating(false)
            setProcessingMessage(null)
        }
    }, [
        isGenerating,
        prompt,
        expandRegion,
        generateMask,
        generatePaddedImage,
        canvasEditor,
        project,
        updateProject,
        setProcessingMessage,
    ])

    return (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto overflow-x-hidden pr-2 panel-scroll">
            {/* Prompt */}
            <div className="panel-card space-y-3">
                <label className="panel-label">Prompt</label>
                <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                    placeholder="Describe what should appear in the expanded area..."
                    className="panel-input resize-none"
                    style={{ minHeight: '72px' }}
                />
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Tip: Short, concrete prompts produce cleaner edge blending.
                </p>
            </div>

            {/* Aspect Ratio Selector */}
            <div className="space-y-2.5">
                <label className="panel-label">Aspect Ratio</label>
                <div className="grid grid-cols-5 gap-1.5">
                    {ASPECT_RATIOS.map((ratio) => {
                        const Icon = ratio.icon
                        const active = selectedRatio === ratio.id

                        return (
                            <button
                                key={ratio.id}
                                type="button"
                                onClick={() => setSelectedRatio(ratio.id)}
                                className="flex flex-col items-center gap-1 rounded-lg p-2 text-center editor-interactive"
                                style={{
                                    border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    background: active ? 'rgba(0, 229, 255, 0.12)' : 'var(--bg-elevated)',
                                    color: active ? 'var(--accent-primary)' : 'var(--text-muted)',
                                }}
                            >
                                <Icon className="h-3.5 w-3.5" />
                                <span className="text-[10px] font-medium">
                                    {ratio.label}
                                </span>
                            </button>
                        )
                    })}
                </div>
            </div>

            {/* Drawing controls */}
            <div className="panel-card space-y-3"
                 style={{ borderColor: expandRegion ? 'rgba(0, 229, 255, 0.3)' : 'var(--border-subtle)' }}>
                <div className="flex items-center justify-between gap-3">
                    <label className="panel-label">Expansion Region</label>
                    {expandRegion && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                              style={{ color: 'var(--accent-primary)', background: 'rgba(0, 229, 255, 0.1)' }}>
                            {expandRegion.width}×{expandRegion.height}
                        </span>
                    )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                    <button
                        onClick={startDrawing}
                        disabled={!mainImage}
                        className="flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive disabled:opacity-40"
                        style={{
                            background: 'var(--accent-primary)',
                            color: '#fff',
                            border: 'none',
                        }}
                    >
                        <Maximize2 className="h-3.5 w-3.5" />
                        Draw Region
                    </button>
                    <button
                        onClick={clearExpandRegion}
                        disabled={!expandRegion}
                        className="flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive disabled:opacity-40"
                        style={{
                            background: 'var(--bg-surface)',
                            color: 'var(--text-secondary)',
                            border: '1px solid var(--border-subtle)',
                        }}
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                        Clear
                    </button>
                </div>

                {!mainImage && (
                    <p className="text-[11px]" style={{ color: 'var(--accent-warning)' }}>
                        ⚠ Add an image to the canvas first
                    </p>
                )}
            </div>

            {/* Action buttons */}
            <div className="grid grid-cols-2 gap-2">
                <button
                    onClick={handlePreviewMask}
                    disabled={!expandRegion}
                    className="flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium editor-interactive disabled:opacity-40"
                    style={{
                        background: 'var(--bg-elevated)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border-subtle)',
                    }}
                >
                    Preview Mask
                </button>
                <button
                    onClick={handleGenerate}
                    disabled={!expandRegion || isGenerating || !prompt.trim()}
                    className="flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-40"
                    style={{
                        background: isGenerating ? 'var(--bg-surface)' : 'var(--accent-primary)',
                        color: '#fff',
                        border: 'none',
                        boxShadow: !isGenerating && expandRegion ? 'var(--shadow-glow)' : 'none',
                    }}
                >
                    {isGenerating ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {isGenerating ? "Generating..." : "Generate"}
                </button>
            </div>

            {/* Mask preview */}
            {maskPreviewUrl && (
                <div className="panel-card overflow-hidden p-0">
                    <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-widest"
                         style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                        Mask Preview
                    </div>
                    <div className="p-2">
                        <img
                            src={maskPreviewUrl}
                            alt="Binary mask"
                            className="h-32 w-full rounded-md object-contain"
                            style={{ background: 'var(--bg-app)' }}
                        />
                    </div>
                    <div className="px-3 py-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        ■ Black = preserve · □ White = AI generation
                    </div>
                </div>
            )}

            {/* How it works */}
            <div className="panel-card text-[11px]" style={{ borderColor: 'rgba(0, 229, 255, 0.15)' }}>
                <p className="font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>How it works</p>
                <ol className="list-decimal list-inside space-y-1" style={{ color: 'var(--text-muted)' }}>
                    <li>Draw an expansion region around your image</li>
                    <li>Choose an aspect ratio or keep Free</li>
                    <li>Describe what should appear in the new area</li>
                    <li>Click Generate — AI fills the void seamlessly</li>
                </ol>
            </div>
        </div>
    )
}

export default GenerativeExpand
