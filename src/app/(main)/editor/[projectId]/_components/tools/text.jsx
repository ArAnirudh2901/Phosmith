"use client"

import React, { useCallback, useEffect, useState } from 'react'
import { useCanvas } from '../../../../../../../context/context'
import {
    AlignCenter,
    AlignLeft,
    AlignRight,
    Bold,
    Italic,
    Minus,
    Plus,
    Trash2,
    Type,
    Underline,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { IText } from 'fabric'
import Colorful from '@uiw/react-color-colorful'

const FONT_FAMILIES = [
    "Arial",
    "Arial Black",
    "Helvetica",
    "Times New Roman",
    "Courier New",
    "Georgia",
    "Verdana",
    "Comic Sans MS",
    "Impact",
]

const FONT_SIZES = { min: 8, max: 120, default: 20 }
const DEFAULT_TEXT_COLOR = "#111827"
const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

const TEXT_ALIGNMENTS = [
    { value: "left", label: "Left", icon: AlignLeft },
    { value: "center", label: "Center", icon: AlignCenter },
    { value: "right", label: "Right", icon: AlignRight },
]

const COLOR_SWATCHES = [
    "#111827",
    "#ffffff",
    "#ef4444",
    "#f59e0b",
    "#22c55e",
    "#06b6d4",
    "#3b82f6",
    "#a855f7",
]

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const isTextObject = (object) => {
    const objectType = object?.type?.toLowerCase()

    return objectType === "i-text" || objectType === "textbox" || objectType === "text"
}

const getCanvasCenter = (canvasEditor) => {
    if (canvasEditor?.getVpCenter)
        return canvasEditor.getVpCenter()

    const zoom = canvasEditor?.getZoom?.() || 1

    return {
        x: (canvasEditor?.width || 0) / (2 * zoom),
        y: (canvasEditor?.height || 0) / (2 * zoom),
    }
}

const getFontSize = (value) =>
    clamp(parseInt(value, 10) || FONT_SIZES.default, FONT_SIZES.min, FONT_SIZES.max)

const isEditableElement = (target) => {
    const tagName = target?.tagName?.toLowerCase()

    return target?.isContentEditable || ["input", "textarea", "select"].includes(tagName)
}

const TextControls = ({ dominantColor, contrastingColor, lighterColor }) => {

    const { canvasEditor } = useCanvas()
    const [selectedText, setSelectedText] = useState(null)
    const [textContent, setTextContent] = useState("")
    const [fontFamily, setFontFamily] = useState("Arial")
    const [fontSize, setFontSize] = useState(FONT_SIZES.default)
    const [textColor, setTextColor] = useState(DEFAULT_TEXT_COLOR)
    const [textAlign, setTextAlign] = useState("left")
    const [isBold, setIsBold] = useState(false)
    const [isItalic, setIsItalic] = useState(false)
    const [isUnderline, setIsUnderline] = useState(false)

    const updateSelectedText = useCallback(() => {
        if (!canvasEditor)
            return

        const activeObject = canvasEditor.getActiveObject()

        if (isTextObject(activeObject)) {
            setSelectedText(activeObject)

            const fill = typeof activeObject.fill === "string"
                ? activeObject.fill
                : DEFAULT_TEXT_COLOR
            const fontWeight = String(activeObject.fontWeight || "normal")

            setFontFamily(activeObject.fontFamily || "Arial")
            setFontSize(activeObject.fontSize || FONT_SIZES.default)
            setTextColor(fill)
            setTextAlign(activeObject.textAlign || "left")
            setTextContent(activeObject.text || "")
            setIsBold(fontWeight === "bold" || parseInt(fontWeight, 10) >= 600)
            setIsItalic(activeObject.fontStyle === "italic")
            setIsUnderline(Boolean(activeObject.underline))
        }
        else {
            setSelectedText(null)
            setTextContent("")
        }
    }, [canvasEditor])

    useEffect(() => {
        if (!canvasEditor)
            return

        const initialSyncTimeout = window.setTimeout(updateSelectedText, 0)

        const handleSelectionCreated = () => updateSelectedText()
        const handleSelectionUpdated = () => updateSelectedText()
        const handleSelectionCleared = () => updateSelectedText()
        const handleTextChanged = () => updateSelectedText()
        const handleObjectModified = () => updateSelectedText()
        const handleObjectRemoved = () => updateSelectedText()

        canvasEditor.on("selection:created", handleSelectionCreated)
        canvasEditor.on("selection:updated", handleSelectionUpdated)
        canvasEditor.on("selection:cleared", handleSelectionCleared)
        canvasEditor.on("text:changed", handleTextChanged)
        canvasEditor.on("object:modified", handleObjectModified)
        canvasEditor.on("object:removed", handleObjectRemoved)

        return () => {
            window.clearTimeout(initialSyncTimeout)
            canvasEditor.off("selection:created", handleSelectionCreated)
            canvasEditor.off("selection:updated", handleSelectionUpdated)
            canvasEditor.off("selection:cleared", handleSelectionCleared)
            canvasEditor.off("text:changed", handleTextChanged)
            canvasEditor.off("object:modified", handleObjectModified)
            canvasEditor.off("object:removed", handleObjectRemoved)
        }

    }, [canvasEditor, updateSelectedText])

    const addText = useCallback(() => {
        if (!canvasEditor)
            return

        const center = getCanvasCenter(canvasEditor)
        const text = new IText("Edit this text", {
            left: center.x,
            top: center.y,
            originX: "center",
            originY: "center",
            fontFamily,
            fontSize,
            fill: HEX_COLOR_PATTERN.test(textColor) ? textColor : DEFAULT_TEXT_COLOR,
            textAlign,
            fontWeight: isBold ? "bold" : "normal",
            fontStyle: isItalic ? "italic" : "normal",
            underline: isUnderline,
            editable: true,
            selectable: true,
        })

        canvasEditor.add(text)
        canvasEditor.setActiveObject(text)
        canvasEditor.requestRenderAll()

        setTimeout(() => {
            text.enterEditing()
            text.selectAll()
        }, 100)
    }, [canvasEditor, fontFamily, fontSize, isBold, isItalic, isUnderline, textAlign, textColor])

    const updateTextProperty = useCallback((property, value) => {
        if (!canvasEditor || !selectedText)
            return

        selectedText.set(property, value)
        selectedText.setCoords()
        canvasEditor.requestRenderAll()
        canvasEditor.fire("object:modified", { target: selectedText })
    }, [canvasEditor, selectedText])

    const applyFontFamily = (family) => {
        setFontFamily(family)
        updateTextProperty("fontFamily", family)
    }

    const applyFontSize = (value) => {
        const nextFontSize = getFontSize(value)

        setFontSize(nextFontSize)
        updateTextProperty("fontSize", nextFontSize)
    }

    const applyTextColor = (color) => {
        setTextColor(color)

        if (HEX_COLOR_PATTERN.test(color))
            updateTextProperty("fill", color)
    }

    const applyTextAlign = (alignment) => {
        setTextAlign(alignment)
        updateTextProperty("textAlign", alignment)
    }

    const applyTextContent = (content) => {
        setTextContent(content)
        updateTextProperty("text", content)
    }

    const toggleBold = useCallback(() => {
        const nextIsBold = !isBold

        setIsBold(nextIsBold)
        updateTextProperty("fontWeight", nextIsBold ? "bold" : "normal")
    }, [isBold, updateTextProperty])

    const toggleItalic = useCallback(() => {
        const nextIsItalic = !isItalic

        setIsItalic(nextIsItalic)
        updateTextProperty("fontStyle", nextIsItalic ? "italic" : "normal")
    }, [isItalic, updateTextProperty])

    const toggleUnderline = useCallback(() => {
        const nextIsUnderline = !isUnderline

        setIsUnderline(nextIsUnderline)
        updateTextProperty("underline", nextIsUnderline)
    }, [isUnderline, updateTextProperty])

    const deleteSelectedText = useCallback(() => {
        if (!canvasEditor || !selectedText)
            return

        canvasEditor.remove(selectedText)
        canvasEditor.discardActiveObject()
        canvasEditor.requestRenderAll()
        setSelectedText(null)
        setTextContent("")
    }, [canvasEditor, selectedText])

    useEffect(() => {
        if (!canvasEditor)
            return

        const handleShortcut = (event) => {
            const activeObject = canvasEditor.getActiveObject()

            if (!isTextObject(activeObject) || isEditableElement(event.target))
                return

            const isEditingText = Boolean(activeObject.isEditing)
            const isModifiedShortcut = event.metaKey || event.ctrlKey
            const key = event.key.toLowerCase()

            if ((event.key === "Delete" || event.key === "Backspace") && !isEditingText) {
                event.preventDefault()
                deleteSelectedText()
                return
            }

            if (!isModifiedShortcut || event.altKey || event.shiftKey)
                return

            if (key === "b") {
                event.preventDefault()
                toggleBold()
            }

            if (key === "i") {
                event.preventDefault()
                toggleItalic()
            }

            if (key === "u") {
                event.preventDefault()
                toggleUnderline()
            }
        }

        window.addEventListener("keydown", handleShortcut)

        return () => {
            window.removeEventListener("keydown", handleShortcut)
        }
    }, [canvasEditor, deleteSelectedText, toggleBold, toggleItalic, toggleUnderline])

    if (!canvasEditor) {
        return (
            <div className='p-4'>
                <p className='text-xs' style={{ color: 'var(--text-muted)' }}>Canvas not ready</p>
            </div>
        )
    }

    return (
        <div className='space-y-4 overflow-y-auto pr-1 panel-scroll'>
            <div className='space-y-3'>
                <label className='panel-label'>Add Text</label>
                <button
                    onClick={addText}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive"
                    style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none', boxShadow: 'var(--shadow-glow)' }}
                >
                    <Type className='h-3.5 w-3.5' />
                    Add Text
                </button>
            </div>

            {selectedText && (
                <div className='space-y-4 pt-4' style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <label className='panel-label'>Edit Selected Text</label>

                    <div className='space-y-1.5'>
                        <label className='text-[10px]' style={{ color: 'var(--text-muted)' }}>Content</label>
                        <textarea
                            value={textContent}
                            onChange={(e) => applyTextContent(e.target.value)}
                            rows={3}
                            className="panel-input resize-none"
                            style={{ minHeight: '60px' }}
                        />
                    </div>

                    <div className='space-y-1.5'>
                        <label className='text-[10px]' style={{ color: 'var(--text-muted)' }}>Font Family</label>
                        <select
                            value={fontFamily}
                            onChange={(e) => applyFontFamily(e.target.value)}
                            className='panel-input'
                            style={{ appearance: 'auto' }}
                        >
                            {FONT_FAMILIES.map((font) => (
                                <option key={font} value={font}>{font}</option>
                            ))}
                        </select>
                    </div>

                    <div className='space-y-2'>
                        <div className='flex items-center justify-between'>
                            <label className='text-[10px]' style={{ color: 'var(--text-muted)' }}>Size</label>
                            <span className='text-[10px] font-mono px-1.5 py-0.5 rounded'
                                  style={{ color: 'var(--accent-primary)', background: 'rgba(0, 229, 255, 0.1)' }}>
                                {fontSize}px
                            </span>
                        </div>
                        <div className='flex items-center gap-2'>
                            <button
                                type="button"
                                onClick={() => applyFontSize(fontSize - 1)}
                                className="flex items-center justify-center w-7 h-7 rounded-lg editor-interactive"
                                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                            >
                                <Minus className='h-3 w-3' />
                            </button>
                            <Slider
                                value={[fontSize]}
                                min={FONT_SIZES.min}
                                max={FONT_SIZES.max}
                                step={1}
                                onValueChange={(value) => applyFontSize(value[0])}
                                className='flex-1'
                            />
                            <button
                                type="button"
                                onClick={() => applyFontSize(fontSize + 1)}
                                className="flex items-center justify-center w-7 h-7 rounded-lg editor-interactive"
                                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                            >
                                <Plus className='h-3 w-3' />
                            </button>
                        </div>
                        <input
                            type="number"
                            value={fontSize}
                            min={FONT_SIZES.min}
                            max={FONT_SIZES.max}
                            onChange={(e) => applyFontSize(e.target.value)}
                            className="panel-input"
                        />
                    </div>

                    <div className='space-y-2'>
                        <label className='text-[10px]' style={{ color: 'var(--text-muted)' }}>Color</label>
                        <Colorful
                            color={HEX_COLOR_PATTERN.test(textColor) ? textColor : DEFAULT_TEXT_COLOR}
                            onChange={(color) => applyTextColor(color.hex)}
                            disableAlpha
                            style={{ width: "100%" }}
                        />
                        <div className='flex items-center gap-3'>
                            <input
                                value={textColor}
                                onChange={(e) => applyTextColor(e.target.value)}
                                placeholder={DEFAULT_TEXT_COLOR}
                                className="panel-input flex-1 min-w-0"
                            />
                            <div
                                className='h-9 w-9 shrink-0 rounded-lg'
                                style={{
                                    backgroundColor: HEX_COLOR_PATTERN.test(textColor) ? textColor : DEFAULT_TEXT_COLOR,
                                    border: '1px solid var(--border-default)',
                                }}
                            />
                        </div>
                        <div className='grid grid-cols-8 gap-1.5'>
                            {COLOR_SWATCHES.map((color) => (
                                <button
                                    key={color}
                                    type="button"
                                    aria-label={`Use ${color}`}
                                    onClick={() => applyTextColor(color)}
                                    className='h-6 rounded-md editor-interactive'
                                    style={{
                                        backgroundColor: color,
                                        border: `2px solid ${textColor.toLowerCase() === color ? 'var(--accent-primary)' : 'transparent'}`,
                                        boxShadow: textColor.toLowerCase() === color ? '0 0 0 1px rgba(0,229,255,0.3)' : 'none',
                                    }}
                                />
                            ))}
                        </div>
                    </div>

                    <div className='space-y-2'>
                        <label className='text-[10px]' style={{ color: 'var(--text-muted)' }}>Style</label>
                        <div className='grid grid-cols-3 gap-1.5'>
                            {[
                                { active: isBold, toggle: toggleBold, Icon: Bold },
                                { active: isItalic, toggle: toggleItalic, Icon: Italic },
                                { active: isUnderline, toggle: toggleUnderline, Icon: Underline },
                            ].map(({ active, toggle, Icon }) => (
                                <button
                                    key={Icon.displayName || Icon.name}
                                    type="button"
                                    onClick={toggle}
                                    className="flex items-center justify-center h-8 rounded-lg editor-interactive"
                                    style={{
                                        background: active ? 'rgba(0, 229, 255, 0.15)' : 'var(--bg-elevated)',
                                        border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                        color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                    }}
                                >
                                    <Icon className='h-3.5 w-3.5' />
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className='space-y-2'>
                        <label className='text-[10px]' style={{ color: 'var(--text-muted)' }}>Alignment</label>
                        <div className='grid grid-cols-3 gap-1.5'>
                            {TEXT_ALIGNMENTS.map((alignment) => {
                                const Icon = alignment.icon
                                const isSelected = textAlign === alignment.value

                                return (
                                    <button
                                        key={alignment.value}
                                        type="button"
                                        onClick={() => applyTextAlign(alignment.value)}
                                        aria-label={`${alignment.label} align`}
                                        className="flex items-center justify-center h-8 rounded-lg editor-interactive"
                                        style={{
                                            background: isSelected ? 'rgba(0, 229, 255, 0.15)' : 'var(--bg-elevated)',
                                            border: `1px solid ${isSelected ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                            color: isSelected ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                        }}
                                    >
                                        <Icon className='h-3.5 w-3.5' />
                                    </button>
                                )
                            })}
                        </div>
                    </div>

                    <button
                        type="button"
                        onClick={deleteSelectedText}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
                        style={{ background: 'rgba(239, 68, 68, 0.08)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.2)' }}
                    >
                        <Trash2 className='h-3.5 w-3.5' />
                        Delete Text
                    </button>

                    <div className='panel-card text-[11px]' style={{ borderColor: 'rgba(0, 229, 255, 0.1)' }}>
                        <p className='font-medium mb-1.5' style={{ color: 'var(--text-secondary)' }}>Shortcuts</p>
                        <div className='space-y-1' style={{ color: 'var(--text-muted)' }}>
                            <div className='flex items-center justify-between gap-3'>
                                <span>Delete</span>
                                <span className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>⌫</span>
                            </div>
                            <div className='flex items-center justify-between gap-3'>
                                <span>Bold</span>
                                <span className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>⌘B</span>
                            </div>
                            <div className='flex items-center justify-between gap-3'>
                                <span>Italic</span>
                                <span className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>⌘I</span>
                            </div>
                            <div className='flex items-center justify-between gap-3'>
                                <span>Underline</span>
                                <span className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>⌘U</span>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

export default TextControls
