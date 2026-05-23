"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCanvas } from '../../../../../../../context/context'
import {
    AlignCenter,
    AlignLeft,
    AlignRight,
    Bold,
    ChevronDown,
    Italic,
    Minus,
    Palette,
    Plus,
    Search,
    Strikethrough,
    Trash2,
    Type,
    Underline,
    Wand2,
} from 'lucide-react'
import { IText, Shadow } from 'fabric'
import { ProRulerSlider } from '@/components/editor/ProRulerSlider'
import Colorful from '@uiw/react-color-colorful'
import { motion, AnimatePresence } from 'framer-motion'
import GOOGLE_FONTS from '@/lib/google-fonts.json'

// ─── System fonts (always available) ───
const SYSTEM_FONTS = [
    { family: "Arial", category: "sans-serif" },
    { family: "Arial Black", category: "sans-serif" },
    { family: "Helvetica", category: "sans-serif" },
    { family: "Times New Roman", category: "serif" },
    { family: "Georgia", category: "serif" },
    { family: "Courier New", category: "monospace" },
    { family: "Verdana", category: "sans-serif" },
    { family: "Comic Sans MS", category: "handwriting" },
    { family: "Impact", category: "display" },
]

const ALL_FONTS = [
    ...SYSTEM_FONTS.map(f => ({ ...f, source: 'system' })),
    ...GOOGLE_FONTS.map(f => ({ ...f, source: 'google' })),
]

const FONT_CATEGORIES = ['all', 'sans-serif', 'serif', 'display', 'handwriting', 'monospace']

// ─── Font loader cache ───
const loadedFonts = new Set(['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New', 'Verdana', 'Comic Sans MS', 'Impact', 'Arial Black'])

