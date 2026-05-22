"use client"

import { Bot, Expand, Eye, Maximize2, Palette, Sliders, Text, Crop, ArrowLeft, Lock, ChevronDown, Download, Save, Undo2, Redo2, ZoomIn } from 'lucide-react'
import { useRouter } from 'next/navigation'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useCanvas, useDynamicAccent } from '../../../../../../context/context'
import usePlanAccess from '../../../../../../hooks/usePlanAccess'
import UpgradeModel from '@/components/upgradeModel'
import { motion, AnimatePresence } from 'framer-motion'

const EXPORT_PRESETS = [
    { id: 'png', label: 'PNG', description: 'Lossless · Best quality', format: 'png', quality: 1 },
    { id: 'jpeg90', label: 'JPEG 90%', description: 'Lossy · Great quality', format: 'jpeg', quality: 0.9 },
    { id: 'jpeg80', label: 'JPEG 80%', description: 'Lossy · Smaller file', format: 'jpeg', quality: 0.8 },
    { id: 'webp90', label: 'WebP 90%', description: 'Modern · Smallest file', format: 'webp', quality: 0.9 },
]

const TOOLS = [
    { id: "resize", label: "Resize", icon: Expand },
    { id: "crop", label: "Crop", icon: Crop },
    { id: "adjust", label: "Adjust", icon: Sliders },
    { id: "text", label: "Text", icon: Text },
    { id: "ai_background", label: "AI BG", icon: Palette, proOnly: true },
    { id: "ai_extender", label: "Extender", icon: Maximize2, proOnly: true },
    { id: "ai_edit", label: "AI Edit", icon: Eye, proOnly: true },
    { id: "ai_agent", label: "Agent", icon: Bot },
]

