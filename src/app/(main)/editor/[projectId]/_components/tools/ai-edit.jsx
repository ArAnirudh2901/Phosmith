"use client"

import React, { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Sparkles, ScanSearch, WandSparkles, BadgeCheck, Loader2 } from 'lucide-react'
import { useCanvas } from '../../../../../../../context/context'
import { useDatabaseMutation } from '../../../../../../../hooks/useDatabaseQuery'
import { api } from "@/lib/neon-api";
import { buildAiEditPresetUrl, ensureCurrentImageKitEndpoint, getCanvasActiveImage, hasImageKitAiTransform, isImageKitUrl, replaceCanvasImageFromUrl } from '../../../../../../lib/imagekit-ai'
import { serializeCanvasState } from '../../../../../../lib/canvas-state'
import BeforeAfterCompare from '@/components/neo/BeforeAfterCompare'
import { ArrowLeftRight } from 'lucide-react'

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
        description: 'Contrast stretch and crisp sharpening combined.',
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

const presetIncludesUpscale = (presetId) => presetId === 'upscale' || presetId === 'premiumQuality'

const AIEdits = ({ project, dominantColor, contrastingColor, lighterColor }) => {
    const { canvasEditor, setProcessingMessage } = useCanvas()
    const { mutate: updateProject } = useDatabaseMutation(api.projects.updateProject)

    const [selectedPreset, setSelectedPreset] = useState('premiumQuality')
    const [previewUrl, setPreviewUrl] = useState('')
    const [isPreviewing, setIsPreviewing] = useState(false)
    const [isApplying, setIsApplying] = useState(false)
    const [, setImageRevision] = useState(0)
    const [comparison, setComparison] = useState(null)
    const [isCompareOpen, setIsCompareOpen] = useState(false)

    useEffect(() => {
        if (!canvasEditor) return undefined
        const bump = (event) => {
            const image = getCanvasActiveImage(canvasEditor)
            console.log('[AI Edit] canvas selection/object event', {
                eventType: event?.type || 'initial',
                hasImage: Boolean(image),
                imageWidth: image?.width,
                imageHeight: image?.height,
                imageSrc: image?.getSrc?.() || image?._originalElement?.src || '',
            })
            setImageRevision((value) => value + 1)
        }

        const initialImage = getCanvasActiveImage(canvasEditor)
        console.log('[AI Edit] canvas initial image state', {
            hasImage: Boolean(initialImage),
            imageWidth: initialImage?.width,
            imageHeight: initialImage?.height,
            imageSrc: initialImage?.getSrc?.() || initialImage?._originalElement?.src || '',
        })
        canvasEditor.on('selection:created', bump)
        canvasEditor.on('selection:updated', bump)
        canvasEditor.on('selection:cleared', bump)
        canvasEditor.on('object:added', bump)
        canvasEditor.on('object:modified', bump)
        return () => {
            canvasEditor.off('selection:created', bump)
            canvasEditor.off('selection:updated', bump)
            canvasEditor.off('selection:cleared', bump)
            canvasEditor.off('object:added', bump)
            canvasEditor.off('object:modified', bump)
        }
    }, [canvasEditor])

    const activeImage = getCanvasActiveImage(canvasEditor)
    const sourceUrl = getSourceUrl(activeImage, project)

    const getSourceDims = () => ({
        width: activeImage?.width || project?.width || 0,
        height: activeImage?.height || project?.height || 0,
    })

    const buildPreview = (presetId = selectedPreset, { trigger = 'manual', updatePreview = true } = {}) => {
        if (!activeImage || !sourceUrl) {
            console.warn('[AI Edit] build preview blocked: no active image/source URL', {
                trigger,
                preset: presetId,
                hasActiveImage: Boolean(activeImage),
                sourceUrl,
            })
            toast.error('Add an ImageKit image first')
            return null
        }

        if (!isImageKitUrl(sourceUrl)) {
            console.warn('[AI Edit] build preview blocked: source is not ImageKit-hosted', {
                trigger,
                preset: presetId,
                sourceUrl,
            })
            toast.error('AI Edit requires an ImageKit-hosted image')
            return null
        }

        // Pass source dimensions so buildAiEditPresetUrl can skip e-upscale
        // on images exceeding ImageKit's 16MP limit
        const sourceDims = getSourceDims()
        const sourcePixels = sourceDims.width * sourceDims.height

        const url = buildAiEditPresetUrl(sourceUrl, presetId, { sourceDims })
        const requestedUpscale = presetIncludesUpscale(presetId)
        const willUpscale = url.includes('e-upscale')
        const needsAsyncResolve = hasImageKitAiTransform([url])

        console.log('[AI Edit] build preview', {
            trigger,
            preset: presetId,
            sourceUrl,
            sourceDims,
            sourcePixels,
            requestedUpscale,
            willUpscale,
            skippedUpscaleBecauseLarge: requestedUpscale && !willUpscale,
            needsAsyncResolve,
            url,
        })

        if (updatePreview) setPreviewUrl(url)
        return url
    }

    const resolveImageKitUrl = async (url, { source, preset }) => {
        console.log('[AI Edit] resolve request', {
            source,
            preset,
            url,
        })

        const response = await fetch('/api/imagekit/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url,
                source,
                preset,
                maxAttempts: 12,
                retryDelayMs: 5000,
            }),
        })
        const data = await response.json().catch(() => ({}))

        console.log('[AI Edit] resolve response', {
            source,
            preset,
            ok: response.ok,
            status: response.status,
            data,
            url,
        })

        if (!response.ok || !data?.success) {
            throw new Error(data?.error || 'ImageKit transform did not finish')
        }

        return data.url || url
    }

    const preparePreview = async (presetId = selectedPreset, trigger = 'preview-button') => {
        const url = buildPreview(presetId, { trigger, updatePreview: false })
        if (!url) return null

        if (!hasImageKitAiTransform([url])) {
            setPreviewUrl(url)
            return url
        }

        setIsPreviewing(true)
        setProcessingMessage?.('Preparing ImageKit AI preview...')
        try {
            const readyUrl = await resolveImageKitUrl(url, {
                source: `ai-edit-${trigger}`,
                preset: presetId,
            })
            setPreviewUrl(readyUrl)
            return readyUrl
        } catch (error) {
            console.warn('[AI Edit] preview failed', {
                trigger,
                preset: presetId,
                url,
                error,
            })
            toast.error(error?.message || 'Failed to prepare AI preview')
            return null
        } finally {
            setIsPreviewing(false)
            setProcessingMessage?.(null)
        }
    }

    const handlePresetSelect = async (presetId) => {
        console.log('[AI Edit] preset clicked', {
            preset: presetId,
            previousPreset: selectedPreset,
            hasActiveImage: Boolean(activeImage),
            sourceUrl,
        })
        setSelectedPreset(presetId)
        setPreviewUrl('')

        const url = await preparePreview(presetId, 'preset-click')
        if (url) {
            toast.success('AI edit preview ready')
        }
    }

    const handlePreview = async () => {
        const url = await preparePreview(selectedPreset, 'preview-button')
        if (url) {
            toast.success('AI edit preview ready')
        }
    }

    const handleApply = async () => {
        const url = buildPreview(selectedPreset, { trigger: 'apply', updatePreview: false })
        if (!url || !activeImage) return

        setIsApplying(true)
        setProcessingMessage('Applying AI edit...')

        try {
            let readyUrl = url
            let usedFallback = false
            const needsPolling = hasImageKitAiTransform([url])
            const requestedUpscale = presetIncludesUpscale(selectedPreset)

            // If the image belongs to a different ImageKit account,
            // re-upload it so AI extension units are charged correctly.
            if (needsPolling) {
                setProcessingMessage('Checking image account...')
                try {
                    const currentSourceUrl = await ensureCurrentImageKitEndpoint(sourceUrl, {
                        onStatus: (msg) => setProcessingMessage(msg),
                    })
                    // If re-uploaded, rebuild the transform URL with the new base
                    if (currentSourceUrl !== sourceUrl) {
                        readyUrl = buildAiEditPresetUrl(currentSourceUrl, selectedPreset, { sourceDims: getSourceDims() })
                    }
                } catch (reuploadErr) {
                    console.warn('[AI Edit] Re-upload failed:', reuploadErr)
                    toast.error('Failed to re-upload image: ' + (reuploadErr?.message || ''))
                    return
                }

                // AI transforms (e-upscale, e-retouch) are async — poll until ready.
                setProcessingMessage('Waiting for AI processing...')
                try {
                    readyUrl = await resolveImageKitUrl(readyUrl, {
                        source: 'ai-edit-apply',
                        preset: selectedPreset,
                    })
                } catch (pollErr) {
                    // If extension units exhausted, fall back to free transforms
                    const isQuotaError = /extension.?limit|limit.?exceeded|units.?exhausted/i.test(pollErr?.message || '')
                    if (isQuotaError) {
                        setProcessingMessage('AI quota exceeded — applying free enhancements...')
                        readyUrl = buildAiEditPresetUrl(sourceUrl, 'enhanceSharpen')
                        usedFallback = true
                        // enhanceSharpen uses only e-contrast + e-sharpen (instant, no polling needed)
                    } else {
                        throw pollErr
                    }
                }
            }
            // else: enhanceSharpen preset uses e-contrast + e-sharpen (instant, no polling)

            setProcessingMessage('Loading enhanced image...')
            const didUpscale = !usedFallback && requestedUpscale && readyUrl.includes('e-upscale')
            const beforeUrlForComparison = didUpscale ? sourceUrl : null
            const nextImage = await replaceCanvasImageFromUrl(canvasEditor, activeImage, readyUrl, {
                preserveDisplayedBounds: true,
                placement: 'fit',
            })
            const nextWidth = Math.max(1, Math.round(nextImage?.width || project?.width || 1))
            const nextHeight = Math.max(1, Math.round(nextImage?.height || project?.height || 1))

            setPreviewUrl(readyUrl)

            if (didUpscale && beforeUrlForComparison) {
                setComparison({ beforeUrl: beforeUrlForComparison, afterUrl: readyUrl, width: nextWidth, height: nextHeight })
            }

            await updateProject({
                projectId: project._id,
                currentImageUrl: readyUrl,
                canvasState: serializeCanvasState(canvasEditor),
            })

            if (usedFallback) {
                toast.warning('AI extension units exhausted — applied free enhancements (contrast + sharpen) instead.')
            } else if (didUpscale) {
                toast.success(`Upscaled to ${nextWidth} × ${nextHeight}`, {
                    description: 'Image kept at the same visual size. Click Compare to view before/after.',
                })
            } else {
                toast.success('AI edit applied')
            }
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
                                onClick={() => handlePresetSelect(preset.id)}
                                disabled={isPreviewing || isApplying}
                                className='rounded-lg p-3 text-left editor-interactive'
                                style={{
                                    border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    background: active ? 'rgba(6, 184, 212, 0.1)' : 'var(--bg-elevated)',
                                }}
                            >
                                <div className='flex items-start gap-3'>
                                    <div className='rounded-md p-1.5'
                                         style={{ background: 'rgba(6, 184, 212, 0.1)', color: 'var(--accent-primary)' }}>
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

            <div className='grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2'>
                <button
                    onClick={handlePreview}
                    disabled={!activeImage || isPreviewing || isApplying}
                    className='flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium editor-interactive disabled:opacity-40'
                    style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
                >
                    {isPreviewing ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : <Sparkles className='h-3.5 w-3.5' />}
                    {isPreviewing ? 'Previewing' : 'Preview'}
                </button>
                <button
                    onClick={handleApply}
                    disabled={!activeImage || isApplying || isPreviewing}
                    className='flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-40'
                    style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none', boxShadow: !isApplying ? 'var(--shadow-glow)' : 'none' }}
                >
                    {isApplying ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : <BadgeCheck className='h-3.5 w-3.5' />}
                    {isApplying ? 'Applying' : 'Apply'}
                </button>
            </div>

            {comparison && (
                <button
                    type='button'
                    onClick={() => setIsCompareOpen(true)}
                    className='flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold'
                    style={{
                        background: '#0E1118',
                        border: '2px solid #F4F4F5',
                        color: '#F4F4F5',
                        boxShadow: '3px 3px 0 0 #06B8D4',
                        fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                        letterSpacing: '0.12em',
                        textTransform: 'uppercase',
                    }}
                >
                    <ArrowLeftRight className='h-3.5 w-3.5' style={{ color: '#06B8D4' }} strokeWidth={2.5} />
                    Compare Before / After
                    <span style={{ color: '#06B8D4', marginLeft: 4 }}>
                        {comparison.width} × {comparison.height}
                    </span>
                </button>
            )}

            {previewUrl && (
                <div className='panel-card overflow-hidden p-0'>
                    <div className='px-3 py-2 text-[10px] font-semibold uppercase tracking-widest'
                         style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                        Preview
                    </div>
                    <img
                        src={previewUrl}
                        alt='AI edit preview'
                        className='h-40 w-full object-cover'
                        onLoad={(event) => {
                            console.log('[AI Edit] preview image loaded', {
                                preset: selectedPreset,
                                previewUrl,
                                naturalWidth: event.currentTarget.naturalWidth,
                                naturalHeight: event.currentTarget.naturalHeight,
                            })
                        }}
                        onError={(event) => {
                            console.warn('[AI Edit] preview image failed to load', {
                                preset: selectedPreset,
                                previewUrl,
                                currentSrc: event.currentTarget.currentSrc,
                            })
                        }}
                    />
                </div>
            )}

            <BeforeAfterCompare
                open={isCompareOpen}
                beforeUrl={comparison?.beforeUrl}
                afterUrl={comparison?.afterUrl}
                beforeLabel='Original'
                afterLabel='Upscaled'
                onClose={() => setIsCompareOpen(false)}
            />

            <div className='panel-card text-[11px]' style={{ borderColor: 'rgba(6, 184, 212, 0.15)' }}>
                <p style={{ color: 'var(--text-muted)' }}>
                    Best results with ImageKit-hosted images. The Premium preset stacks multiple passes for cleanest output.
                </p>
            </div>
        </div>
    )
}

export default AIEdits