function loadGoogleFont(family, weights = [400, 700]) {
    if (loadedFonts.has(family)) return Promise.resolve()
    loadedFonts.add(family)

    const weightStr = weights.join(';')
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weightStr}&display=swap`
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = url

    return new Promise((resolve) => {
        link.onload = resolve
        link.onerror = resolve
        document.head.appendChild(link)
    })
}

// ─── WordArt Presets ───
const WORDART_PRESETS = [
    {
        id: 'gradient-sunset',
        label: 'Sunset',
        preview: 'linear-gradient(135deg, #ff6b6b, #ffd93d)',
        apply: (obj) => {
            obj.set({
                fill: '#ff6b6b',
                stroke: '#ffd93d',
                strokeWidth: 1,
                shadow: new Shadow({ color: 'rgba(255,107,107,0.5)', blur: 12, offsetX: 0, offsetY: 4 }),
                fontFamily: 'Bebas Neue',
                fontWeight: 'bold',
            })
            loadGoogleFont('Bebas Neue')
        },
    },
    {
        id: 'neon-glow',
        label: 'Neon',
        preview: 'linear-gradient(135deg, #00f5d4, #7b2ff7)',
        apply: (obj) => {
            obj.set({
                fill: '#00f5d4',
                stroke: '',
                strokeWidth: 0,
                shadow: new Shadow({ color: '#00f5d4', blur: 20, offsetX: 0, offsetY: 0 }),
                fontFamily: 'Orbitron',
                fontWeight: 'bold',
            })
            loadGoogleFont('Orbitron')
        },
    },
    {
        id: 'outline',
        label: 'Outline',
        preview: 'linear-gradient(135deg, transparent, transparent)',
        apply: (obj) => {
            obj.set({
                fill: 'transparent',
                stroke: '#ffffff',
                strokeWidth: 2,
                shadow: null,
                fontFamily: 'Montserrat',
                fontWeight: 'bold',
            })
            loadGoogleFont('Montserrat')
        },
    },
    {
        id: 'retro-shadow',
        label: 'Retro',
        preview: 'linear-gradient(135deg, #f8e71c, #f5a623)',
        apply: (obj) => {
            obj.set({
                fill: '#f8e71c',
                stroke: '#2d1b00',
                strokeWidth: 1,
                shadow: new Shadow({ color: '#2d1b00', blur: 0, offsetX: 4, offsetY: 4 }),
                fontFamily: 'Permanent Marker',
                fontWeight: 'normal',
            })
            loadGoogleFont('Permanent Marker')
        },
    },
    {
        id: 'chrome',
        label: 'Chrome',
        preview: 'linear-gradient(180deg, #e8e8e8, #7a7a7a)',
        apply: (obj) => {
            obj.set({
                fill: '#c0c0c0',
                stroke: '#888888',
                strokeWidth: 1,
                shadow: new Shadow({ color: 'rgba(0,0,0,0.6)', blur: 6, offsetX: 2, offsetY: 3 }),
                fontFamily: 'Oswald',
                fontWeight: 'bold',
            })
            loadGoogleFont('Oswald')
        },
    },
    {
        id: 'fire',
        label: 'Fire',
        preview: 'linear-gradient(180deg, #ff4500, #ff8c00)',
        apply: (obj) => {
            obj.set({
                fill: '#ff4500',
                stroke: '#ff8c00',
                strokeWidth: 1,
                shadow: new Shadow({ color: 'rgba(255,69,0,0.7)', blur: 18, offsetX: 0, offsetY: 2 }),
                fontFamily: 'Anton',
                fontWeight: 'normal',
            })
            loadGoogleFont('Anton')
        },
    },
    {
        id: 'ocean',
        label: 'Ocean',
        preview: 'linear-gradient(135deg, #0077b6, #00b4d8)',
        apply: (obj) => {
            obj.set({
                fill: '#00b4d8',
                stroke: '#0077b6',
                strokeWidth: 1,
                shadow: new Shadow({ color: 'rgba(0,119,182,0.5)', blur: 14, offsetX: 0, offsetY: 3 }),
                fontFamily: 'Raleway',
                fontWeight: 'bold',
            })
            loadGoogleFont('Raleway')
        },
    },
    {
        id: 'comic',
        label: 'Comic',
        preview: 'linear-gradient(135deg, #ffeb3b, #ff5722)',
        apply: (obj) => {
            obj.set({
                fill: '#ffeb3b',
                stroke: '#1a1a1a',
                strokeWidth: 3,
                shadow: new Shadow({ color: '#1a1a1a', blur: 0, offsetX: 3, offsetY: 3 }),
                fontFamily: 'Bangers',
                fontWeight: 'normal',
            })
            loadGoogleFont('Bangers')
        },
    },
]

const FONT_SIZES = { min: 8, max: 200, default: 24 }
const DEFAULT_TEXT_COLOR = '#ffffff'
const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

const TEXT_ALIGNMENTS = [
    { value: 'left', label: 'Left', icon: AlignLeft },
    { value: 'center', label: 'Center', icon: AlignCenter },
    { value: 'right', label: 'Right', icon: AlignRight },
]

const TEXT_TRANSFORMS = [
    { value: 'none', label: 'Aa' },
    { value: 'uppercase', label: 'AB' },
    { value: 'lowercase', label: 'ab' },
    { value: 'capitalize', label: 'Ab' },
]

const COLOR_SWATCHES = [
    '#ffffff', '#111827', '#ef4444', '#f59e0b',
    '#22c55e', '#06b6d4', '#3b82f6', '#a855f7',
]

const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
const isTextObject = (obj) => {
    const t = obj?.type?.toLowerCase()
    return t === 'i-text' || t === 'textbox' || t === 'text'
}
const getCanvasCenter = (c) => {
    if (c?.getVpCenter) return c.getVpCenter()
    const z = c?.getZoom?.() || 1
    return { x: (c?.width || 0) / (2 * z), y: (c?.height || 0) / (2 * z) }
}
const getFontSize = (v) => clamp(parseInt(v, 10) || FONT_SIZES.default, FONT_SIZES.min, FONT_SIZES.max)
const isEditable = (t) => t?.isContentEditable || ['input', 'textarea', 'select'].includes(t?.tagName?.toLowerCase())

const TextControls = ({ dominantColor, contrastingColor, lighterColor }) => {
    const { canvasEditor } = useCanvas()
    const [selectedText, setSelectedText] = useState(null)
    const [textContent, setTextContent] = useState('')
    const [fontFamily, setFontFamily] = useState('Inter')
    const [fontSize, setFontSize] = useState(FONT_SIZES.default)
    const [textColor, setTextColor] = useState(DEFAULT_TEXT_COLOR)
    const [textAlign, setTextAlign] = useState('left')
    const [isBold, setIsBold] = useState(false)
    const [isItalic, setIsItalic] = useState(false)
    const [isUnderline, setIsUnderline] = useState(false)
    const [isStrikethrough, setIsStrikethrough] = useState(false)
    const [letterSpacing, setLetterSpacing] = useState(0)
    const [lineHeight, setLineHeight] = useState(1.2)
    const [textOpacity, setTextOpacity] = useState(100)
    const [strokeColor, setStrokeColor] = useState('')
    const [strokeWidth, setStrokeWidth] = useState(0)
    const [shadowEnabled, setShadowEnabled] = useState(false)
    const [shadowColor, setShadowColor] = useState('#000000')
    const [shadowBlur, setShadowBlur] = useState(8)
    const [shadowOffsetX, setShadowOffsetX] = useState(2)
    const [shadowOffsetY, setShadowOffsetY] = useState(2)
    const [textTransform, setTextTransform] = useState('none')

    // Font picker state
    const [showFontPicker, setShowFontPicker] = useState(false)
    const [fontSearch, setFontSearch] = useState('')
    const [fontCategory, setFontCategory] = useState('all')
    const fontPickerRef = useRef(null)
    const searchInputRef = useRef(null)

    // Section visibility
    const [showWordArt, setShowWordArt] = useState(false)
    const [showAdvanced, setShowAdvanced] = useState(false)

    const filteredFonts = useMemo(() => {
        let list = ALL_FONTS
        if (fontCategory !== 'all') list = list.filter(f => f.category === fontCategory)
        if (fontSearch.trim()) {
            const q = fontSearch.toLowerCase()
            list = list.filter(f => f.family.toLowerCase().includes(q))
        }
        return list.slice(0, 60)
    }, [fontSearch, fontCategory])

    const updateSelectedText = useCallback(() => {
        if (!canvasEditor) return
        const active = canvasEditor.getActiveObject()
        if (isTextObject(active)) {
            setSelectedText(active)
            setFontFamily(active.fontFamily || 'Inter')
            setFontSize(active.fontSize || FONT_SIZES.default)
            setTextColor(typeof active.fill === 'string' ? active.fill : DEFAULT_TEXT_COLOR)
            setTextAlign(active.textAlign || 'left')
            setTextContent(active.text || '')
            const fw = String(active.fontWeight || 'normal')
            setIsBold(fw === 'bold' || parseInt(fw, 10) >= 600)
            setIsItalic(active.fontStyle === 'italic')
            setIsUnderline(Boolean(active.underline))
            setIsStrikethrough(Boolean(active.linethrough))
            setLetterSpacing(active.charSpacing || 0)
            setLineHeight(active.lineHeight || 1.2)
            setTextOpacity(Math.round((active.opacity ?? 1) * 100))
            setStrokeColor(active.stroke || '')
            setStrokeWidth(active.strokeWidth || 0)
            if (active.shadow) {
                setShadowEnabled(true)
                setShadowColor(active.shadow.color || '#000000')
                setShadowBlur(active.shadow.blur || 8)
                setShadowOffsetX(active.shadow.offsetX || 0)
                setShadowOffsetY(active.shadow.offsetY || 0)
            } else {
                setShadowEnabled(false)
            }
        } else {
            setSelectedText(null)
            setTextContent('')
        }
    }, [canvasEditor])

    useEffect(() => {
        if (!canvasEditor) return
        const t = setTimeout(updateSelectedText, 0)
        const events = ['selection:created', 'selection:updated', 'selection:cleared', 'text:changed', 'object:modified', 'object:removed']
        events.forEach(e => canvasEditor.on(e, updateSelectedText))
        return () => {
            clearTimeout(t)
            events.forEach(e => canvasEditor.off(e, updateSelectedText))
        }
    }, [canvasEditor, updateSelectedText])

    // Close font picker on outside click
    useEffect(() => {
        if (!showFontPicker) return
        const handler = (e) => {
            if (fontPickerRef.current && !fontPickerRef.current.contains(e.target)) setShowFontPicker(false)
        }
        window.addEventListener('mousedown', handler)
        return () => window.removeEventListener('mousedown', handler)
    }, [showFontPicker])

    useEffect(() => {
        if (showFontPicker && searchInputRef.current) searchInputRef.current.focus()
    }, [showFontPicker])

    const updateProp = useCallback((prop, value) => {
        if (!canvasEditor || !selectedText) return
        selectedText.set(prop, value)
        selectedText.setCoords()
        canvasEditor.requestRenderAll()
        canvasEditor.fire('object:modified', { target: selectedText })
    }, [canvasEditor, selectedText])

    const applyFont = async (family) => {
        const font = ALL_FONTS.find(f => f.family === family)
        if (font?.source === 'google') await loadGoogleFont(family)
        setFontFamily(family)
        updateProp('fontFamily', family)
        setShowFontPicker(false)
    }

    const applyFontSize = (v) => { const s = getFontSize(v); setFontSize(s); updateProp('fontSize', s) }
    const applyColor = (c) => { setTextColor(c); if (HEX_COLOR_PATTERN.test(c)) updateProp('fill', c) }
    const applyAlign = (a) => { setTextAlign(a); updateProp('textAlign', a) }
    const applyContent = (c) => { setTextContent(c); updateProp('text', c) }

    const toggleBold = useCallback(() => { const n = !isBold; setIsBold(n); updateProp('fontWeight', n ? 'bold' : 'normal') }, [isBold, updateProp])
    const toggleItalic = useCallback(() => { const n = !isItalic; setIsItalic(n); updateProp('fontStyle', n ? 'italic' : 'normal') }, [isItalic, updateProp])
    const toggleUnderline = useCallback(() => { const n = !isUnderline; setIsUnderline(n); updateProp('underline', n) }, [isUnderline, updateProp])
    const toggleStrikethrough = useCallback(() => { const n = !isStrikethrough; setIsStrikethrough(n); updateProp('linethrough', n) }, [isStrikethrough, updateProp])

    const applyLetterSpacing = (v) => { setLetterSpacing(v); updateProp('charSpacing', v) }
    const applyLineHeight = (v) => { setLineHeight(v); updateProp('lineHeight', v) }
    const applyOpacity = (v) => { setTextOpacity(v); if (selectedText) { selectedText.set('opacity', v / 100); canvasEditor?.requestRenderAll() } }

    const applyStroke = (color, width) => {
        setStrokeColor(color); setStrokeWidth(width)
        if (selectedText) { selectedText.set({ stroke: color, strokeWidth: width }); canvasEditor?.requestRenderAll() }
    }

    const applyShadow = () => {
        if (!selectedText) return
        if (shadowEnabled) {
            selectedText.set('shadow', new Shadow({
                color: shadowColor, blur: shadowBlur, offsetX: shadowOffsetX, offsetY: shadowOffsetY,
            }))
        } else {
            selectedText.set('shadow', null)
        }
        canvasEditor?.requestRenderAll()
    }
    useEffect(() => { if (selectedText) applyShadow() }, [shadowEnabled, shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY])

    const applyTextTransform = (transform) => {
        setTextTransform(transform)
        if (!selectedText) return
        const original = selectedText.text || ''
        let text = original
        switch (transform) {
            case 'uppercase': text = original.toUpperCase(); break
            case 'lowercase': text = original.toLowerCase(); break
            case 'capitalize': text = original.replace(/\b\w/g, c => c.toUpperCase()); break
            default: break
        }
        if (text !== original) { setTextContent(text); updateProp('text', text) }
    }

    const applyWordArt = (preset) => {
        if (!selectedText || !canvasEditor) return
        preset.apply(selectedText)
        selectedText.setCoords()
        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.()
        updateSelectedText()
    }

    const addText = useCallback(async () => {
        if (!canvasEditor) return
        await loadGoogleFont('Inter')
        const center = getCanvasCenter(canvasEditor)
        const text = new IText('Edit this text', {
            left: center.x, top: center.y,
            originX: 'center', originY: 'center',
            fontFamily: 'Inter', fontSize: FONT_SIZES.default,
            fill: DEFAULT_TEXT_COLOR, textAlign: 'left',
            fontWeight: 'normal', fontStyle: 'normal',
            underline: false, editable: true, selectable: true,
        })
        canvasEditor.add(text)
        canvasEditor.setActiveObject(text)
        canvasEditor.requestRenderAll()
        setTimeout(() => { text.enterEditing(); text.selectAll() }, 100)
    }, [canvasEditor])

    const deleteSelectedText = useCallback(() => {
        if (!canvasEditor || !selectedText) return
        canvasEditor.remove(selectedText)
        canvasEditor.discardActiveObject()
        canvasEditor.requestRenderAll()
        setSelectedText(null)
        setTextContent('')
    }, [canvasEditor, selectedText])

    // Keyboard shortcuts
    useEffect(() => {
        if (!canvasEditor) return
        const handler = (e) => {
            const active = canvasEditor.getActiveObject()
            if (!isTextObject(active) || isEditable(e.target)) return
            const editing = Boolean(active.isEditing)
            const mod = e.metaKey || e.ctrlKey

            if ((e.key === 'Delete' || e.key === 'Backspace') && !editing) { e.preventDefault(); deleteSelectedText(); return }
            if (!mod || e.altKey || e.shiftKey) return
            const k = e.key.toLowerCase()
            if (k === 'b') { e.preventDefault(); toggleBold() }
            if (k === 'i') { e.preventDefault(); toggleItalic() }
            if (k === 'u') { e.preventDefault(); toggleUnderline() }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [canvasEditor, deleteSelectedText, toggleBold, toggleItalic, toggleUnderline])

    if (!canvasEditor) {
        return <div className="p-4"><p className="text-xs" style={{ color: 'var(--text-muted)' }}>Canvas not ready</p></div>
    }

    return (
        <div className="space-y-4 overflow-y-auto pr-1 panel-scroll">
            {/* Add Text */}
            <div className="space-y-3">
                <label className="panel-label">Add Text</label>
                <button
                    onClick={addText}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive"
                    style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none', boxShadow: 'var(--shadow-glow)' }}
                >
                    <Type className="h-3.5 w-3.5" />
                    Add Text
                </button>
            </div>

            {/* WordArt Presets */}
            <div className="space-y-2" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                <button
                    type="button"
                    onClick={() => setShowWordArt(!showWordArt)}
                    className="flex w-full items-center justify-between text-left"
                >
                    <span className="panel-label flex items-center gap-1.5">
                        <Wand2 className="h-3 w-3" /> WordArt Styles
                    </span>
                    <ChevronDown className={`h-3 w-3 transition-transform ${showWordArt ? 'rotate-180' : ''}`} style={{ color: 'var(--text-muted)' }} />
                </button>
                <AnimatePresence>
                    {showWordArt && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                        >
                            <div className="grid grid-cols-4 gap-1.5 pt-1">
                                {WORDART_PRESETS.map(preset => (
                                    <motion.button
                                        key={preset.id}
                                        type="button"
                                        onClick={() => applyWordArt(preset)}
                                        disabled={!selectedText}
                                        whileTap={{ scale: 0.95 }}
                                        className="flex flex-col items-center gap-1 rounded-lg p-2 editor-interactive disabled:opacity-35"
                                        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                                        title={preset.label}
                                    >
                                        <div
                                            className="w-full h-5 rounded"
                                            style={{ background: preset.preview }}
                                        />
                                        <span className="text-[9px] font-medium" style={{ color: 'var(--text-muted)' }}>
                                            {preset.label}
                                        </span>
                                    </motion.button>
                                ))}
                            </div>
                            {!selectedText && (
                                <p className="text-[10px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
                                    Select a text object to apply WordArt
                                </p>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {selectedText && (
                <div className="space-y-4" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                    <label className="panel-label">Edit Text</label>

                    {/* Content */}
                    <div className="space-y-1.5">
                        <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Content</label>
                        <textarea
                            value={textContent}
                            onChange={(e) => applyContent(e.target.value)}
                            rows={3}
                            className="panel-input resize-none"
                            style={{ minHeight: '60px' }}
                        />
                    </div>

                    {/* Font Picker */}
                    <div className="space-y-1.5" ref={fontPickerRef}>
                        <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Font Family</label>
                        <button
                            type="button"
                            onClick={() => setShowFontPicker(!showFontPicker)}
                            className="flex w-full items-center justify-between rounded-lg px-3 py-2 panel-input"
                            style={{ fontFamily }}
                        >
                            <span className="text-xs truncate">{fontFamily}</span>
                            <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${showFontPicker ? 'rotate-180' : ''}`} />
                        </button>

                        <AnimatePresence>
                            {showFontPicker && (
                                <motion.div
                                    initial={{ opacity: 0, y: -4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -4 }}
                                    className="rounded-xl overflow-hidden"
                                    style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-lg)' }}
                                >
                                    {/* Search */}
                                    <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                                        <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                                        <input
                                            ref={searchInputRef}
                                            value={fontSearch}
                                            onChange={(e) => setFontSearch(e.target.value)}
                                            placeholder="Search fonts..."
                                            className="flex-1 bg-transparent text-xs outline-none"
                                            style={{ color: 'var(--text-primary)' }}
                                        />
                                    </div>

                                    {/* Categories */}
                                    <div className="flex gap-0.5 px-2 py-1.5 overflow-x-auto" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                                        {FONT_CATEGORIES.map(cat => (
                                            <button
                                                key={cat}
                                                type="button"
                                                onClick={() => setFontCategory(cat)}
                                                className="px-2 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap editor-interactive"
                                                style={{
                                                    background: fontCategory === cat ? 'rgba(0,229,255,0.15)' : 'transparent',
                                                    color: fontCategory === cat ? 'var(--accent-primary)' : 'var(--text-muted)',
                                                    border: `1px solid ${fontCategory === cat ? 'var(--accent-primary)' : 'transparent'}`,
                                                }}
                                            >
                                                {cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
                                            </button>
                                        ))}
                                    </div>

                                    {/* Font list */}
                                    <div className="max-h-48 overflow-y-auto panel-scroll">
                                        {filteredFonts.length === 0 && (
                                            <p className="text-[11px] px-3 py-4 text-center" style={{ color: 'var(--text-muted)' }}>No fonts found</p>
                                        )}
                                        {filteredFonts.map(font => (
                                            <button
                                                key={font.family}
                                                type="button"
                                                onClick={() => applyFont(font.family)}
                                                onMouseEnter={() => { if (font.source === 'google') loadGoogleFont(font.family) }}
                                                className="flex w-full items-center justify-between px-3 py-1.5 text-left editor-interactive"
                                                style={{
                                                    background: fontFamily === font.family ? 'rgba(0,229,255,0.08)' : 'transparent',
                                                    color: 'var(--text-primary)',
                                                }}
                                            >
                                                <span className="text-xs truncate" style={{ fontFamily: font.family }}>
                                                    {font.family}
                                                </span>
                                                <span className="text-[9px] shrink-0 ml-2" style={{ color: 'var(--text-muted)' }}>
                                                    {font.source === 'google' ? 'G' : 'S'}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    {/* Font Size */}
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={() => applyFontSize(fontSize - 1)}
                            className="flex items-center justify-center w-8 h-11 rounded-lg editor-interactive shrink-0"
                            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                            <Minus className="h-3.5 w-3.5" />
                        </button>
                        <ProRulerSlider className="flex-1 min-w-0" label="Size" value={fontSize}
                            min={FONT_SIZES.min} max={FONT_SIZES.max} step={1} suffix="px"
                            onChange={applyFontSize}
                            visual={{ fill: 'rgba(47,143,203,0.45)', accent: dominantColor || '#5eb8ff', trackBg: 'rgba(18,22,30,0.96)' }}
                        />
                        <button type="button" onClick={() => applyFontSize(fontSize + 1)}
                            className="flex items-center justify-center w-8 h-11 rounded-lg editor-interactive shrink-0"
                            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                            <Plus className="h-3.5 w-3.5" />
                        </button>
                    </div>

                    {/* Style toggles */}
                    <div className="space-y-2">
                        <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Style</label>
                        <div className="grid grid-cols-4 gap-1.5">
                            {[
                                { active: isBold, toggle: toggleBold, Icon: Bold, label: 'Bold' },
                                { active: isItalic, toggle: toggleItalic, Icon: Italic, label: 'Italic' },
                                { active: isUnderline, toggle: toggleUnderline, Icon: Underline, label: 'Underline' },
                                { active: isStrikethrough, toggle: toggleStrikethrough, Icon: Strikethrough, label: 'Strike' },
                            ].map(({ active, toggle, Icon, label }) => (
                                <button key={label} type="button" onClick={toggle}
                                    className="flex items-center justify-center h-8 rounded-lg editor-interactive"
                                    style={{
                                        background: active ? 'rgba(0,229,255,0.15)' : 'var(--bg-elevated)',
                                        border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                        color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                    }}>
                                    <Icon className="h-3.5 w-3.5" />
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Alignment */}
                    <div className="space-y-2">
                        <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Alignment</label>
                        <div className="grid grid-cols-3 gap-1.5">
                            {TEXT_ALIGNMENTS.map(a => {
                                const Icon = a.icon; const sel = textAlign === a.value
                                return (
                                    <button key={a.value} type="button" onClick={() => applyAlign(a.value)}
                                        className="flex items-center justify-center h-8 rounded-lg editor-interactive"
                                        style={{
                                            background: sel ? 'rgba(0,229,255,0.15)' : 'var(--bg-elevated)',
                                            border: `1px solid ${sel ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                            color: sel ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                        }}>
                                        <Icon className="h-3.5 w-3.5" />
                                    </button>
                                )
                            })}
                        </div>
                    </div>

                    {/* Text Transform */}
                    <div className="space-y-2">
                        <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Transform</label>
                        <div className="grid grid-cols-4 gap-1.5">
                            {TEXT_TRANSFORMS.map(t => {
                                const sel = textTransform === t.value
                                return (
                                    <button key={t.value} type="button" onClick={() => applyTextTransform(t.value)}
                                        className="flex items-center justify-center h-8 rounded-lg text-[11px] font-bold editor-interactive"
                                        style={{
                                            background: sel ? 'rgba(0,229,255,0.15)' : 'var(--bg-elevated)',
                                            border: `1px solid ${sel ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                            color: sel ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                        }}>
                                        {t.label}
                                    </button>
                                )
                            })}
                        </div>
                    </div>

                    {/* Color */}
                    <div className="space-y-2">
                        <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Color</label>
                        <Colorful
                            color={HEX_COLOR_PATTERN.test(textColor) ? textColor : DEFAULT_TEXT_COLOR}
                            onChange={(c) => applyColor(c.hex)}
                            disableAlpha
                            style={{ width: '100%' }}
                        />
                        <div className="flex items-center gap-3">
                            <input value={textColor} onChange={(e) => applyColor(e.target.value)}
                                placeholder={DEFAULT_TEXT_COLOR} className="panel-input flex-1 min-w-0" />
                            <div className="h-9 w-9 shrink-0 rounded-lg"
                                style={{ backgroundColor: HEX_COLOR_PATTERN.test(textColor) ? textColor : DEFAULT_TEXT_COLOR, border: '1px solid var(--border-default)' }} />
                        </div>
                        <div className="grid grid-cols-8 gap-1.5">
                            {COLOR_SWATCHES.map(c => (
                                <button key={c} type="button" onClick={() => applyColor(c)}
                                    className="h-6 rounded-md editor-interactive"
                                    style={{
                                        backgroundColor: c,
                                        border: `2px solid ${textColor.toLowerCase() === c ? 'var(--accent-primary)' : 'transparent'}`,
                                        boxShadow: textColor.toLowerCase() === c ? '0 0 0 1px rgba(0,229,255,0.3)' : 'none',
                                    }} />
                            ))}
                        </div>
                    </div>

                    {/* Advanced Section */}
                    <div className="space-y-2" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                        <button type="button" onClick={() => setShowAdvanced(!showAdvanced)}
                            className="flex w-full items-center justify-between text-left">
                            <span className="panel-label flex items-center gap-1.5">
                                <Palette className="h-3 w-3" /> Advanced
                            </span>
                            <ChevronDown className={`h-3 w-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} style={{ color: 'var(--text-muted)' }} />
                        </button>

                        <AnimatePresence>
                            {showAdvanced && (
                                <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.2 }}
                                    className="space-y-3 overflow-hidden"
                                >
                                    {/* Letter Spacing */}
                                    <div className="space-y-1.5 pt-1">
                                        <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Letter Spacing</label>
                                        <ProRulerSlider label="Spacing" value={letterSpacing} min={-200} max={1000} step={10}
                                            onChange={applyLetterSpacing}
                                            onChangeEnd={() => canvasEditor?.__pushHistoryState?.()}
                                            visual={{ fill: 'rgba(47,143,203,0.45)', accent: dominantColor || '#5eb8ff', trackBg: 'rgba(18,22,30,0.96)' }}
                                        />
                                    </div>

                                    {/* Line Height */}
                                    <div className="space-y-1.5">
                                        <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Line Height</label>
                                        <ProRulerSlider label="Height" value={lineHeight} min={0.5} max={3} step={0.05} suffix="×"
                                            onChange={applyLineHeight}
                                            onChangeEnd={() => canvasEditor?.__pushHistoryState?.()}
                                            visual={{ fill: 'rgba(47,143,203,0.45)', accent: dominantColor || '#5eb8ff', trackBg: 'rgba(18,22,30,0.96)' }}
                                        />
                                    </div>

                                    {/* Opacity */}
                                    <div className="space-y-1.5">
                                        <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Opacity</label>
                                        <ProRulerSlider label="Opacity" value={textOpacity} min={0} max={100} step={1} suffix="%"
                                            onChange={applyOpacity}
                                            onChangeEnd={() => canvasEditor?.__pushHistoryState?.()}
                                            visual={{ fill: 'rgba(47,143,203,0.45)', accent: dominantColor || '#5eb8ff', trackBg: 'rgba(18,22,30,0.96)' }}
                                        />
                                    </div>

                                    {/* Stroke */}
                                    <div className="space-y-1.5">
                                        <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Stroke</label>
                                        <div className="flex items-center gap-2">
                                            <input value={strokeColor} onChange={(e) => applyStroke(e.target.value, strokeWidth)}
                                                placeholder="No stroke" className="panel-input flex-1 min-w-0" />
                                            <ProRulerSlider className="flex-1 min-w-0" label="Width" value={strokeWidth} min={0} max={10} step={0.5} suffix="px"
                                                onChange={(v) => applyStroke(strokeColor, v)}
                                                onChangeEnd={() => canvasEditor?.__pushHistoryState?.()}
                                                visual={{ fill: 'rgba(47,143,203,0.45)', accent: dominantColor || '#5eb8ff', trackBg: 'rgba(18,22,30,0.96)' }}
                                            />
                                        </div>
                                    </div>

                                    {/* Shadow */}
                                    <div className="space-y-1.5">
                                        <div className="flex items-center justify-between">
                                            <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Shadow</label>
                                            <button type="button" onClick={() => setShadowEnabled(!shadowEnabled)}
                                                className="text-[10px] px-2 py-0.5 rounded-full editor-interactive"
                                                style={{
                                                    background: shadowEnabled ? 'rgba(0,229,255,0.15)' : 'var(--bg-elevated)',
                                                    color: shadowEnabled ? 'var(--accent-primary)' : 'var(--text-muted)',
                                                    border: `1px solid ${shadowEnabled ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                                }}>
                                                {shadowEnabled ? 'On' : 'Off'}
                                            </button>
                                        </div>
                                        {shadowEnabled && (
                                            <div className="space-y-1.5">
                                                <div className="flex items-center gap-2">
                                                    <input value={shadowColor} onChange={(e) => setShadowColor(e.target.value)}
                                                        className="panel-input flex-1 min-w-0" placeholder="#000000" />
                                                    <div className="h-7 w-7 rounded shrink-0"
                                                        style={{ background: shadowColor, border: '1px solid var(--border-default)' }} />
                                                </div>
                                                <ProRulerSlider label="Blur" value={shadowBlur} min={0} max={40} step={1} suffix="px"
                                                    onChange={setShadowBlur}
                                                    visual={{ fill: 'rgba(47,143,203,0.45)', accent: dominantColor || '#5eb8ff', trackBg: 'rgba(18,22,30,0.96)' }}
                                                />
                                                <div className="grid grid-cols-2 gap-2">
                                                    <ProRulerSlider label="X" value={shadowOffsetX} min={-20} max={20} step={1} suffix="px"
                                                        onChange={setShadowOffsetX}
                                                        visual={{ fill: 'rgba(47,143,203,0.45)', accent: dominantColor || '#5eb8ff', trackBg: 'rgba(18,22,30,0.96)' }}
                                                    />
                                                    <ProRulerSlider label="Y" value={shadowOffsetY} min={-20} max={20} step={1} suffix="px"
                                                        onChange={setShadowOffsetY}
                                                        visual={{ fill: 'rgba(47,143,203,0.45)', accent: dominantColor || '#5eb8ff', trackBg: 'rgba(18,22,30,0.96)' }}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    {/* Delete */}
                    <button type="button" onClick={deleteSelectedText}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
                        style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' }}>
                        <Trash2 className="h-3.5 w-3.5" /> Delete Text
                    </button>

                    {/* Shortcuts */}
                    <div className="panel-card text-[11px]" style={{ borderColor: 'rgba(0,229,255,0.1)' }}>
                        <p className="font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Shortcuts</p>
                        <div className="space-y-1" style={{ color: 'var(--text-muted)' }}>
                            {[['Delete', '⌫'], ['Bold', '⌘B'], ['Italic', '⌘I'], ['Underline', '⌘U']].map(([l, k]) => (
                                <div key={l} className="flex items-center justify-between gap-3">
                                    <span>{l}</span>
                                    <span className="font-mono text-[9px]">{k}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

export default TextControls
