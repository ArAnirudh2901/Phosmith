"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, ImagePlus } from 'lucide-react'
import { Rect } from 'fabric'
import { useCanvas } from '../../../../../../../context/context'
import { useConvexMutation } from '../../../../../../../hooks/useConvexQuery'
import { api } from '../../../../../../../convex/_generated/api'
import { buildGenerativeFillUrl, getCanvasActiveImage, isImageKitUrl, normalizeImageKitUrl } from '../../../../../../lib/imagekit-ai'
import { serializeCanvasState } from '../../../../../../lib/canvas-state'

const MAX_OUTPUT_DIMENSION = 4096
const MAX_RETRIES = 8
const BASE_RETRY_DELAY = 4000

const getSourceUrl = (image, project) => {
    const candidates = [
        project?.currentImageUrl,
        project?.originalImageUrl,
        image?.getSrc?.(),
        image?._originalElement?.src,
    ].filter(Boolean)

    const imagekitUrl = candidates.find(url => url.includes('ik.imagekit.io'))
    return imagekitUrl || candidates[0] || ''
}

/**
 * Remove ALL leftover expansion frame Rects from the canvas.
 * This prevents stale frames from accumulating across tool switches.
 */
const removeAllExpansionFrames = (canvas) => {
    if (!canvas) return
    const frames = canvas.getObjects().filter(obj => obj._isExpansionFrame)
    frames.forEach(frame => {
        try { canvas.remove(frame) } catch (_) { }
    })
    if (frames.length > 0) {
        canvas.requestRenderAll()
    }
}

/**
 * Pre-fetch an image URL to verify it's ready (not still processing).
 */
const waitForImageReady = (url, timeoutMs = 20000) => {
    return new Promise((resolve) => {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        const timer = setTimeout(() => {
            img.onload = null
            img.onerror = null
            resolve(false)
        }, timeoutMs)

        img.onload = () => {
            clearTimeout(timer)
            // Also check that the image actually has content
            resolve(img.naturalWidth > 0 && img.naturalHeight > 0)
        }
        img.onerror = () => {
            clearTimeout(timer)
            resolve(false)
        }
        img.src = url
    })
}

