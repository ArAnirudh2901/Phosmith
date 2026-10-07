"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Aperture, Wind, Droplet, Sun, Loader2, Circle, Hexagon, CircleDot } from 'lucide-react'
import { FabricImage, Shadow } from 'fabric'
import { toast } from 'sonner'
import { useCanvas } from '../../../../../../../context/context'
import { applyMegashaderFilter } from '@/lib/megashader/apply-megashader'
import { setMaskTexture } from '@/lib/megashader/mask-types'
import { buildDepthOfField, motionBlurLayer, tiltShiftLayer } from '@/lib/effects/focus'
import { buildColorPop } from '@/lib/effects/color-pop'
import { castShadowAlpha, castShadowCanvas, frameShadowParams, GLOBAL_LIGHT_ANGLE } from '@/lib/effects/shadow'
import { canvasToPlane, imageToLumaPlane, matchPlane, planeToCoverageCanvas } from '@/lib/cv/plane-image'
import { gradientLayer, setMaskTexture as setShadowTexture } from '@/lib/megashader/mask-types'
import { refineMatte } from '@/lib/cv/guided-filter'
import { toUserMessage } from '@/lib/user-error'

const sourceElementOf = (img) => img?._originalElement || img?._element || img?.getElement?.() || null

const hexToUnit = (hex) => {
    const h = String(hex || '#000000').replace('#', '')
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    const n = parseInt(full.slice(0, 6), 16) || 0
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

/** Does this image carry real transparency (a cut-out) or is it a full frame? */
const hasTransparency = (el) => {
    try {
        const probe = document.createElement('canvas')
        const w = Math.min(96, el.naturalWidth || el.width)
        const h = Math.min(96, el.naturalHeight || el.height)
        probe.width = w
        probe.height = h
        const ctx = probe.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(el, 0, 0, w, h)
        const { data } = ctx.getImageData(0, 0, w, h)
        let clear = 0
        for (let i = 3; i < data.length; i += 4) if (data[i] < 8) clear += 1
        // A few stray transparent pixels are noise; a real cut-out has many.
        return clear > (w * h) * 0.02
    } catch {
        return false
    }
}

const Section = ({ title, icon: Icon, children }) => (
    <div className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
            {Icon && <Icon className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} />}
            <span className="text-[11px] font-semibold tracking-wide" style={{ color: 'var(--text-primary)' }}>{title}</span>
        </div>
        <div className="px-4 pb-4 space-y-3">{children}</div>
    </div>
)

const Slider = ({ label, value, min, max, step = 1, suffix = '', onChange }) => (
    <div className="space-y-1">
        <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--text-secondary)' }}>
            <span className="font-medium">{label}</span>
            <span className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>{value}{suffix}</span>
        </div>
        <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-full accent-[var(--accent-primary)] editor-interactive"
            style={{ height: 4, background: 'var(--border-subtle)', borderRadius: 2, appearance: 'none' }}
        />
    </div>
)

const Chips = ({ options, value, onChange, columns = 3 }) => (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {options.map(({ id, label, icon: Icon }) => (
            <button
                key={id}
                type="button"
                onClick={() => onChange(id)}
                className="flex items-center justify-center gap-1 rounded-lg px-2 py-2 text-[10px] font-semibold editor-interactive"
                style={{
                    background: value === id ? 'var(--accent-primary)' : 'var(--surface-raised)',
                    color: value === id ? '#ffffff' : 'var(--text-secondary)',
                    border: '1px solid var(--border-subtle)',
                }}
            >
                {Icon && <Icon className="h-3 w-3" />}
                {label}
            </button>
        ))}
    </div>
)

const ApplyButton = ({ children, onClick, busy, disabled }) => (
    <motion.button
        type="button"
        whileTap={{ scale: 0.97 }}
        onClick={onClick}
        disabled={busy || disabled}
        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: 'var(--accent-primary)', color: '#ffffff' }}
    >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {children}
    </motion.button>
)

