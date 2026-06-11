"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eraser, Loader2, MousePointerClick, Sparkles, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { motion } from 'framer-motion'
import { useCanvas } from '../../../../../../../context/context'
import usePlanAccess from '../../../../../../../hooks/usePlanAccess'
import usePixelMaskTool, { MIN_BRUSH, MAX_BRUSH } from '../../../../../../../hooks/usePixelMaskTool'
import {
    BrushSizeControl,
    LabeledSlider,
    MaskActionButtons,
    ModeToggle,
    TipCard,
    ToolEmptyState,
} from './_pixel-tool-ui'
import { buildImageKitBackgroundRemovalUrls } from '@/lib/imagekit-ai'


const MAX_BG_DIMENSION = 1600
const PRO_BG_TOOL = 'ai_background'



const buildBackgroundRemovalUrls = (project) => {
    // Prefer originalImageUrl — currentImageUrl may already contain AI transforms
    // (e-bgremove, e-upscale, e-genfill, etc.) that ImageKit rejects with a 400
    // when chained with another e-bgremove. The original is always the clean source.
    const original = project?.originalImageUrl
    const current = project?.currentImageUrl
    const imageUrl = (original?.includes('ik.imagekit.io') ? original : current) || original || current
    return buildImageKitBackgroundRemovalUrls(imageUrl, {
        width: project?.width,
        height: project?.height,
        maxDimension: MAX_BG_DIMENSION,
    })
}

const loadImageElement = (src) =>
    new Promise((resolve, reject) => {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('Failed to load processed image'))
        img.src = src
    })

const getReadableResponseText = async (response) => {
    const ikError = response.headers.get('ik-error') || ''
    const text = await response.text().catch(() => '')
    const body = text
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    return [ikError, body]
        .filter(Boolean)
        .join(': ')
        .slice(0, 180)
}

// Poll ImageKit's bgremove endpoint. While the asset is still being prepared it
// returns an intermediate (non-image) response; once ready it streams the PNG.
const fetchProcessedImage = async (url, { attempts = 7, signal, onStatus } = {}) => {
    let delay = 1200
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

        let response = null
        try {
            response = await fetch(url, { mode: 'cors', cache: 'no-store', signal })
        } catch (error) {
            // Only transient/network errors are retried; aborts bubble immediately.
            if (error.name === 'AbortError') throw error
            lastError = error
        }

        if (response) {
            const contentType = response.headers.get('content-type') || ''
            const intermediate = response.headers.get('is-intermediate-response') === 'true'

            if (response.ok && contentType.startsWith('image/') && !intermediate) {
                const blob = await response.blob()
                return URL.createObjectURL(blob)
            }
            // A definitive HTTP error (not 202 Accepted / 425 Too Early, which mean
            // "still preparing") fails fast — throwing OUTSIDE the try so it isn't
            // swallowed and retried for the full ~25s budget.
            if (!response.ok && response.status >= 400 && response.status !== 425 && response.status !== 202) {
                const detail = await getReadableResponseText(response)
                throw new Error(`Background service error (${response.status})${detail ? `: ${detail}` : ''}`)
            }
            // Otherwise it's an intermediate "still preparing" response — fall through and retry.
        }

        if (attempt < attempts - 1) {
            onStatus?.(`AI is isolating the subject… (${attempt + 2}/${attempts})`)
            await new Promise((resolve) => setTimeout(resolve, delay))
            delay = Math.min(delay + 1200, 6000)
        }
    }
    throw lastError || new Error('Background removal timed out — try again in a moment')
}

