"use client"

import React, { useEffect, useRef, useState } from "react"
import GlassSlider from "@/components/GlassSlider"
import { useCanvas } from "../../../../../../../context/context"
import { filters } from 'fabric'
import { RotateCcw, SlidersHorizontal } from 'lucide-react'

const TEMP_WARM = "#ffb45f"
const TEMP_COOL = "#72b7ff"

const FILTER_CONFIGS = [
    { group: "Tone", key: "brightness", label: "Brightness", min: -100, max: 100, step: 1, defaultValue: 0, filterClass: filters.Brightness, valueKey: "brightness", toFilterValue: (v) => v / 100, fromFilterValue: (v) => v * 100 },
    { group: "Tone", key: "contrast", label: "Contrast", min: -100, max: 100, step: 1, defaultValue: 0, filterClass: filters.Contrast, valueKey: "contrast", toFilterValue: (v) => v / 100, fromFilterValue: (v) => v * 100 },
    { group: "Tone", key: "gamma", label: "Gamma", min: 20, max: 220, step: 1, defaultValue: 100, filterClass: filters.Gamma, toFilterOptions: (v) => ({ gamma: [v / 100, v / 100, v / 100] }), readValue: (filter) => Array.isArray(filter.gamma) ? (filter.gamma.reduce((sum, next) => sum + next, 0) / filter.gamma.length) * 100 : 100, suffix: "%" },
    { group: "Color", key: "temperature", label: "Temperature", min: -100, max: 100, step: 1, defaultValue: 0, filterClass: filters.BlendColor, matchesFilter: (filter) => filter?.type === "BlendColor" && [TEMP_WARM, TEMP_COOL].includes(String(filter.color).toLowerCase()), toFilterOptions: (v) => ({ color: v >= 0 ? TEMP_WARM : TEMP_COOL, mode: "tint", alpha: Math.abs(v) / 280 }), readValue: (filter) => (String(filter.color).toLowerCase() === TEMP_WARM ? 1 : -1) * Math.round((filter.alpha || 0) * 280) },
    { group: "Color", key: "saturation", label: "Saturation", min: -100, max: 100, step: 1, defaultValue: 0, filterClass: filters.Saturation, valueKey: "saturation", toFilterValue: (v) => v / 100, fromFilterValue: (v) => v * 100 },
    { group: "Color", key: "vibrance", label: "Vibrance", min: -100, max: 100, step: 1, defaultValue: 0, filterClass: filters.Vibrance, valueKey: "vibrance", toFilterValue: (v) => v / 100, fromFilterValue: (v) => v * 100 },
    { group: "Color", key: "hue", label: "Hue", min: -180, max: 180, step: 1, defaultValue: 0, filterClass: filters.HueRotation, valueKey: "rotation", toFilterValue: (v) => v / 180, fromFilterValue: (v) => v * 180, suffix: "º" },
    { group: "Detail", key: "sharpness", label: "Sharpness", min: 0, max: 100, step: 1, defaultValue: 0, filterClass: filters.Convolute, toFilterOptions: (v) => { const a = v / 100; return { opaque: false, matrix: [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0] } }, readValue: (filter) => Array.isArray(filter.matrix) ? Math.round(Math.max(0, -filter.matrix[1] || 0) * 100) : 0 },
    { group: "Detail", key: "blur", label: "Blur", min: 0, max: 100, step: 1, defaultValue: 0, filterClass: filters.Blur, valueKey: "blur", toFilterValue: (v) => v / 100, fromFilterValue: (v) => v * 100 },
    { group: "Detail", key: "noise", label: "Noise", min: 0, max: 100, step: 1, defaultValue: 0, filterClass: filters.Noise, valueKey: "noise", toFilterValue: (v) => v * 6, fromFilterValue: (v) => v / 6 },
    { group: "Detail", key: "pixelate", label: "Pixelate", min: 1, max: 32, step: 1, defaultValue: 1, filterClass: filters.Pixelate, valueKey: "blocksize", toFilterValue: (v) => v, fromFilterValue: (v) => v },
]

