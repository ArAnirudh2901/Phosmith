"use client"

import { Bot, Expand, Eye, ImagePlus, Maximize2, Palette, Pen, Scissors, Sliders, Text, Crop, ArrowLeft, ChevronDown, Download, Loader2, Save, Undo2, Redo2, ZoomIn, Keyboard } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useCanvas, useDynamicAccent } from '../../../../../../context/context'
import usePlanAccess from '../../../../../../hooks/usePlanAccess'
import UpgradeModel from '@/components/upgradeModel'
import { addImageFilesToCanvas } from '@/lib/canvas-images'
import ProBadge from '@/components/pro-badge'
import InkDropLogo from '@/components/ink-drop-logo'
import ShortcutsGuide from '@/components/neo/ShortcutsGuide'
import { motion, AnimatePresence } from 'framer-motion'
import { isPixxelMaskOverlay } from '@/lib/canvas-mask'

const EXPORT_PRESETS = [
    { id: 'png', label: 'PNG', description: 'Lossless · Best quality', format: 'png', quality: 1 },
    { id: 'jpeg90', label: 'JPEG 90%', description: 'Lossy · Great quality', format: 'jpeg', quality: 0.9 },
    { id: 'jpeg80', label: 'JPEG 80%', description: 'Lossy · Smaller file', format: 'jpeg', quality: 0.8 },
    { id: 'webp90', label: 'WebP 90%', description: 'Modern · Smallest file', format: 'webp', quality: 0.9 },
]

const TOOLS = [
    { id: "resize", label: "Resize", icon: Expand },
    { id: "crop", label: "Crop", icon: Crop },
    { id: "images", label: "Images", icon: ImagePlus },
    { id: "adjust", label: "Adjust", icon: Sliders },
    { id: "draw", label: "Draw", icon: Pen },
    { id: "mask", label: "Mask", icon: Scissors },
    { id: "text", label: "Text", icon: Text },
    { id: "ai_background", label: "AI BG", icon: Palette, proOnly: true },
    { id: "ai_extender", label: "Extender", icon: Maximize2, proOnly: true },
    { id: "ai_edit", label: "AI Edit", icon: Eye, proOnly: true },
    { id: "ai_agent", label: "Agent", icon: Bot },
]

const isExportTransientObject = (obj) =>
    obj?.excludeFromExport ||
    isPixxelMaskOverlay(obj)