const EraseControls = ({ project, dominantColor }) => {
    const { canvasEditor, processingMessage, setProcessingMessage } = useCanvas()
    const { hasAccess } = usePlanAccess()

    const tool = usePixelMaskTool({
        canvasEditor,
        defaultMode: 'erase',
        supportsMagic: true,
        deferApply: false,
        inferRegion: false,
        showOverlay: false,
        livePreview: false,
    })
    const [isAutoErasing, setIsAutoErasing] = useState(false)
    const abortRef = useRef(null)
    const { setMagic, setMode, setObjectSelect } = tool

    const canUseAi = hasAccess(PRO_BG_TOOL)
    const backgroundRemovalUrls = useMemo(() => buildBackgroundRemovalUrls(project), [project])

    useEffect(() => () => abortRef.current?.abort(), [])

    // React to radial-menu sub-actions (Brush / Magic / Auto BG / Restore).
    const handleAutoEraseRef = useRef(null)
    useEffect(() => {
        const onSub = (event) => {
            const { toolId, subId } = event.detail || {}
            if (toolId !== 'erase' || !subId) return
            if (subId === 'magic') setMagic(true)
            else if (subId === 'brush') { setMagic(false); setObjectSelect(false); setMode('erase') }
            else if (subId === 'restore') { setMagic(false); setObjectSelect(false); setMode('restore') }
            else if (subId === 'auto') handleAutoEraseRef.current?.()
        }
        window.addEventListener('pixxel:tool-sub', onSub)
        return () => window.removeEventListener('pixxel:tool-sub', onSub)
        // setMagic/setMode/setObjectSelect are stable and handleAutoEraseRef is a
        // ref, so the listener binds once instead of re-binding every render.
    }, [setMagic, setMode, setObjectSelect])

    const handleAutoErase = useCallback(async () => {
        if (!canvasEditor || isAutoErasing) return
        if (!canUseAi) {
            toast.error('AI auto-erase is a Pro feature')
            return
        }
        if (!backgroundRemovalUrls.length) {
            toast.error('Auto-erase needs an ImageKit-hosted image')
            return
        }

        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        setIsAutoErasing(true)
        setProcessingMessage('AI is isolating the subject…')
        let objectUrl = null
        try {
            let lastError = null
            for (let index = 0; index < backgroundRemovalUrls.length; index += 1) {
                try {
                    objectUrl = await fetchProcessedImage(backgroundRemovalUrls[index], {
                        signal: controller.signal,
                        onStatus: setProcessingMessage,
                    })
                    break
                } catch (error) {
                    lastError = error
                    if (error.name === 'AbortError') throw error
                    const canTryFallback =
                        index < backgroundRemovalUrls.length - 1 &&
                        /Background service error \(400\)|rejected|400/i.test(error?.message || '')
                    if (!canTryFallback) throw error
                    setProcessingMessage('Retrying background removal…')
                }
            }
            if (!objectUrl) throw lastError || new Error('Auto-erase failed')
            const imageEl = await loadImageElement(objectUrl)
            const applied = tool.applyAlphaMask(imageEl)
            if (applied) toast.success('Background erased — refine with the brush')
            else toast.error('Could not apply auto-erase to this image')
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.warn('[erase] auto-erase failed:', error)
                toast.error(error?.message || 'Auto-erase failed')
            }
        } finally {
            if (objectUrl) URL.revokeObjectURL(objectUrl)
            setProcessingMessage(null)
            setIsAutoErasing(false)
            if (abortRef.current === controller) abortRef.current = null
        }
    }, [canvasEditor, isAutoErasing, canUseAi, backgroundRemovalUrls, setProcessingMessage, tool])

    // Keep the ref pointing at the latest handler so the sub-action listener can
    // call it without re-binding on every dependency change.
    useEffect(() => { handleAutoEraseRef.current = handleAutoErase }, [handleAutoErase])

    if (!canvasEditor) {
        return (
            <div className="p-4">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Canvas not ready</p>
            </div>
        )
    }

    if (!tool.mainImage) {
        return (
            <ToolEmptyState
                icon={Eraser}
                title="No image on canvas"
                subtitle="Add an image first, then use the erase tool"
            />
        )
    }

    const autoBusy = isAutoErasing || Boolean(processingMessage)

    return (
        <div className="space-y-4 overflow-y-auto pr-1 panel-scroll">
            {/* AI auto-erase — one-click background removal (CapCut-style) */}
            <div className="space-y-2">
                <label className="panel-label">Auto-Erase Background</label>
                <button
                    type="button"
                    onClick={handleAutoErase}
                    disabled={autoBusy || !canUseAi}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)', color: '#03050A', border: 'none', boxShadow: 'var(--shadow-glow)' }}
                >
                    {isAutoErasing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    {isAutoErasing ? 'Erasing…' : 'Erase Background with AI'}
                </button>
                {!canUseAi && (
                    <p className="text-[11px]" style={{ color: 'var(--accent-warning)' }}>
                        ⚠ Pro feature — upgrade to auto-erase backgrounds
                    </p>
                )}
                {canUseAi && !backgroundRemovalUrls.length && (
                    <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Needs an ImageKit-hosted image. You can still erase manually below.
                    </p>
                )}
            </div>

            {/* AI object eraser — SAM 2: click an object, the model segments
                the WHOLE object under the pointer and erases it. Click more
                objects to erase each (multi-subject by accumulation). */}
            <div className="space-y-2" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                <label className="panel-label">AI Object Eraser</label>
                <motion.button
                    type="button"
                    onClick={() => tool.setObjectSelect(!tool.objectSelect)}
                    whileTap={{ scale: 0.97 }}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left editor-interactive"
                    style={{
                        background: tool.objectSelect ? 'rgba(124, 58, 237, 0.1)' : 'transparent',
                        border: `1px solid ${tool.objectSelect ? 'rgba(124,58,237,0.6)' : 'var(--border-subtle)'}`,
                        color: tool.objectSelect ? '#C4B5FD' : 'var(--text-secondary)',
                    }}
                >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
                        style={{
                            background: tool.objectSelect ? 'rgba(124,58,237,0.15)' : 'var(--bg-elevated)',
                            border: `1px solid ${tool.objectSelect ? 'rgba(124,58,237,0.5)' : 'var(--border-default)'}`,
                        }}>
                        {tool.isObjectRunning
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Sparkles className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0">
                        <div className="text-xs font-semibold">
                            {tool.isObjectRunning
                                ? 'Detecting object…'
                                : tool.objectSelect ? 'Click-object erase: ON' : 'Click-object erase: OFF'}
                        </div>
                        <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            SAM 2 segments the whole object you click — repeat for multiple subjects
                        </div>
                    </div>
                </motion.button>
            </div>

            {/* Magic eraser toggle */}
            <div className="space-y-2" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                <label className="panel-label">Magic Eraser</label>
                <motion.button
                    type="button"
                    onClick={() => tool.setMagic(!tool.magic)}
                    whileTap={{ scale: 0.97 }}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left editor-interactive"
                    style={{
                        background: tool.magic ? 'rgba(6, 184, 212, 0.1)' : 'transparent',
                        border: `1px solid ${tool.magic ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                        color: tool.magic ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    }}
                >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
                        style={{
                            background: tool.magic ? 'rgba(6,184,212,0.15)' : 'var(--bg-elevated)',
                            border: `1px solid ${tool.magic ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                        }}>
                        <Wand2 className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                        <div className="text-xs font-semibold">{tool.magic ? 'Click-to-erase: ON' : 'Click-to-erase: OFF'}</div>
                        <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Erase a contiguous color region</div>
                    </div>
                </motion.button>
                {tool.magic && (
                    <LabeledSlider
                        label="Tolerance"
                        value={tool.tolerance}
                        min={1}
                        max={100}
                        suffix="%"
                        onChange={tool.setTolerance}
                        dominantColor={dominantColor}
                    />
                )}
            </div>

            {/* Mode */}
            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                <ModeToggle mode={tool.mode} setMode={tool.setMode} altActive={tool.altActive} />
            </div>

            {/* Brush controls — hidden when a click mode (magic / AI object) is active */}
            {!tool.magic && !tool.objectSelect && (
                <div className="space-y-3" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                    <BrushSizeControl value={tool.brushSize} setValue={tool.setBrushSize} min={MIN_BRUSH} max={MAX_BRUSH} dominantColor={dominantColor} />
                    <LabeledSlider label="Hardness" value={tool.hardness} min={1} max={100} suffix="%" onChange={tool.setHardness} dominantColor={dominantColor} />
                    <LabeledSlider label="Flow" value={tool.flow} min={5} max={100} suffix="%" onChange={tool.setFlow} dominantColor={dominantColor} />
                </div>
            )}

            {/* Edge feather */}
            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                <LabeledSlider label="Edge Feather" value={tool.feather} min={0} max={50} suffix="px" onChange={tool.setFeather} dominantColor={dominantColor} />
            </div>

            <MaskActionButtons
                hasMask={tool.hasMask}
                undoDepth={tool.undoDepth}
                redoDepth={tool.redoDepth}
                onUndo={tool.undo}
                onRedo={tool.redo}
                onInvert={tool.invert}
                onClear={tool.clear}
            />

            <TipCard>
                <p>• <strong>Paint</strong> over what you want to erase — the exact stroke is removed when you release</p>
                <p>• <strong>AI object eraser</strong>: click an object and SAM 2 removes the whole thing — click each subject to erase several</p>
                <p>• <strong>Magic eraser</strong>: click a contiguous color region to remove it</p>
                <p>• Hold <strong>Alt</strong> to temporarily switch Erase ↔ Restore</p>
                <p>• <strong>[</strong> / <strong>]</strong> resize the brush; raise feather for soft edges</p>
            </TipCard>

            <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                <MousePointerClick className="h-3 w-3" />
                Non-destructive — restore brings pixels back anytime
            </div>
        </div>
    )
}

export default EraseControls