const DEFAULT_VALUES = FILTER_CONFIGS.reduce((acc, c) => { acc[c.key] = c.defaultValue; return acc }, {})
const FILTER_GROUPS = ["Tone", "Color", "Detail"]
const getValuesSignature = (v) => FILTER_CONFIGS.map(({ key }) => v[key]).join("|")
const clamp = (v, min, max) => Math.max(min, Math.min(max, v))

const getActiveImage = (canvasEditor) => {
    if (!canvasEditor) return null
    const active = canvasEditor.getActiveObject()
    if (active?.type === "image") return active
    return canvasEditor.getObjects().find((obj) => obj.type === "image") ?? null
}

const getValuesFromImageFilters = (imageObject) => {
    const next = { ...DEFAULT_VALUES }
    for (const f of imageObject?.filters ?? []) {
        const config = FILTER_CONFIGS.find(({ filterClass, matchesFilter }) => matchesFilter ? matchesFilter(f) : filterClass.type === f?.type)
        if (!config) continue
        const raw = config.readValue ? config.readValue(f) : f[config.valueKey]
        if (typeof raw !== "number") continue
        const displayValue = config.readValue ? raw : config.fromFilterValue(raw)
        next[config.key] = clamp(Math.round(displayValue), config.min, config.max)
    }
    return next
}

const buildFabricFilters = (values) =>
    FILTER_CONFIGS.reduce((acc, config) => {
        if (values[config.key] === config.defaultValue) return acc
        const options = config.toFilterOptions
            ? config.toFilterOptions(values[config.key])
            : { [config.valueKey]: config.toFilterValue(values[config.key]) }
        acc.push(new config.filterClass(options))
        return acc
    }, [])

const getPreviewElement = (canvasEditor) => canvasEditor?.lowerCanvasEl ?? canvasEditor?.getElement?.() ?? null

const applyPreviewFilter = (canvasEditor, next, committed) => {
    const el = getPreviewElement(canvasEditor)
    if (!el) return
    const brightness = (1 + next.brightness / 100) / (1 + committed.brightness / 100)
    const contrast = (1 + next.contrast / 100) / (1 + committed.contrast / 100)
    const sat = (1 + next.saturation / 100 + next.vibrance / 200) / (1 + committed.saturation / 100 + committed.vibrance / 200)
    const gamma = (next.gamma || 100) / (committed.gamma || 100)
    const temp = (next.temperature - committed.temperature) / 7
    el.style.willChange = "filter"
    el.style.filter = [
        `brightness(${clamp(brightness * gamma, 0, 3)})`,
        `contrast(${clamp(contrast, 0, 3)})`,
        `saturate(${clamp(sat, 0, 4)})`,
        `hue-rotate(${next.hue - committed.hue + temp}deg)`,
        `blur(${Math.max(0, next.blur - committed.blur) / 8}px)`,
    ].join(" ")
}

const clearPreview = (canvasEditor) => { const el = getPreviewElement(canvasEditor); if (el) { el.style.filter = ""; el.style.willChange = "" } }

const applyFilters = (canvasEditor, values, sigRef, { persist = false } = {}) => {
    if (!canvasEditor) return
    const img = getActiveImage(canvasEditor)
    if (!img) return
    const sig = getValuesSignature(values)
    try {
        if (sig !== sigRef.current) {
            img.filters = buildFabricFilters(values)
            img.applyFilters()
            img.set("dirty", true)
            canvasEditor.requestRenderAll()
            sigRef.current = sig
        }
        if (persist) img.set("dirty", true), canvasEditor.fire("object:modified", { target: img })
    } catch (e) { console.error(e) }
}

