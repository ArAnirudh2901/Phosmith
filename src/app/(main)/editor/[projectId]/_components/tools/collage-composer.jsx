"use client"

// Collage Composer panel: understands the photos, solves one-of-a-kind layouts
// instantly on-device, lets Gemini art-direct from any brief (even vague ones)
// in the background, and applies the chosen design with a procedural finish and
// colour harmony. Layouts can have more slots than photos: empty slots become
// "+" placeholders you click to upload into.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Aperture, Dices, Loader2, Check } from 'lucide-react'
import { FabricImage } from 'fabric'
import { toast } from 'sonner'
import { applyCanvasSizedBackground } from '@/lib/canvas-background'
import { uploadImageBlobToImageKit } from '@/lib/canvas-images'
import { applyCollageBackground } from '@/lib/collage-styles'
import { isVisibleImage } from '@/lib/collage-layout'
import { analyzeElement } from '@/lib/collage/analyze'
import { FAMILIES, composeCandidates } from '@/lib/collage/compose'
import { BACKDROP_KINDS, directionFromPrompt, validateDirection } from '@/lib/collage/director'
import { harmonyAdjustments, nativeBackdrop, needsRenderedBackdrop, renderBackdrop, synthesizePalette } from '@/lib/collage/finish'
import { applyComposition, applyHarmony, applyShadowStrength, drawLayoutPreview } from '@/lib/collage/render'
import { PRESET_SHAPES, presetShape, shapeFromMatte, shapeFromText } from '@/lib/collage/shapes'
import { createSlot, isCollageSlot } from '@/lib/collage/slot'

const BACKDROP_LABELS = { field: 'Field', aura: 'Aura', echo: 'Echo', paper: 'Paper', solid: 'Solid' }
const SHAPE_OPTIONS = [
    { id: 'subject', label: 'Subject', title: 'The hero subject’s own outline' },
    { id: 'heart', label: 'Heart' },
    { id: 'circle', label: 'Circle' },
    { id: 'star', label: 'Star' },
    { id: 'text', label: 'Word', title: 'Spell a word with your photos' },
]
const SLOT_CHOICES = ['auto', 2, 3, 4, 5, 6, 8, 10, 12]

export const sourceElement = (img) => img?._originalElement || img?._element || img?.getElement?.()

const matteCoverage = (matte) => {
    const d = matte.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, matte.width, matte.height).data
    let on = 0
    for (let i = 0; i < d.length; i += 16) if (d[i] > 127) on += 1
    return on / (d.length / 16)
}

const thumbnailFor = (el, edge = 384) => {
    const w = el.naturalWidth || el.width
    const h = el.naturalHeight || el.height
    const s = Math.min(1, edge / Math.max(w, h))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w * s))
    c.height = Math.max(1, Math.round(h * s))
    c.getContext('2d').drawImage(el, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.72).split(',')[1]
}

// Analysis without canvases/pixels, for the API.
const wireAnalysis = (a) => {
    const rest = { ...a }
    delete rest.thumb
    delete rest.pixels
    return rest
}

// Stand-in analysis for an empty slot: neutral subject, varied aspect for rhythm.
const ASPECTS = [1.5, 0.8, 1, 1.33, 0.75, 1.78, 0.9, 1.2]
const placeholderPhoto = (i) => ({
    placeholder: true,
    aspect: ASPECTS[i % ASPECTS.length],
    box: { x0: 0.2, y0: 0.15, x1: 0.8, y1: 0.85 },
    focus: { x: 0.5, y: 0.5 },
    concentration: 0.4,
    calm: { x0: 0.55, y0: 0.05, x1: 0.95, y1: 0.55, area: 0.2 },
    openSide: 'right',
    palette: [],
    mean: { r: 0.5, g: 0.5, b: 0.5 },
    luminance: 0.5,
    contrast: 0.2,
    colorfulness: 0.15,
    warmth: 0,
    sharpness: 0.5,
    lineAngle: 0,
    lineStrength: 0,
    quality: 0.5,
    weight: i === 0 ? 0.8 : 0.45,
})

