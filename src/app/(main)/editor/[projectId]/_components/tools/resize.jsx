"use client"

import React, { useEffect, useState } from 'react'
import { useCanvas } from '../../../../../../../context/context';
import { useConvexMutation } from '../../../../../../../hooks/useConvexQuery';
import { api } from '../../../../../../../convex/_generated/api';
import { Button } from '@/components/ui/button';
import { Expand, Lock, Monitor, Unlock } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';

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

const ResizeControls = ({ project }) => {

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

    const calculateViewportScale = () => {

        if (!canvasEditor || !newWidth || !newHeight)
            return 1

        const container =
            canvasEditor.wrapperEl?.parentElement?.parentElement ||
            canvasEditor.wrapperEl?.parentElement ||
            canvasEditor.getElement()?.parentNode

        if (!container)
            return 1

        const containerWidth = Math.max(container.clientWidth - 40, 1)  // 40px padding
        const containerHeight = Math.max(container.clientHeight - 40, 1)

        const scaleX = containerWidth / newWidth
        const scaleY = containerHeight / newHeight

        // Use the smaller scale to ensure the canvas fits completely
        // Cap at 1 to prevent the upscaling beyond the original size
        return Math.min(scaleX, scaleY, 1)
    }

    const handleApplyResize = async () => {

        if (!canvasEditor || !project || (newWidth === project.width && newHeight === project.height))
            return                                              // No changes needed

        setProcessingMessage("Resizing Canvas...")

        try {
            const viewportScale = calculateViewportScale()

            // Fabric 7 removed setWidth/setHeight, so setDimensions handles the canvas size.
            canvasEditor.setDimensions(
                {
                    width: newWidth * viewportScale,             // Visual width
                    height: newHeight * viewportScale,
                },
                { backstoreOnly: false }
            )

            canvasEditor.setZoom(viewportScale)                  // Set zoom level
            canvasEditor.calcOffset()                            // Recalculate mouse coordinates
            canvasEditor.requestRenderAll()                      // Trigger redraw

            await updateProject({
                projectId: project._id,
                width: newWidth,
                height: newHeight,
                canvasState: canvasEditor.toJSON(),              // Save current canvas state
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
        <div className='space-y-5'>
            <div className='bg-slate-700/30 rounded-lg p-3'>
                <h4 className='text-sm font-medium text-white mb-2'>
                    Current Size
                </h4>
                <div className='text-xs text-white/70'>
                    {project.width} x {project.height} px
                </div>
            </div>

            <div className='space-y-4'>
                <div className='flex items-center justify-between mb-2'>
                    <h3 className='text-sm font-medium text-white'>
                        Custom Size
                    </h3>
                    <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => setLockAspectRatio(!lockAspectRatio)}
                        className="text-white/70 hover:text-white p-1"
                    >
                        {lockAspectRatio ? (
                            <Lock className='h-4 w-4' />        // Locked - proportions maintained
                        ) : (
                            <Unlock className='h-4 w-4' />)    // Unlocked - free resize
                        }
                    </Button>
                </div>
                <div className='grid grid-cols-2 gap-3'>
                    <div>
                        <label className='text-xs text-white/70 mb-1 block'>
                            Width
                        </label>
                        <Input
                            type="number"
                            value={newWidth}
                            onChange={(e) => handleWidthChange(e.target.value)}
                            min="100"
                            max="5000"
                            className="bg-slate-700 border-white/20 text-white"
                        />
                    </div>
                    <div>
                        <label className='text-xs text-white/70 mb-1 block'>
                            Height
                        </label>
                        <Input
                            type="number"
                            value={newHeight}
                            onChange={(e) => handleHeightChange(e.target.value)}
                            min="100"
                            max="5000"
                            className="bg-slate-700 border-white/20 text-white"
                        />
                    </div>
                </div>
                <div className='flex items-center justify-between text-xs'>
                    <span className='text-white/70'>
                        {lockAspectRatio ? "Aspect ratio locked" : "Free resize"}
                    </span>
                </div>
            </div>

            <div className='space-y-3'>
                <h3 className='text-sm font-medium text-white'>
                    Aspect Ratios
                </h3>
                <div className='grid grid-cols-1 max-h-60 overflow-y-auto gap-2'>
                    {ASPECT_RATIOS.map((aspectRatio) => {
                        const dimensions = calculateAspectRatioDimensions(
                            aspectRatio.ratio
                        )

                        return (
                            <Button
                                key={aspectRatio.name}
                                variant={
                                    selectedPreset === aspectRatio.name ? "default" : "outline"
                                }
                                size="sm"
                                onClick={() => applyAspectRatio(aspectRatio)}
                                className={`justify-between h-auto py-2 text-left
                                    ${selectedPreset === aspectRatio.name
                                        ? "bg-cyan-500 hover:bg-cyan-600"       // Highlight selected preset
                                        : "text-white/70 hover:text-white border-white/20"
                                    }`}
                            >
                                <div className='text-left'>
                                    <div className='font-medium'>
                                        {aspectRatio.name}
                                    </div>
                                    <div className='text-xs opacity-70'>
                                        {dimensions.width} x {dimensions.height} (
                                        {aspectRatio.label})
                                    </div>
                                </div>
                                <Monitor className='h-4 w-4' />
                            </Button>
                        )
                    })}
                </div>
            </div>
            {hasChanges && (
                <div className='bg-slate-700/30 rounded-lg p-3'>
                    <h4 className='text-sm font-medium text-white mb-2'>
                        New Size Preview
                    </h4>
                    <div className='text-xs text-white/70'>
                        <div>
                            New Canvas: {newWidth} x {newHeight} px
                        </div>
                        <div className='text-cyan-400'>
                            {/* Indicate whether canvas will grow or shrink */}
                            {newWidth > project.width || newHeight > project.height
                                ? "Canvas will be expanded"                       // Growing - adds space
                                : "Canvas will be cropped"
                            }{" "}
                        </div>
                        <div className='text-white/50 mt-1'>
                            Objects will maintain their current size and positions
                        </div>
                    </div>
                </div>
            )}

            <Button
                onClick={handleApplyResize}
                disabled={!hasChanges || processingMessage}                         // Disabled if there are no changes or processing
                className="w-full"
                variant="primary"
            >
                <Expand className='h-4 w-4 mr-2' />
                Apply Resize
            </Button>

            {/* Info that we want to show to the user */}
            <div className='bg-slate-700/30 rounded-lg p-3'>
                <p className='text-xs text-white/70'>
                    <strong>Resize Canvas:</strong> Changes canvas dimensions
                    <br />
                    <strong>Aspect Ratios:</strong> Smart sizing based on your current canvas
                    <br />
                    Objects maintain their size and position
                </p>
            </div>
        </div >
    )
}

export default ResizeControls
