"use client"

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useCanvas } from '../../../../../../../context/context'
import { Expand, Image as ImageIcon, Lock, Maximize2, Unlock } from 'lucide-react'
import { toast } from 'sonner'
import { ProRulerSlider } from '@/components/editor/ProRulerSlider'
import { useDatabaseMutation } from '../../../../../../../hooks/useDatabaseQuery'
import { api } from "@/lib/neon-api";
import { serializeCanvasState } from '../../../../../../lib/canvas-state'

const isImageObject = (obj) => obj?.type?.toLowerCase() === 'image'

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const getBaseSize = (image) => ({
    width: Math.max(1, Math.round(image?.width || image?._originalElement?.naturalWidth || 1)),
    height: Math.max(1, Math.round(image?.height || image?._originalElement?.naturalHeight || 1)),
})

const getScaledSize = (image) => ({
    width: Math.max(1, Math.round(Math.abs(image?.getScaledWidth?.() || (image?.width || 1) * (image?.scaleX || 1)))),
    height: Math.max(1, Math.round(Math.abs(image?.getScaledHeight?.() || (image?.height || 1) * (image?.scaleY || 1)))),
})

const getVisibleImages = (canvasEditor) =>
    (canvasEditor?.getObjects?.() || []).filter((obj) => isImageObject(obj) && obj.visible !== false)

