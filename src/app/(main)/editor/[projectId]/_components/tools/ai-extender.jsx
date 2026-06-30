"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, ImagePlus, Square } from 'lucide-react'
import { Rect } from 'fabric'
import { useCanvas } from '../../../../../../../context/context'
import { useDatabaseMutation } from '../../../../../../../hooks/useDatabaseQuery'
import { api } from "@/lib/neon-api";
import {
    getCanvasActiveImage,
} from '../../../../../../lib/imagekit-ai'
import { serializeCanvasState } from '../../../../../../lib/canvas-state'
import {
    canvasBoundsToScreen,
    buildVisibleImageBlob,
    frameToPixelExpansion,
    getFrameBoundsFromFabricRect,
    getSourcePixelDimensions,
    isCanvasLive,
    MAX_OUTPUT_DIMENSION,
    removeExpansionFramesFromCanvas,
    showEdgeControlsOnly,
    silenceImageForExpansion,
    unionFrameBounds,
    validateExpansion,
} from '../../../../../../lib/expansion-pipeline'
import {
    cancelExtendPoll,
    hasPendingExtend,
    startExtendPoll,
} from '../../../../../../lib/extend-poller'

const isRemoteImageUrl = (url) =>
    typeof url === 'string' &&
    /^https?:\/\//i.test(url) &&
    !url.startsWith('data:') &&
    !url.startsWith('blob:')

const getVisibleImageUrl = (image, project) =>
    [
        image?.getSrc?.(),
        image?._originalElement?.src,
        image?._element?.src,
        project?.currentImageUrl,
        project?.originalImageUrl,
    ].find(isRemoteImageUrl) || ''

const getBlobExtension = (blob) => {
    const type = String(blob?.type || '').toLowerCase()
    if (type.includes('webp')) return 'webp'
    if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
    return 'png'
}

const buildExtendRequest = ({ sourceUrl, sourceRender, expansion, prompt }) => {
    if (sourceRender?.blob?.size) {
        const formData = new FormData()
        formData.append(
            'sourceFile',
            sourceRender.blob,
            `visible-source-${Date.now()}.${getBlobExtension(sourceRender.blob)}`
        )
        if (sourceUrl) formData.append('sourceUrl', sourceUrl)
        formData.append('expansion', JSON.stringify(expansion))
        formData.append('prompt', prompt || '')
        formData.append('targetWidth', String(expansion.targetWidth))
        formData.append('targetHeight', String(expansion.targetHeight))

        return {
            body: formData,
            headers: undefined,
            sourceMode: 'visible-canvas-upload',
        }
    }

    return {
        body: JSON.stringify({
            sourceUrl,
            expansion,
            prompt,
            targetWidth: expansion.targetWidth,
            targetHeight: expansion.targetHeight,
        }),
        headers: { 'Content-Type': 'application/json' },
        sourceMode: 'remote-url',
    }
}

