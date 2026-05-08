"use client"

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Sparkles, Layers3, MoveHorizontal, MoveVertical, Loader2, ImagePlus, SlidersHorizontal, Square, Trash2 } from 'lucide-react'
import { Rect } from 'fabric'
import { useCanvas } from '../../../../../../../context/context'
import { useConvexMutation } from '../../../../../../../hooks/useConvexQuery'
import { api } from '../../../../../../../convex/_generated/api'
import { buildGenerativeFillUrl, getCanvasActiveImage, isImageKitUrl, normalizeImageKitUrl, replaceCanvasImageFromUrl } from '../../../../../../lib/imagekit-ai'
import { serializeCanvasState } from '../../../../../../lib/canvas-state'

const EXPAND_MODES = [
    { id: 'balanced', label: 'Balanced', description: 'Extend equally in all directions', icon: Layers3 },
    { id: 'horizontal', label: 'Wide', description: 'Extend left and right', icon: MoveHorizontal },
    { id: 'vertical', label: 'Tall', description: 'Extend top and bottom', icon: MoveVertical },
    { id: 'freestyle', label: 'Free Style', description: 'Set a custom extension amount', icon: SlidersHorizontal },
]

const EXTEND_PRESETS = [
    { id: 25, label: '25%', hint: 'Subtle extension' },
    { id: 50, label: '50%', hint: 'Standard outpaint' },
    { id: 75, label: '75%', hint: 'More canvas room' },
    { id: 100, label: '100%', hint: 'Maximum expansion' },
]

const getSourceUrl = (image, project) => {
    return image?.getSrc?.() || image?._originalElement?.src || project?.currentImageUrl || project?.originalImageUrl || ''
}

const getTargetDimensions = (image, mode, extensionPercent, freestyleAmount) => {
    const width = Math.max(1, Math.round(image?.width || 0))
    const height = Math.max(1, Math.round(image?.height || 0))

    if (mode === 'freestyle') {
        const freestyleScale = 1 + Math.max(0, freestyleAmount) / 100
        return {
            width: Math.round(width * freestyleScale),
            height: Math.round(height * freestyleScale),
        }
    }

    const scale = 1 + Math.max(0, extensionPercent) / 100

    if (mode === 'horizontal') {
        return { width: Math.round(width * scale), height }
    }

    if (mode === 'vertical') {
        return { width, height: Math.round(height * scale) }
    }

    return {
        width: Math.round(width * scale),
        height: Math.round(height * scale),
    }
}

