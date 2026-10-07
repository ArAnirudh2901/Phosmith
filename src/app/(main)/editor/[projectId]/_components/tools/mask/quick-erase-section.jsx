import { Eraser, X } from 'lucide-react'
import { BrushSizeControl, LabeledSlider, ModeToggle } from '../_pixel-tool-ui'
import { MAX_BRUSH, MIN_BRUSH } from '../../../../../../../../hooks/usePixelMaskTool'
import { Section } from './ui'

// Quick Erase: destructive manual brush.

export default function QuickEraseSection({
    dominantColor,
    handleStartQuickErase,
    handleStopQuickErase,
    quickEraseActive,
    tool,
}) {
    // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
    'use no memo'
    return (
        <Section title="Quick Erase" icon={Eraser} defaultOpen={false}>
            <div className="space-y-2">
                <p className="text-[10px]" style={{ color: '#FCA5A5' }}>
                    ⚠ This paints directly onto the image and hides pixels
                    (destructive). For a reversible result, use the
                    <strong> Selection Brush</strong> with Erase / Cut instead.
                    Turn this on to paint; turn it off to stop.
                </p>
                <button
                    type="button"
                    onClick={quickEraseActive ? handleStopQuickErase : handleStartQuickErase}
                    aria-pressed={quickEraseActive}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-semibold editor-interactive"
                    style={{
                        background: quickEraseActive ? 'rgba(239,68,68,0.14)' : 'var(--bg-elevated)',
                        border: `1px solid ${quickEraseActive ? 'rgba(239,68,68,0.45)' : 'var(--border-subtle)'}`,
                        color: quickEraseActive ? '#FCA5A5' : 'var(--text-secondary)',
                    }}
                >
                    {quickEraseActive ? <X className="h-3.5 w-3.5" /> : <Eraser className="h-3.5 w-3.5" />}
                    {quickEraseActive ? 'Stop erasing' : 'Enable Quick Erase'}
                </button>
                {quickEraseActive && (
                    <>
                        <ModeToggle mode={tool.mode} setMode={tool.setMode} altActive={tool.altActive} />
                        <BrushSizeControl
                            value={tool.brushSize}
                            setValue={tool.setBrushSize}
                            min={MIN_BRUSH}
                            max={MAX_BRUSH}
                            dominantColor={dominantColor}
                        />
                        <LabeledSlider label="Hardness" value={tool.hardness} min={1} max={100} suffix="%" onChange={tool.setHardness} dominantColor={dominantColor} />
                        <LabeledSlider label="Flow" value={tool.flow} min={5} max={100} suffix="%" onChange={tool.setFlow} dominantColor={dominantColor} />
                        <LabeledSlider label="Edge Feather" value={tool.feather} min={0} max={50} suffix="px" onChange={tool.setFeather} dominantColor={dominantColor} />
                    </>
                )}
            </div>
        </Section>
    )
}