const AIExtender = ({ project }) => {
    const { canvasEditor, setProcessingMessage, setExpansionPreview } = useCanvas()
    const { mutate: updateProject } = useDatabaseMutation(api.projects.updateProject)

    const [prompt, setPrompt] = useState(
        'soft cinematic continuation, realistic background, seamless extension'
    )
    const [isApplying, setIsApplying] = useState(false)
    const [sourceDims, setSourceDims] = useState(null)
    const [targetDims, setTargetDims] = useState(null)

    const expansionFrameRef = useRef(null)
    const frameDimsRafRef = useRef(null)
    const setupGenerationRef = useRef(0)
    const abortControllerRef = useRef(null)

    // Bumped whenever an image is added/removed on the canvas so activeImage
    // (and the expansion frame built around it) re-resolves after an extension
    // replaces the image, after the background poller swaps the soft preview
    // for the real result, and after undo/redo recreates objects. Without it
    // the panel keeps a stale reference to a removed image and a second
    // extension silently works from dead pixels.
    const [imageRevision, setImageRevision] = useState(0)
    useEffect(() => {
        if (!canvasEditor) return undefined
        const bump = (opt) => {
            if (opt?.target?.type?.toLowerCase?.() === 'image') {
                setImageRevision((v) => v + 1)
            }
        }
        canvasEditor.on('object:added', bump)
        canvasEditor.on('object:removed', bump)
        return () => {
            canvasEditor.off('object:added', bump)
            canvasEditor.off('object:removed', bump)
        }
    }, [canvasEditor])

    const activeImage = useMemo(
        () => getCanvasActiveImage(canvasEditor),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [canvasEditor, imageRevision]
    )

    const syncExpansionPreview = useCallback(() => {
        const canvas = canvasEditor
        const frame = expansionFrameRef.current
        const image = activeImage
        if (!isCanvasLive(canvas) || !frame || !image) return

        try {
            const imageBounds = image.getBoundingRect()
            const frameBounds = getFrameBoundsFromFabricRect(frame)
            const pixelDims = getSourcePixelDimensions(image)
            if (!pixelDims.width || !pixelDims.height) return

            const expansion = frameToPixelExpansion(imageBounds, frameBounds, pixelDims)
            setSourceDims({ width: pixelDims.width, height: pixelDims.height })
            setTargetDims({ width: expansion.targetWidth, height: expansion.targetHeight })

            const host =
                canvas.upperCanvasEl?.closest?.('.editor-canvas-host') ||
                canvas.upperCanvasEl?.parentElement?.parentElement
            const hostSize = {
                width: host?.clientWidth || canvas.getWidth(),
                height: host?.clientHeight || canvas.getHeight(),
            }

            setExpansionPreview?.({
                targetWidth: expansion.targetWidth,
                targetHeight: expansion.targetHeight,
                insets: expansion.insets,
                frameScreen: canvasBoundsToScreen(canvas, frameBounds),
                imageScreen: canvasBoundsToScreen(canvas, imageBounds),
                hostSize,
            })
        } catch (err) {
            console.warn('[ai-extender] preview sync skipped:', err)
        }
    }, [activeImage, canvasEditor, setExpansionPreview])

    const schedulePreviewSync = useCallback(() => {
        if (frameDimsRafRef.current) return
        frameDimsRafRef.current = requestAnimationFrame(() => {
            frameDimsRafRef.current = null
            syncExpansionPreview()
        })
    }, [syncExpansionPreview])

    const removeExpansionFrame = useCallback(() => {
        if (!canvasEditor) return
        if (frameDimsRafRef.current) {
            cancelAnimationFrame(frameDimsRafRef.current)
            frameDimsRafRef.current = null
        }
        if (expansionFrameRef.current) {
            try {
                canvasEditor.remove(expansionFrameRef.current)
            } catch {
                /* ignore */
            }
            expansionFrameRef.current = null
        }
        removeExpansionFramesFromCanvas(canvasEditor)
        setTargetDims(null)
        setExpansionPreview?.(null)
    }, [canvasEditor, setExpansionPreview])

    const unlockImage = useCallback(
        (image) => {
            const target = image || activeImage
            if (!target) return
            target.set({
                selectable: true,
                evented: true,
                hasControls: true,
                hasBorders: true,
                lockMovementX: false,
                lockMovementY: false,
                lockScalingX: false,
                lockScalingY: false,
            })
            canvasEditor?.requestRenderAll?.()
        },
        [activeImage, canvasEditor]
    )

    const lockImage = useCallback((image) => {
        silenceImageForExpansion(image)
    }, [])

    /**
     * Silence image for expansion without visually dirtying it.
     * We avoid calling image.set() with properties that trigger a full
     * re-render from the source element (which loses edited pixels).
     * Instead we set properties individually, then clear the dirty flag.
     */
    const safelyLockImage = useCallback((image) => {
        if (!image) return
        // Lock without triggering a full dirty re-render
        image.selectable = false
        image.evented = false
        image.hasControls = false
        image.hasBorders = false
        image.hoverCursor = 'default'
        image.moveCursor = 'default'
        image.lockMovementX = true
        image.lockMovementY = true
        image.lockScalingX = true
        image.lockScalingY = true
        image.lockRotation = true
        // Don't mark dirty — preserve the current rendered state
        image.dirty = false
    }, [])

    useEffect(() => {
        if (!canvasEditor || !activeImage) {
            canvasEditor && (canvasEditor.__expansionMode = false)
            removeExpansionFrame()
            return undefined
        }

        const pixelDims = getSourcePixelDimensions(activeImage)
        if (pixelDims.width < 1 || pixelDims.height < 1) {
            return undefined
        }

        const setupGen = ++setupGenerationRef.current
        canvasEditor.__expansionMode = true
        removeExpansionFramesFromCanvas(canvasEditor)

        // Use safelyLockImage instead of silenceImageForExpansion to avoid
        // dirtying the image (which causes it to re-render from the original
        // source element, losing edited pixel data)
        canvasEditor.getObjects().forEach((obj) => {
            if (obj?.type?.toLowerCase() === 'image') {
                safelyLockImage(obj)
            }
        })

        const image = activeImage
        const bounds = image.getBoundingRect()
        setSourceDims({ width: pixelDims.width, height: pixelDims.height })

        const minFrame = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }

        const frame = new Rect({
            left: minFrame.left,
            top: minFrame.top,
            width: minFrame.width,
            height: minFrame.height,
            originX: 'left',
            originY: 'top',
            fill: 'rgba(125, 235, 255, 0.08)',
            stroke: 'rgba(125, 235, 255, 0.95)',
            strokeWidth: 1.5,
            strokeDashArray: [6, 4],
            cornerColor: '#F8FBFF',
            cornerStrokeColor: '#031014',
            cornerSize: 14,
            touchCornerSize: 24,
            transparentCorners: false,
            cornerStyle: 'circle',
            borderColor: 'rgba(125, 235, 255, 0.95)',
            borderScaleFactor: 1.5,
            selectable: true,
            evented: true,
            hasControls: true,
            hasBorders: false,
            centeredScaling: false,
            lockMovementX: true,
            lockMovementY: true,
            lockUniScaling: false,
            lockScalingFlip: true,
            lockRotation: true,
            hasRotatingPoint: false,
            _isExpansionFrame: true,
        })

        showEdgeControlsOnly(frame)

        const commitFrameSize = () => {
            const imgBounds = image.getBoundingRect()
            const frameBounds = getFrameBoundsFromFabricRect(frame)
            const union = unionFrameBounds(imgBounds, frameBounds)

            frame.set({
                ...union,
                scaleX: 1,
                scaleY: 1,
                originX: 'left',
                originY: 'top',
            })
            frame.setCoords()
            showEdgeControlsOnly(frame)
            canvasEditor.setActiveObject(frame)
            canvasEditor.requestRenderAll()
            schedulePreviewSync()
        }

        frame.on('scaling', schedulePreviewSync)
        frame.on('modified', commitFrameSize)

        if (setupGen !== setupGenerationRef.current) {
            return undefined
        }

        expansionFrameRef.current = frame
        canvasEditor.add(frame)
        canvasEditor.bringObjectToFront(frame)
        canvasEditor.discardActiveObject()
        canvasEditor.setActiveObject(frame)
        showEdgeControlsOnly(frame)
        safelyLockImage(image)

        canvasEditor.skipTargetFind = false
        canvasEditor.defaultCursor = 'default'
        canvasEditor.hoverCursor = 'default'
        canvasEditor.moveCursor = 'default'
        if (canvasEditor.upperCanvasEl) {
            canvasEditor.upperCanvasEl.style.cursor = 'default'
        }

        canvasEditor.requestRenderAll()
        schedulePreviewSync()

        const guardPointer = (opt) => {
            if (!canvasEditor.__expansionMode) return
            const target = opt.target
            if (target?.type?.toLowerCase() === 'image') {
                canvasEditor.setActiveObject(frame)
                canvasEditor.requestRenderAll()
            }
        }

        canvasEditor.on('mouse:down', guardPointer)

        const focusFrame = requestAnimationFrame(() => {
            if (setupGen !== setupGenerationRef.current || !isCanvasLive(canvasEditor)) return
            canvasEditor.setActiveObject(frame)
            showEdgeControlsOnly(frame)
            safelyLockImage(image)
            canvasEditor.requestRenderAll()
        })

        return () => {
            cancelAnimationFrame(focusFrame)
            canvasEditor.off('mouse:down', guardPointer)
            frame.off('scaling', schedulePreviewSync)
            frame.off('modified', commitFrameSize)
            if (frameDimsRafRef.current) {
                cancelAnimationFrame(frameDimsRafRef.current)
                frameDimsRafRef.current = null
            }
            canvasEditor.__expansionMode = false
            unlockImage(image)
            removeExpansionFrame()
        }
    }, [
        activeImage,
        canvasEditor,
        lockImage,
        removeExpansionFrame,
        safelyLockImage,
        schedulePreviewSync,
        unlockImage,
    ])

    const handleCancel = useCallback(() => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
            abortControllerRef.current = null
        }
        // Note: a background poll for an ALREADY-applied soft preview is left
        // running on purpose — cancelling here only stops the in-flight
        // request; the real result for a previous soft preview should still
        // swap in when it lands.
        setIsApplying(false)
        setProcessingMessage(null)
        toast.info('Extension cancelled')
    }, [setProcessingMessage])

    const handleApply = async () => {
        if (isApplying) return
        if (!activeImage) {
            toast.error('Add an image to the canvas first')
            return
        }

        const frame = expansionFrameRef.current
        if (!frame) {
            toast.error('Expansion frame not found — reselect the Extender tool')
            return
        }

        // The image can leave the canvas between renders (undo past the
        // extension, background swap mid-gesture). Never export dead pixels.
        if (!canvasEditor?.getObjects?.()?.includes(activeImage)) {
            toast.error('The image changed — adjust the frame and try again')
            setImageRevision((v) => v + 1)
            return
        }

        const imageBounds = activeImage.getBoundingRect()
        const frameBounds = getFrameBoundsFromFabricRect(frame)

        // Abort any prior running request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
        }
        const controller = new AbortController()
        abortControllerRef.current = controller

        // A previous extension's real result may still be cooking. Starting a
        // new one supersedes it — and the visible pixels being extended are
        // the soft preview's, so tell the user what they're working from.
        if (hasPendingExtend(project._id)) {
            cancelExtendPoll(project._id)
            toast.warning(
                'The previous extension was still finalising — this new extension starts from the current preview.'
            )
        }

        // Freeze the frame while the request is in flight: a mid-flight resize
        // would silently disagree with the expansion that was actually sent.
        frame.set({ selectable: false, evented: false })
        canvasEditor?.discardActiveObject?.()
        canvasEditor?.requestRenderAll?.()
        const unfreezeFrame = () => {
            const liveFrame = expansionFrameRef.current
            if (!liveFrame || !isCanvasLive(canvasEditor)) return
            liveFrame.set({ selectable: true, evented: true })
            canvasEditor.setActiveObject(liveFrame)
            canvasEditor.requestRenderAll()
        }

        setIsApplying(true)
        setProcessingMessage('Preparing extension...')

        try {
            const sourceUrl = getVisibleImageUrl(activeImage, project)

            if (!sourceUrl) {
                toast.error('No image URL found for this project')
                return
            }

            const visibleSource = await buildVisibleImageBlob(activeImage)
            console.log('[AI Extender] Source URL:', sourceUrl)
            console.log('[AI Extender] Source render:', visibleSource
                ? { width: visibleSource.width, height: visibleSource.height, bytes: visibleSource.blob.size, type: visibleSource.blob.type }
                : 'visible-export-failed'
            )

            if (!visibleSource?.blob?.size) {
                throw new Error('Could not export the visible edited pixels for AI Extend. Reload the project and try again.')
            }

            const fabricDims = visibleSource
                ? { width: visibleSource.width, height: visibleSource.height }
                : getSourcePixelDimensions(activeImage)
            const pixelDims = {
                width: fabricDims.width > 0 ? fabricDims.width : project?.width,
                height: fabricDims.height > 0 ? fabricDims.height : project?.height,
            }

            if (!pixelDims.width || !pixelDims.height) {
                toast.error('Image dimensions are not available yet')
                return
            }

            const expansion = frameToPixelExpansion(imageBounds, frameBounds, pixelDims)
            const validation = validateExpansion(expansion)

            if (!validation.valid) {
                toast.error(validation.error)
                return
            }

            console.log('[AI Extender] Expansion:', JSON.stringify(expansion))

            if (controller.signal.aborted) return

            setProcessingMessage('Extending with AI (full image)...')
            const request = buildExtendRequest({
                sourceUrl,
                sourceRender: visibleSource,
                expansion,
                prompt,
            })

            const res = await fetch('/api/ai/extend', {
                method: 'POST',
                ...(request.headers ? { headers: request.headers } : {}),
                body: request.body,
                signal: controller.signal,
            })

            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
                throw new Error(data.error || `Extension failed (${res.status})`)
            }

            const genfillUrl = data.url
            if (!genfillUrl) throw new Error('No result URL returned')

            console.log('[AI Extender] API response:', {
                method: data.method,
                sourceMode: request.sourceMode,
                uploadedUrl: data.uploadedUrl,
                url: genfillUrl,
            })

            if (controller.signal.aborted) return
            const readyUrl = genfillUrl

            if (controller.signal.aborted) return

            // Try to load the result image FIRST, before modifying canvas state.
            // If loading fails, we want the canvas to stay in its current state.
            setProcessingMessage('Loading extended image...')
            let nextImage
            try {
                const { FabricImage } = await import('fabric')
                nextImage = await FabricImage.fromURL(readyUrl, {
                    crossOrigin: readyUrl.startsWith('data:') || readyUrl.startsWith('blob:') ? undefined : 'anonymous',
                })
            } catch (loadErr) {
                console.warn('[AI Extender] Image load failed, restoring canvas:', loadErr)
                // Don't touch the canvas — leave it as-is with expansion frame
                throw new Error('Extended image could not be loaded. Your original image is preserved.')
            }

            if (!nextImage?.width || !nextImage?.height) {
                throw new Error('Extended image failed to load on canvas')
            }

            // Image loaded successfully — now safe to modify the canvas
            unlockImage(activeImage)
            removeExpansionFrame()

            nextImage.set({
                left: 0,
                top: 0,
                angle: activeImage.angle,
                originX: 'left',
                originY: 'top',
                scaleX: 1,
                scaleY: 1,
                selectable: activeImage.selectable,
                evented: activeImage.evented,
            })

            if (typeof nextImage.setSrc === 'function') {
                await nextImage.setSrc(readyUrl, { crossOrigin: 'anonymous' })
            }

            canvasEditor.remove(activeImage)
            canvasEditor.add(nextImage)
            nextImage.setCoords()
            canvasEditor.discardActiveObject()
            canvasEditor.requestRenderAll()

            const outputW = nextImage.width || expansion.targetWidth
            const outputH = nextImage.height || expansion.targetHeight

            canvasEditor.__fitCanvasToProject?.({ width: outputW, height: outputH })
            canvasEditor.__pushHistoryState?.({ label: 'AI extended image', domain: 'extend' })

            try {
                await updateProject({
                    projectId: project._id,
                    currentImageUrl: readyUrl,
                    width: outputW,
                    height: outputH,
                    canvasState: serializeCanvasState(canvasEditor),
                })
            } catch (saveError) {
                console.warn('Canvas state save failed:', saveError)
                await updateProject({
                    projectId: project._id,
                    currentImageUrl: readyUrl,
                    width: outputW,
                    height: outputH,
                }).catch(() => {})
            }

            if (data.method === 'local-soft-extend') {
                if (data.pendingGenfillUrl) {
                    toast.warning('AI is taking longer than expected — showing a soft preview. The real result will replace it automatically, even if you keep editing.')
                    // Module-scoped poller: survives tool switches, undo/redo
                    // (it re-finds the preview by src), and page reloads.
                    startExtendPoll({
                        projectId: project._id,
                        pendingGenfillUrl: data.pendingGenfillUrl,
                        fallbackUrl: readyUrl,
                    })
                } else {
                    toast.warning('ImageKit is still preparing, so a soft extension was applied.')
                }
            } else {
                toast.success('Image extended successfully!')
            }
        } catch (error) {
            if (error?.name !== 'AbortError') {
                console.warn('AI extender failed:', error)
                toast.error(error?.message || 'Failed to extend image')
            }
        } finally {
            // No-op after success (the frame was removed); restores
            // interactivity after errors, aborts, and validation bails.
            unfreezeFrame()
            if (abortControllerRef.current === controller) {
                abortControllerRef.current = null
            }
            setIsApplying(false)
            setProcessingMessage(null)
        }
    }

    // Cleanup abort controller on unmount. The extend-poller is deliberately
    // NOT cancelled here — it outlives the panel so a pending soft preview
    // still gets its real result.
    useEffect(() => {
        return () => {
            abortControllerRef.current?.abort()
        }
    }, [])

    if (!canvasEditor) {
        return (
            <div className="p-4">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Load an image to extend
                </p>
            </div>
        )
    }

    if (!activeImage) {
        return (
            <div className="p-4">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Add an image to the canvas first
                </p>
            </div>
        )
    }

    return (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto overflow-x-hidden pr-2 panel-scroll">
            <div className="space-y-2">
                <label className="panel-label">Extension Prompt</label>
                <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                    placeholder="Describe what should appear in the extended area"
                    className="panel-input resize-none"
                    style={{ minHeight: '68px' }}
                    disabled={isApplying}
                />
            </div>

            {sourceDims && targetDims && (
                <div
                    className="panel-card text-[11px] space-y-1.5"
                    style={{ borderColor: 'rgba(125, 235, 255, 0.25)' }}
                >
                    <div className="flex items-center justify-between">
                        <span style={{ color: 'var(--text-muted)' }}>Source</span>
                        <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
                            {sourceDims.width} × {sourceDims.height}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span style={{ color: 'var(--text-muted)' }}>Target output</span>
                        <span className="font-mono font-medium" style={{ color: 'var(--accent-primary)' }}>
                            {targetDims.width} × {targetDims.height} px
                        </span>
                    </div>
                    {(sourceDims.width >= MAX_OUTPUT_DIMENSION || sourceDims.height >= MAX_OUTPUT_DIMENSION) && (
                        <p className="pt-1 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                            {sourceDims.width >= MAX_OUTPUT_DIMENSION && sourceDims.height >= MAX_OUTPUT_DIMENSION
                                ? 'Image is already at the maximum size on both axes — extension is not available.'
                                : sourceDims.width >= MAX_OUTPUT_DIMENSION
                                ? `Width is already at the ${MAX_OUTPUT_DIMENSION}px limit. Drag the top or bottom handle to extend vertically.`
                                : `Height is already at the ${MAX_OUTPUT_DIMENSION}px limit. Drag the left or right handle to extend horizontally.`}
                        </p>
                    )}
                </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={handleApply}
                    disabled={isApplying}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-40"
                    style={{
                        background: 'var(--accent-primary)',
                        color: '#fff',
                        border: 'none',
                    }}
                >
                    {isApplying ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <ImagePlus className="h-3.5 w-3.5" />
                    )}
                    {isApplying ? 'Extending...' : 'Extend Image'}
                </button>

                {isApplying && (
                    <button
                        type="button"
                        onClick={handleCancel}
                        className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-xs font-medium editor-interactive"
                        style={{
                            background: 'rgba(239, 68, 68, 0.15)',
                            color: '#ef4444',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                        }}
                    >
                        <Square className="h-3 w-3" style={{ fill: 'currentColor' }} />
                        Stop
                    </button>
                )}
            </div>

            <div className="panel-card text-[11px]" style={{ borderColor: 'rgba(125, 235, 255, 0.12)' }}>
                <p style={{ color: 'var(--text-muted)' }}>
                    Drag the <strong style={{ color: 'var(--text-secondary)' }}>cyan edge handles</strong> outward
                    past the photo (into the dark area you want filled). The badge shows output size. Click{' '}
                    <strong style={{ color: 'var(--text-secondary)' }}>Extend Image</strong> to generate.
                </p>
            </div>
        </div>
    )
}

export default AIExtender
