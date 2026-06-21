"use client"

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { LayoutGrid, Rows, Check, Sparkles, Palette, Square, Circle, Loader2, X, Replace, SlidersHorizontal, Wand2, Shuffle } from 'lucide-react'
import { FabricImage } from 'fabric'
import { FastAverageColor } from 'fast-average-color'
import { useCanvas } from '../../../../../../../context/context'
import { applyCanvasSizedBackground } from '@/lib/canvas-background'
import { loadFabricImageFromFile } from '@/lib/canvas-images'
import {
    COLLAGE_STYLES,
    COLLAGE_BACKDROPS,
    AI_BG_THEMES,
    applyCollageBackground,
    backdropPreviewCss,
    buildAiBackgroundPrompt,
} from '@/lib/collage-styles'
import {
    LAYOUTS,
    buildLayoutCells,
    computeCollageCells,
    generateTemplateRecipes,
    isVisibleImage,
    getCellCoverScale,
    fitImageToCell,
    restyleImage,
    clampToCell,
    cellFromClipPath,
} from '@/lib/collage-layout'
import { toast } from 'sonner'

const fac = new FastAverageColor()

const LabeledSlider = ({ label, value, min, max, onChange, suffix = 'px' }) => (
    <div className="space-y-1.5">
        <div className="flex justify-between items-center text-[10px]" style={{ color: 'var(--text-secondary)' }}>
            <span className="font-medium">{label}</span>
            <span className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
                {value}{suffix}
            </span>
        </div>
        <input
            type="range"
            min={min}
            max={max}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-full accent-[var(--accent-primary)] editor-interactive"
            style={{
                height: '4px',
                background: 'var(--border-subtle)',
                borderRadius: '2px',
                appearance: 'none'
            }}
        />
    </div>
)

/** A mini diagram of a layout's actual cell arrangement (Google-Photos-style
 *  template thumbnail), derived from the same geometry the canvas uses. */
const LayoutPreview = ({ layoutId, active }) => {
    const cells = buildLayoutCells(layoutId, { x: 0, y: 0, w: 100, h: 100 }, 5)
    return (
        <div className="relative" style={{ width: 30, height: 30 }}>
            {cells.map((cell, index) => (
                <div
                    key={index}
                    style={{
                        position: 'absolute',
                        left: `${cell.x}%`,
                        top: `${cell.y}%`,
                        width: `${cell.w}%`,
                        height: `${cell.h}%`,
                        borderRadius: 2,
                        background: active ? 'var(--accent-primary)' : 'var(--text-muted)',
                        opacity: active ? 0.95 : 0.5,
                    }}
                />
            ))}
        </div>
    )
}

/** A realistic thumbnail of a generated template recipe: the backdrop with the
 *  layout's cells drawn at the recipe's frame shape. */
const TemplatePreview = ({ recipe }) => {
    const cells = buildLayoutCells(recipe.layoutId, { x: 0, y: 0, w: 100, h: 100 }, 6)
    const radius = recipe.style.shape === 'circle' ? '50%' : `${Math.round((recipe.style.radiusPct || 0) / 5) + 1}px`
    return (
        <div
            className="relative w-full overflow-hidden rounded-md"
            style={{ aspectRatio: '1 / 1', background: recipe.previewBg }}
        >
            {cells.map((cell, index) => (
                <div
                    key={index}
                    style={{
                        position: 'absolute',
                        left: `${cell.x}%`,
                        top: `${cell.y}%`,
                        width: `${cell.w}%`,
                        height: `${cell.h}%`,
                        borderRadius: radius,
                        background: 'rgba(255,255,255,0.92)',
                        boxShadow: recipe.style.shadow
                            ? '0 1px 2px rgba(0,0,0,0.35)'
                            : 'inset 0 0 0 1px rgba(0,0,0,0.08)',
                    }}
                />
            ))}
        </div>
    )
}

const Section = ({ title, icon: Icon, children }) => (
    <div className="px-4 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-2 mb-3">
            <div className="flex items-center justify-center w-5 h-5 rounded" style={{ background: 'rgba(6,184,212,0.1)' }}>
                <Icon className="w-3 h-3" style={{ color: 'var(--accent-primary)' }} />
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>
                {title}
            </h3>
        </div>
        {children}
    </div>
)

