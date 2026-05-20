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

const AIEdits = ({ project, dominantColor, contrastingColor, lighterColor }) => {
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
        <div className='flex h-full min-h-0 flex-col gap-4 overflow-y-auto overflow-x-hidden pr-2 panel-scroll'>
            <div className='space-y-2.5'>
                <label className='panel-label'>Enhancement Presets</label>
                <div className='grid gap-2'>
                    {PRESETS.map((preset) => {
                        const Icon = preset.icon
                        const active = selectedPreset === preset.id

                        return (
                            <button
                                key={preset.id}
                                type='button'
                                onClick={() => setSelectedPreset(preset.id)}
                                className='rounded-lg p-3 text-left editor-interactive'
                                style={{
                                    border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    background: active ? 'rgba(0, 229, 255, 0.1)' : 'var(--bg-elevated)',
                                }}
                            >
                                <div className='flex items-start gap-3'>
                                    <div className='rounded-md p-1.5'
                                         style={{ background: 'rgba(0, 229, 255, 0.1)', color: 'var(--accent-primary)' }}>
                                        <Icon className='h-3.5 w-3.5' />
                                    </div>
                                    <div className='min-w-0 flex-1'>
                                        <div className='text-xs font-medium' style={{ color: 'var(--text-primary)' }}>{preset.title}</div>
                                        <div className='mt-0.5 text-[10px] leading-relaxed' style={{ color: 'var(--text-muted)' }}>{preset.description}</div>
                                    </div>
                                </div>
                            </button>
                        )
                    })}
                </div>
            </div>

            <div className='grid grid-cols-2 gap-2'>
                <button
                    onClick={handlePreview}
                    disabled={!activeImage}
                    className='flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium editor-interactive disabled:opacity-40'
                    style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
                >
                    <Sparkles className='h-3.5 w-3.5' />
                    Preview
                </button>
                <button
                    onClick={handleApply}
                    disabled={!activeImage || isApplying}
                    className='flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-40'
                    style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none', boxShadow: !isApplying ? 'var(--shadow-glow)' : 'none' }}
                >
                    {isApplying ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : <BadgeCheck className='h-3.5 w-3.5' />}
                    Apply
                </button>
            </div>

            {previewUrl && (
                <div className='panel-card overflow-hidden p-0'>
                    <div className='px-3 py-2 text-[10px] font-semibold uppercase tracking-widest'
                         style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                        Preview
                    </div>
                    <img src={previewUrl} alt='AI edit preview' className='h-40 w-full object-cover' />
                </div>
            )}

            <div className='panel-card text-[11px]' style={{ borderColor: 'rgba(0, 229, 255, 0.15)' }}>
                <p style={{ color: 'var(--text-muted)' }}>
                    Best results with ImageKit-hosted images. The Premium preset stacks multiple passes for cleanest output.
                </p>
            </div>
        </div>
    )
}

export default AIEdits