const AIExtender = ({ project }) => {
    const { canvasEditor, setProcessingMessage } = useCanvas()
    const { mutate: updateProject } = useConvexMutation(api.projects.updateProject)

    const [prompt, setPrompt] = useState('soft cinematic continuation, realistic background, seamless outpainting')
    const [expandMode, setExpandMode] = useState('balanced')
    const [extendPercent, setExtendPercent] = useState(50)
    const [freestyleAmount, setFreestyleAmount] = useState(50)
    const [previewUrl, setPreviewUrl] = useState('')
    const [isApplying, setIsApplying] = useState(false)

    const selectionFrameRef = useRef(null)
    const activeImageRef = useRef(null)

    const activeImage = useMemo(() => getCanvasActiveImage(canvasEditor), [canvasEditor])
    const sourceUrl = getSourceUrl(activeImage, project)

    useEffect(() => {
        activeImageRef.current = activeImage
    }, [activeImage])

    useEffect(() => {
        return () => {
            if (canvasEditor && selectionFrameRef.current) {
                canvasEditor.remove(selectionFrameRef.current)
                canvasEditor.requestRenderAll()
            }
        }
    }, [canvasEditor])

    const clearSelectionFrame = () => {
        if (canvasEditor && selectionFrameRef.current) {
            canvasEditor.remove(selectionFrameRef.current)
            canvasEditor.requestRenderAll()
        }
        selectionFrameRef.current = null
    }

    const createSelectionFrame = () => {
        if (!canvasEditor || !activeImageRef.current) return

        clearSelectionFrame()

        const bounds = activeImageRef.current.getBoundingRect()
        const frame = new Rect({
            left: bounds.left + bounds.width * 0.12,
            top: bounds.top + bounds.height * 0.12,
            width: bounds.width * 0.76,
            height: bounds.height * 0.76,
            fill: 'rgba(34, 211, 238, 0.08)',
            stroke: '#22d3ee',
            strokeWidth: 2,
            strokeDashArray: [6, 6],
            cornerColor: '#22d3ee',
            cornerSize: 10,
            transparentCorners: false,
            selectable: true,
            evented: true,
            hasBorders: true,
            hasControls: true,
        })

        selectionFrameRef.current = frame
        canvasEditor.add(frame)
        canvasEditor.setActiveObject(frame)
        canvasEditor.requestRenderAll()
    }

    const getSelectionBounds = () => {
        const frame = selectionFrameRef.current
        if (!frame) return null

        const bounds = frame.getBoundingRect()
        return {
            width: Math.max(1, Math.round(bounds.width)),
            height: Math.max(1, Math.round(bounds.height)),
        }
    }

    const buildPreview = () => {
        if (!activeImage || !sourceUrl) {
            toast.error('Add an ImageKit image to extend first')
            return null
        }

        if (!isImageKitUrl(sourceUrl)) {
            toast.error('Generative fill only works with ImageKit-hosted images')
            return null
        }

        const selectionBounds = getSelectionBounds()
        const dimensions = selectionBounds
            ? {
                width: Math.round(selectionBounds.width * (1 + extendPercent / 100)),
                height: Math.round(selectionBounds.height * (1 + (expandMode === 'freestyle' ? freestyleAmount : extendPercent) / 100)),
            }
            : getTargetDimensions(activeImage, expandMode, extendPercent, freestyleAmount)

        const url = buildGenerativeFillUrl({
            sourceUrl: normalizeImageKitUrl(sourceUrl),
            prompt,
            width: dimensions.width,
            height: dimensions.height,
        })

        setPreviewUrl(url)
        return url
    }

    const handlePreview = () => {
        const url = buildPreview()
        if (url) {
            toast.success('Generative fill preview ready')
        }
    }

    const handleApply = async () => {
        const url = previewUrl || buildPreview()
        if (!url || !activeImageRef.current) return

        setIsApplying(true)
        setProcessingMessage('Applying AI image extender...')

        try {
            const nextImage = await replaceCanvasImageFromUrl(canvasEditor, activeImageRef.current, url, {
                placement: 'native',
                preserveDisplayedBounds: false,
            })

            if (nextImage) {
                canvasEditor.setDimensions(
                    {
                        width: Math.max(nextImage.width || project.width, project.width),
                        height: Math.max(nextImage.height || project.height, project.height),
                    },
                    { backstoreOnly: false }
                )
                canvasEditor.calcOffset()
                canvasEditor.requestRenderAll()
            }

            await updateProject({
                projectId: project._id,
                currentImageUrl: url,
                width: nextImage?.width || project.width,
                height: nextImage?.height || project.height,
                canvasState: serializeCanvasState(canvasEditor),
            })

            clearSelectionFrame()
            toast.success('AI image extended')
        } catch (error) {
            console.warn('AI image extender failed:', error)
            toast.error(error?.message || 'Failed to extend image')
        } finally {
            setIsApplying(false)
            setProcessingMessage(null)
        }
    }

    return (
        <div className='flex h-full min-h-0 flex-col gap-4 overflow-y-auto overflow-x-hidden pr-2'>
            <div className='rounded-xl border border-white/10 bg-slate-900/60 p-4 shadow-lg'>
                <div className='flex items-start gap-3'>
                    <div className='rounded-lg bg-cyan-500/15 p-2 text-cyan-300'>
                        <ImagePlus className='h-5 w-5' />
                    </div>
                    <div>
                        <h3 className='text-sm font-semibold text-white'>AI Image Extender</h3>
                        <p className='text-xs text-white/65'>Professional generative fill powered by ImageKit.</p>
                    </div>
                </div>
            </div>

            <div className='space-y-3 rounded-xl border border-white/10 bg-slate-800/40 p-4'>
                <label className='text-sm font-medium text-white'>Outpaint Prompt</label>
                <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                    placeholder='Describe what should appear in the extended area'
                    className='w-full resize-none rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-cyan-300'
                />
                <p className='text-xs text-white/50'>Use short, concrete prompts for cleaner edge blending.</p>
            </div>

            <div className='space-y-3'>
                <label className='text-sm font-medium text-white'>Expansion Style</label>
                <div className='grid gap-2 sm:grid-cols-2'>
                    {EXPAND_MODES.map((mode) => {
                        const Icon = mode.icon
                        const active = expandMode === mode.id

                        return (
                            <button
                                key={mode.id}
                                type='button'
                                onClick={() => setExpandMode(mode.id)}
                                className={`rounded-xl border p-3 text-left transition ${active
                                    ? 'border-cyan-300 bg-cyan-500/10'
                                    : 'border-white/10 bg-slate-800/40 hover:border-white/20'
                                    }`}
                            >
                                <Icon className='mb-2 h-4 w-4 text-cyan-300' />
                                <div className='text-sm font-medium text-white'>{mode.label}</div>
                                <div className='text-xs text-white/55'>{mode.description}</div>
                            </button>
                        )
                    })}
                </div>
            </div>

            {expandMode === 'freestyle' && (
                <div className='space-y-3 rounded-xl border border-white/10 bg-slate-800/40 p-4'>
                    <div className='flex items-center justify-between gap-3'>
                        <label className='text-sm font-medium text-white'>Free Style Amount</label>
                        <span className='text-xs text-white/60'>+{freestyleAmount}%</span>
                    </div>
                    <input
                        type='range'
                        min='10'
                        max='150'
                        step='5'
                        value={freestyleAmount}
                        onChange={(e) => setFreestyleAmount(Number(e.target.value))}
                        className='w-full accent-cyan-400'
                    />
                    <div className='grid grid-cols-4 gap-2'>
                        {[25, 50, 100, 150].map((amount) => (
                            <button
                                key={amount}
                                type='button'
                                onClick={() => setFreestyleAmount(amount)}
                                className={`rounded-lg border px-2 py-2 text-xs transition ${freestyleAmount === amount
                                    ? 'border-cyan-300 bg-cyan-500/10 text-white'
                                    : 'border-white/10 bg-slate-900/40 text-white/70 hover:border-white/20'
                                    }`}
                            >
                                <div className='font-medium'>+{amount}%</div>
                                <div className='mt-0.5 text-[10px] text-white/45'>Free style</div>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <div className='space-y-3 rounded-xl border border-white/10 bg-slate-800/40 p-4'>
                <div className='flex items-center justify-between gap-3'>
                    <label className='text-sm font-medium text-white'>Extension Area</label>
                    <span className='text-xs text-white/60'>+{extendPercent}%</span>
                </div>
                <input
                    type='range'
                    min='25'
                    max='100'
                    step='5'
                    value={extendPercent}
                    onChange={(e) => setExtendPercent(Number(e.target.value))}
                    className='w-full accent-cyan-400'
                />
                <div className='grid grid-cols-4 gap-2'>
                    {EXTEND_PRESETS.map((preset) => (
                        <button
                            key={preset.id}
                            type='button'
                            onClick={() => setExtendPercent(preset.id)}
                            className={`rounded-lg border px-2 py-2 text-xs transition ${extendPercent === preset.id
                                ? 'border-cyan-300 bg-cyan-500/10 text-white'
                                : 'border-white/10 bg-slate-900/40 text-white/70 hover:border-white/20'
                                }`}
                        >
                            <div className='font-medium'>+{preset.label}</div>
                            <div className='mt-0.5 text-[10px] text-white/45'>{preset.hint}</div>
                        </button>
                    ))}
                </div>
            </div>

            <div className='space-y-3 rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-4'>
                <div className='flex items-center justify-between gap-3'>
                    <label className='text-sm font-medium text-cyan-50'>Select Portion to Extend</label>
                    <span className='text-xs text-cyan-50/75'>Draw a frame on the canvas</span>
                </div>
                <div className='grid grid-cols-2 gap-2'>
                    <Button variant='outline' onClick={createSelectionFrame} disabled={!activeImage} className='w-full'>
                        Select Area
                    </Button>
                    <Button variant='ghost' onClick={clearSelectionFrame} disabled={!selectionFrameRef.current} className='w-full text-white'>
                        <Trash2 className='mr-2 h-4 w-4' />
                        Clear
                    </Button>
                </div>
            </div>

            <div className='grid grid-cols-2 gap-2'>
                <Button variant='outline' onClick={handlePreview} disabled={!activeImage} className='w-full'>
                    <Sparkles className='mr-2 h-4 w-4' />
                    Preview
                </Button>
                <Button variant='primary' onClick={handleApply} disabled={!activeImage || isApplying} className='w-full'>
                    {isApplying ? <Loader2 className='mr-2 h-4 w-4 animate-spin' /> : <ImagePlus className='mr-2 h-4 w-4' />}
                    Apply
                </Button>
            </div>

            {previewUrl && (
                <div className='overflow-hidden rounded-xl border border-white/10 bg-slate-900/60'>
                    <div className='border-b border-white/10 px-4 py-3 text-xs font-medium uppercase tracking-wide text-white/55'>
                        Generative Fill Preview
                    </div>
                    <img src={previewUrl} alt='Generative fill preview' className='h-32 w-full object-cover' />
                </div>
            )}

            <div className='rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-4 text-xs text-cyan-50/90'>
                Generative fill works best with a source image hosted on ImageKit. If the current asset is external, upload it first.
            </div>
        </div>
    )
}

export default AIExtender