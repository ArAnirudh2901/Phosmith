"use client"

import { Expand, Eye, Maximize2, Palette, Sliders, Text, Crop, ArrowLeft, Lock, RotateCcw, ChevronDown, Download, RotateCw, Save } from 'lucide-react'
import { useRouter } from 'next/navigation'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useCanvas } from '../../../../../../context/context'
import usePlanAccess from '../../../../../../hooks/usePlanAccess'
import { Button } from '@/components/ui/button'
import UpgradeModel from '@/components/upgradeModel'

const EXPORT_PRESETS = [
    { id: 'png', label: 'PNG (High Quality)', description: 'PNG • 100% quality', format: 'png', quality: 1 },
    { id: 'jpeg90', label: 'JPEG (90% Quality)', description: 'JPEG • 90% quality', format: 'jpeg', quality: 0.9 },
    { id: 'jpeg80', label: 'JPEG (80% Quality)', description: 'JPEG • 80% quality', format: 'jpeg', quality: 0.8 },
    { id: 'webp90', label: 'WebP (90% Quality)', description: 'WEBP • 90% quality', format: 'webp', quality: 0.9 },
]

const TOOLS = [
    {
        id: "resize",
        label: "Resize",
        icon: Expand,
        isActive: true,
    },

    {
        id: "crop",
        label: "Crop",
        icon: Crop,
    },

    {
        id: "adjust",
        label: "Adjust",
        icon: Sliders,
    },

    {
        id: "text",
        label: "Text",
        icon: Text,
    },

    {
        id: "ai_background",
        label: "AI Background",
        icon: Palette,
        proOnly: true,
    },

    {
        id: "ai_extender",
        label: "AI Image Extender",
        icon: Maximize2,
        proOnly: true,
    },

    {
        id: "ai_edit",
        label: "AI Edit",
        icon: Eye,
        proOnly: true,
    },
]

const EditorTopbar = ({ project }) => {

    const router = useRouter()
    const exportMenuRef = useRef(null)

    const [showUpgradeModel, setShowUpgradeModel] = useState(false)
    const [restrictedTool, setRestrictedTool] = useState(null)
    const [showExportMenu, setShowExportMenu] = useState(false)

    const { canvasEditor, activeTool, onToolChange } = useCanvas()
    const { hasAccess, canExport, isFree } = usePlanAccess()

    const exportResolutionLabel = useMemo(() => {
        if (!project?.width || !project?.height) return 'Export Resolution'
        return `Export Resolution: ${project.width} × ${project.height}px`
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
            <div className='border-b px-6 py-3'>
                <div className='flex items-center justify-between mb-4'>
                    <Button
                        variant='ghost'
                        size='sm'
                        onClick={handleBackToDashboard}
                        className="text-white hover:text-gray-300"
                    >
                        <ArrowLeft className='h-4 w-4 mr-2' />
                        All Projects
                    </Button>

                    <h1 className='font-extrabold capitalize'>
                        {project.title}
                    </h1>

                    <div className='flex items-center gap-2'>
                        <Button
                            variant='ghost'
                            size='sm'
                            className='text-white hover:bg-white/10'
                            onClick={() => canvasEditor?.__resetCanvasView?.()}
                            disabled={!canvasEditor}
                            title='Reset canvas view'
                        >
                            <RotateCw className='h-4 w-4 mr-2' />
                            Reset
                        </Button>

                        <Button
                            variant='ghost'
                            size='sm'
                            className='text-white hover:bg-white/10'
                            onClick={() => canvasEditor?.__saveCanvasState?.()}
                            disabled={!canvasEditor}
                            title='Save canvas state'
                        >
                            <Save className='h-4 w-4 mr-2' />
                            Save
                        </Button>
                    </div>
                </div>

                <div className='flex items-center justify-between'>
                    <div className='flex items-center gap-2'>
                        {TOOLS.map((tool) => {
                            const Icon = tool.icon
                            const isActive = activeTool === tool.id
                            const hasToolAccess = hasAccess(tool.id)

                            return (
                                <Button
                                    key={tool.id}
                                    variant={isActive ? "default" : "ghost"}
                                    size="sm"
                                    onClick={() => handleToolChange(tool.id)}
                                    className={`gap-2 relative rounded-sm  ${isActive
                                        ? "bg-blue-600 text-white hover:bg-blue-700"
                                        : "text-white hover:text-gray-300 hover:bg-gray-100"
                                        } ${!hasToolAccess ? "opacity-60" : ""}`}
                                >
                                    <Icon className='h-4 w-4' />
                                    {tool.label}
                                    {tool.proOnly && !hasToolAccess && (
                                        <Lock className='h-3 w-3 text-amber-400' />
                                    )}

                                </Button>
                            )
                        })}
                    </div>

                    <div className='relative flex items-center gap-1' ref={exportMenuRef}>
                        <Button variant='ghost' size='sm' className="text-white" title='Reset View'>
                            <RotateCcw className='h-4 w-4' />
                        </Button>

                        <Button variant='ghost' size='sm' className="text-white" title='Restore View'>
                            <RotateCw className='h-4 w-4' />
                        </Button>

                        <Button
                            variant='ghost'
                            size='sm'
                            className='text-white hover:bg-white/10'
                            onClick={() => setShowExportMenu((current) => !current)}
                        >
                            <Download className='h-4 w-4 mr-2' />
                            Export
                            <ChevronDown className='h-4 w-4 ml-1' />
                        </Button>

                        {showExportMenu && (
                            <div className='absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-white/10 bg-slate-900/95 shadow-2xl backdrop-blur-xl'>
                                <div className='border-b border-white/10 px-4 py-3'>
                                    <div className='text-sm font-medium text-white'>{exportResolutionLabel}</div>
                                </div>

                                <div className='p-2'>
                                    {EXPORT_PRESETS.map((preset) => (
                                        <button
                                            key={preset.id}
                                            type='button'
                                            onClick={() => handleExport(preset)}
                                            className='flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition hover:bg-white/5'
                                        >
                                            <div className='flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white'>
                                                <Download className='h-4 w-4' />
                                            </div>
                                            <div>
                                                <div className='text-sm font-semibold text-white'>{preset.label}</div>
                                                <div className='text-xs text-white/55'>{preset.description}</div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
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
