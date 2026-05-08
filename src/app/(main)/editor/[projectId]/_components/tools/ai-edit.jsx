"use client"

import React, { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Sparkles, ScanSearch, WandSparkles, BadgeCheck, Loader2 } from 'lucide-react'
import { useCanvas } from '../../../../../../../context/context'
import { useConvexMutation } from '../../../../../../../hooks/useConvexQuery'
import { api } from '../../../../../../../convex/_generated/api'
import { buildAiEditPresetUrl, getCanvasActiveImage, isImageKitUrl, replaceCanvasImageFromUrl } from '../../../../../../lib/imagekit-ai'
import { serializeCanvasState } from '../../../../../../lib/canvas-state'

const PRESETS = [
    {
        id: 'retouch',
        title: 'AI Retouch',
        description: 'Smooths imperfections and improves overall fidelity.',
        icon: ScanSearch,
    },
    {
        id: 'upscale',
        title: 'Upscaling',
        description: 'Increases resolution for sharper large-format output.',
        icon: Sparkles,
    },
    {
        id: 'enhanceSharpen',
        title: 'Enhance + Sharpen',
        description: 'Retouch, contrast stretch, and crisp sharpening combined.',
        icon: WandSparkles,
    },
    {
        id: 'premiumQuality',
        title: 'Premium Quality',
        description: 'Retouch, upscale, and enhancement stack for polished results.',
        icon: BadgeCheck,
    },
]

const getSourceUrl = (image, project) => {
    return image?.getSrc?.() || image?._originalElement?.src || project?.currentImageUrl || project?.originalImageUrl || ''
}

const AIEdits = ({ project }) => {
    const { canvasEditor, setProcessingMessage } = useCanvas()
    const { mutate: updateProject } = useConvexMutation(api.projects.updateProject)

    const [selectedPreset, setSelectedPreset] = useState('premiumQuality')
    const [previewUrl, setPreviewUrl] = useState('')
    const [isApplying, setIsApplying] = useState(false)

    const activeImage = useMemo(() => getCanvasActiveImage(canvasEditor), [canvasEditor])
    const sourceUrl = getSourceUrl(activeImage, project)

    const buildPreview = () => {
        if (!activeImage || !sourceUrl) {
            toast.error('Add an ImageKit image first')
            return null
        }

        if (!isImageKitUrl(sourceUrl)) {
            toast.error('AI Edit requires an ImageKit-hosted image')
            return null
        }

        const url = buildAiEditPresetUrl(sourceUrl, selectedPreset)
        setPreviewUrl(url)
        return url
    }

    const handlePreview = () => {
        const url = buildPreview()
        if (url) {
            toast.success('AI edit preview ready')
        }
    }

    const handleApply = async () => {
        const url = previewUrl || buildPreview()
        if (!url || !activeImage) return

        setIsApplying(true)
        setProcessingMessage('Applying AI edit...')

        try {
            await replaceCanvasImageFromUrl(canvasEditor, activeImage, url, {
                preserveDisplayedBounds: true,
            })

            await updateProject({
                projectId: project._id,
                currentImageUrl: url,
                canvasState: serializeCanvasState(canvasEditor),
            })

            toast.success('AI edit applied')
        } catch (error) {
            console.warn('AI edit failed:', error)
            toast.error(error?.message || 'Failed to apply AI edit')
        } finally {
            setIsApplying(false)
            setProcessingMessage(null)
        }
    }

    return (
        <div className='flex h-full min-h-0 flex-col gap-5 overflow-hidden'>
            <div className='rounded-xl border border-white/10 bg-slate-900/60 p-4 shadow-lg'>
                <div className='flex items-start gap-3'>
                    <div className='rounded-lg bg-violet-500/15 p-2 text-violet-300'>
                        <BadgeCheck className='h-5 w-5' />
                    </div>
                    <div>
                        <h3 className='text-sm font-semibold text-white'>AI Editing</h3>
                        <p className='text-xs text-white/65'>Production-grade ImageKit enhancement presets for image cleanup and detail recovery.</p>
                    </div>
                </div>
            </div>

            <div className='grid gap-3'>
                {PRESETS.map((preset) => {
                    const Icon = preset.icon
                    const active = selectedPreset === preset.id

                    return (
                        <button
                            key={preset.id}
                            type='button'
                            onClick={() => setSelectedPreset(preset.id)}
                            className={`rounded-xl border p-4 text-left transition ${active
                                ? 'border-violet-300 bg-violet-500/10'
                                : 'border-white/10 bg-slate-800/40 hover:border-white/20'
                                }`}
                        >
                            <div className='flex items-start gap-3'>
                                <div className='rounded-lg bg-white/5 p-2 text-violet-300'>
                                    <Icon className='h-4 w-4' />
                                </div>
                                <div className='min-w-0 flex-1'>
                                    <div className='text-sm font-medium text-white'>{preset.title}</div>
                                    <div className='mt-1 text-xs leading-5 text-white/60'>{preset.description}</div>
                                </div>
                            </div>
                        </button>
                    )
                })}
            </div>

            <div className='grid grid-cols-2 gap-2'>
                <Button variant='outline' onClick={handlePreview} disabled={!activeImage} className='w-full'>
                    <Sparkles className='mr-2 h-4 w-4' />
                    Preview
                </Button>
                <Button variant='primary' onClick={handleApply} disabled={!activeImage || isApplying} className='w-full'>
                    {isApplying ? <Loader2 className='mr-2 h-4 w-4 animate-spin' /> : <BadgeCheck className='mr-2 h-4 w-4' />}
                    Apply
                </Button>
            </div>

            {previewUrl && (
                <div className='overflow-hidden rounded-xl border border-white/10 bg-slate-900/60'>
                    <div className='border-b border-white/10 px-4 py-3 text-xs font-medium uppercase tracking-wide text-white/55'>
                        AI Edit Preview
                    </div>
                    <img src={previewUrl} alt='AI edit preview' className='h-48 w-full object-cover' />
                </div>
            )}

            <div className='rounded-xl border border-violet-500/20 bg-violet-500/10 p-4 text-xs text-violet-50/90'>
                Retouch and upscale are best used on ImageKit-hosted images. The premium preset stacks multiple enhancement passes for the cleanest output.
            </div>
        </div>
    )
}

export default AIEdits