export default function FocusControls() {
    const { canvasEditor } = useCanvas()
    const [activeImage, setActiveImage] = useState(null)
    const [busy, setBusy] = useState(null)
    const [note, setNote] = useState('')

    // Focus
    const [focusMode, setFocusMode] = useState('tilt-radial')
    const [blurPx, setBlurPx] = useState(30)
    const [aperture, setAperture] = useState('disc')
    const [bloom, setBloom] = useState(2)
    const [feather, setFeather] = useState(35)
    const [focusPlane, setFocusPlane] = useState(50)
    const [miniature, setMiniature] = useState(0)
    // Motion
    const [motionAngle, setMotionAngle] = useState(0)
    const [motionLength, setMotionLength] = useState(60)
    const [motionPx, setMotionPx] = useState(40)
    const [spin, setSpin] = useState(false)
    // Colour pop
    const [popMode, setPopMode] = useState('subject')
    const [keepSat, setKeepSat] = useState(15)
    const [popFeather, setPopFeather] = useState(15)
    // Colour mode: the picked colour, where it was picked (a spatial limit stops
    // an unrelated red object across the frame from surviving), and how wide the
    // match is.
    const [pickedColor, setPickedColor] = useState(null)
    const [pickPoint, setPickPoint] = useState(null)
    const [picking, setPicking] = useState(false)
    const [tolerance, setTolerance] = useState(24)
    const [contiguous, setContiguous] = useState(true)
    // Shadow
    const [shadowKind, setShadowKind] = useState('frame')
    const [lightAngle, setLightAngle] = useState(GLOBAL_LIGHT_ANGLE)
    const [shadowDistance, setShadowDistance] = useState(18)
    const [shadowSize, setShadowSize] = useState(28)
    const [shadowSpread, setShadowSpread] = useState(10)
    const [shadowOpacity, setShadowOpacity] = useState(38)
    const [shadowColor, setShadowColor] = useState('#0b0d12')
    const [castLength, setCastLength] = useState(55)
    const [castSoftness, setCastSoftness] = useState(50)

    const matteRef = useRef(new WeakMap())

    const syncActive = useCallback(() => {
        const active = canvasEditor?.getActiveObject?.()
        const isImage = active && active.type?.toLowerCase() === 'image'
        const fallback = canvasEditor?.getObjects?.().filter((o) => o.type?.toLowerCase() === 'image')
        setActiveImage(isImage ? active : (fallback?.[fallback.length - 1] || null))
    }, [canvasEditor])

    useEffect(() => {
        if (!canvasEditor) return undefined
        syncActive()
        const events = ['selection:created', 'selection:updated', 'selection:cleared', 'object:added', 'object:removed']
        events.forEach((e) => canvasEditor.on(e, syncActive))
        return () => events.forEach((e) => canvasEditor.off(e, syncActive))
    }, [canvasEditor, syncActive])

    const imageSize = useMemo(() => {
        const el = sourceElementOf(activeImage)
        return {
            width: el?.naturalWidth || el?.width || activeImage?.width || 0,
            height: el?.naturalHeight || el?.height || activeImage?.height || 0,
        }
    }, [activeImage])

    /** Read the stack already on the image so a new effect stacks instead of replacing. */
    const currentStack = useCallback((image) => {
        const mega = image?.filters?.find((f) => f && f.type === 'Megashader')
        const chain = Array.isArray(mega?.stack?.chain) ? mega.stack.chain : []
        return { chain: chain.map((e) => ({ op: e.op, layer: { ...e.layer } })), base: mega?.stack?.base }
    }, [])

    const pushLayers = useCallback((image, layers, label) => {
        const stack = currentStack(image)
        const entries = layers.map((layer, i) => ({ op: stack.chain.length === 0 && i === 0 ? 'replace' : 'add', layer }))
        applyMegashaderFilter(image, { chain: [...stack.chain, ...entries], base: stack.base }, { globalMaskAlpha: 1 })
        canvasEditor?.requestRenderAll()
        canvasEditor?.__pushHistoryState?.({ label, domain: 'focus' })
        canvasEditor?.__saveCanvasState?.()
    }, [canvasEditor, currentStack])

    /** Subject matte, cached per image element. On-device first (SlimSAM), service
     *  second — the same order the Mask tool uses. */
    const getMatte = useCallback(async (image) => {
        const el = sourceElementOf(image)
        if (!el) return null
        const cached = matteRef.current.get(el)
        if (cached) return cached
        const dims = { width: el.naturalWidth || el.width, height: el.naturalHeight || el.height }
        try {
            const { clientSubjectMask } = await import('@/lib/client-ai')
            const mask = await clientSubjectMask(el, dims)
            if (mask) { matteRef.current.set(el, mask); return mask }
        } catch (error) {
            console.warn('[focus] subject mask failed', error)
        }
        return null
    }, [])

    // Sample the colour under the pointer straight from the photo's pixels, in
    // image space — the canvas may be zoomed, panned or the object scaled.
    useEffect(() => {
        if (!canvasEditor || !picking || !activeImage) return undefined
        const el = sourceElementOf(activeImage)
        if (!el) return undefined
        const probe = document.createElement('canvas')
        probe.width = el.naturalWidth || el.width
        probe.height = el.naturalHeight || el.height
        const ctx = probe.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(el, 0, 0)

        const onPick = (opt) => {
            const scene = canvasEditor.getScenePoint(opt.e)
            const local = activeImage.toLocalPoint
                ? activeImage.toLocalPoint(scene, 'left', 'top')
                : { x: scene.x - activeImage.left, y: scene.y - activeImage.top }
            const x = Math.round((local.x / (activeImage.width * activeImage.scaleX)) * probe.width)
            const y = Math.round((local.y / (activeImage.height * activeImage.scaleY)) * probe.height)
            if (x < 0 || y < 0 || x >= probe.width || y >= probe.height) {
                toast.error('Click inside the photo to pick a colour')
                return
            }
            const d = ctx.getImageData(x, y, 1, 1).data
            setPickedColor({ r: d[0] / 255, g: d[1] / 255, b: d[2] / 255 })
            setPickPoint({ x: x / probe.width, y: y / probe.height })
            setPicking(false)
            canvasEditor.defaultCursor = 'default'
            toast.success(`Picked rgb(${d[0]}, ${d[1]}, ${d[2]})`)
        }
        canvasEditor.defaultCursor = 'crosshair'
        canvasEditor.on('mouse:down', onPick)
        return () => {
            canvasEditor.off('mouse:down', onPick)
            canvasEditor.defaultCursor = 'default'
        }
    }, [canvasEditor, picking, activeImage])

    const applyFocus = useCallback(async () => {
        if (!activeImage) return
        setBusy('focus')
        setNote('')
        try {
            if (focusMode === 'dof') {
                const el = sourceElementOf(activeImage)
                let depthCanvas = null
                try {
                    const { checkMaskService } = await import('@/lib/mask-service-client')
                    const health = await checkMaskService()
                    if (health?.available && health?.depth) {
                        const { serviceDepthMap } = await import('@/lib/mask-service-client')
                        depthCanvas = await serviceDepthMap(el).catch(() => null)
                    }
                } catch { /* service absent: the on-device path below is the answer */ }
                const matteCanvas = depthCanvas ? null : await getMatte(activeImage)
                const { layer, source, coverage } = buildDepthOfField(el, {
                    depthCanvas,
                    matteCanvas,
                    focus: focusPlane / 100,
                    aperture: 1,
                    blurPx,
                    shape: aperture,
                    highlightGain: bloom,
                    reach: Math.max(0.05, feather / 100),
                })
                pushLayers(activeImage, [layer], 'Depth of field')
                setNote(source === 'depth' ? 'Depth from the masking service (thin-lens falloff).'
                    : source === 'matte' ? 'Subject matte + distance falloff, computed on device.'
                        : source === 'defocus' ? `Estimated from the photo's own edges (${(coverage * 100).toFixed(1)}% carried an estimate).`
                            : 'No depth evidence found — used a centred focus band.')
            } else {
                const layer = tiltShiftLayer({
                    mode: focusMode === 'tilt-linear' ? 'linear' : 'radial',
                    imageSize,
                    radius: Math.max(0.05, 0.45 - feather / 400),
                    feather: Math.max(0.02, feather / 100),
                    blurPx,
                    shape: aperture,
                    highlightGain: bloom,
                    miniature,
                })
                pushLayers(activeImage, [layer], 'Tilt-shift')
                setNote('Drag the layer in the Mask panel to move the focus band.')
            }
            toast.success('Focus applied')
        } catch (error) {
            console.error('[focus] apply failed', error)
            toast.error(toUserMessage(error, 'Could not apply focus'))
        } finally {
            setBusy(null)
        }
    }, [activeImage, focusMode, imageSize, feather, blurPx, aperture, bloom, miniature, focusPlane, getMatte, pushLayers])

    const applyMotion = useCallback(() => {
        if (!activeImage) return
        pushLayers(activeImage, [motionBlurLayer({
            angle: (motionAngle * Math.PI) / 180,
            length: motionLength / 100,
            blurPx: motionPx,
            spin,
        })], spin ? 'Spin blur' : 'Motion blur')
        toast.success(spin ? 'Spin blur applied' : 'Motion blur applied')
    }, [activeImage, motionAngle, motionLength, motionPx, spin, pushLayers])

    const applyColorPop = useCallback(async () => {
        if (!activeImage) return
        setBusy('pop')
        setNote('')
        try {
            const el = sourceElementOf(activeImage)
            const matteCanvas = popMode === 'subject' ? await getMatte(activeImage) : null
            if (popMode === 'subject' && !matteCanvas) throw new Error('No subject found — try the Mask tool to select it by hand')
            if (popMode === 'color' && !pickedColor) throw new Error('Pick a colour on the photo first')
            const { layer, keptFraction } = buildColorPop({
                imageEl: el,
                matteCanvas,
                target: popMode === 'color' ? pickedColor : null,
                tolerance: tolerance / 100,
                point: pickPoint,
                contiguous,
                keep: keepSat,
                feather: popFeather / 100,
            })
            pushLayers(activeImage, [layer], 'Colour pop')
            setNote(`Kept ${(keptFraction * 100).toFixed(0)}% of the frame in colour at ${keepSat}% surround saturation.`)
            toast.success('Colour pop applied')
        } catch (error) {
            console.error('[focus] colour pop failed', error)
            toast.error(toUserMessage(error, 'Could not apply colour pop'))
        } finally {
            setBusy(null)
        }
    }, [activeImage, popMode, keepSat, popFeather, pickedColor, pickPoint, tolerance, contiguous, getMatte, pushLayers])

    const applyShadow = useCallback(async () => {
        if (!activeImage) return
        setBusy('shadow')
        setNote('')
        try {
            const params = frameShadowParams({
                angle: lightAngle,
                distance: shadowDistance,
                size: shadowSize,
                spread: shadowSpread / 100,
                opacity: shadowOpacity / 100,
                color: shadowColor,
            })
            if (shadowKind === 'frame') {
                activeImage.set({ shadow: new Shadow({ color: params.color, blur: params.blur, offsetX: params.offsetX, offsetY: params.offsetY }) })
                canvasEditor?.requestRenderAll()
                canvasEditor?.__pushHistoryState?.({ label: 'Frame shadow', domain: 'focus' })
                canvasEditor?.__saveCanvasState?.()
                setNote(`Light at ${lightAngle}° → shadow offset ${params.offsetX.toFixed(0)}, ${params.offsetY.toFixed(0)}px.`)
            } else {
                const el = sourceElementOf(activeImage)
                const matteCanvas = await getMatte(activeImage)
                if (!matteCanvas) throw new Error('A cast shadow needs a subject — none was found')
                const guide = imageToLumaPlane(el)
                const raw = matchPlane(canvasToPlane(matteCanvas, 'luma'), guide.width, guide.height)
                const matte = refineMatte(raw, guide, { radius: 6, eps: 1e-3, subsample: 2 })
                const { alpha } = castShadowAlpha(matte, {
                    angle: lightAngle,
                    length: castLength / 100,
                    softness: castSoftness / 100,
                    opacity: shadowOpacity / 100,
                })
                // A cast shadow needs somewhere to fall. On a head-and-shoulders
                // crop the projection lands inside the subject itself, so the
                // effect would silently do nothing — say so instead.
                let visible = 0
                let total = 0
                for (let i = 0; i < alpha.data.length; i += 1) {
                    if (alpha.data[i] <= 0.02) continue
                    total += 1
                    if (matte.data[i] < 0.5) visible += 1
                }
                if (total === 0 || visible / total < 0.15) {
                    throw new Error('No ground for a shadow to fall on — this crop has no space beside the subject. Use “Behind photo”, or a cut-out with room around it.')
                }

                // A shadow object UNDER an opaque photo is invisible — the photo
                // covers it. So an opaque frame gets the shadow composited into
                // it (the subject casts onto its own background), and only a
                // cut-out gets a separate object beneath.
                if (!hasTransparency(el)) {
                    const key = `cast-${Date.now().toString(36)}`
                    setShadowTexture(key, planeToCoverageCanvas(alpha))
                    const rgb = hexToUnit(shadowColor)
                    pushLayers(activeImage, [{
                        ...gradientLayer({ gradientMapKey: key, low: 0, high: 1 }),
                        label: 'Cast shadow',
                        fillMode: 'fill',
                        fillColor: rgb,
                        fillStrength: 1,
                    }], 'Cast shadow')
                    setNote('Cast shadow painted onto the photo — the subject shades its own background.')
                    toast.success('Shadow applied')
                    return
                }
                const shadowCanvas = castShadowCanvas(alpha, { color: shadowColor })
                const shadowImage = new FabricImage(shadowCanvas, {
                    left: activeImage.left,
                    top: activeImage.top,
                    originX: activeImage.originX,
                    originY: activeImage.originY,
                    scaleX: (activeImage.width * activeImage.scaleX) / shadowCanvas.width,
                    scaleY: (activeImage.height * activeImage.scaleY) / shadowCanvas.height,
                    angle: activeImage.angle,
                    selectable: true,
                    evented: true,
                })
                shadowImage.phosmithCastShadow = true
                canvasEditor.add(shadowImage)
                // Behind the subject, or it covers what it is supposed to ground.
                const index = canvasEditor.getObjects().indexOf(activeImage)
                canvasEditor.moveObjectTo?.(shadowImage, Math.max(0, index))
                canvasEditor.requestRenderAll()
                canvasEditor.__pushHistoryState?.({ label: 'Cast shadow', domain: 'focus' })
                canvasEditor.__saveCanvasState?.()
                setNote('Cast shadow added as its own layer — move or scale it to taste.')
            }
            toast.success('Shadow applied')
        } catch (error) {
            console.error('[focus] shadow failed', error)
            toast.error(toUserMessage(error, 'Could not apply the shadow'))
        } finally {
            setBusy(null)
        }
    }, [activeImage, shadowKind, lightAngle, shadowDistance, shadowSize, shadowSpread, shadowOpacity, shadowColor, castLength, castSoftness, canvasEditor, getMatte])

    const clearEffects = useCallback(() => {
        if (!activeImage) return
        applyMegashaderFilter(activeImage, { chain: [] }, {})
        activeImage.set({ shadow: null })
        canvasEditor?.getObjects?.().filter((o) => o.phosmithCastShadow).forEach((o) => canvasEditor.remove(o))
        canvasEditor?.requestRenderAll()
        canvasEditor?.__pushHistoryState?.({ label: 'Cleared focus effects', domain: 'focus' })
        canvasEditor?.__saveCanvasState?.()
        setNote('')
        toast.success('Effects cleared')
    }, [activeImage, canvasEditor])

    if (!activeImage) {
        return (
            <div className="p-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Add or select a photo to use Focus &amp; Light.
            </div>
        )
    }

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            <Section title="Focus" icon={Aperture}>
                <Chips
                    options={[
                        { id: 'tilt-radial', label: 'Radial' },
                        { id: 'tilt-linear', label: 'Band' },
                        { id: 'dof', label: 'Depth' },
                    ]}
                    value={focusMode}
                    onChange={setFocusMode}
                />
                <Slider label="Blur" value={blurPx} min={0} max={120} suffix="px" onChange={setBlurPx} />
                <Slider label={focusMode === 'dof' ? 'Falloff' : 'Feather'} value={feather} min={2} max={100} suffix="%" onChange={setFeather} />
                {focusMode === 'dof' && (
                    <Slider label="Focus plane" value={focusPlane} min={0} max={100} suffix="%" onChange={setFocusPlane} />
                )}
                {focusMode !== 'dof' && (
                    <Slider label="Miniature look" value={miniature} min={0} max={100} suffix="%" onChange={setMiniature} />
                )}
                <div className="space-y-1">
                    <span className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>Aperture</span>
                    <Chips
                        options={[
                            { id: 'disc', label: 'Round', icon: Circle },
                            { id: 'hex', label: 'Hex', icon: Hexagon },
                            { id: 'ring', label: 'Ring', icon: CircleDot },
                        ]}
                        value={aperture}
                        onChange={setAperture}
                    />
                </div>
                <Slider label="Highlight bloom" value={bloom} min={0} max={8} step={0.5} onChange={setBloom} />
                <ApplyButton onClick={applyFocus} busy={busy === 'focus'}>
                    {focusMode === 'dof' ? 'Apply depth of field' : 'Apply tilt-shift'}
                </ApplyButton>
            </Section>

            <Section title="Motion" icon={Wind}>
                <Slider label="Direction" value={motionAngle} min={0} max={180} suffix="°" onChange={setMotionAngle} />
                <Slider label="Length" value={motionLength} min={5} max={100} suffix="%" onChange={setMotionLength} />
                <Slider label="Amount" value={motionPx} min={0} max={160} suffix="px" onChange={setMotionPx} />
                <label className="flex items-center gap-2 text-[10px] editor-interactive" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={spin} onChange={(e) => setSpin(e.target.checked)} className="accent-[var(--accent-primary)]" />
                    Spin instead of straight (rotational blur about the centre)
                </label>
                <ApplyButton onClick={applyMotion}>Apply motion blur</ApplyButton>
            </Section>

            <Section title="Colour pop" icon={Droplet}>
                <Chips
                    options={[{ id: 'subject', label: 'Subject' }, { id: 'color', label: 'Picked colour' }]}
                    value={popMode}
                    onChange={setPopMode}
                    columns={2}
                />
                {popMode === 'color' && (
                    <>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setPicking((v) => !v)}
                                className="flex-1 rounded-lg px-2 py-2 text-[10px] font-semibold editor-interactive"
                                style={{
                                    background: picking ? 'var(--accent-primary)' : 'var(--surface-raised)',
                                    color: picking ? '#ffffff' : 'var(--text-secondary)',
                                    border: '1px solid var(--border-subtle)',
                                }}
                            >
                                {picking ? 'Click the photo…' : pickedColor ? 'Pick again' : 'Pick a colour'}
                            </button>
                            <div
                                className="h-7 w-7 rounded"
                                style={{
                                    background: pickedColor
                                        ? `rgb(${Math.round(pickedColor.r * 255)},${Math.round(pickedColor.g * 255)},${Math.round(pickedColor.b * 255)})`
                                        : 'transparent',
                                    border: '1px solid var(--border-subtle)',
                                }}
                            />
                        </div>
                        <Slider label="Match width" value={tolerance} min={2} max={80} suffix="%" onChange={setTolerance} />
                        <label className="flex items-start gap-2 text-[10px] editor-interactive" style={{ color: 'var(--text-secondary)' }}>
                            <input type="checkbox" checked={contiguous} onChange={(e) => setContiguous(e.target.checked)} className="mt-0.5 accent-[var(--accent-primary)]" />
                            <span>
                                Only where I clicked
                                <span className="block text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                    Off, every matching colour in the frame stays — a red car behind a red jacket included.
                                </span>
                            </span>
                        </label>
                    </>
                )}
                <Slider label="Surround colour left" value={keepSat} min={0} max={60} suffix="%" onChange={setKeepSat} />
                <Slider label="Edge softness" value={popFeather} min={0} max={60} suffix="%" onChange={setPopFeather} />
                <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                    A little colour left in the surround reads better than a dead grey, especially on skin.
                </p>
                <ApplyButton onClick={applyColorPop} busy={busy === 'pop'} disabled={popMode === 'color' && !pickedColor}>
                    {popMode === 'color' ? 'Keep this colour' : 'Keep the subject in colour'}
                </ApplyButton>
            </Section>

            <Section title="Shadow" icon={Sun}>
                <Chips
                    options={[{ id: 'frame', label: 'Behind photo' }, { id: 'cast', label: 'Subject cast' }]}
                    value={shadowKind}
                    onChange={setShadowKind}
                    columns={2}
                />
                <Slider label="Light angle" value={lightAngle} min={0} max={360} suffix="°" onChange={setLightAngle} />
                {shadowKind === 'frame' ? (
                    <>
                        <Slider label="Distance" value={shadowDistance} min={0} max={80} suffix="px" onChange={setShadowDistance} />
                        <Slider label="Size" value={shadowSize} min={0} max={120} suffix="px" onChange={setShadowSize} />
                        <Slider label="Spread" value={shadowSpread} min={0} max={100} suffix="%" onChange={setShadowSpread} />
                    </>
                ) : (
                    <>
                        <Slider label="Length" value={castLength} min={10} max={150} suffix="%" onChange={setCastLength} />
                        <Slider label="Softness" value={castSoftness} min={0} max={100} suffix="%" onChange={setCastSoftness} />
                    </>
                )}
                <Slider label="Opacity" value={shadowOpacity} min={0} max={100} suffix="%" onChange={setShadowOpacity} />
                <div className="flex items-center gap-2">
                    <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>Colour</span>
                    <input
                        type="color"
                        value={shadowColor}
                        onChange={(e) => setShadowColor(e.target.value)}
                        className="h-6 w-10 rounded editor-interactive"
                        style={{ background: 'transparent', border: '1px solid var(--border-subtle)' }}
                    />
                </div>
                <ApplyButton onClick={applyShadow} busy={busy === 'shadow'}>
                    {shadowKind === 'frame' ? 'Apply shadow behind photo' : 'Cast the subject\'s shadow'}
                </ApplyButton>
            </Section>

            <div className="p-4 space-y-2">
                {note && (
                    <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>{note}</p>
                )}
                <button
                    type="button"
                    onClick={clearEffects}
                    className="w-full rounded-lg px-3 py-2 text-[10px] font-semibold editor-interactive"
                    style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
                >
                    Clear focus effects
                </button>
            </div>
        </div>
    )
}
