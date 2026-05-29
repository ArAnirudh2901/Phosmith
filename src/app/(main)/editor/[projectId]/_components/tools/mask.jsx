"use client"

import React from 'react'
import { Scissors } from 'lucide-react'
import { useCanvas } from '../../../../../../../context/context'
import usePixelMaskTool, { MIN_BRUSH, MAX_BRUSH } from '../../../../../../../hooks/usePixelMaskTool'
import {
    BrushSizeControl,
    LabeledSlider,
    MaskActionButtons,
    ModeToggle,
    TipCard,
    ToolEmptyState,
} from './_pixel-tool-ui'

const MaskControls = ({ dominantColor }) => {
    const { canvasEditor } = useCanvas()
    const tool = usePixelMaskTool({ canvasEditor, defaultMode: 'erase', supportsMagic: false })

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
                icon={Scissors}
                title="No image on canvas"
                subtitle="Add an image first, then use the mask tool"
            />
        )
    }

    return (
        <div className="space-y-4 overflow-y-auto pr-1 panel-scroll">
            <ModeToggle mode={tool.mode} setMode={tool.setMode} altActive={tool.altActive} />

            <div className="space-y-3" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                <BrushSizeControl
                    value={tool.brushSize}
                    setValue={tool.setBrushSize}
                    min={MIN_BRUSH}
                    max={MAX_BRUSH}
                    dominantColor={dominantColor}
                />
                <LabeledSlider label="Hardness" value={tool.hardness} min={1} max={100} suffix="%" onChange={tool.setHardness} dominantColor={dominantColor} />
                <LabeledSlider label="Flow" value={tool.flow} min={5} max={100} suffix="%" onChange={tool.setFlow} dominantColor={dominantColor} />
            </div>

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
                <p>• <strong>Erase</strong> hides parts of the image (red preview)</p>
                <p>• <strong>Restore</strong> brings hidden parts back</p>
                <p>• Hold <strong>Alt</strong> to temporarily invert the brush</p>
                <p>• Lower <strong>Hardness</strong> or raise <strong>Feather</strong> for soft edges</p>
                <p>• PNG export preserves masked transparency</p>
            </TipCard>
        </div>
    )
}

export default MaskControls