const EditorTopbar = ({ project }) => {

    const router = useRouter()
    const exportMenuRef = useRef(null)

    const [showUpgradeModel, setShowUpgradeModel] = useState(false)
    const [restrictedTool, setRestrictedTool] = useState(null)
    const [showExportMenu, setShowExportMenu] = useState(false)
    const [canUndo, setCanUndo] = useState(false)
    const [canRedo, setCanRedo] = useState(false)

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

    const handleToolChange = (toolId) => {
        if (!hasAccess(toolId)) {
            setRestrictedTool(toolId)
            setShowUpgradeModel(true)
            return
        }
        onToolChange(toolId)
    }

    const handleExport = async ({ format, quality }) => {
        if (!canvasEditor || !project) return

        const multiplier = 1
        const backgroundColor = format === 'png' ? null : (canvasEditor.backgroundColor || '#ffffff')
        const dataUrl = canvasEditor.toDataURL({
            format,
            quality,
            multiplier,
            backgroundColor,
        })

        const link = document.createElement('a')
        link.href = dataUrl
        link.download = `${project.title || 'export'}.${format === 'jpeg' ? 'jpg' : format}`
        link.click()
        setShowExportMenu(false)
    }

    return (
        <>
            {/* ── Top Navigation Bar ── */}
            <div className="editor-topbar flex items-center px-3">

                {/* Left section: Back + Project name */}
                <div className="flex w-[340px] flex-none items-center gap-2 min-w-0 mr-4">
                    <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={handleBackToDashboard}
                        className="editor-icon-button flex items-center justify-center"
                        title="Back to projects"
                    >
                        <ArrowLeft className="h-4 w-4" />
                    </motion.button>

                    <div className="h-5 w-px" style={{ background: 'var(--border-default)' }} />

                    <span className="text-sm font-semibold truncate max-w-[160px]"
                          style={{ color: 'var(--text-primary)' }}>
                        {project.title}
                    </span>

                    {exportResolutionLabel && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded"
                              style={{ color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
                            {exportResolutionLabel}
                        </span>
                    )}
                </div>

                {/* Center: Tool buttons */}
                <div className="flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-hidden">
                    {TOOLS.map((tool) => {
                        const Icon = tool.icon
                        const isActive = activeTool === tool.id
                        const hasToolAccess = hasAccess(tool.id)

                        return (
                            <motion.button
                                key={tool.id}
                                whileTap={{ scale: 0.93 }}
                                transition={{ type: "spring", stiffness: 600, damping: 30 }}
                                onClick={() => handleToolChange(tool.id)}
                                className={`tool-btn ${isActive ? 'tool-btn--active' : ''} ${!hasToolAccess ? 'tool-btn--locked' : ''}`}
                                style={isActive ? {
                                    color: '#03050A',
                                    borderColor: 'rgba(255,255,255,0.92)',
                                    background: 'linear-gradient(180deg, #F8FAFC 0%, #DDE5F0 100%)',
                                    boxShadow: `0 0 0 1px rgba(${accentRgb}, 0.45), 0 8px 22px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.95)`,
                                } : {}}
                            >
                                <Icon className="h-3.5 w-3.5" />
                                <span className="hidden xl:inline">{tool.label}</span>
                                {tool.proOnly && !hasToolAccess && (
                                    <Lock className="h-2.5 w-2.5 ml-0.5" style={{ color: 'var(--accent-warning)' }} />
                                )}
                            </motion.button>
                        )
                    })}
                </div>

                {/* Right: Actions */}
                <div className="ml-4 flex w-[340px] flex-none items-center justify-end gap-1">
                    {/* Undo / Redo */}
                    <motion.button
                        whileTap={{ scale: canUndo ? 0.9 : 1 }}
                        onClick={handleUndo}
                        disabled={!canUndo}
                        className="editor-icon-button flex items-center justify-center disabled:opacity-35 disabled:pointer-events-none"
                        title="Undo (⌘Z)"
                    >
                        <Undo2 className="h-3.5 w-3.5" />
                    </motion.button>

                    <motion.button
                        whileTap={{ scale: canRedo ? 0.9 : 1 }}
                        onClick={handleRedo}
                        disabled={!canRedo}
                        className="editor-icon-button flex items-center justify-center disabled:opacity-35 disabled:pointer-events-none"
                        title="Redo (⌘⇧Z)"
                    >
                        <Redo2 className="h-3.5 w-3.5" />
                    </motion.button>

                    <div className="h-5 w-px mx-1" style={{ background: 'var(--border-default)' }} />

                    {/* Reset View */}
                    <motion.button
                        whileTap={{ scale: 0.9 }}
                        onClick={() => canvasEditor?.__resetCanvasView?.()}
                        className="editor-icon-button flex items-center justify-center"
                        title="Reset view"
                    >
                        <ZoomIn className="h-3.5 w-3.5" />
                    </motion.button>

                    {/* Save */}
                    <motion.button
                        whileTap={{ scale: 0.9 }}
                        onClick={() => canvasEditor?.__saveCanvasState?.()}
                        className="editor-icon-button flex items-center justify-center"
                        title="Save"
                    >
                        <Save className="h-3.5 w-3.5" />
                    </motion.button>

                    <div className="h-5 w-px mx-1" style={{ background: 'var(--border-default)' }} />

                    {/* Export dropdown */}
                    <div className="relative" ref={exportMenuRef}>
                        <motion.button
                            whileTap={{ scale: 0.95 }}
                            onClick={() => setShowExportMenu(prev => !prev)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium editor-interactive pill-control"
                            style={{
                                background: 'linear-gradient(180deg, #FFE28A 0%, #D9A72E 100%)',
                                border: '1px solid rgba(255,232,150,0.78)',
                                color: '#080A0F',
                                boxShadow: '0 10px 26px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.55)',
                            }}
                        >
                            <Download className="h-3.5 w-3.5" />
                            Export
                            <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${showExportMenu ? 'rotate-180' : ''}`} />
                        </motion.button>

                        <AnimatePresence>
                            {showExportMenu && (
                                <motion.div
                                    className="fixed right-3 top-[58px] z-50 w-64 overflow-hidden rounded-xl glass-panel"
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
        </>
    )
}

export default EditorTopbar
