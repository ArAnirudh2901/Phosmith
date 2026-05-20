"use client"

import React, { useEffect, useState } from "react"
import { CanvasContext } from "../../../../../../context/context"
import TextControls from "./tools/text"
import ResizeControls from "./tools/resize"
import CropContent from "./tools/crop"
import AdjustControls from "./tools/adjust"
import BackgroundControls from "./tools/ai-background"
import AIExtender from "./tools/ai-extender"
import AIEdits from "./tools/ai-edit"
import GenerativeExpand from "./tools/generative-expand"
import { Crop, Expand, Eye, Maximize2, Palette, Sliders, Text, Wand2 } from "lucide-react"
import { extractDominantColors, getContrastingColor, adjustColorBrightness } from "@/lib/color-extraction"

const TOOL_CONFIGS = {
    resize: { title: "Resize", icon: Expand },
    crop: { title: "Crop", icon: Crop },
    adjust: { title: "Adjust", icon: Sliders },
    text: { title: "Text", icon: Text },
    ai_background: { title: "AI Background", icon: Palette },
    ai_extender: { title: "AI Extender", icon: Maximize2 },
    ai_edit: { title: "AI Edit", icon: Eye },
    generative_expand: { title: "Generative Fill", icon: Wand2 },
}

export default function EditorSidebar({ project: projectProp }) {
    const { activeTool } = React.useContext(CanvasContext)
    const project = projectProp
    const [dominantColor, setDominantColor] = useState('#00E5FF')
    const [contrastingColor, setContrastingColor] = useState('#000000')
    const [lighterColor, setLighterColor] = useState('#33E9FF')

    useEffect(() => {
        if (!project?.currentImageUrl && !project?.originalImageUrl) return

        const imageUrl = project.currentImageUrl || project.originalImageUrl
        extractDominantColors(imageUrl, 1).then(colors => {
            if (colors.length > 0) {
                const primary = colors[0]
                setDominantColor(primary.hex)
                setContrastingColor(getContrastingColor(primary.r, primary.g, primary.b))
                setLighterColor(adjustColorBrightness(primary.hex, 40))
            }
        }).catch(err => {
            console.warn('Color extraction failed:', err)
        })
    }, [project?.currentImageUrl, project?.originalImageUrl])

    if (!activeTool) return (
        <div className="flex flex-col items-center justify-center h-full text-center p-6" style={{ color: 'var(--text-muted)' }}>
            <div className="text-4xl mb-4 opacity-50">🖌️</div>
            <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Select a tool to begin</p>
            <p className="text-[11px]">Choose from the toolbar above to start editing</p>
        </div>
    )

    const config = TOOL_CONFIGS[activeTool]
    if (!config) return null
    const Icon = config.icon

    const renderContent = () => {
        const colorProps = { dominantColor, contrastingColor, lighterColor }
        switch (activeTool) {
            case "crop": return <CropContent {...colorProps} />
            case "resize": return project ? <ResizeControls project={project} {...colorProps} /> : <div>Loading...</div>
            case "adjust": return <AdjustControls {...colorProps} />
            case "text": return <TextControls {...colorProps} />
            case "ai_background": return project ? <BackgroundControls project={project} {...colorProps} /> : <div>Loading...</div>
            case "ai_extender": return project ? <AIExtender project={project} {...colorProps} /> : <div>Loading...</div>
            case "ai_edit": return project ? <AIEdits project={project} {...colorProps} /> : <div>Loading...</div>
            case "generative_expand": return project ? <GenerativeExpand project={project} {...colorProps} /> : <div>Loading...</div>
            default: return <div>Tool not available</div>
        }
    }

    return (
        <aside className="editor-sidebar h-full flex flex-col">
            <div className="editor-sidebar-header flex items-center gap-3">
                <div 
                    className="editor-tool-emblem flex items-center justify-center"
                    style={{
                        background: `linear-gradient(180deg, ${lighterColor}, ${dominantColor})`,
                        borderColor: dominantColor,
                        color: contrastingColor,
                    }}
                >
                    <Icon className="h-4 w-4" />
                </div>
                <div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{config.title}</h3>
                    <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>Properties</p>
                </div>
            </div>
            <div className="panel-scroll flex-1 overflow-y-auto p-4">
                {renderContent()}
            </div>
        </aside>
    )
}