const enterCollageConstraints = (image) => {
    image.set({ lockRotation: true, lockSkewingX: true, lockSkewingY: true })
}
const exitCollageConstraints = (image) => {
    image.set({ lockRotation: false, lockSkewingX: false, lockSkewingY: false })
}

export default function CollageControls({ project, dominantColor }) {
    const { canvasEditor, processingMessage, setProcessingMessage, onToolChange } = useCanvas()
    const [selectedLayout, setSelectedLayout] = useState('2-split-h')
    const [gap, setGap] = useState(10)
    const [padding, setPadding] = useState(10)
    const [imageCount, setImageCount] = useState(0)
    // The currently-selected collage cell photo (drives the Replace / Edit panel).
    const [selectedPhoto, setSelectedPhoto] = useState(null)
    const [isReplacing, setIsReplacing] = useState(false)
    const replaceInputRef = useRef(null)
    // Photo-frame styling (shape + corner radius + shadow). The selected preset id
    // is cosmetic; `style` is the live source of truth applied to the cells.
    const [selectedStyle, setSelectedStyle] = useState('clean')
    const [shape, setShape] = useState('rect')
    const [radiusPct, setRadiusPct] = useState(0)
    const [shadow, setShadow] = useState(false)
    const [activeBackdrop, setActiveBackdrop] = useState(null)
    const [generatingTheme, setGeneratingTheme] = useState(null)
    // Generated "stylish template" suggestions (gallery).
    const [templateRecipes, setTemplateRecipes] = useState([])

    const syncImageCount = useCallback(() => {
        const images = canvasEditor?.getObjects?.().filter(isVisibleImage) || []
        setImageCount(images.length)
    }, [canvasEditor])

    useEffect(() => {
        if (!canvasEditor) return
        syncImageCount()
        const events = ['object:added', 'object:removed', 'object:modified']
        events.forEach(event => canvasEditor.on(event, syncImageCount))
        return () => events.forEach(event => canvasEditor.off(event, syncImageCount))
    }, [canvasEditor, syncImageCount])

    // Surface the Replace / Edit actions whenever a SINGLE collage cell photo is
    // the active selection on the canvas.
    useEffect(() => {
        if (!canvasEditor) return undefined
        const sync = () => {
            const active = canvasEditor.getActiveObject?.()
            const framed = active && isVisibleImage(active) && (active.phosmithCollageCell || cellFromClipPath(active))
            setSelectedPhoto(framed ? active : null)
        }
        sync()
        const events = ['selection:created', 'selection:updated', 'selection:cleared', 'object:removed']
        events.forEach((event) => canvasEditor.on(event, sync))
        return () => events.forEach((event) => canvasEditor.off(event, sync))
    }, [canvasEditor])

    // While the collage tool is open, keep every FRAMED image (one carrying a
    // collage cell, or one we can recover a cell from via its persisted absolute
    // clipPath) panning/scaling INSIDE its cell. Handlers are scoped to this
    // tool so other tools aren't constrained; rotation/skew locks are released
    // when the tool closes.
    useEffect(() => {
        if (!canvasEditor) return undefined
        canvasEditor.getObjects().filter(isVisibleImage).forEach((img) => {
            if (!img.phosmithCollageCell) {
                const cell = cellFromClipPath(img)
                if (cell) {
                    img.phosmithCollageCell = cell
                    img._phosmithCollageCell = cell
                    img.phosmithCollageCoverScale = getCellCoverScale(img, cell)
                }
            }
            if (img.phosmithCollageCell) enterCollageConstraints(img)
        })

        const onMoving = (e) => { if (e?.target?.phosmithCollageCell) clampToCell(e.target) }
        const onScaling = (e) => { if (e?.target?.phosmithCollageCell) clampToCell(e.target) }
        const onModified = (e) => {
            if (e?.target?.phosmithCollageCell && clampToCell(e.target)) canvasEditor.requestRenderAll()
        }
        canvasEditor.on('object:moving', onMoving)
        canvasEditor.on('object:scaling', onScaling)
        canvasEditor.on('object:modified', onModified)
        canvasEditor.requestRenderAll()
        return () => {
            canvasEditor.off('object:moving', onMoving)
            canvasEditor.off('object:scaling', onScaling)
            canvasEditor.off('object:modified', onModified)
            canvasEditor.getObjects?.().filter(isVisibleImage).forEach((img) => {
                if (img.phosmithCollageCell) exitCollageConstraints(img)
            })
            canvasEditor.requestRenderAll()
        }
    }, [canvasEditor])

    const applyLayout = useCallback(() => {
        if (!canvasEditor) return

        const images = canvasEditor.getObjects().filter(isVisibleImage)
        const layout = LAYOUTS.find(l => l.id === selectedLayout)
        if (!layout) return

        if (images.length < layout.cellCount) {
            const missing = layout.cellCount - images.length
            toast.error(`Add ${missing} more image${missing === 1 ? '' : 's'} for this layout`)
            return
        }

        const cells = computeCollageCells(
            { width: project?.width, height: project?.height },
            selectedLayout,
            gap,
            padding,
        )

        canvasEditor.discardActiveObject()
        const layoutStyle = { shape, radiusPct, shadow }
        images.slice(0, cells.length).forEach((image, index) => {
            fitImageToCell(image, cells[index], layoutStyle)
            canvasEditor.fire('object:modified', { target: image })
        })

        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.({ label: 'Applied collage layout', detail: layout.label, domain: 'collage' })
        canvasEditor.__saveCanvasState?.()

        const extraCount = images.length - cells.length
        toast.success(`${layout.label} applied to ${cells.length} images`)
        if (extraCount > 0) {
            toast.info(`${extraCount} extra layer${extraCount === 1 ? '' : 's'} left unchanged`)
        }
    }, [canvasEditor, selectedLayout, gap, padding, project?.width, project?.height, shape, radiusPct, shadow])

    // Re-skin already-framed photos in place (no re-layout) so shape/radius/shadow
    // tweaks are instant. No-op when nothing is framed yet — the choice still sticks
    // and applies the next time a layout runs.
    const restyleFramedPhotos = useCallback((nextStyle) => {
        if (!canvasEditor) return
        let changed = 0
        canvasEditor.getObjects().filter(isVisibleImage).forEach((img) => {
            if (restyleImage(img, nextStyle)) changed += 1
        })
        if (changed > 0) {
            canvasEditor.requestRenderAll()
            canvasEditor.__pushHistoryState?.({ label: 'Restyled collage photos', domain: 'collage' })
            canvasEditor.__saveCanvasState?.()
        }
    }, [canvasEditor])

    const updateStyle = useCallback((patch) => {
        const next = { shape, radiusPct, shadow, ...patch }
        if (patch.shape !== undefined) setShape(patch.shape)
        if (patch.radiusPct !== undefined) setRadiusPct(patch.radiusPct)
        if (patch.shadow !== undefined) setShadow(patch.shadow)
        restyleFramedPhotos(next)
    }, [shape, radiusPct, shadow, restyleFramedPhotos])

    // Apply a backdrop colour/gradient to the canvas immediately (independent of
    // the layout). `null` clears it.
    const applyBackdrop = useCallback((backdrop) => {
        if (!canvasEditor) return
        applyCollageBackground(canvasEditor, backdrop, project)
        setActiveBackdrop(backdrop)
        canvasEditor.__pushHistoryState?.({ label: backdrop ? 'Set collage background' : 'Cleared collage background', domain: 'collage' })
        canvasEditor.__saveCanvasState?.()
    }, [canvasEditor, project])

    // Pick a one-click preset: set the photo style AND its paired backdrop.
    const applyStylePreset = useCallback((preset) => {
        setSelectedStyle(preset.id)
        setShape(preset.shape)
        setRadiusPct(preset.radiusPct)
        setShadow(preset.shadow)
        restyleFramedPhotos({ shape: preset.shape, radiusPct: preset.radiusPct, shadow: preset.shadow })
        if (preset.backdrop) applyBackdrop(preset.backdrop)
    }, [restyleFramedPhotos, applyBackdrop])

    // Sample the dominant colour of each framed/visible photo so the generated
    // background harmonises with them ("fit the photos").
    const samplePhotoColors = useCallback(async () => {
        const images = (canvasEditor?.getObjects?.().filter(isVisibleImage) || []).slice(0, 4)
        const colors = []
        for (const img of images) {
            const src = img.getSrc?.() || img._originalElement?.src
            if (!src || src.startsWith('blob:')) continue
            try {
                const c = await fac.getColorAsync(src, { algorithm: 'dominant', crossOrigin: 'anonymous' })
                if (c?.hex) colors.push(c.hex)
            } catch {
                /* tainted/unreachable source — skip it */
            }
        }
        if (colors.length === 0 && dominantColor) colors.push(dominantColor)
        return colors
    }, [canvasEditor, dominantColor])

    // Generate a decorative background tuned to the photos and set it on the canvas.
    const generateThemedBackground = useCallback(async (theme) => {
        if (!canvasEditor || generatingTheme) return
        setGeneratingTheme(theme.id)
        setProcessingMessage?.(`Generating ${theme.label.toLowerCase()} background...`)
        try {
            const colors = await samplePhotoColors()
            const prompt = buildAiBackgroundPrompt(theme, colors)
            const response = await fetch('/api/ai/background', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, raw: true }),
            })
            if (!response.ok) {
                const data = await response.json().catch(() => ({}))
                throw new Error(data.error || `HTTP ${response.status}`)
            }
            const data = await response.json()
            if (!data?.imageUrl) throw new Error('No image returned')

            setProcessingMessage?.('Applying background...')
            await applyCanvasSizedBackground(canvasEditor, FabricImage, data.imageUrl, project)
            setActiveBackdrop(null)
            canvasEditor.__pushHistoryState?.({ label: 'Generated collage background', detail: theme.label, domain: 'collage' })
            canvasEditor.__saveCanvasState?.()
            toast.success(`${theme.label} background applied`)
        } catch (error) {
            console.warn('[collage] themed background failed:', error)
            const msg = String(error?.message || '')
            toast.error(
                /rate limit|429/i.test(msg) ? 'AI is busy — try again in a minute.'
                    : /token|configured/i.test(msg) ? 'AI background is not configured.'
                        : 'Could not generate that background. Try another style.'
            )
        } finally {
            setGeneratingTheme(null)
            setProcessingMessage?.(null)
        }
    }, [canvasEditor, generatingTheme, samplePhotoColors, project, setProcessingMessage])

    // One click: detect the photo count, pick a fitting layout + a random style,
    // place the photos, then generate a background tuned to them. Layout/style
    // land instantly; the AI background streams in after.
    const autoTemplate = useCallback(async () => {
        if (!canvasEditor || generatingTheme) return
        const images = canvasEditor.getObjects().filter(isVisibleImage)
        if (images.length < 2) {
            toast.error('Add at least 2 photos to auto-generate a template')
            return
        }
        const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)]

        // Prefer layouts that use as many of the photos as possible, then random.
        const usable = LAYOUTS.filter((l) => l.cellCount <= images.length)
        const maxCells = Math.max(...usable.map((l) => l.cellCount))
        const layoutDef = pickRandom(usable.filter((l) => l.cellCount === maxCells))
        const preset = pickRandom(COLLAGE_STYLES)
        const theme = pickRandom(AI_BG_THEMES)
        const nextStyle = { shape: preset.shape, radiusPct: preset.radiusPct, shadow: preset.shadow }

        // Reflect the random pick in the controls.
        setSelectedLayout(layoutDef.id)
        setSelectedStyle(preset.id)
        setShape(preset.shape)
        setRadiusPct(preset.radiusPct)
        setShadow(preset.shadow)

        const cells = computeCollageCells(
            { width: project?.width, height: project?.height },
            layoutDef.id,
            gap,
            padding,
        )
        canvasEditor.discardActiveObject()
        images.slice(0, cells.length).forEach((image, index) => fitImageToCell(image, cells[index], nextStyle))
        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.({ label: 'Auto template', detail: layoutDef.label, domain: 'collage' })
        canvasEditor.__saveCanvasState?.()
        toast.success(`${layoutDef.label} · ${preset.label} — generating background…`)

        // Generate + apply the fit-to-photos background (handles its own toasts).
        await generateThemedBackground(theme)
    }, [canvasEditor, generatingTheme, project?.width, project?.height, gap, padding, generateThemedBackground])

    // (Re)generate the stylish-template gallery for the current photo count.
    const regenerateTemplates = useCallback(() => {
        setTemplateRecipes(imageCount >= 2 ? generateTemplateRecipes(imageCount, 6) : [])
    }, [imageCount])

    // Keep at least one set of suggestions ready; refresh when the photo count
    // changes (a layout for 2 photos shouldn't linger once there are 5).
    useEffect(() => {
        setTemplateRecipes((current) =>
            imageCount >= 2 && current.length === 0 ? generateTemplateRecipes(imageCount, 6) : current
        )
    }, [imageCount])

    // Apply one generated template: layout + frame style + its backdrop (instant)
    // or AI theme (generated to fit the photos).
    const applyRecipe = useCallback(async (recipe) => {
        if (!canvasEditor || generatingTheme) return
        const images = canvasEditor.getObjects().filter(isVisibleImage)
        if (images.length < 2) {
            toast.error('Add at least 2 photos first')
            return
        }
        const nextStyle = recipe.style
        setSelectedLayout(recipe.layoutId)
        setShape(nextStyle.shape)
        setRadiusPct(nextStyle.radiusPct)
        setShadow(nextStyle.shadow)

        const cells = computeCollageCells(
            { width: project?.width, height: project?.height },
            recipe.layoutId,
            gap,
            padding,
        )
        canvasEditor.discardActiveObject()
        images.slice(0, cells.length).forEach((image, index) => fitImageToCell(image, cells[index], nextStyle))
        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.({ label: 'Applied stylish template', detail: recipe.label, domain: 'collage' })
        canvasEditor.__saveCanvasState?.()

        if (recipe.theme) {
            const theme = AI_BG_THEMES.find((t) => t.id === recipe.theme)
            if (theme) {
                toast.success(`${recipe.label} — generating background…`)
                await generateThemedBackground(theme)
            }
        } else if (recipe.backdrop) {
            applyBackdrop(recipe.backdrop)
            toast.success(`${recipe.label} applied`)
        }
    }, [canvasEditor, generatingTheme, project?.width, project?.height, gap, padding, generateThemedBackground, applyBackdrop])

    // Replace the selected cell's photo with an uploaded one, keeping the SAME
    // cell frame, shape and cover-fit so the collage stays intact.
    const onReplaceFileChange = useCallback(async (event) => {
        const file = event.target?.files?.[0]
        if (event.target) event.target.value = ''
        if (!file || !canvasEditor || !selectedPhoto) return
        const cell = selectedPhoto.phosmithCollageCell || cellFromClipPath(selectedPhoto)
        if (!cell) {
            toast.error('That photo is not part of a collage cell')
            return
        }
        setIsReplacing(true)
        const toastId = toast.loading('Replacing photo...')
        try {
            const newImage = await loadFabricImageFromFile(file)
            const index = canvasEditor.getObjects().indexOf(selectedPhoto)
            fitImageToCell(newImage, cell, { shape, radiusPct, shadow })
            canvasEditor.remove(selectedPhoto)
            if (index >= 0 && typeof canvasEditor.insertAt === 'function') {
                canvasEditor.insertAt(Math.min(index, canvasEditor.getObjects().length), newImage)
            } else {
                canvasEditor.add(newImage)
            }
            canvasEditor.setActiveObject(newImage)
            canvasEditor.requestRenderAll()
            canvasEditor.__pushHistoryState?.({ label: 'Replaced collage photo', domain: 'collage' })
            canvasEditor.__saveCanvasState?.()
            setSelectedPhoto(newImage)
            toast.success('Photo replaced', { id: toastId })
        } catch (error) {
            console.warn('[collage] replace failed:', error)
            toast.error('Could not replace the photo', { id: toastId })
        } finally {
            setIsReplacing(false)
        }
    }, [canvasEditor, selectedPhoto, shape, radiusPct, shadow])

    // Jump to the Adjust tool with this photo selected to fine-tune it.
    const handleEditPhoto = useCallback(() => {
        if (!canvasEditor || !selectedPhoto) return
        canvasEditor.setActiveObject(selectedPhoto)
        canvasEditor.requestRenderAll()
        onToolChange?.('adjust')
    }, [canvasEditor, selectedPhoto, onToolChange])

    const layout = LAYOUTS.find(item => item.id === selectedLayout)
    const missingCount = Math.max(0, (layout?.cellCount || 0) - imageCount)
    const isGenerating = Boolean(generatingTheme)


    return (
        <div className="h-full flex flex-col hide-scrollbar" style={{ background: 'var(--bg-panel)' }}>
            <input
                ref={replaceInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={onReplaceFileChange}
            />

            <Section title="Auto Template" icon={Wand2}>
                <p className="mb-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {`Detects your ${imageCount} photo${imageCount === 1 ? '' : 's'}, picks a matching layout & style, and generates a background to fit them.`}
                </p>
                <motion.button
                    type="button"
                    onClick={autoTemplate}
                    disabled={isGenerating || Boolean(processingMessage) || imageCount < 2}
                    whileTap={{ scale: 0.97 }}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)', color: '#ffffff', border: 'none', boxShadow: 'var(--shadow-glow)' }}
                >
                    {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                    {isGenerating ? 'Generating…' : 'Auto-generate Template'}
                </motion.button>
                {imageCount < 2 && (
                    <p className="mt-2 text-[10px]" style={{ color: 'var(--accent-warning)' }}>
                        ⚠ Add at least 2 photos to the canvas
                    </p>
                )}
            </Section>

            {imageCount >= 2 && (
                <Section title="Stylish Templates" icon={Sparkles}>
                    <div className="mb-3 flex items-center justify-between gap-2">
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {`Ready-made looks for your ${imageCount} photos.`}
                        </p>
                        <button
                            type="button"
                            onClick={regenerateTemplates}
                            disabled={isGenerating}
                            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium editor-interactive disabled:opacity-50"
                            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                        >
                            <Shuffle className="w-3 h-3" />
                            Shuffle
                        </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        {templateRecipes.map((recipe) => (
                            <motion.button
                                key={recipe.id}
                                type="button"
                                onClick={() => applyRecipe(recipe)}
                                disabled={isGenerating || Boolean(processingMessage)}
                                whileTap={{ scale: 0.96 }}
                                className="relative flex flex-col gap-1.5 rounded-lg p-1.5 text-left editor-interactive disabled:opacity-50"
                                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                                title={`${recipe.label} template`}
                            >
                                <TemplatePreview recipe={recipe} />
                                <div className="flex items-center justify-between gap-1 px-0.5">
                                    <span className="truncate text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                                        {recipe.label}
                                    </span>
                                    {recipe.isAi && (
                                        <span
                                            className="shrink-0 rounded px-1 text-[8px] font-semibold uppercase tracking-wide"
                                            style={{ background: 'rgba(6,184,212,0.15)', color: 'var(--accent-primary)' }}
                                        >
                                            AI
                                        </span>
                                    )}
                                </div>
                            </motion.button>
                        ))}
                    </div>
                </Section>
            )}

            {selectedPhoto && (
                <Section title="Selected Photo" icon={Replace}>
                    <p className="mb-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        Swap this photo for another, or fine-tune it.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            onClick={() => replaceInputRef.current?.click()}
                            disabled={isReplacing}
                            className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-50"
                            style={{ background: 'var(--accent-primary)', color: '#ffffff', border: 'none' }}
                        >
                            {isReplacing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Replace className="w-3.5 h-3.5" />}
                            Replace
                        </button>
                        <button
                            type="button"
                            onClick={handleEditPhoto}
                            className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-xs font-medium editor-interactive"
                            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                        >
                            <SlidersHorizontal className="w-3.5 h-3.5" />
                            Edit
                        </button>
                    </div>
                </Section>
            )}

            <Section title="Layout" icon={LayoutGrid}>
                <div className="grid grid-cols-3 gap-2">
                    {LAYOUTS.map(layout => {
                        const isActive = selectedLayout === layout.id
                        return (
                            <motion.button
                                key={layout.id}
                                type="button"
                                onClick={() => setSelectedLayout(layout.id)}
                                aria-label={`Use ${layout.label} collage layout`}
                                title={layout.label}
                                whileTap={{ scale: 0.95 }}
                                className="flex min-h-[68px] flex-col items-center justify-center gap-1.5 rounded-lg p-2 text-center editor-interactive relative"
                                style={{
                                    background: isActive ? 'rgba(6,184,212,0.12)' : 'var(--bg-elevated)',
                                    border: `1px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)'
                                }}
                            >
                                <LayoutPreview layoutId={layout.id} active={isActive} />
                                <span className="text-[9px] font-medium leading-tight">{layout.label}</span>
                                {isActive && (
                                    <div className="absolute top-1 right-1">
                                        <div className="bg-[var(--accent-primary)] rounded-full p-0.5">
                                            <Check className="w-2 h-2 text-white" strokeWidth={3} />
                                        </div>
                                    </div>
                                )}
                            </motion.button>
                        )
                    })}
                </div>
            </Section>

            <Section title="Template Style" icon={Sparkles}>
                <div className="grid grid-cols-2 gap-2">
                    {COLLAGE_STYLES.map((preset) => {
                        const isActive = selectedStyle === preset.id
                        return (
                            <motion.button
                                key={preset.id}
                                type="button"
                                onClick={() => applyStylePreset(preset)}
                                aria-label={`Use ${preset.label} style`}
                                title={preset.label}
                                whileTap={{ scale: 0.95 }}
                                className="relative flex items-center gap-2 rounded-lg p-2 editor-interactive"
                                style={{
                                    background: isActive ? 'rgba(6,184,212,0.12)' : 'var(--bg-elevated)',
                                    border: `1px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                }}
                            >
                                <span
                                    className="h-8 w-8 shrink-0"
                                    style={{
                                        background: backdropPreviewCss(preset.backdrop),
                                        border: '1px solid var(--border-default)',
                                        borderRadius: preset.shape === 'circle' ? '999px' : `${Math.round(preset.radiusPct / 4) + 2}px`,
                                        boxShadow: preset.shadow ? '0 2px 6px rgba(0,0,0,0.35)' : 'none',
                                    }}
                                />
                                <span
                                    className="text-[10px] font-medium leading-tight text-left"
                                    style={{ color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)' }}
                                >
                                    {preset.label}
                                </span>
                                {isActive && (
                                    <div className="absolute top-1 right-1 rounded-full bg-[var(--accent-primary)] p-0.5">
                                        <Check className="w-2 h-2 text-white" strokeWidth={3} />
                                    </div>
                                )}
                            </motion.button>
                        )
                    })}
                </div>
            </Section>

            <Section title="Background" icon={Palette}>
                <div className="grid grid-cols-6 gap-1.5">
                    {COLLAGE_BACKDROPS.map((backdrop) => {
                        const isActive =
                            activeBackdrop &&
                            activeBackdrop.type === backdrop.type &&
                            activeBackdrop.color === backdrop.color &&
                            JSON.stringify(activeBackdrop.stops || null) === JSON.stringify(backdrop.stops || null)
                        return (
                            <button
                                key={backdrop.label}
                                type="button"
                                onClick={() => applyBackdrop(backdrop)}
                                aria-label={`Set ${backdrop.label} background`}
                                title={backdrop.label}
                                className="h-7 rounded-md editor-interactive"
                                style={{
                                    background: backdropPreviewCss(backdrop),
                                    border: `2px solid ${isActive ? 'var(--accent-primary)' : 'transparent'}`,
                                    boxShadow: isActive ? '0 0 0 1px rgba(6,184,212,0.3)' : 'inset 0 0 0 1px var(--border-subtle)',
                                }}
                            />
                        )
                    })}
                </div>
                <button
                    type="button"
                    onClick={() => applyBackdrop(null)}
                    className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[10px] font-medium editor-interactive"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                >
                    <X className="w-3 h-3" />
                    Clear Background
                </button>
            </Section>

            <Section title="Photo Shape" icon={Square}>
                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-2">
                        {[
                            { id: 'rect', label: 'Rounded', Icon: Square },
                            { id: 'circle', label: 'Circle', Icon: Circle },
                        ].map(({ id, label, Icon }) => {
                            const isActive = shape === id
                            return (
                                <button
                                    key={id}
                                    type="button"
                                    onClick={() => updateStyle({ shape: id })}
                                    className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-medium editor-interactive"
                                    style={{
                                        background: isActive ? 'rgba(6,184,212,0.12)' : 'var(--bg-elevated)',
                                        border: `1px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                        color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                    }}
                                >
                                    <Icon className="w-3.5 h-3.5" />
                                    {label}
                                </button>
                            )
                        })}
                    </div>
                    {shape === 'rect' && (
                        <LabeledSlider
                            label="Corner Radius"
                            value={radiusPct}
                            min={0}
                            max={50}
                            onChange={(v) => updateStyle({ radiusPct: v })}
                            suffix="%"
                        />
                    )}
                    <button
                        type="button"
                        onClick={() => updateStyle({ shadow: !shadow })}
                        aria-pressed={shadow}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-[11px] font-medium editor-interactive"
                        style={{
                            background: shadow ? 'rgba(6,184,212,0.1)' : 'var(--bg-elevated)',
                            border: `1px solid ${shadow ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                            color: shadow ? 'var(--accent-primary)' : 'var(--text-secondary)',
                        }}
                    >
                        <span>Drop Shadow</span>
                        <span
                            className="h-4 w-7 rounded-full transition-colors"
                            style={{ background: shadow ? 'var(--accent-primary)' : 'var(--border-default)', position: 'relative' }}
                        >
                            <span
                                className="absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all"
                                style={{ left: shadow ? '14px' : '2px' }}
                            />
                        </span>
                    </button>
                </div>
            </Section>

            <Section title="AI Background" icon={Sparkles}>
                <p className="mb-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Generate a decorative background tuned to your photos&apos; colors.
                </p>
                <div className="grid grid-cols-2 gap-2">
                    {AI_BG_THEMES.map((theme) => {
                        const isThisGenerating = generatingTheme === theme.id
                        return (
                            <motion.button
                                key={theme.id}
                                type="button"
                                onClick={() => generateThemedBackground(theme)}
                                disabled={isGenerating || Boolean(processingMessage) || imageCount === 0}
                                whileTap={{ scale: 0.96 }}
                                className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2.5 text-[11px] font-medium editor-interactive disabled:cursor-not-allowed disabled:opacity-50"
                                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                            >
                                {isThisGenerating ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--accent-primary)' }} />
                                ) : (
                                    <Sparkles className="w-3.5 h-3.5" />
                                )}
                                {theme.label}
                            </motion.button>
                        )
                    })}
                </div>
                {imageCount === 0 && (
                    <p className="mt-2 text-[10px]" style={{ color: 'var(--accent-warning)' }}>
                        ⚠ Add photos first so the background can match them
                    </p>
                )}
            </Section>

            <Section title="Spacing" icon={Rows}>
                <div className="space-y-4">
                    <LabeledSlider
                        label="Gap"
                        value={gap}
                        min={0}
                        max={100}
                        onChange={setGap}
                    />
                    <LabeledSlider
                        label="Padding"
                        value={padding}
                        min={0}
                        max={100}
                        onChange={setPadding}
                    />
                </div>
            </Section>

            <div className="p-4 mt-auto" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <p className="mb-2 text-[10px]" style={{ color: missingCount ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
                    {`${imageCount} visible image${imageCount === 1 ? '' : 's'}${missingCount > 0 ? ` · add ${missingCount} more for this layout` : ' · ready to arrange'}`}
                </p>
                <motion.button
                    type="button"
                    onClick={applyLayout}
                    disabled={missingCount > 0}
                    whileTap={{ scale: 0.97 }}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                    style={{
                        background: 'var(--accent-primary)',
                        color: '#ffffff',
                    }}
                >
                    <LayoutGrid className="w-4 h-4" />
                    Apply Layout
                </motion.button>
            </div>
        </div>
    )
}
