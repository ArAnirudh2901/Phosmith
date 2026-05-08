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

const TextControls = () => {

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
                <p className='text-white/70 text-sm'>
                    Canvas not ready
                </p>
            </div>
        )
    }

    return (
        <div className='space-y-6 overflow-y-auto pr-1'>
            <div className='space-y-4'>
                <div>
                    <h3 className='text-sm font-medium text-white mb-2'>
                        Add Text
                    </h3>
                </div>
                <Button
                    onClick={addText}
                    className="w-full"
                    variant="primary"
                >
                    <Type className='h-4 w-4 mr-2' />
                    Add Text
                </Button>
            </div>

            {selectedText && (
                <div className='space-y-5 border-t border-white/10 pt-6'>
                    <h3 className='text-sm font-medium text-white mb-4'>
                        Edit Selected Text
                    </h3>

                    <div className='space-y-2'>
                        <label className='text-xs text-white/70'>
                            Content
                        </label>
                        <textarea
                            value={textContent}
                            onChange={(e) => applyTextContent(e.target.value)}
                            rows={3}
                            className="w-full resize-none rounded border border-white/20 bg-slate-700 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-cyan-300"
                        />
                    </div>

                    <div className='space-y-2'>
                        <label className='text-xs text-white/70'>
                            Font Family
                        </label>
                        <select
                            value={fontFamily}
                            onChange={(e) => applyFontFamily(e.target.value)}
                            className='w-full rounded border border-white/20 bg-slate-700 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300'
                        >
                            {FONT_FAMILIES.map((font) => (
                                <option key={font} value={font}>
                                    {font}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className='space-y-3'>
                        <div className='flex items-center justify-between'>
                            <label className='text-xs text-white/70'>
                                Size
                            </label>
                            <span className='text-xs text-white/70'>
                                {fontSize}px
                            </span>
                        </div>
                        <div className='flex items-center gap-2'>
                            <Button
                                type="button"
                                variant="outline"
                                size="icon-sm"
                                onClick={() => applyFontSize(fontSize - 1)}
                            >
                                <Minus className='h-4 w-4' />
                            </Button>
                            <Slider
                                value={[fontSize]}
                                min={FONT_SIZES.min}
                                max={FONT_SIZES.max}
                                step={1}
                                onValueChange={(value) => applyFontSize(value[0])}
                                className='flex-1'
                            />
                            <Button
                                type="button"
                                variant="outline"
                                size="icon-sm"
                                onClick={() => applyFontSize(fontSize + 1)}
                            >
                                <Plus className='h-4 w-4' />
                            </Button>
                        </div>
                        <Input
                            type="number"
                            value={fontSize}
                            min={FONT_SIZES.min}
                            max={FONT_SIZES.max}
                            onChange={(e) => applyFontSize(e.target.value)}
                            className="bg-slate-700 border-white/20 text-white"
                        />
                    </div>

                    <div className='space-y-3'>
                        <label className='text-xs text-white/70'>
                            Color
                        </label>
                        <Colorful
                            color={HEX_COLOR_PATTERN.test(textColor) ? textColor : DEFAULT_TEXT_COLOR}
                            onChange={(color) => applyTextColor(color.hex)}
                            disableAlpha
                            style={{ width: "100%" }}
                        />
                        <div className='flex items-center gap-3'>
                            <Input
                                value={textColor}
                                onChange={(e) => applyTextColor(e.target.value)}
                                placeholder={DEFAULT_TEXT_COLOR}
                                className="min-w-0 flex-1 bg-slate-700 border-white/20 text-white"
                            />
                            <div
                                className='h-10 w-10 shrink-0 rounded border border-white/20'
                                style={{
                                    backgroundColor: HEX_COLOR_PATTERN.test(textColor)
                                        ? textColor
                                        : DEFAULT_TEXT_COLOR,
                                }}
                            />
                        </div>
                        <div className='grid grid-cols-8 gap-2'>
                            {COLOR_SWATCHES.map((color) => (
                                <button
                                    key={color}
                                    type="button"
                                    aria-label={`Use ${color}`}
                                    onClick={() => applyTextColor(color)}
                                    className={`h-7 rounded border transition-colors ${textColor.toLowerCase() === color
                                        ? "border-cyan-300 ring-2 ring-cyan-300/30"
                                        : "border-white/20 hover:border-white/50"
                                        }`}
                                    style={{ backgroundColor: color }}
                                />
                            ))}
                        </div>
                    </div>

                    <div className='space-y-3'>
                        <label className='text-xs text-white/70'>
                            Style
                        </label>
                        <div className='grid grid-cols-3 gap-2'>
                            <Button
                                type="button"
                                variant={isBold ? "default" : "outline"}
                                onClick={toggleBold}
                                className={isBold ? "bg-cyan-500 text-white hover:bg-cyan-600" : "text-white/70 hover:text-white border-white/20"}
                            >
                                <Bold className='h-4 w-4' />
                            </Button>
                            <Button
                                type="button"
                                variant={isItalic ? "default" : "outline"}
                                onClick={toggleItalic}
                                className={isItalic ? "bg-cyan-500 text-white hover:bg-cyan-600" : "text-white/70 hover:text-white border-white/20"}
                            >
                                <Italic className='h-4 w-4' />
                            </Button>
                            <Button
                                type="button"
                                variant={isUnderline ? "default" : "outline"}
                                onClick={toggleUnderline}
                                className={isUnderline ? "bg-cyan-500 text-white hover:bg-cyan-600" : "text-white/70 hover:text-white border-white/20"}
                            >
                                <Underline className='h-4 w-4' />
                            </Button>
                        </div>
                    </div>

                    <div className='space-y-3'>
                        <label className='text-xs text-white/70'>
                            Alignment
                        </label>
                        <div className='grid grid-cols-3 gap-2'>
                            {TEXT_ALIGNMENTS.map((alignment) => {
                                const Icon = alignment.icon
                                const isSelected = textAlign === alignment.value

                                return (
                                    <Button
                                        key={alignment.value}
                                        type="button"
                                        variant={isSelected ? "default" : "outline"}
                                        onClick={() => applyTextAlign(alignment.value)}
                                        aria-label={`${alignment.label} align`}
                                        className={isSelected ? "bg-cyan-500 text-white hover:bg-cyan-600" : "text-white/70 hover:text-white border-white/20"}
                                    >
                                        <Icon className='h-4 w-4' />
                                    </Button>
                                )
                            })}
                        </div>
                    </div>

                    <Button
                        type="button"
                        variant="outline"
                        onClick={deleteSelectedText}
                        className="w-full border-red-400/30 text-red-200 hover:border-red-300 hover:bg-red-500/10 hover:text-red-100"
                    >
                        <Trash2 className='h-4 w-4 mr-2' />
                        Delete Text
                    </Button>

                    <div className='rounded-lg bg-slate-700/30 p-3'>
                        <p className='text-xs font-medium text-white mb-2'>
                            Keyboard Shortcuts
                        </p>
                        <div className='space-y-1 text-xs text-white/70'>
                            <div className='flex items-center justify-between gap-3'>
                                <span>Delete selected text</span>
                                <span className='text-white/50'>Delete / Backspace</span>
                            </div>
                            <div className='flex items-center justify-between gap-3'>
                                <span>Bold</span>
                                <span className='text-white/50'>Cmd/Ctrl + B</span>
                            </div>
                            <div className='flex items-center justify-between gap-3'>
                                <span>Italic</span>
                                <span className='text-white/50'>Cmd/Ctrl + I</span>
                            </div>
                            <div className='flex items-center justify-between gap-3'>
                                <span>Underline</span>
                                <span className='text-white/50'>Cmd/Ctrl + U</span>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

export default TextControls