const AIExtender = ({ project, dominantColor, contrastingColor, lighterColor }) => {
    const { canvasEditor, setProcessingMessage } = useCanvas()
    const { mutate: updateProject } = useConvexMutation(api.projects.updateProject)

    const [prompt, setPrompt] = useState('soft cinematic continuation, realistic background, seamless outpainting')
    const [isApplying, setIsApplying] = useState(false)
    const [frameDims, setFrameDims] = useState(null)
    const [originalDims, setOriginalDims] = useState(null)

    const expansionFrameRef = useRef(null)
    const activeImageRef = useRef(null)
    const originalImageStateRef = useRef(null)
    // Store the REAL pixel dimensions of the image (not canvas display size)
    const realImageDimsRef = useRef(null)

    const activeImage = useMemo(() => getCanvasActiveImage(canvasEditor), [canvasEditor])
    const sourceUrl = getSourceUrl(activeImage, project)

    useEffect(() => {
        activeImageRef.current = activeImage
    }, [activeImage])

    const removeExpansionFrame = useCallback(() => {
        if (!canvasEditor) return
        // Remove the tracked frame
        if (expansionFrameRef.current) {
            try { canvasEditor.remove(expansionFrameRef.current) } catch (_) { }
            expansionFrameRef.current = null
        }
        // Also clean up any orphaned expansion frames
        removeAllExpansionFrames(canvasEditor)
        setFrameDims(null)
    }, [canvasEditor])

    const unlockImage = useCallback(() => {
        const image = activeImageRef.current
        const original = originalImageStateRef.current
        if (image && original) {
            image.set({
                selectable: original.selectable !== false,
                evented: original.evented !== false,
                hasControls: original.hasControls !== false,
                hasBorders: original.hasBorders !== false,
                lockMovementX: false,
                lockMovementY: false,
                lockScalingX: false,
                lockScalingY: false,
            })
            originalImageStateRef.current = null
            canvasEditor?.requestRenderAll?.()
        }
    }, [canvasEditor])

    const lockImage = useCallback((image) => {
        originalImageStateRef.current = {
            selectable: image.selectable,
            evented: image.evented,
            hasControls: image.hasControls,
            hasBorders: image.hasBorders,
        }

        image.set({
            selectable: true,
            evented: true,
            hasControls: false,
            hasBorders: true,
            lockMovementX: false,
            lockMovementY: false,
            lockScalingX: true,
            lockScalingY: true,
        })
    }, [])

    /**
     * Auto-create expansion frame when tool mounts.
     */
    useEffect(() => {
        if (!canvasEditor || !activeImageRef.current) return

        // FIRST: Clean up any leftover expansion frames from previous sessions
        removeAllExpansionFrames(canvasEditor)

        const image = activeImageRef.current
        const bounds = image.getBoundingRect()
        const centerX = bounds.left + bounds.width / 2
        const centerY = bounds.top + bounds.height / 2

        // Store the REAL pixel dimensions of the image (not scaled canvas coordinates)
        // This is critical: ImageKit expects real pixel dimensions, not display pixels
        const realW = image.width || bounds.width
        const realH = image.height || bounds.height
        realImageDimsRef.current = { width: realW, height: realH }

        // Display dimensions use bounds (canvas coordinates)
        setOriginalDims({ width: Math.round(bounds.width), height: Math.round(bounds.height) })

        lockImage(image)

        const frame = new Rect({
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
            fill: 'rgba(125, 235, 255, 0.035)',
            stroke: 'rgba(125, 235, 255, 0.95)',
            strokeWidth: 3,
            strokeDashArray: [6, 4],
            cornerColor: '#F8FBFF',
            cornerStrokeColor: '#031014',
            cornerSize: 16,
            touchCornerSize: 28,
            padding: 8,
            transparentCorners: false,
            cornerStyle: 'circle',
            borderColor: 'rgba(125, 235, 255, 0.95)',
            borderScaleFactor: 2,
            selectable: true,
            evented: true,
            hasControls: true,
            hasBorders: true,
            centeredScaling: true,
            lockMovementX: true,
            lockMovementY: true,
            lockUniScaling: false,
            lockScalingFlip: true,
            lockRotation: true,
            hasRotatingPoint: false,
            _isExpansionFrame: true,
        })

        const getFrameSize = () => {
            const scaledW = frame.getScaledWidth?.() || frame.width * (frame.scaleX || 1)
            const scaledH = frame.getScaledHeight?.() || frame.height * (frame.scaleY || 1)
            return {
                width: Math.max(bounds.width, scaledW),
                height: Math.max(bounds.height, scaledH),
            }
        }

        const updateFrameDims = () => {
            const next = getFrameSize()
            setFrameDims({ width: Math.round(next.width), height: Math.round(next.height) })
        }

        const commitFrameSize = () => {
            const next = getFrameSize()

            frame.set({
                left: centerX - next.width / 2,
                top: centerY - next.height / 2,
                width: next.width,
                height: next.height,
                scaleX: 1,
                scaleY: 1,
            })
            frame.setCoords()
            setFrameDims({ width: Math.round(next.width), height: Math.round(next.height) })
            canvasEditor.requestRenderAll()
        }

        frame.on('scaling', updateFrameDims)
        frame.on('modified', commitFrameSize)

        expansionFrameRef.current = frame
        canvasEditor.add(frame)
        canvasEditor.setActiveObject(frame)
        canvasEditor.requestRenderAll()
        setFrameDims({ width: Math.round(bounds.width), height: Math.round(bounds.height) })

        // Cleanup when component unmounts
        return () => {
            unlockImage()
            if (expansionFrameRef.current) {
                try { canvasEditor.remove(expansionFrameRef.current) } catch (_) { }
                expansionFrameRef.current = null
            }
            // Also clean orphaned frames
            removeAllExpansionFrames(canvasEditor)
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvasEditor])

    const handleApply = async () => {
        if (!activeImageRef.current || !sourceUrl) {
            toast.error('Add an ImageKit image first')
            return
        }

        if (!isImageKitUrl(sourceUrl)) {
            toast.error('Generative fill only works with ImageKit-hosted images')
            return
        }

        const frame = expansionFrameRef.current
        if (!frame) {
            toast.error('Expansion frame not found')
            return
        }

        const imageBounds = activeImageRef.current.getBoundingRect()
        const realDims = realImageDimsRef.current

        // Calculate the frame size in canvas coordinates
        const frameDisplayW = Math.round(frame.width * (frame.scaleX || 1))
        const frameDisplayH = Math.round(frame.height * (frame.scaleY || 1))

        if (frameDisplayW <= imageBounds.width + 2 && frameDisplayH <= imageBounds.height + 2) {
            toast.error('Drag the frame handles outward beyond the image to extend')
            return
        }

        // Convert canvas display coordinates to REAL pixel dimensions
        // Scale factor: how much the image is scaled down to fit on canvas
        const scaleFactorX = realDims ? (realDims.width / imageBounds.width) : 1
        const scaleFactorY = realDims ? (realDims.height / imageBounds.height) : 1

        let targetW = Math.round(frameDisplayW * scaleFactorX)
        let targetH = Math.round(frameDisplayH * scaleFactorY)

        // Cap to max dimension
        if (targetW > MAX_OUTPUT_DIMENSION) {
            const ratio = MAX_OUTPUT_DIMENSION / targetW
            targetW = MAX_OUTPUT_DIMENSION
            targetH = Math.round(targetH * ratio)
        }
        if (targetH > MAX_OUTPUT_DIMENSION) {
            const ratio = MAX_OUTPUT_DIMENSION / targetH
            targetH = MAX_OUTPUT_DIMENSION
            targetW = Math.round(targetW * ratio)
        }

        // Ensure minimum dimensions
        targetW = Math.max(targetW, realDims?.width || 100)
        targetH = Math.max(targetH, realDims?.height || 100)

        // Build the generative fill URL using the ORIGINAL source
        const baseSourceUrl = normalizeImageKitUrl(
            project?.originalImageUrl || sourceUrl
        )
        const url = buildGenerativeFillUrl({
            sourceUrl: baseSourceUrl,
            prompt,
            width: targetW,
            height: targetH,
        })

        console.log('[AI Extender] Source URL:', baseSourceUrl)
        console.log('[AI Extender] Generated URL:', url)
        console.log('[AI Extender] Real image dims:', realDims)
        console.log('[AI Extender] Display bounds:', { w: imageBounds.width, h: imageBounds.height })
        console.log('[AI Extender] Scale factors:', { x: scaleFactorX, y: scaleFactorY })
        console.log('[AI Extender] Target dims:', targetW, '×', targetH)

        setIsApplying(true)
        setProcessingMessage('Extending image with AI...')

        try {
            unlockImage()
            removeExpansionFrame()

            const sourceImage = activeImageRef.current
            const { FabricImage } = await import('fabric')

            let nextImage = null
            let lastError = null

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    setProcessingMessage(
                        attempt === 1
                            ? 'Extending image with AI...'
                            : `Processing... (attempt ${attempt}/${MAX_RETRIES})`
                    )

                    // Pre-fetch to check readiness
                    const isReady = await waitForImageReady(url, 25000)

                    if (!isReady && attempt < MAX_RETRIES) {
                        console.warn(`[AI Extender] Image not ready on attempt ${attempt}, retrying...`)
                        const delay = Math.min(attempt * BASE_RETRY_DELAY, 20000)
                        await new Promise(resolve => setTimeout(resolve, delay))
                        continue
                    }

                    // Load into Fabric
                    nextImage = await FabricImage.fromURL(url, {
                        crossOrigin: 'anonymous',
                    })

                    if (nextImage && nextImage.width > 0 && nextImage.height > 0) {
                        break
                    } else {
                        throw new Error('Loaded image has zero dimensions')
                    }
                } catch (err) {
                    lastError = err
                    console.warn(`[AI Extender] Attempt ${attempt}/${MAX_RETRIES} failed:`, err?.message)
                    if (attempt < MAX_RETRIES) {
                        const delay = Math.min(attempt * BASE_RETRY_DELAY, 20000)
                        await new Promise(resolve => setTimeout(resolve, delay))
                    }
                }
            }

            if (!nextImage) {
                throw new Error(
                    `Failed to load extended image after ${MAX_RETRIES} attempts. ` +
                    `ImageKit may still be processing — try again in a few seconds. ` +
                    `(${lastError?.message || 'Unknown error'})`
                )
            }

            const outputW = nextImage.width || targetW
            const outputH = nextImage.height || targetH

            nextImage.set({
                left: outputW / 2,
                top: outputH / 2,
                originX: 'center',
                originY: 'center',
                scaleX: 1,
                scaleY: 1,
                selectable: true,
                evented: true,
                hasControls: true,
                hasBorders: true,
                lockMovementX: false,
                lockMovementY: false,
                lockScalingX: false,
                lockScalingY: false,
            })

            canvasEditor.remove(sourceImage)
            canvasEditor.add(nextImage)
            canvasEditor.setActiveObject(nextImage)
            nextImage.setCoords()
            canvasEditor.__fitCanvasToProject?.({ width: outputW, height: outputH })
            canvasEditor.requestRenderAll()

            activeImageRef.current = nextImage

            // Save state
            try {
                await updateProject({
                    projectId: project._id,
                    currentImageUrl: url,
                    width: outputW,
                    height: outputH,
                    canvasState: serializeCanvasState(canvasEditor),
                })
            } catch (saveError) {
                console.warn('Canvas state save failed:', saveError)
                try {
                    await updateProject({
                        projectId: project._id,
                        currentImageUrl: url,
                        width: outputW,
                        height: outputH,
                    })
                } catch (fallbackError) {
                    console.warn('Fallback save also failed:', fallbackError)
                }
            }

            toast.success('Image extended successfully!')
        } catch (error) {
            console.warn('AI extender failed:', error)
            toast.error(error?.message || 'Failed to extend image')
        } finally {
            setIsApplying(false)
            setProcessingMessage(null)
        }
    }

    return (
        <div className='flex h-full min-h-0 flex-col gap-4 overflow-y-auto overflow-x-hidden pr-2 panel-scroll'>
            {/* Prompt */}
            <div className='space-y-2'>
                <label className='panel-label'>Outpaint Prompt</label>
                <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                    placeholder='Describe what should appear in the extended area'
                    className='panel-input resize-none'
                    style={{ minHeight: '68px' }}
                />
            </div>

            {/* Dimension info */}
            {frameDims && originalDims && (
                <div className='panel-card text-[11px] space-y-1.5' style={{ borderColor: 'rgba(0, 229, 255, 0.25)' }}>
                    <div className='flex items-center justify-between'>
                        <span style={{ color: 'var(--text-muted)' }}>Original</span>
                        <span className='font-mono' style={{ color: 'var(--text-secondary)' }}>
                            {originalDims.width} × {originalDims.height}
                        </span>
                    </div>
                    <div className='flex items-center justify-between'>
                        <span style={{ color: 'var(--text-muted)' }}>Output</span>
                        <span className='font-mono font-medium' style={{ color: 'var(--accent-primary)' }}>
                            {frameDims.width} × {frameDims.height}
                        </span>
                    </div>
                </div>
            )}

            {/* Apply Button */}
            <button
                onClick={handleApply}
                disabled={!activeImage || isApplying}
                className='flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-40'
                style={{ 
                    background: dominantColor || 'var(--accent-primary)', 
                    color: contrastingColor || '#fff', 
                    border: 'none',
                    boxShadow: !isApplying ? `0 0 30px ${dominantColor}40` : 'none' 
                }}
            >
                {isApplying ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : <ImagePlus className='h-3.5 w-3.5' />}
                {isApplying ? 'Extending...' : 'Extend Image'}
            </button>

            {/* Instructions */}
            <div className='panel-card text-[11px]' style={{ borderColor: 'rgba(0, 229, 255, 0.1)' }}>
                <p style={{ color: 'var(--text-muted)' }}>
                    Drag the frame handles outward to define the extension area.
                    The frame expands from the image center so the generated result aligns with the canvas. Click <strong style={{ color: 'var(--text-secondary)' }}>Extend Image</strong> to AI-fill the empty space.
                </p>
            </div>
        </div>
    )
}

export default AIExtender
