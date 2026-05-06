import { Crop, Expand, Eye, Maximize2, Palette, Sliders, Text } from 'lucide-react'
import React from 'react'
import { useCanvas } from '../../../../../../context/context'
import CropContent from './tools/crop'
import ResizeControls from './tools/resize'
import AdjustControls from './tools/adjust'

const TOOL_CONFIGS = {
    resize: {
        title: "Resize",
        icon: Expand,
        description: "Change project dimensions"
    },

    crop: {
        title: "Crop",
        icon: Crop,
        description: "Crop and trim your image"
    },

    adjust: {
        title: "Adjust",
        icon: Sliders,
        description: "Brightness, contrast, saturation, and more"
    },

    ai_background: {
        title: "Background",
        icon: Palette,
        description: "Remove or change background"
    },

    ai_extender: {
        title: "AI Image Extender",
        icon: Maximize2,
        description: "Extend image boundaries with AI"
    },

    text: {
        title: "Add Text",
        icon: Text,
        description: "Customize in Various Fonts"
    },

    ai_edit: {
        title: "AI Editing",
        icon: Eye,
        description: "Enhance image quality with AI"
    },
}

const EditorSidebar = ({ project }) => {

    const { activeTool } = useCanvas()

    const toolConfig = TOOL_CONFIGS[activeTool]

    if (!toolConfig)
        return null

    const Icon = toolConfig.icon

    return (
        <div className='min-w-96 border-r flex flex-col'>
            <div className='p-4 border-b'>
                <div className='flex items-center gap-3'>
                    <Icon className='h-5 w-5 text-white' />
                    <h2 className='text-lg font-semibold text-white'>
                        {toolConfig.title}
                    </h2>
                </div>
                <p className='text-sm text-white mt-1'>
                    {toolConfig.description}
                </p>
            </div>

            <div className='flex-1 p-4'>
                {renderToolConfig(activeTool, project)}
            </div>
        </div>
    )
}

const renderToolConfig = (activeTool, project) => {
    switch (activeTool) {
        case "crop":
            return <CropContent />

        case "resize":
            return <ResizeControls project={project} />

        case "adjust":
            return <AdjustControls />

        default:
            return <div className='text-white'>Select a tool to get started</div>
    }
}

export default EditorSidebar
