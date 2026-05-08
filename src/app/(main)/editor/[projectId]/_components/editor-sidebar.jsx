import { Crop, Expand, Eye, Maximize2, Palette, Sliders, Text } from 'lucide-react'
import React from 'react'
import { useCanvas } from '../../../../../../context/context'
import CropContent from './tools/crop'
import ResizeControls from './tools/resize'
import AdjustControls from './tools/adjust'
import BackgroundControls from './tools/ai-background'
import AIExtender from './tools/ai-extender'
import AIEdits from './tools/ai-edit'
import TextControls from './tools/text'

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
        <div className='w-[380px] max-w-[380px] shrink-0 border-r flex h-full min-h-0 flex-col overflow-hidden'>
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

            <div className='flex-1 min-h-0 overflow-y-auto p-4 pr-3'>
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

        case "ai_background":
            return <BackgroundControls project={project} />

        case "ai_extender":
            return <AIExtender project={project} />

        case "ai_edit":
            return <AIEdits project={project} />

        case "text":
            return <TextControls />

        default:
            return <div className='text-white'>Select a tool to get started</div>
    }
}

export default EditorSidebar