const EditorTopbar = ({ project }) => {

    const router = useRouter()
    const exportMenuRef = useRef(null)
    const addImageInputRef = useRef(null)

    const [showUpgradeModel, setShowUpgradeModel] = useState(false)
    const [restrictedTool, setRestrictedTool] = useState(null)
    const [showExportMenu, setShowExportMenu] = useState(false)
    const [canUndo, setCanUndo] = useState(false)
    const [canRedo, setCanRedo] = useState(false)
    const [showShortcuts, setShowShortcuts] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [isExporting, setIsExporting] = useState(false)

    const triggerAddImage = useCallback(() => {
        addImageInputRef.current?.click()
    }, [])

    useEffect(() => {
        const isTypingTarget = (target) => {
            if (!target) return false
            const tag = target.tagName
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
            return Boolean(target.isContentEditable)
        }
        const onKeyDown = (event) => {
            if (event.repeat || isTypingTarget(event.target)) return
            if ((event.key === 'I' || event.key === 'i') && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault()
                triggerAddImage()
                return
            }
            if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
                event.preventDefault()
                setShowShortcuts((prev) => !prev)
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [triggerAddImage])

    const { canvasEditor, activeTool, onToolChange } = useCanvas()
    const { hasAccess } = usePlanAccess()
    const { accentRgb } = useDynamicAccent()

    const exportResolutionLabel = useMemo(() => {
        if (!project?.width || !project?.height) return ''
        return `${project.width} × ${project.height}`
    }, [project?.width, project?.height])

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (exportMenuRef.current && !exportMenuRef.current.contains(event.target)) {
                setShowExportMenu(false)
            }
        }

        window.addEventListener('mousedown', handleClickOutside)
        return () => window.removeEventListener('mousedown', handleClickOutside)
    }, [])

    useEffect(() => {
        if (!canvasEditor) {
            const resetHistoryState = () => {
                setCanUndo(false)
                setCanRedo(false)
            }
            if (typeof queueMicrotask === 'function') queueMicrotask(resetHistoryState)
            else setTimeout(resetHistoryState, 0)
            return undefined
        }

        const syncHistory = () => {
            const state = canvasEditor.__getHistoryState?.()
            if (state) {
                setCanUndo(state.canUndo)
                setCanRedo(state.canRedo)
            }
        }

        syncHistory()
        canvasEditor.on('history:changed', syncHistory)
        return () => canvasEditor.off('history:changed', syncHistory)
    }, [canvasEditor])

    const handleUndo = async () => {
        if (!canvasEditor?.__undoCanvasState) return
        const didUndo = await canvasEditor.__undoCanvasState()
        if (!didUndo) toast.message('Nothing to undo')
        else await canvasEditor.__saveCanvasState?.()
    }

    const handleRedo = async () => {
        if (!canvasEditor?.__redoCanvasState) return
        const didRedo = await canvasEditor.__redoCanvasState()
        if (!didRedo) toast.message('Nothing to redo')
        else await canvasEditor.__saveCanvasState?.()
    }

    const handleBackToDashboard = () => {
        router.push("/dashboard")
    }

    const handleSave = async () => {
        if (!canvasEditor?.__saveCanvasState || isSaving) return
        setIsSaving(true)
        const toastId = toast.loading('Saving project...')
        try {
            await canvasEditor.__saveCanvasState({ rethrow: true })
            toast.success('Project saved', { id: toastId })
        } catch (error) {
            console.error('[Save] Failed:', error)
            const msg = error?.message || String(error) || 'Unknown error'
            // Neon's per-document size limit is 1 MB. If saved state exceeds that
            // (large data URLs from uploaded images), the user needs to know — that's
            // the root cause of "my changes are suddenly gone".
            const isSizeError = /too large|maximum.*size|1MB|1 MB/i.test(msg)
            toast.error(
                isSizeError
                    ? 'Save failed: project too large. Re-upload any embedded images so they go through ImageKit.'
                    : `Save failed: ${msg}`,
                { id: toastId, duration: 8000 }
            )
        } finally {
            setIsSaving(false)
        }
    }

    const handleToolChange = (toolId) => {
        if (!hasAccess(toolId)) {
            setRestrictedTool(toolId)
            setShowUpgradeModel(true)
            return
        }
        onToolChange(toolId)
    }

    const handleExport = async ({ format, quality }) => {
        if (!canvasEditor || !project || isExporting) return
        setIsExporting(true)
        const toastId = toast.loading(`Exporting as ${format.toUpperCase()}…`)

        // Multi-image edge case: if the user has multiple images selected (ActiveSelection)
        // when they click Export, Fabric's render path treats those objects as children of
        // the active selection group — they end up double-transformed and render at wrong
        // positions or get clipped. Discard the selection before snapshotting and restore
        // it after so the export captures pixels at their real positions.
        const previousActive = canvasEditor.getActiveObject?.()
        if (previousActive) canvasEditor.discardActiveObject()

        // Hoist viewport save variables so `finally` can always restore them.
        let savedVpt = null
        let savedW = null
        let savedH = null
        const hiddenForExport = []

        try {
            for (const obj of canvasEditor.getObjects?.() || []) {
                if (obj.visible !== false && isExportTransientObject(obj)) {
                    hiddenForExport.push(obj)
                    obj.set?.('visible', false)
                }
            }

            // Fabric.js v7 export fix: temporarily reset the viewport to identity
            // so objects render at their true project-space positions.
            savedVpt = [...canvasEditor.viewportTransform]
            savedW = canvasEditor.getWidth()
            savedH = canvasEditor.getHeight()

            canvasEditor.viewportTransform = [1, 0, 0, 1, 0, 0]
            canvasEditor.calcOffset()
            canvasEditor.renderAll()

            // Compute the tight bounding box around ALL visible objects.
            // This ensures only the actual image content is exported — no
            // surrounding empty project canvas.
            const objects = canvasEditor.getObjects().filter(o => o.visible !== false && !isExportTransientObject(o))
            if (!objects.length) {
                throw new Error('No visible objects on the canvas to export')
            }

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
            for (const obj of objects) {
                const rect = obj.getBoundingRect(true) // absolute coords, no viewport
                minX = Math.min(minX, rect.left)
                minY = Math.min(minY, rect.top)
                maxX = Math.max(maxX, rect.left + rect.width)
                maxY = Math.max(maxY, rect.top + rect.height)
            }

            // Round outward to whole pixels
            const cropLeft = Math.floor(minX)
            const cropTop = Math.floor(minY)
            const cropW = Math.ceil(maxX) - cropLeft
            const cropH = Math.ceil(maxY) - cropTop

            if (cropW < 1 || cropH < 1) {
                throw new Error('Object bounding box is empty')
            }

            // Set canvas dimensions large enough to contain the crop region
            const canvasSizeW = Math.max(cropLeft + cropW, savedW)
            const canvasSizeH = Math.max(cropTop + cropH, savedH)
            canvasEditor.setDimensions({ width: canvasSizeW, height: canvasSizeH })
            canvasEditor.calcOffset()
            canvasEditor.renderAll()

            // Export only the bounding box region
            const exportCanvas = canvasEditor.toCanvasElement(1, {
                width: cropW,
                height: cropH,
                left: cropLeft,
                top: cropTop,
            })

            let finalCanvas = exportCanvas
            if (format !== 'png') {
                finalCanvas = document.createElement('canvas')
                finalCanvas.width = exportCanvas.width
                finalCanvas.height = exportCanvas.height
                const ctx = finalCanvas.getContext('2d')
                const bg = canvasEditor.backgroundColor
                const isRealColor = typeof bg === 'string' && bg !== 'transparent' && bg !== ''
                ctx.fillStyle = isRealColor ? bg : '#ffffff'
                ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height)
                ctx.drawImage(exportCanvas, 0, 0)
            }

            const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'

            // toBlob with a Blob URL avoids materializing the full base64 string into JS
            // memory — important for full-resolution exports of 4K+ images, where the
            // toDataURL string can be tens of MB and crash mobile browsers.
            const blob = await new Promise((resolve, reject) => {
                finalCanvas.toBlob(
                    (b) => (b ? resolve(b) : reject(new Error('Canvas encoding failed'))),
                    mimeType,
                    quality,
                )
            })
            const blobUrl = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = blobUrl
            link.download = `${project.title || 'export'}.${format === 'jpeg' ? 'jpg' : format}`
            document.body.appendChild(link)
            link.click()
            link.remove()
            // Release the blob URL on the next tick — Safari needs the link click first.
            setTimeout(() => URL.revokeObjectURL(blobUrl), 0)

            setShowExportMenu(false)
            toast.success(`Exported as ${format.toUpperCase()}`, { id: toastId })
        } catch (error) {
            console.error('[Export] Failed:', error)
            toast.error(`Export failed: ${error?.message || 'Unknown error'}`, { id: toastId })
        } finally {
            // Always restore viewport dimensions and transform, even if export failed.
            for (const obj of hiddenForExport) {
                try { obj.set?.('visible', true) } catch { /* object may have been removed */ }
            }
            if (savedVpt && typeof savedW === 'number' && typeof savedH === 'number') {
                try {
                    canvasEditor.setDimensions({ width: savedW, height: savedH })
                    canvasEditor.viewportTransform = savedVpt
                    canvasEditor.calcOffset()
                } catch { /* canvas may have been disposed */ }
            }
            // Always restore the selection the user had before they clicked Export.
            if (previousActive && canvasEditor.contextContainer) {
                try { canvasEditor.setActiveObject(previousActive) } catch { /* selection may have been removed */ }
            }
            canvasEditor.requestRenderAll()
            setIsExporting(false)
        }
    }

    return (
        <>
            {/* ── Top Navigation Bar ── */}
            <div className="editor-topbar flex items-center px-3 justify-between">

                {/* Left section: Back + Project name */}
                <div className="flex flex-1 items-center gap-2 min-w-0">
                    <Link
                        href="/dashboard"
                        className="editor-logo-button flex items-center justify-center flex-none"
                        title="Go to dashboard"
                        aria-label="Go to dashboard"
                    >
                        <InkDropLogo />
                    </Link>

                    <motion.button

                        onClick={handleBackToDashboard}
                        className="editor-icon-button flex items-center justify-center flex-none"
                        title="Back to projects"
                    >
                        <ArrowLeft className="h-4 w-4" />
                    </motion.button>

                    <div className="h-5 w-px flex-none" style={{ background: 'var(--border-default)' }} />

                    <span className="text-sm font-semibold truncate max-w-[80px] sm:max-w-[120px] xl:max-w-[160px] flex-none"
                          style={{ color: 'var(--text-primary)' }}>
                        {project.title}
                    </span>

                    <ProBadge size="sm" />

                    {exportResolutionLabel && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded flex-none"
                              style={{ color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
                            {exportResolutionLabel}
                        </span>
                    )}
                </div>

                {/* Center: Tool buttons */}
                {/* Explicit horizontal margin so the center group can never overlap
                    the left title block or the right action group at any width.
                    Uses overflow-x-auto so tools scroll on very narrow viewports. */}
                <div className="flex flex-none items-center justify-center gap-1 lg:gap-1.5 xl:gap-2 px-1 lg:px-2 mx-1 lg:mx-3 overflow-x-auto scrollbar-hide">
                    {TOOLS.map((tool) => {
                        const Icon = tool.icon
                        const isActive = activeTool === tool.id
                        const hasToolAccess = hasAccess(tool.id)

                        return (
                            <React.Fragment key={tool.id}>
                                {/* Visual dividers to create tool groups */}
                                {(tool.id === 'mask' || tool.id === 'ai_background') && (
                                    <div className="h-5 w-px flex-none" style={{ background: 'var(--border-default)' }} />
                                )}
                                <motion.button
                                    onClick={() => handleToolChange(tool.id)}
                                    className={`tool-btn ${isActive ? 'tool-btn--active' : ''} ${!hasToolAccess ? 'tool-btn--locked' : ''}`}
                                >
                                    <Icon className="h-4 w-4 flex-none" />
                                    <span className="hidden 2xl:inline">{tool.label}</span>
                                </motion.button>
                            </React.Fragment>
                        )
                    })}
                </div>

                {/* Right: Actions — overflow-visible so the export dropdown isn't clipped */}
                <div className="flex flex-1 items-center justify-end gap-0.5 lg:gap-1 min-w-0" style={{ overflow: 'visible' }}>
                    {/* Undo / Redo */}
                    <motion.button
                        onClick={handleUndo}
                        disabled={!canUndo}
                        className="editor-icon-button flex items-center justify-center disabled:opacity-35 disabled:pointer-events-none flex-none"
                        title="Undo (⌘Z)"
                    >
                        <Undo2 className="h-3.5 w-3.5" />
                    </motion.button>

                    <motion.button
                        onClick={handleRedo}
                        disabled={!canRedo}
                        className="editor-icon-button flex items-center justify-center disabled:opacity-35 disabled:pointer-events-none flex-none"
                        title="Redo (⌘⇧Z)"
                    >
                        <Redo2 className="h-3.5 w-3.5" />
                    </motion.button>

                    <div className="h-5 w-px mx-1 flex-none" style={{ background: 'var(--border-default)' }} />

                    <input
                        ref={addImageInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={async (e) => {
                            const files = Array.from(e.target.files || [])
                            e.target.value = ''
                            if (files.length === 0) return
                            await addImageFilesToCanvas(canvasEditor, files, project)
                        }}
                    />
                    <motion.button
                        onClick={() => addImageInputRef.current?.click()}
                        disabled={!canvasEditor}
                        className="editor-icon-button flex items-center justify-center disabled:opacity-35 flex-none"
                        title="Add image (Shift + I)"
                        aria-label="Add image"
                    >
                        <ImagePlus className="h-3.5 w-3.5" />
                    </motion.button>

                    <div className="h-5 w-px mx-1 flex-none" style={{ background: 'var(--border-default)' }} />

                    {/* Reset View */}
                    <motion.button
                        onClick={() => canvasEditor?.__resetCanvasView?.()}
                        className="editor-icon-button flex items-center justify-center flex-none"
                        title="Reset view"
                    >
                        <ZoomIn className="h-3.5 w-3.5" />
                    </motion.button>

                    {/* Save */}
                    <motion.button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="editor-icon-button flex items-center justify-center flex-none disabled:opacity-50 disabled:cursor-wait"
                        title={isSaving ? 'Saving…' : 'Save (⌘S)'}
                    >
                        {isSaving
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Save className="h-3.5 w-3.5" />}
                    </motion.button>

                    {/* Keyboard shortcuts */}
                    <motion.button
                        onClick={() => setShowShortcuts(true)}
                        className="editor-icon-button flex items-center justify-center flex-none"
                        title="Keyboard shortcuts (?)"
                        aria-label="Show keyboard shortcuts"
                    >
                        <Keyboard className="h-3.5 w-3.5" />
                    </motion.button>

                    <div className="h-5 w-px mx-1 flex-none" style={{ background: 'var(--border-default)' }} />

                    {/* Export dropdown */}
                    <div className="relative flex-none" ref={exportMenuRef}>
                        <motion.button
                            onClick={() => setShowExportMenu(prev => !prev)}
                            className="flex items-center gap-1.5 editor-interactive pill-control"
                            style={{
                                background: '#A8794E',
                                border: '2px solid #F4F4F5',
                                color: '#03050A',
                                boxShadow: '4px 4px 0 0 #F4F4F5',
                                fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                letterSpacing: '0.12em',
                                textTransform: 'uppercase',
                                fontWeight: 800,
                                fontSize: '0.7rem',
                                padding: '0.5rem 0.85rem',
                                borderRadius: 0,
                            }}
                        >
                            <Download className="h-3.5 w-3.5" strokeWidth={2.5} />
                            Export
                            <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${showExportMenu ? 'rotate-180' : ''}`} />
                        </motion.button>

                        <AnimatePresence>
                            {showExportMenu && (
                                <motion.div
                                    className="absolute right-0 top-full mt-2 z-50 w-64 overflow-hidden rounded-xl glass-panel"
                                    style={{ boxShadow: 'var(--shadow-lg)', transformOrigin: 'top right' }}
                                    initial={{ opacity: 0, y: -6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -6 }}
                                    transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                                >
                                    <div className="p-1.5">
                                        {EXPORT_PRESETS.map((preset, idx) => (
                                            <motion.button
                                                key={preset.id}
                                                type="button"
                                                initial={{ opacity: 0 }}
                                                animate={{ opacity: 1 }}
                                                transition={{ delay: idx * 0.03 }}
                                                onClick={() => handleExport(preset)}
                                                className="flex w-full items-center gap-3 rounded-full px-3 py-2.5 text-left editor-interactive"
                                                style={{ color: 'var(--text-primary)' }}
                                                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                                                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                            >
                                                <div className="flex h-8 w-8 items-center justify-center rounded-full"
                                                     style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}>
                                                    <Download className="h-3.5 w-3.5" style={{ color: 'var(--accent-secondary)' }} />
                                                </div>
                                                <div>
                                                    <div className="text-xs font-semibold">{preset.label}</div>
                                                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{preset.description}</div>
                                                </div>
                                            </motion.button>
                                        ))}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </div>
            </div>

            <UpgradeModel
                isOpen={showUpgradeModel}
                onClose={() => {
                    setShowUpgradeModel(false)
                    setRestrictedTool(null)
                }}
                restrictedTool={restrictedTool}
                reason={
                    restrictedTool === "export"
                        ? "Free plan is limited to 20 exports per month. Upgrade to Pro for unlimited exports"
                        : undefined
                }
            />

            <ShortcutsGuide open={showShortcuts} onClose={() => setShowShortcuts(false)} />
        </>
    )
}

export default EditorTopbar