const AdjustControls = ({ dominantColor, contrastingColor, lighterColor }) => {
    const { canvasEditor } = useCanvas()
    const [values, setValues] = useState(DEFAULT_VALUES)
    const latestRef = useRef(DEFAULT_VALUES)
    const committedRef = useRef(DEFAULT_VALUES)
    const sigRef = useRef(getValuesSignature(DEFAULT_VALUES))
    const commitTimeout = useRef(null)
    const previewFrame = useRef(null)

    useEffect(() => {
        if (!canvasEditor) return
        const sync = () => {
            const img = getActiveImage(canvasEditor)
            const next = img ? getValuesFromImageFilters(img) : { ...DEFAULT_VALUES }
            clearPreview(canvasEditor)
            if (commitTimeout.current) { clearTimeout(commitTimeout.current); commitTimeout.current = null }
            if (previewFrame.current) { cancelAnimationFrame(previewFrame.current); previewFrame.current = null }
            latestRef.current = next; committedRef.current = next; sigRef.current = getValuesSignature(next)
            setValues((cur) => getValuesSignature(cur) === getValuesSignature(next) ? cur : next)
        }
        sync()
        canvasEditor.on("selection:created", sync)
        canvasEditor.on("selection:updated", sync)
        canvasEditor.on("selection:cleared", sync)
        canvasEditor.on("object:added", sync)
        return () => {
            clearPreview(canvasEditor)
            if (commitTimeout.current) clearTimeout(commitTimeout.current)
            if (previewFrame.current) cancelAnimationFrame(previewFrame.current)
            canvasEditor.off("selection:created", sync)
            canvasEditor.off("selection:updated", sync)
            canvasEditor.off("selection:cleared", sync)
            canvasEditor.off("object:added", sync)
        }
    }, [canvasEditor])

    const handleChange = (key, v) => {
        const val = Array.isArray(v) ? v[0] : v
        const next = { ...latestRef.current, [key]: val }
        if (getValuesSignature(latestRef.current) === getValuesSignature(next)) return
        latestRef.current = next
        if (commitTimeout.current) clearTimeout(commitTimeout.current)
        if (previewFrame.current) cancelAnimationFrame(previewFrame.current)
        setValues(next)
        previewFrame.current = requestAnimationFrame(() => {
            previewFrame.current = null
            applyPreviewFilter(canvasEditor, next, committedRef.current)
        })
        commitTimeout.current = setTimeout(() => {
            commitTimeout.current = null
            applyFilters(canvasEditor, next, sigRef, { persist: true })
            committedRef.current = next
            clearPreview(canvasEditor)
        }, 260)
    }

    const reset = () => {
        const next = { ...DEFAULT_VALUES }
        latestRef.current = next; if (commitTimeout.current) { clearTimeout(commitTimeout.current); commitTimeout.current = null }
        if (previewFrame.current) { cancelAnimationFrame(previewFrame.current); previewFrame.current = null }
        setValues(next); applyFilters(canvasEditor, next, sigRef, { persist: true })
        committedRef.current = next; clearPreview(canvasEditor)
    }

    if (!canvasEditor) return <div className='p-4'><p className='text-xs' style={{ color: 'var(--text-muted)' }}>Load an image to adjust</p></div>

    return (
        <div className='adjust-panel'>
            <div className='adjust-panel-header'>
                <div className="flex items-center gap-2">
                    <SlidersHorizontal className="h-4 w-4" />
                    <span>Adjustments</span>
                </div>
                <button 
                    type="button" 
                    onClick={reset} 
                    className="adjust-reset-button"
                    style={{
                        borderColor: dominantColor || 'rgba(255,255,255,0.18)',
                        color: contrastingColor || '#E6ECF5',
                    }}
                >
                    <RotateCcw className='h-3.5 w-3.5' /> Reset
                </button>
            </div>

            <div className='space-y-4 p-3'>
                {FILTER_GROUPS.map((group) => (
                    <section key={group} className="adjust-section">
                        <div className="adjust-section-title">{group}</div>
                        <div className="space-y-3">
                            {FILTER_CONFIGS.filter((cfg) => cfg.group === group).map(cfg => (
                                <GlassSlider
                                    key={cfg.key}
                                    label={cfg.label}
                                    value={values[cfg.key]}
                                    onChange={(v) => handleChange(cfg.key, v)}
                                    min={cfg.min}
                                    max={cfg.max}
                                    step={cfg.step}
                                    unit={cfg.suffix || ""}
                                    showValue
                                />
                            ))}
                        </div>
                    </section>
                ))}
            </div>
        </div>
    )
}

export default AdjustControls
