"use client"

import React, { useCallback, useEffect, useRef, useState } from 'react'
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

const MAX_BG_DIMENSION = 1600
const PRO_BG_TOOL = 'ai_background'

const buildBackgroundRemovalUrl = (project) => {
    const imageUrl = project?.currentImageUrl || project?.originalImageUrl
    if (!imageUrl?.includes('ik.imagekit.io')) return null
    const width = Math.min(Math.max(Math.round(project?.width || MAX_BG_DIMENSION), 1), MAX_BG_DIMENSION)
    const height = Math.min(Math.max(Math.round(project?.height || MAX_BG_DIMENSION), 1), MAX_BG_DIMENSION)
    return `${imageUrl.split('?')[0]}?tr=w-${width},h-${height},c-at_max,e-bgremove`
}

const loadImageElement = (src) =>
    new Promise((resolve, reject) => {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('Failed to load processed image'))
        img.src = src
    })

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
                throw new Error(`Background service error (${response.status})`)
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

    const tool = usePixelMaskTool({ canvasEditor, defaultMode: 'erase', supportsMagic: true })
    const [isAutoErasing, setIsAutoErasing] = useState(false)
    const abortRef = useRef(null)

    const canUseAi = hasAccess(PRO_BG_TOOL)
    const backgroundRemovalUrl = buildBackgroundRemovalUrl(project)

    useEffect(() => () => abortRef.current?.abort(), [])

    // React to radial-menu sub-actions (Brush / Magic / Auto BG / Restore).
    const handleAutoEraseRef = useRef(null)
    useEffect(() => {
        const onSub = (event) => {
            const { toolId, subId } = event.detail || {}
            if (toolId !== 'erase' || !subId) return
            if (subId === 'magic') tool.setMagic(true)
            else if (subId === 'brush') { tool.setMagic(false); tool.setMode('erase') }
            else if (subId === 'restore') { tool.setMagic(false); tool.setMode('restore') }
            else if (subId === 'auto') handleAutoEraseRef.current?.()
        }
        window.addEventListener('pixxel:tool-sub', onSub)
        return () => window.removeEventListener('pixxel:tool-sub', onSub)
    }, [tool])

    const handleAutoErase = useCallback(async () => {
        if (!canvasEditor || isAutoErasing) return
        if (!canUseAi) {
            toast.error('AI auto-erase is a Pro feature')
            return
        }
        if (!backgroundRemovalUrl) {
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
            objectUrl = await fetchProcessedImage(backgroundRemovalUrl, {
                signal: controller.signal,
                onStatus: setProcessingMessage,
            })
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
    }, [canvasEditor, isAutoErasing, canUseAi, backgroundRemovalUrl, setProcessingMessage, tool])

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
                {canUseAi && !backgroundRemovalUrl && (
                    <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Needs an ImageKit-hosted image. You can still erase manually below.
                    </p>
                )}
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

            {/* Brush controls — hidden when magic click mode is active */}
            {!tool.magic && (
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
                <p>• <strong>Erase</strong> hides pixels — exports as transparent PNG</p>
                <p>• <strong>Magic eraser</strong>: click a color region to remove it</p>
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