const ResizeControls = ({ project, dominantColor, contrastingColor }) => {
    const { canvasEditor } = useCanvas()
    const [selectedImage, setSelectedImage] = useState(null)
    const [currentSize, setCurrentSize] = useState({ width: 0, height: 0 })
    const [newWidth, setNewWidth] = useState(0)
    const [newHeight, setNewHeight] = useState(0)
    const [scalePercent, setScalePercent] = useState(100)
    const [lockAspectRatio, setLockAspectRatio] = useState(true)
    const [canvasWidth, setCanvasWidth] = useState(project?.width || 0)
    const [canvasHeight, setCanvasHeight] = useState(project?.height || 0)
    const [lockCanvasAspectRatio, setLockCanvasAspectRatio] = useState(true)
    const { mutate: updateProject } = useDatabaseMutation(api.projects.updateProject)

    const baseSize = useMemo(() => getBaseSize(selectedImage), [selectedImage])
    const aspectRatio = baseSize.height / baseSize.width
    const projectAspectRatio = Math.max(1, project?.height || 1) / Math.max(1, project?.width || 1)

    useEffect(() => {
        const syncFrame = requestAnimationFrame(() => {
            setCanvasWidth(project?.width || 0)
            setCanvasHeight(project?.height || 0)
        })
        return () => cancelAnimationFrame(syncFrame)
    }, [project?.width, project?.height])

    const syncFromImage = useCallback((image) => {
        if (!image) {
            setSelectedImage(null)
            setCurrentSize({ width: 0, height: 0 })
            setNewWidth(0)
            setNewHeight(0)
            setScalePercent(100)
            return
        }

        const scaled = getScaledSize(image)
        const base = getBaseSize(image)
        setSelectedImage(image)
        setCurrentSize(scaled)
        setNewWidth(scaled.width)
        setNewHeight(scaled.height)
        setScalePercent(Math.round((scaled.width / base.width) * 100))
    }, [])

    const syncSelection = useCallback(() => {
        if (!canvasEditor) return
        const active = canvasEditor.getActiveObject?.()
        if (isImageObject(active) && active.visible !== false) {
            syncFromImage(active)
            return
        }
        syncFromImage(null)
    }, [canvasEditor, syncFromImage])

    useEffect(() => {
        if (!canvasEditor) return

        const active = canvasEditor.getActiveObject?.()
        if (!isImageObject(active) || active.visible === false) {
            const topVisibleImage = getVisibleImages(canvasEditor).at(-1)
            if (topVisibleImage) {
                canvasEditor.setActiveObject(topVisibleImage)
                canvasEditor.requestRenderAll()
            }
        }

        const syncFrame = requestAnimationFrame(syncSelection)
        const events = [
            'selection:created',
            'selection:updated',
            'selection:cleared',
            'object:added',
            'object:removed',
            'object:modified',
            'object:scaling',
        ]
        events.forEach((eventName) => canvasEditor.on(eventName, syncSelection))
        return () => {
            cancelAnimationFrame(syncFrame)
            events.forEach((eventName) => canvasEditor.off(eventName, syncSelection))
        }
    }, [canvasEditor, syncSelection])

    const resizeImage = useCallback((width, height, { commit = false } = {}) => {
        if (!canvasEditor || !selectedImage) return

        const base = getBaseSize(selectedImage)
        const safeWidth = clamp(Math.round(width) || 1, 1, 20000)
        const safeHeight = clamp(Math.round(height) || 1, 1, 20000)
        selectedImage.set({
            scaleX: safeWidth / base.width,
            scaleY: safeHeight / base.height,
        })
        selectedImage.setCoords()
        canvasEditor.setActiveObject(selectedImage)
        canvasEditor.requestRenderAll()

        if (commit) {
            setCurrentSize({ width: safeWidth, height: safeHeight })
            canvasEditor.fire('object:modified', { target: selectedImage })
            canvasEditor.__pushHistoryState?.({ label: 'Resized image', domain: 'resize' })
            canvasEditor.__saveCanvasState?.()
        }
    }, [canvasEditor, selectedImage])

    const handleWidthChange = (value) => {
        const width = clamp(parseInt(value, 10) || 1, 1, 20000)
        const height = lockAspectRatio ? Math.max(1, Math.round(width * aspectRatio)) : newHeight
        setNewWidth(width)
        setNewHeight(height)
        setScalePercent(Math.round((width / baseSize.width) * 100))
    }

    const handleHeightChange = (value) => {
        const height = clamp(parseInt(value, 10) || 1, 1, 20000)
        const width = lockAspectRatio ? Math.max(1, Math.round(height / aspectRatio)) : newWidth
        setNewHeight(height)
        setNewWidth(width)
        setScalePercent(Math.round((width / baseSize.width) * 100))
    }

    const setImageScale = (percent, commit = false) => {
        if (!selectedImage) return
        const nextScale = clamp(percent, 1, 500)
        const width = Math.max(1, Math.round(baseSize.width * (nextScale / 100)))
        const height = Math.max(1, Math.round(baseSize.height * (nextScale / 100)))
        setScalePercent(nextScale)
        setNewWidth(width)
        setNewHeight(height)
        resizeImage(width, height, { commit })
    }

    const applyImageResize = () => {
        if (!selectedImage) {
            toast.error('Select an image layer first')
            return
        }

        resizeImage(newWidth, newHeight, { commit: true })
        toast.success('Image resized')
    }

    const fitImageToCanvas = (mode) => {
        if (!selectedImage || !project?.width || !project?.height) return
        const fitScale = mode === 'fill'
            ? Math.max(project.width / baseSize.width, project.height / baseSize.height)
            : Math.min(project.width / baseSize.width, project.height / baseSize.height)
        setImageScale(Math.round(fitScale * 100), true)
        toast.success(mode === 'fill' ? 'Image filled the canvas frame' : 'Image fit inside the canvas frame')
    }

    const handleCanvasWidthChange = (value) => {
        const width = clamp(parseInt(value, 10) || 1, 1, 20000)
        const height = lockCanvasAspectRatio ? Math.max(1, Math.round(width * projectAspectRatio)) : canvasHeight
        setCanvasWidth(width)
        setCanvasHeight(height)
    }

    const handleCanvasHeightChange = (value) => {
        const height = clamp(parseInt(value, 10) || 1, 1, 20000)
        const width = lockCanvasAspectRatio ? Math.max(1, Math.round(height / projectAspectRatio)) : canvasWidth
        setCanvasHeight(height)
        setCanvasWidth(width)
    }

    const applyCanvasResize = async () => {
        if (!project?._id || !canvasEditor) return
        const width = clamp(Math.round(canvasWidth) || 1, 1, 20000)
        const height = clamp(Math.round(canvasHeight) || 1, 1, 20000)
        if (width === project.width && height === project.height) {
            toast.message('Canvas size is already applied')
            return
        }

        const toastId = toast.loading('Updating canvas size...')
        try {
            canvasEditor.__fitCanvasToProject?.({ width, height })
            await updateProject({
                projectId: project._id,
                width,
                height,
                canvasState: serializeCanvasState(canvasEditor),
            })
            canvasEditor.__pushHistoryState?.({ label: 'Resized canvas', domain: 'resize' })
            toast.success('Canvas size updated', { id: toastId })
        } catch (error) {
            console.error('[Resize] Failed to update canvas size:', error)
            toast.error(error?.message || 'Failed to update canvas size', { id: toastId })
        }
    }

    if (!canvasEditor || !project) {
        return (
            <div className='p-4'>
                <p className='text-white/70 text-sm'>Canvas not ready</p>
            </div>
        )
    }

    const hasChanges = selectedImage && (newWidth !== currentSize.width || newHeight !== currentSize.height)
    const hasCanvasChanges = project && (canvasWidth !== project.width || canvasHeight !== project.height)

    return (
        <div className='space-y-4'>
            <div className='panel-card'>
                <div className='flex items-center justify-between gap-2'>
                    <label className='panel-label'>Canvas Size</label>
                    <button
                        type='button'
                        onClick={() => setLockCanvasAspectRatio(!lockCanvasAspectRatio)}
                        className="flex h-7 w-7 items-center justify-center rounded-lg editor-interactive"
                        style={{ color: lockCanvasAspectRatio ? dominantColor || 'var(--accent-primary)' : 'var(--text-muted)', background: 'transparent' }}
                        title={lockCanvasAspectRatio ? 'Unlock canvas aspect ratio' : 'Lock canvas aspect ratio'}
                    >
                        {lockCanvasAspectRatio ? <Lock className='h-3.5 w-3.5' /> : <Unlock className='h-3.5 w-3.5' />}
                    </button>
                </div>

                <div className='mt-3 grid grid-cols-[repeat(auto-fit,minmax(100px,1fr))] gap-2'>
                    <div>
                        <label className='mb-1 block text-[10px]' style={{ color: 'var(--text-muted)' }}>Width</label>
                        <input
                            type="number"
                            value={canvasWidth}
                            onChange={(e) => handleCanvasWidthChange(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && hasCanvasChanges) { e.preventDefault(); applyCanvasResize() } }}
                            min="1"
                            max="20000"
                            className="panel-input"
                        />
                    </div>
                    <div>
                        <label className='mb-1 block text-[10px]' style={{ color: 'var(--text-muted)' }}>Height</label>
                        <input
                            type="number"
                            value={canvasHeight}
                            onChange={(e) => handleCanvasHeightChange(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && hasCanvasChanges) { e.preventDefault(); applyCanvasResize() } }}
                            min="1"
                            max="20000"
                            className="panel-input"
                        />
                    </div>
                </div>

                <button
                    type='button'
                    onClick={applyCanvasResize}
                    disabled={!hasCanvasChanges}
                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-40"
                    style={{
                        background: hasCanvasChanges ? dominantColor || 'var(--accent-primary)' : 'var(--bg-elevated)',
                        color: hasCanvasChanges ? contrastingColor || '#fff' : 'var(--text-secondary)',
                        border: hasCanvasChanges ? 'none' : '1px solid var(--border-subtle)',
                        boxShadow: hasCanvasChanges ? `0 0 30px ${dominantColor || '#06b8d4'}40` : 'none',
                    }}
                >
                    <Maximize2 className='h-3.5 w-3.5' />
                    Apply Canvas Size
                </button>
            </div>

            {!selectedImage ? (
                <div className='panel-card flex flex-col items-center justify-center gap-3 text-center'>
                    <ImageIcon className='h-6 w-6' style={{ color: dominantColor || 'var(--accent-primary)' }} />
                    <div>
                        <p className='text-xs font-semibold' style={{ color: 'var(--text-primary)' }}>Select an image layer</p>
                        <p className='mt-1 text-[11px]' style={{ color: 'var(--text-muted)' }}>Choose an image on the canvas or in Layers to resize it.</p>
                    </div>
                </div>
            ) : (
                <>
                    <div className='space-y-3'>
                        <div className='flex items-center justify-between'>
                            <label className='panel-label'>Image Size</label>
                            <button
                                type='button'
                                onClick={() => setLockAspectRatio(!lockAspectRatio)}
                                className="flex h-7 w-7 items-center justify-center rounded-lg editor-interactive"
                                style={{ color: lockAspectRatio ? dominantColor || 'var(--accent-primary)' : 'var(--text-muted)', background: 'transparent' }}
                                title={lockAspectRatio ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                            >
                                {lockAspectRatio ? <Lock className='h-3.5 w-3.5' /> : <Unlock className='h-3.5 w-3.5' />}
                            </button>
                        </div>

                        <div className='grid grid-cols-[repeat(auto-fit,minmax(100px,1fr))] gap-2'>
                            <div>
                                <label className='mb-1 block text-[10px]' style={{ color: 'var(--text-muted)' }}>Width</label>
                                <input
                                    type="number"
                                    value={newWidth}
                                    onChange={(e) => handleWidthChange(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' && hasChanges) { e.preventDefault(); applyImageResize() } }}
                                    min="1"
                                    max="20000"
                                    className="panel-input"
                                />
                            </div>
                            <div>
                                <label className='mb-1 block text-[10px]' style={{ color: 'var(--text-muted)' }}>Height</label>
                                <input
                                    type="number"
                                    value={newHeight}
                                    onChange={(e) => handleHeightChange(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' && hasChanges) { e.preventDefault(); applyImageResize() } }}
                                    min="1"
                                    max="20000"
                                    className="panel-input"
                                />
                            </div>
                        </div>

                        <ProRulerSlider
                            variant="instrument"
                            value={scalePercent}
                            min={1}
                            max={500}
                            step={1}
                            label="Scale"
                            suffix="%"
                            onPreview={(value) => setImageScale(value, false)}
                            onCommit={(value) => setImageScale(value, true)}
                            visual={{
                                fill: 'rgba(47, 143, 203, 0.45)',
                                accent: dominantColor || '#5eb8ff',
                                trackBg: 'rgba(18, 22, 30, 0.96)',
                            }}
                        />
                    </div>

                    <div className='grid grid-cols-[repeat(auto-fit,minmax(90px,1fr))] gap-1.5'>
                        {[
                            { label: 'Original', icon: ImageIcon, action: () => setImageScale(100, true) },
                            { label: '50%', icon: Expand, action: () => setImageScale(50, true) },
                            { label: 'Fit', icon: Maximize2, action: () => fitImageToCanvas('fit') },
                            { label: 'Fill', icon: Maximize2, action: () => fitImageToCanvas('fill') },
                        ].map(({ label, icon: Icon, action }) => (
                            <button
                                key={label}
                                type='button'
                                onClick={action}
                                className='flex h-8 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive'
                                style={{
                                    background: 'var(--bg-elevated)',
                                    border: '1px solid var(--border-subtle)',
                                    color: 'var(--text-secondary)',
                                }}
                            >
                                <Icon className='h-3.5 w-3.5' />
                                {label}
                            </button>
                        ))}
                    </div>

                    {hasChanges && (
                        <div className='panel-card' style={{ borderColor: 'rgba(6, 184, 212, 0.2)' }}>
                            <label className='panel-label'>Pending Image Size</label>
                            <div className='mt-1.5 text-xs' style={{ color: 'var(--text-secondary)' }}>
                                <div className="font-mono">{newWidth} × {newHeight} px</div>
                                <div className='mt-1' style={{ color: 'var(--accent-primary)' }}>
                                    Canvas remains {project.width} × {project.height} px
                                </div>
                            </div>
                        </div>
                    )}

                    <button
                        type='button'
                        onClick={applyImageResize}
                        disabled={!hasChanges}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-40"
                        style={{
                            background: dominantColor || 'var(--accent-primary)',
                            color: contrastingColor || '#fff',
                            border: 'none',
                            boxShadow: hasChanges ? `0 0 30px ${dominantColor || '#06b8d4'}40` : 'none',
                        }}
                    >
                        <Expand className='h-3.5 w-3.5' />
                        Apply Image Resize
                    </button>
                </>
            )}
        </div>
    )
}

export default ResizeControls