const Tile = ({ candidate, analyses, active, onApply, disabled }) => {
    const ref = useRef(null)
    useEffect(() => {
        const c = ref.current
        if (!c) return
        const { width, height } = candidate.layout.canvas
        c.width = 280
        c.height = Math.max(40, Math.round((280 * height) / width))
        drawLayoutPreview(c, candidate.layout, analyses, { background: candidate.previewBg })
    }, [candidate, analyses])
    const empty = candidate.layout.cells.filter((cell) => analyses[cell.index]?.placeholder).length
    return (
        <button
            type="button"
            onClick={() => onApply(candidate)}
            disabled={disabled}
            title={candidate.rationale || candidate.blurb}
            aria-pressed={active}
            className="group flex min-w-0 flex-col gap-1 rounded-lg p-1.5 text-left transition-colors disabled:opacity-60"
            style={{ background: 'var(--bg-elevated)', border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}` }}
        >
            <canvas ref={ref} className="block w-full rounded" style={{ height: 'auto' }} />
            <span className="flex min-w-0 items-center gap-1">
                {active && <Check className="h-3 w-3 shrink-0" style={{ color: 'var(--accent-primary)' }} />}
                {candidate.ai && <span className="shrink-0 rounded px-1 text-[8.5px] font-bold" style={{ background: 'rgba(6,184,212,0.16)', color: 'var(--accent-primary)' }}>AI</span>}
                <span className="truncate text-[10.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>{candidate.title}</span>
            </span>
            <span className="truncate text-[9.5px]" style={{ color: 'var(--text-muted)' }} title="How much of every subject stays visible">
                {candidate.familyLabel} · {empty ? `${empty} empty slot${empty === 1 ? '' : 's'}` : `${Math.round(candidate.layout.metrics.safe * 100)}% subjects`}
            </span>
        </button>
    )
}

const Chip = ({ active, onClick, disabled, title, children }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={active}
        title={title}
        className="rounded-md px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-35"
        style={{
            background: active ? 'rgba(6,184,212,0.14)' : 'var(--bg-elevated)',
            border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
            color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
        }}
    >
        {children}
    </button>
)

export default function CollageComposer({ canvasEditor, project, imageCount, busyElsewhere, setProcessingMessage }) {
    const [prompt, setPrompt] = useState('')
    const [family, setFamily] = useState('auto')
    const [shape, setShape] = useState('subject')
    const [word, setWord] = useState('')
    const [slots, setSlots] = useState('auto')
    const [busy, setBusy] = useState(null)
    const [aiPending, setAiPending] = useState(false)
    const [candidates, setCandidates] = useState([])
    const [analyses, setAnalyses] = useState([])
    const [story, setStory] = useState('')
    const [appliedId, setAppliedId] = useState(null)
    const [finish, setFinish] = useState(null)
    const seedRef = useRef(Math.floor(Math.random() * 90000) + 1)
    const lastDirectionsRef = useRef([])
    const outlineCacheRef = useRef(new WeakMap())
    const runRef = useRef(0)
    const appliedIdRef = useRef(null)
    useEffect(() => { appliedIdRef.current = appliedId }, [appliedId])

    const canvas = useMemo(() => ({ width: Number(project?.width) || 1080, height: Number(project?.height) || 1080 }), [project?.width, project?.height])
    const slotTotal = slots === 'auto' ? Math.max(2, imageCount || 6) : slots

    // Real photos (up to the slot count) followed by placeholders for empty slots.
    const collect = useCallback((total) => {
        const all = canvasEditor?.getObjects?.().filter(isVisibleImage) || []
        const images = []
        const photos = []
        for (const img of all) {
            if (images.length >= total) break
            const el = sourceElement(img)
            const a = el ? analyzeElement(el) : null
            if (a) { images.push(img); photos.push(a) }
        }
        while (photos.length < total) photos.push(placeholderPhoto(photos.length))
        return { images, photos }
    }, [canvasEditor])

    const buildContainer = useCallback(async (dir, images, photos) => {
        const kind = dir.shape || 'subject'
        if (kind === 'text') return shapeFromText(dir.text || 'LOVE')
        if (PRESET_SHAPES.includes(kind)) return presetShape(kind)
        const real = photos.map((p, i) => [p, i]).filter(([p]) => !p.placeholder)
        const byCompactness = real.map(([p, i]) => [p.concentration, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i)
        const tryOrder = [...new Set([...(Number.isInteger(dir.hero) && images[dir.hero] ? [dir.hero] : []), ...byCompactness])].slice(0, 3)
        if (!tryOrder.length) return presetShape('heart')
        setProcessingMessage?.('Tracing the subject outline…')
        try {
            const { clientSubjectMask } = await import('@/lib/client-ai')
            for (const idx of tryOrder) {
                const el = sourceElement(images[idx])
                if (!el) continue
                let outline = outlineCacheRef.current.get(el)
                if (outline === undefined) {
                    const w = el.naturalWidth || el.width, h = el.naturalHeight || el.height
                    const k = Math.min(1, 512 / Math.max(w, h))
                    const matte = await clientSubjectMask(el, { width: Math.round(w * k), height: Math.round(h * k) })
                    // A matte covering most of the frame is scenery, not a subject.
                    const cover = matte ? matteCoverage(matte) : 0
                    outline = cover > 0.04 && cover < 0.62 ? shapeFromMatte(matte) : null
                    outlineCacheRef.current.set(el, outline)
                }
                if (outline) return outline
            }
            toast.info('No photo has a distinct subject outline, so a heart shape is used instead')
            return presetShape('heart')
        } catch (error) {
            console.warn('[composer] subject outline failed:', error?.message || error)
            toast.info('Could not trace the subject outline, so a heart shape is used instead')
            return presetShape('heart')
        } finally {
            setProcessingMessage?.(null)
        }
    }, [setProcessingMessage])

    const toCandidates = useCallback((directions, photos, { seedBase, ai = false }) => {
        const out = []
        const familyCount = {}
        directions.forEach((dir, di) => {
            const spec = { ...dir, seed: seedBase + di * 97, container: dir.container }
            const limit = directions.length === 1 ? 6 : 1
            const layouts = composeCandidates(photos, canvas, spec, dir.family === 'auto' ? { perFamily: 2, limit } : { limit })
            layouts.forEach((layout, li) => {
                const fam = FAMILIES.find((f) => f.id === layout.family)
                const palette = synthesizePalette(photos.filter((p) => !p.placeholder), dir.finish)
                familyCount[layout.family] = (familyCount[layout.family] || 0) + 1
                const nth = familyCount[layout.family]
                out.push({
                    id: `${layout.id}-${ai ? 'ai' : 'dv'}-${di}-${li}`,
                    ai,
                    title: dir.title && li === 0 ? dir.title : `${fam?.label || layout.family}${nth > 1 ? ` ${nth}` : ''}`,
                    rationale: dir.rationale,
                    blurb: fam?.blurb,
                    familyLabel: fam?.label || layout.family,
                    direction: dir,
                    layout,
                    palette,
                    previewBg: [palette.base, palette.accents[0] || palette.base],
                })
            })
        })
        const seen = new Set()
        return out.filter((c) => (seen.has(c.layout.id) ? false : seen.add(c.layout.id))).slice(0, 6)
    }, [canvas])

    const withUserChoices = useCallback((dir, count) => validateDirection(
        family === 'silhouette' ? { ...dir, family, shape, text: shape === 'text' ? word : dir.text }
            : family !== 'auto' ? { ...dir, family } : dir,
        { photoCount: count },
    ), [family, shape, word])

    // Art director in the background; merges its directions into the gallery.
    const requestArtDirection = useCallback(async (runId, images, photos) => {
        const realCount = photos.filter((p) => !p.placeholder).length
        if (!prompt.trim() && realCount < 2) return
        setAiPending(true)
        try {
            const res = await fetch('/api/ai/collage-direct', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt,
                    photoCount: photos.length,
                    canvasAspect: canvas.width / canvas.height,
                    analyses: photos.filter((p) => !p.placeholder).map(wireAnalysis),
                    photos: images.slice(0, 8).map((img) => ({ base64: thumbnailFor(sourceElement(img)), mimeType: 'image/jpeg' })),
                    count: 3,
                }),
            })
            const data = res.ok ? await res.json() : null
            if (runRef.current !== runId || data?.source !== 'gemini' || !data.directions?.length) return
            const directions = data.directions.map((d) => withUserChoices(d, photos.length))
            for (const dir of directions) {
                if (dir.family === 'silhouette') dir.container = await buildContainer(dir, images, photos)
            }
            if (runRef.current !== runId) return
            const aiCandidates = toCandidates(directions, photos, { seedBase: seedRef.current + 5003, ai: true })
            lastDirectionsRef.current = [...directions, ...lastDirectionsRef.current].slice(0, 4)
            setStory(data.story || '')
            setCandidates((prev) => {
                const ids = new Set(aiCandidates.map((c) => c.layout.id))
                const applied = prev.filter((c) => c.id === appliedIdRef.current)
                return [...aiCandidates, ...applied, ...prev.filter((c) => !ids.has(c.layout.id) && c.id !== appliedIdRef.current)].slice(0, 6)
            })
        } catch {
            /* the on-device gallery already stands */
        } finally {
            if (runRef.current === runId) setAiPending(false)
        }
    }, [prompt, canvas, withUserChoices, buildContainer, toCandidates])

    const compose = useCallback(async ({ remix = false } = {}) => {
        if (!canvasEditor || busy) return
        const { images, photos } = collect(slotTotal)
        if (photos.length < 2) { toast.error('Choose at least 2 slots'); return }
        setBusy(remix ? 'remix' : 'compose')
        setAnalyses(photos)
        seedRef.current += remix ? 7919 : 1
        const runId = ++runRef.current
        try {
            let directions = remix && lastDirectionsRef.current.length ? lastDirectionsRef.current : null
            if (!directions) {
                setStory('')
                const local = withUserChoices(directionFromPrompt(prompt, { photoCount: photos.length, seed: seedRef.current }), photos.length)
                if (local.family === 'silhouette') local.container = await buildContainer(local, images, photos)
                directions = [local]
                lastDirectionsRef.current = directions
            }
            const next = toCandidates(directions, photos, { seedBase: seedRef.current })
            setCandidates(next)
            if (!next.length) toast.error('Could not solve a layout for these settings')
        } finally {
            setBusy(null)
        }
        if (!remix) requestArtDirection(runId, images, photos)
    }, [canvasEditor, busy, collect, slotTotal, prompt, withUserChoices, buildContainer, toCandidates, requestArtDirection])

    const applyFinish = useCallback(async (images, photos, layout, nextFinish, title) => {
        const real = photos.filter((p) => !p.placeholder)
        const palette = synthesizePalette(real, nextFinish)
        let usedRendered = false
        if (needsRenderedBackdrop(nextFinish)) {
            try {
                setProcessingMessage?.('Painting backdrop…')
                const heroEl = images[layout.hero] ? sourceElement(images[layout.hero]) : null
                const kind = !heroEl && nextFinish.backdrop === 'echo' ? { ...nextFinish, backdrop: 'aura' } : nextFinish
                const painted = renderBackdrop(canvas, kind, palette, { heroEl, seed: layout.seed })
                const blob = await new Promise((resolve) => painted.toBlob(resolve, 'image/jpeg', 0.9))
                const url = await uploadImageBlobToImageKit(blob, `composer-backdrop-${Date.now()}.jpg`)
                await applyCanvasSizedBackground(canvasEditor, FabricImage, url, project)
                usedRendered = true
            } catch (error) {
                console.warn('[composer] textured backdrop failed, using gradient:', error?.message || error)
            }
        }
        if (!usedRendered) applyCollageBackground(canvasEditor, nativeBackdrop(nextFinish.backdrop, palette), project)
        if (images.length) {
            setProcessingMessage?.('Harmonising colour…')
            const { skipped } = await applyHarmony(images, harmonyAdjustments(real, nextFinish))
            if (skipped) toast.info(`${skipped} photo${skipped === 1 ? '' : 's'} kept their existing mask edits (not harmonised)`)
        }
        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.({ label: 'Composed collage', detail: title, domain: 'collage' })
        canvasEditor.__saveCanvasState?.()
    }, [canvasEditor, canvas, project, setProcessingMessage])

    const placeSlots = useCallback((layout, photos) => {
        canvasEditor.getObjects().filter(isCollageSlot).forEach((o) => canvasEditor.remove(o))
        layout.cells
            .filter((cell) => photos[cell.index]?.placeholder)
            .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
            .forEach((cell) => canvasEditor.add(createSlot(cell)))
    }, [canvasEditor])

    const applyCandidate = useCallback(async (candidate) => {
        if (!canvasEditor || busy) return
        const total = candidate.layout.cells.length
        const { images, photos } = collect(total)
        const expectedReal = analyses.filter((p) => !p.placeholder).length
        if (images.length !== expectedReal) {
            toast.error('Photos changed, so compose again')
            return
        }
        setBusy('apply')
        try {
            canvasEditor.discardActiveObject()
            applyComposition(canvasEditor, images, candidate.layout, photos, { shadow: candidate.direction.finish.shadow })
            placeSlots(candidate.layout, photos)
            setAppliedId(candidate.id)
            setFinish({ ...candidate.direction.finish })
            await applyFinish(images, photos, candidate.layout, candidate.direction.finish, candidate.title)
            const empty = total - images.length
            toast.success(empty ? `${candidate.title} ready. Click a + slot to add ${empty} photo${empty === 1 ? '' : 's'}` : `${candidate.title} composed`)
        } catch (error) {
            console.error('[composer] apply failed:', error)
            toast.error('Could not apply that composition')
        } finally {
            setProcessingMessage?.(null)
            setBusy(null)
        }
    }, [canvasEditor, busy, collect, analyses, placeSlots, applyFinish, setProcessingMessage])

    const refinish = useCallback(async (patch) => {
        const current = candidates.find((c) => c.id === appliedId)
        if (!current || !finish || busy) return
        const nextFinish = { ...finish, ...patch }
        setFinish(nextFinish)
        const images = canvasEditor.getObjects().filter(isVisibleImage)
        const photos = images.map((img) => analyzeElement(sourceElement(img))).filter(Boolean)
        setBusy('finish')
        try {
            if (patch.shadow !== undefined) applyShadowStrength(images, nextFinish.shadow, Math.min(canvas.width, canvas.height))
            await applyFinish(images, photos, current.layout, nextFinish, current.title)
        } finally {
            setProcessingMessage?.(null)
            setBusy(null)
        }
    }, [candidates, appliedId, finish, busy, canvasEditor, canvas, applyFinish, setProcessingMessage])

    // Test hooks for console / Playwright driving.
    useEffect(() => {
        const ns = (window.__phosmith = window.__phosmith || {})
        ns.composer = {
            candidates: () => candidates,
            finish: () => finish,
            photoSizes: () => (canvasEditor?.getObjects?.().filter(isVisibleImage) || []).map((img) => { const el = sourceElement(img); return `${el?.naturalWidth}x${el?.naturalHeight}` }),
            slots: () => (canvasEditor?.getObjects?.() || []).filter(isCollageSlot).length,
            // Client-space centres of slots and framed photos (for pointer-driven tests).
            screenRects: () => {
                const el = canvasEditor?.upperCanvasEl?.getBoundingClientRect?.()
                if (!el) return null
                const [a, , , d, e, f] = canvasEditor.viewportTransform
                const toClient = (o) => { const b = o.phosmithCollageCell ? { left: o.phosmithCollageCell.x, top: o.phosmithCollageCell.y, width: o.phosmithCollageCell.w, height: o.phosmithCollageCell.h } : o.getBoundingRect(); return { x: Math.round(el.left + (b.left + b.width / 2) * a + e), y: Math.round(el.top + (b.top + b.height / 2) * d + f), src: (o.getSrc?.() || '').slice(-24) } }
                const objs = canvasEditor.getObjects()
                return { slots: objs.filter(isCollageSlot).map(toClient), photos: objs.filter(isVisibleImage).map(toClient) }
            },
        }
        return () => { delete ns.composer }
    }, [candidates, finish, canvasEditor])

    const disabled = Boolean(busy) || busyElsewhere

    return (
        <div className="px-4 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="mb-2 flex items-center gap-2">
                <div className="flex h-5 w-5 items-center justify-center rounded" style={{ background: 'rgba(6,184,212,0.1)' }}>
                    <Aperture className="h-3 w-3" style={{ color: 'var(--accent-primary)' }} />
                </div>
                <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>Composer</h3>
            </div>
            <p className="mb-2.5 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {imageCount >= 2
                    ? 'Designs one-of-a-kind layouts from what is in your photos. Subjects stay uncropped, and the colour is unified across every shot.'
                    : 'Design a template first, then click each + slot to add a photo. Or add photos to design around them.'}
            </p>
            <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                maxLength={400}
                placeholder="Say anything: “for mom’s birthday”, “moody film diary”, “spell GOA”, “make it pop”"
                aria-label="Collage brief"
                className="panel-input mb-2 w-full resize-none rounded-lg px-2.5 py-2 text-[11px] leading-snug"
            />
            <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label="Structure">
                {[{ id: 'auto', label: 'Auto', blurb: 'Let the photos decide', min: 2, max: 99 }, ...FAMILIES].map((f) => (
                    <Chip
                        key={f.id}
                        active={family === f.id}
                        onClick={() => setFamily(f.id)}
                        disabled={f.id !== 'auto' && (slotTotal < f.min || slotTotal > f.max)}
                        title={slotTotal >= f.min && slotTotal <= f.max ? f.blurb : `${f.label} needs ${f.min}–${f.max} slots`}
                    >
                        {f.label}
                    </Chip>
                ))}
            </div>
            {family === 'silhouette' && (
                <div className="mb-2 space-y-1.5">
                    <div className="flex flex-wrap gap-1" role="group" aria-label="Silhouette shape">
                        {SHAPE_OPTIONS.map((o) => (
                            <Chip key={o.id} active={shape === o.id} onClick={() => setShape(o.id)} title={o.title || o.label}>{o.label}</Chip>
                        ))}
                    </div>
                    {shape === 'text' && (
                        <input
                            value={word}
                            onChange={(e) => setWord(e.target.value.toUpperCase().replace(/[^A-Z0-9& ]/g, '').slice(0, 12))}
                            placeholder="Word to spell, e.g. GOA"
                            aria-label="Word to spell"
                            className="panel-input w-full rounded-lg px-2.5 py-1.5 text-[11px] uppercase tracking-wider"
                        />
                    )}
                </div>
            )}
            <div className="mb-2.5 flex items-start gap-2">
                <span className="mt-1 shrink-0 text-[10px]" style={{ color: 'var(--text-secondary)' }}>Slots</span>
                <div className="flex flex-wrap gap-1" role="group" aria-label="Slots">
                    {SLOT_CHOICES.map((n) => (
                        <Chip
                            key={n}
                            active={slots === n}
                            onClick={() => setSlots(n)}
                            title={n === 'auto' ? 'One slot per photo on the canvas' : `${n} slots; empty ones become + placeholders`}
                        >
                            {n === 'auto' ? 'Auto' : n}
                        </Chip>
                    ))}
                </div>
            </div>
            <div className="flex gap-1.5">
                <motion.button
                    type="button"
                    onClick={() => compose()}
                    disabled={disabled}
                    whileTap={{ scale: 0.97 }}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)', color: '#ffffff' }}
                >
                    {busy === 'compose' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Aperture className="h-4 w-4" />}
                    {busy === 'compose' ? 'Composing…' : imageCount >= 2 ? 'Compose' : 'Design template'}
                </motion.button>
                {candidates.length > 0 && (
                    <motion.button
                        type="button"
                        onClick={() => compose({ remix: true })}
                        disabled={disabled}
                        whileTap={{ scale: 0.97 }}
                        title="Same direction, new solutions"
                        className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-xs font-medium disabled:opacity-50"
                        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                    >
                        {busy === 'remix' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Dices className="h-3.5 w-3.5" />}
                        Remix
                    </motion.button>
                )}
            </div>
            {candidates.length > 0 && (
                <>
                    <p className="mb-2 mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        {aiPending && <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" style={{ color: 'var(--accent-primary)' }} />}
                        <span>
                            {aiPending ? 'Designed on-device. The art director is refining…' : candidates.some((c) => c.ai) ? 'Art-directed by Gemini' : 'Designed on-device'}
                            {!aiPending && story ? `: ${story}` : ''}
                        </span>
                    </p>
                    <div className="grid grid-cols-2 gap-1.5">
                        {candidates.map((c) => (
                            <Tile key={c.id} candidate={c} analyses={analyses} active={c.id === appliedId} onApply={applyCandidate} disabled={Boolean(busy) || busyElsewhere} />
                        ))}
                    </div>
                    <p className="mt-2 text-[9.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        After applying, drag a photo onto another to swap them, or onto a + slot to move it.
                    </p>
                </>
            )}
            {finish && appliedId && (
                <div className="mt-3 space-y-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Finish</div>
                    <div className="grid grid-cols-5 gap-1" role="group" aria-label="Backdrop">
                        {BACKDROP_KINDS.map((k) => (
                            <button
                                key={k}
                                type="button"
                                onClick={() => refinish({ backdrop: k })}
                                disabled={Boolean(busy)}
                                aria-pressed={finish.backdrop === k}
                                className="min-w-0 truncate rounded-md px-1 py-1.5 text-[9.5px] font-medium disabled:opacity-50"
                                style={{
                                    background: finish.backdrop === k ? 'rgba(6,184,212,0.14)' : 'var(--bg-elevated)',
                                    border: `1px solid ${finish.backdrop === k ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    color: finish.backdrop === k ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                }}
                            >
                                {BACKDROP_LABELS[k]}
                            </button>
                        ))}
                    </div>
                    {[
                        { key: 'harmony', label: 'Colour harmony' },
                        { key: 'shadow', label: 'Depth' },
                        { key: 'grain', label: 'Grain' },
                    ].map((row) => (
                        <FinishSlider key={row.key} label={row.label} value={finish[row.key]} disabled={Boolean(busy)} onCommit={(v) => refinish({ [row.key]: v })} />
                    ))}
                </div>
            )}
        </div>
    )
}

// Commits on release so each change re-renders the finish once.
const FinishSlider = ({ label, value, disabled, onCommit }) => {
    const [local, setLocal] = useState(null)
    const shown = local ?? Math.round((value || 0) * 100)
    const commit = () => {
        if (local === null) return
        const v = local / 100
        setLocal(null)
        if (Math.abs(v - (value || 0)) > 0.005) onCommit(v)
    }
    return (
        <label className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
            <span className="w-[92px] shrink-0 truncate">{label}</span>
            <input
                type="range"
                min={0}
                max={100}
                value={shown}
                disabled={disabled}
                onChange={(e) => setLocal(Number(e.target.value))}
                onPointerUp={commit}
                onKeyUp={commit}
                onBlur={commit}
                aria-label={label}
                className="mask-range flex-1"
            />
            <span className="w-7 shrink-0 text-right font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>{shown}</span>
        </label>
    )
}
