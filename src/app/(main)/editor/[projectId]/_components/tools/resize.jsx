"use client"

import React, { useEffect, useState } from 'react'
import { useCanvas } from '../../../../../../../context/context';
import { useConvexMutation } from '../../../../../../../hooks/useConvexQuery';
import { api } from '../../../../../../../convex/_generated/api';
import { Button } from '@/components/ui/button';
import { Expand, Lock, Monitor, Unlock } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { serializeCanvasState } from '../../../../../../lib/canvas-state'

const ASPECT_RATIOS = [
    {
        name: "Instagram Story",
        ratio: [9, 16],
        label: "9:16"
    },

    {
        name: "Instagram Post",
        ratio: [1, 1],
        label: "1:1"
    },

    {
        name: "YouTube Thumbnail",
        ratio: [16, 9],
        label: "16:9"
    },

    {
        name: "Portrait",
        ratio: [2, 3],
        label: "2:3"
    },

    {
        name: "Facebook Cover",
        ratio: [851, 315],
        label: "2.7:1"
    },

    {
        name: "Twitter Header",
        ratio: [3, 1],
        label: "3:1"
    },
];

const ResizeControls = ({ project, dominantColor, contrastingColor, lighterColor }) => {

    const { canvasEditor, processingMessage, setProcessingMessage } = useCanvas()

    const data = project
    const isLoading = !data

    const [newWidth, setNewWidth] = useState(project?.width || 800)       // Target width
    const [newHeight, setNewHeight] = useState(project?.height || 600)    // Target height
    const [lockAspectRatio, setLockAspectRatio] = useState(true)          // Whether to maintain proportions
    const [selectedPreset, setSelectedPreset] = useState(null)            // Currectly selected preset

    const { mutate: updateProject } = useConvexMutation(api.projects.updateProject)

    useEffect(() => {
        if (isLoading || !data?.width || !data?.height)
            return

        setNewWidth(data.width)
        setNewHeight(data.height)
        setSelectedPreset(null)

        const resizeTimeout = setTimeout(() => {
            // Work around for initial resize issues
            window.dispatchEvent(new Event("resize"))
        }, 500)

        // window.location.reload()                                            // Force reload to apply new changes to the image
        return () => clearTimeout(resizeTimeout)
    }, [data, isLoading])

    const handleWidthChange = (value) => {
        const width = parseInt(value) || 0
        setNewWidth(width)

        if (lockAspectRatio && project) {
            const ratio = project.height / project.width        // Current aspect ratio
            setNewHeight(Math.round(width * ratio))             // Apply ratio to new width
        }

        setSelectedPreset(null)
    }

    const handleHeightChange = (value) => {
        const height = parseInt(value) || 0
        setNewHeight(height)

        if (lockAspectRatio && project) {
            const ratio = project.width / project.height        // Current aspect ratio
            setNewWidth(Math.round(height * ratio))             // Apply ratio to new height
        }

        setSelectedPreset(null)
    }
    const calculateAspectRatioDimensions = (ratio) => {
        if (!project)
            return { width: newWidth, height: newHeight }

        const [ratioW, ratioH] = ratio
        const originalArea = project.width * project.height      // Preserve total pixel area

        const aspectRatio = ratioW / ratioH
        const newHeight = Math.sqrt(originalArea / aspectRatio)
        const newWidth = newHeight * aspectRatio

        return {
            width: Math.round(newWidth),
            height: Math.round(newHeight)
        }
    }

    const applyAspectRatio = (aspectRatio) => {
        const dimensions = calculateAspectRatioDimensions(aspectRatio.ratio)
        setNewHeight(dimensions.height)
        setNewWidth(dimensions.width)
        setSelectedPreset(aspectRatio.name)
    }

    const handleApplyResize = async () => {

        if (!canvasEditor || !project || (newWidth === project.width && newHeight === project.height))
            return                                              // No changes needed

        setProcessingMessage("Resizing Canvas...")

        try {
            canvasEditor.__fitCanvasToProject?.({ width: newWidth, height: newHeight })
            canvasEditor.calcOffset()
            canvasEditor.requestRenderAll()

            await updateProject({
                projectId: project._id,
                width: newWidth,
                height: newHeight,
                canvasState: serializeCanvasState(canvasEditor), // Save current canvas state and viewport
            })
        } catch (error) {
            console.error("Error resizing canvas: ", error)
            toast.error("Failed to resize canvas. Please try again.")
        } finally {
            setProcessingMessage(null)
        }
    }

    if (!canvasEditor || !project) {
        return (
            <div className='p-4'>
                <p className='text-white/70 text-sm'>
                    Canvas not ready
                </p>
            </div>
        )
    }

    const hasChanges = newWidth !== project.width || newHeight !== project.height

    return (
        <div className='space-y-4'>
            <div className='panel-card'>
                <label className='panel-label'>Current Size</label>
                <div className='text-xs mt-1.5 font-mono' style={{ color: 'var(--text-secondary)' }}>
                    {project.width} × {project.height} px
                </div>
            </div>

            <div className='space-y-3'>
                <div className='flex items-center justify-between'>
                    <label className='panel-label'>Custom Size</label>
                    <button
                        onClick={() => setLockAspectRatio(!lockAspectRatio)}
                        className="flex items-center justify-center w-7 h-7 rounded-lg editor-interactive"
                        style={{ color: lockAspectRatio ? dominantColor || 'var(--accent-primary)' : 'var(--text-muted)', background: 'transparent' }}
                    >
                        {lockAspectRatio ? <Lock className='h-3.5 w-3.5' /> : <Unlock className='h-3.5 w-3.5' />}
                    </button>
                </div>
                <div className='grid grid-cols-2 gap-2'>
                    <div>
                        <label className='text-[10px] mb-1 block' style={{ color: 'var(--text-muted)' }}>Width</label>
                        <input
                            type="number"
                            value={newWidth}
                            onChange={(e) => handleWidthChange(e.target.value)}
                            min="100"
                            max="5000"
                            className="panel-input"
                        />
                    </div>
                    <div>
                        <label className='text-[10px] mb-1 block' style={{ color: 'var(--text-muted)' }}>Height</label>
                        <input
                            type="number"
                            value={newHeight}
                            onChange={(e) => handleHeightChange(e.target.value)}
                            min="100"
                            max="5000"
                            className="panel-input"
                        />
                    </div>
                </div>
                <div className='text-[10px]' style={{ color: 'var(--text-muted)' }}>
                    {lockAspectRatio ? "🔒 Aspect ratio locked" : "🔓 Free resize"}
                </div>
            </div>

            <div className='space-y-2.5'>
                <label className='panel-label'>Aspect Ratios</label>
                <div className='grid grid-cols-1 max-h-56 overflow-y-auto gap-1.5 panel-scroll'>
                    {ASPECT_RATIOS.map((aspectRatio) => {
                        const dimensions = calculateAspectRatioDimensions(aspectRatio.ratio)
                        const active = selectedPreset === aspectRatio.name

                        return (
                            <button
                                key={aspectRatio.name}
                                onClick={() => applyAspectRatio(aspectRatio)}
                                className='flex items-center justify-between rounded-lg px-3 py-2 text-left editor-interactive'
                                style={{
                                    border: `1px solid ${active ? dominantColor || 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    background: active ? `${dominantColor}1a` : 'var(--bg-elevated)',
                                }}
                            >
                                <div>
                                    <div className='text-xs font-medium' style={{ color: active ? contrastingColor || 'var(--text-primary)' : 'var(--text-primary)' }}>
                                        {aspectRatio.name}
                                    </div>
                                    <div className='text-[10px] mt-0.5' style={{ color: 'var(--text-muted)' }}>
                                        {dimensions.width} × {dimensions.height} ({aspectRatio.label})
                                    </div>
                                </div>
                                <Monitor className='h-3.5 w-3.5' style={{ color: active ? dominantColor || 'var(--accent-primary)' : 'var(--text-muted)' }} />
                            </button>
                        )
                    })}
                </div>
            </div>

            {hasChanges && (
                <div className='panel-card' style={{ borderColor: 'rgba(0, 229, 255, 0.2)' }}>
                    <label className='panel-label'>New Size</label>
                    <div className='text-xs mt-1.5' style={{ color: 'var(--text-secondary)' }}>
                        <div className="font-mono">{newWidth} × {newHeight} px</div>
                        <div className='mt-1' style={{ color: 'var(--accent-primary)' }}>
                            {newWidth > project.width || newHeight > project.height
                                ? "↗ Canvas will expand"
                                : "↙ Canvas will crop"
                            }
                        </div>
                        <div className='mt-1' style={{ color: 'var(--text-muted)' }}>
                            Objects maintain their size and position
                        </div>
                    </div>
                </div>
            )}

            <button
                onClick={handleApplyResize}
                disabled={!hasChanges || processingMessage}
                className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-40"
                style={{ 
                    background: dominantColor || 'var(--accent-primary)', 
                    color: contrastingColor || '#fff', 
                    border: 'none',
                    boxShadow: hasChanges ? `0 0 30px ${dominantColor}40` : 'none' 
                }}
            >
                <Expand className='h-3.5 w-3.5' />
                Apply Resize
            </button>

            <div className='panel-card text-[11px]' style={{ borderColor: 'rgba(0, 229, 255, 0.1)' }}>
                <p style={{ color: 'var(--text-muted)' }}>
                    <strong style={{ color: 'var(--text-secondary)' }}>Resize:</strong> Changes canvas dimensions
                    <br />
                    <strong style={{ color: 'var(--text-secondary)' }}>Ratios:</strong> Smart sizing based on your canvas
                    <br />
                    Objects maintain their size and position
                </p>
            </div>
        </div >
    )
}

export default ResizeControls
