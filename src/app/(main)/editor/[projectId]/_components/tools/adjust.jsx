"use client"

import React, { useEffect, useRef, useState } from "react"
import Colorful from "@uiw/react-color-colorful"
import { toast } from "sonner"
import { filters, Gradient, Rect } from "fabric"
import { RotateCcw, SlidersHorizontal, Sparkles, WandSparkles } from "lucide-react"
import { ProRulerSlider } from "@/components/editor/ProRulerSlider"
import { useCanvas } from "../../../../../../../context/context"
import {
    buildImageKitTransformUrl,
    isImageKitUrl,
    waitForImageKitUrl,
} from "../../../../../../lib/imagekit-ai"

const TEMP_WARM = "#ffb45f"
const TEMP_COOL = "#72b7ff"
const VIGNETTE_LAYER_NAME = "pixxel-vignette-overlay"

const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
const stripHex = (hex) => String(hex || "000000").replace("#", "").slice(0, 6).padEnd(6, "0")
const signedToken = (value) => (value < 0 ? `N${Math.abs(value)}` : `${value}`)
const imageKitOpacity = (opacity) => Math.round(clamp(opacity, 0, 100) * 0.99)
    .toString(10)
    .padStart(2, "0")

const isSharpnessFilter = (filter) => {
    if (filter?.type !== filters.Convolute.type || !Array.isArray(filter.matrix) || filter.matrix.length !== 9) return false
    const matrix = filter.matrix.map(Number)
    const edge = -matrix[1]
    return (
        edge >= 0 &&
        Math.abs(matrix[0]) < 0.001 &&
        Math.abs(matrix[2]) < 0.001 &&
        Math.abs(matrix[6]) < 0.001 &&
        Math.abs(matrix[8]) < 0.001 &&
        Math.abs(matrix[1] - matrix[3]) < 0.001 &&
        Math.abs(matrix[1] - matrix[5]) < 0.001 &&
        Math.abs(matrix[1] - matrix[7]) < 0.001 &&
        Math.abs(matrix[4] - (1 + 4 * edge)) < 0.01
    )
}

const SLIDER_CONFIGS = [
    { group: "Tone", key: "exposure", label: "Exposure", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "brightness", label: "Brightness", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "contrast", label: "Contrast", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "highlights", label: "Highlights", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "shadows", label: "Shadows", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "whites", label: "Whites", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "blacks", label: "Blacks", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "gamma", label: "Gamma", min: 20, max: 220, step: 1, defaultValue: 100, suffix: "%" },
    { group: "Tone", key: "fade", label: "Fade", min: 0, max: 100, step: 1, defaultValue: 0 },

    { group: "Color", key: "temperature", label: "Temperature", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Color", key: "tint", label: "Tint", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Color", key: "saturation", label: "Saturation", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Color", key: "vibrance", label: "Vibrance", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Color", key: "hue", label: "Hue", min: -180, max: 180, step: 1, defaultValue: 0, suffix: "º" },
    { group: "Color", key: "red", label: "Red", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Color", key: "green", label: "Green", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Color", key: "blue", label: "Blue", min: -100, max: 100, step: 1, defaultValue: 0 },

    { group: "Detail", key: "clarity", label: "Clarity", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Detail", key: "sharpness", label: "Sharpness", min: 0, max: 100, step: 1, defaultValue: 0 },
    { group: "Detail", key: "blur", label: "Blur", min: 0, max: 100, step: 1, defaultValue: 0 },
    { group: "Detail", key: "noise", label: "Noise", min: 0, max: 100, step: 1, defaultValue: 0 },
    { group: "Detail", key: "grain", label: "Grain", min: 0, max: 100, step: 1, defaultValue: 0 },
    { group: "Detail", key: "pixelate", label: "Pixelate", min: 1, max: 32, step: 1, defaultValue: 1 },
    { group: "Detail", key: "mono", label: "B&W Mix", min: 0, max: 100, step: 1, defaultValue: 0 },
    { group: "Detail", key: "vignette", label: "Vignette", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Detail", key: "vignetteSize", label: "Vignette Size", min: 20, max: 95, step: 1, defaultValue: 62, suffix: "%" },
    { group: "Detail", key: "vignetteFeather", label: "Feather", min: 0, max: 100, step: 1, defaultValue: 70, suffix: "%" },
]

const WHEEL_CONFIGS = [
    { key: "shadowTone", colorKey: "shadowColor", label: "Shadows", defaultColor: "#2342ff", mode: "multiply" },
    { key: "midtoneTone", colorKey: "midtoneColor", label: "Midtones", defaultColor: "#00c2a8", mode: "overlay" },
    { key: "highlightTone", colorKey: "highlightColor", label: "Highlights", defaultColor: "#ffd76d", mode: "screen" },
    { key: "colorizeIntensity", colorKey: "colorizeColor", label: "Colorize", defaultColor: "#ff3f7f", mode: "tint" },
]

const LOOKS = [
    { id: "none", label: "Clean", filterClass: null },
    { id: "vintage", label: "Vintage", filterClass: filters.Vintage },
    { id: "kodachrome", label: "Kodachrome", filterClass: filters.Kodachrome },
    { id: "technicolor", label: "Technicolor", filterClass: filters.Technicolor },
    { id: "polaroid", label: "Polaroid", filterClass: filters.Polaroid },
    { id: "brownie", label: "Brownie", filterClass: filters.Brownie },
    { id: "sepia", label: "Sepia", filterClass: filters.Sepia },
    { id: "blackwhite", label: "B&W", filterClass: filters.BlackWhite },
]

const DEFAULT_VALUES = {
    ...SLIDER_CONFIGS.reduce((acc, c) => {
        acc[c.key] = c.defaultValue
        return acc
    }, {}),
    ...WHEEL_CONFIGS.reduce((acc, c) => {
        acc[c.key] = 0
        acc[c.colorKey] = c.defaultColor
        return acc
    }, {}),
    look: "none",
}

const IMAGEKIT_DEFAULTS = {
    autoContrast: false,
    retouch: false,
    upscale: false,
    grayscale: false,
    sharpen: 0,
    usm: 0,
    urlBlur: 0,
    colorize: 0,
    colorizeColor: "#FF3F7F",
    shadow: false,
    shadowBlur: 10,
    shadowSaturation: 30,
    shadowX: 2,
    shadowY: 2,
    gradient: false,
    gradientAngle: 45,
    gradientFrom: "#000000",
    gradientTo: "#FFFFFF",
    gradientOpacity: 0,
}

const FILTER_GROUPS = ["Tone", "Color", "Wheels", "Detail", "ImageKit"]
const ALL_VALUE_KEYS = new Set([...Object.keys(DEFAULT_VALUES)])
const getValuesSignature = (v) => JSON.stringify(v)

const getActiveImage = (canvasEditor) => {
    if (!canvasEditor) return null
    const active = canvasEditor.getActiveObject()
    if (active?.type === "image") return active
    return canvasEditor.getObjects().find((obj) => obj.type === "image") ?? null
}

const getImageSrc = (image) =>
    image?.getSrc?.() ||
    image?._originalElement?.src ||
    image?._element?.src ||
    image?.src ||
    ""

const normalizeStoredValues = (values) => {
    const next = { ...DEFAULT_VALUES, ...(values || {}) }
    for (const config of SLIDER_CONFIGS) {
        next[config.key] = clamp(Number(next[config.key] ?? config.defaultValue), config.min, config.max)
    }
    for (const config of WHEEL_CONFIGS) {
        next[config.key] = clamp(Number(next[config.key] ?? 0), 0, 100)
        next[config.colorKey] = String(next[config.colorKey] || config.defaultColor)
    }
    next.look = LOOKS.some((look) => look.id === next.look) ? next.look : "none"
    return next
}

const filterMatchesManagedKey = (filter) =>
    filter?._pixxelAdjustmentManaged === true ||
    ALL_VALUE_KEYS.has(filter?._pixxelAdjustmentKey) ||
    filter?._pixxelAgentFilter === true ||
    [
        filters.Brightness.type,
        filters.Contrast.type,
        filters.Gamma.type,
        filters.BlendColor.type,
        filters.Saturation.type,
        filters.Vibrance.type,
        filters.HueRotation.type,
        filters.Convolute.type,
        filters.Blur.type,
        filters.Noise.type,
        filters.Pixelate.type,
        filters.ColorMatrix.type,
        filters.Vintage.type,
        filters.Kodachrome.type,
        filters.Technicolor.type,
        filters.Polaroid.type,
        filters.Brownie.type,
        filters.Sepia.type,
        filters.BlackWhite.type,
    ].includes(filter?.type)

const getValuesFromImageFilters = (imageObject) => {
    const stored = imageObject?.pixxelAdjustValues || imageObject?._pixxelAdjustValues
    if (stored) return normalizeStoredValues(stored)

    const next = { ...DEFAULT_VALUES }
    for (const f of imageObject?.filters ?? []) {
        if (f?.type === filters.Brightness.type && typeof f.brightness === "number") next.brightness = clamp(Math.round(f.brightness * 100), -100, 100)
        if (f?.type === filters.Contrast.type && typeof f.contrast === "number") next.contrast = clamp(Math.round(f.contrast * 100), -100, 100)
        if (f?.type === filters.Gamma.type && Array.isArray(f.gamma)) next.gamma = clamp(Math.round((f.gamma.reduce((sum, n) => sum + n, 0) / f.gamma.length) * 100), 20, 220)
        if (f?.type === filters.Saturation.type && typeof f.saturation === "number") next.saturation = clamp(Math.round(f.saturation * 100), -100, 100)
        if (f?.type === filters.Vibrance.type && typeof f.vibrance === "number") next.vibrance = clamp(Math.round(f.vibrance * 100), -100, 100)
        if (f?.type === filters.HueRotation.type && typeof f.rotation === "number") next.hue = clamp(Math.round(f.rotation * 180), -180, 180)
        if (f?.type === filters.Blur.type && typeof f.blur === "number") next.blur = clamp(Math.round(f.blur * 100), 0, 100)
        if (f?.type === filters.Noise.type && typeof f.noise === "number") next.noise = clamp(Math.round(f.noise / 6), 0, 100)
        if (f?.type === filters.Pixelate.type && typeof f.blocksize === "number") next.pixelate = clamp(Math.round(f.blocksize), 1, 32)
        if (isSharpnessFilter(f)) next.sharpness = clamp(Math.round(Math.max(0, -f.matrix[1]) * 100), 0, 100)
    }
    return next
}

const markFilter = (filter, key) => {
    filter._pixxelAdjustmentManaged = true
    filter._pixxelAdjustmentKey = key
    return filter
}

const buildChannelMatrix = (values) => {
    const r = 1 + Number(values.red || 0) / 115
    const g = 1 + Number(values.green || 0) / 115
    const b = 1 + Number(values.blue || 0) / 115
    const exposure = Number(values.exposure || 0) / 260
    const whites = Number(values.whites || 0) / 420
    const blacks = -Number(values.blacks || 0) / 520
    const fade = Number(values.fade || 0) / 520
    const offset = exposure + whites + blacks + fade
    const active =
        Math.abs(r - 1) > 0.001 ||
        Math.abs(g - 1) > 0.001 ||
        Math.abs(b - 1) > 0.001 ||
        Math.abs(offset) > 0.001

    if (!active) return null
    return [
        r, 0, 0, 0, offset,
        0, g, 0, 0, offset,
        0, 0, b, 0, offset,
        0, 0, 0, 1, 0,
    ]
}

const grayscaleMatrix = (amount) => {
    const a = clamp(amount, 0, 100) / 100
    const inv = 1 - a
    return [
        inv + 0.2126 * a, 0.7152 * a, 0.0722 * a, 0, 0,
        0.2126 * a, inv + 0.7152 * a, 0.0722 * a, 0, 0,
        0.2126 * a, 0.7152 * a, inv + 0.0722 * a, 0, 0,
        0, 0, 0, 1, 0,
    ]
}

const buildConvolution = (amount) => {
    const a = Math.abs(amount) / 100
    if (a <= 0) return null
    if (amount < 0) {
        return [a / 9, a / 9, a / 9, a / 9, 1 - (8 * a) / 9, a / 9, a / 9, a / 9, a / 9]
    }
    return [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0]
}

const addBlend = (acc, key, color, mode, alpha) => {
    if (alpha <= 0) return
    acc.push(markFilter(new filters.BlendColor({ color, mode, alpha: clamp(alpha, 0, 1) }), key))
}

const buildFabricFilters = (values) => {
    const next = []
    const look = LOOKS.find((item) => item.id === values.look)

    if (look?.filterClass) next.push(markFilter(new look.filterClass(), "look"))
    if (values.brightness) next.push(markFilter(new filters.Brightness({ brightness: values.brightness / 100 }), "brightness"))
    if (values.contrast) next.push(markFilter(new filters.Contrast({ contrast: values.contrast / 100 }), "contrast"))
    if (values.gamma !== 100) next.push(markFilter(new filters.Gamma({ gamma: [values.gamma / 100, values.gamma / 100, values.gamma / 100] }), "gamma"))
    if (values.temperature) addBlend(next, "temperature", values.temperature >= 0 ? TEMP_WARM : TEMP_COOL, "tint", Math.abs(values.temperature) / 280)
    if (values.tint) addBlend(next, "tint", values.tint >= 0 ? "#e879f9" : "#46d68c", "tint", Math.abs(values.tint) / 320)
    if (values.saturation) next.push(markFilter(new filters.Saturation({ saturation: values.saturation / 100 }), "saturation"))
    if (values.vibrance) next.push(markFilter(new filters.Vibrance({ vibrance: values.vibrance / 100 }), "vibrance"))
    if (values.hue) next.push(markFilter(new filters.HueRotation({ rotation: values.hue / 180 }), "hue"))

    const channelMatrix = buildChannelMatrix(values)
    if (channelMatrix) next.push(markFilter(new filters.ColorMatrix({ matrix: channelMatrix }), "rgb-mixer"))

    if (values.highlights > 0) addBlend(next, "highlights", "#ffffff", "screen", values.highlights / 260)
    if (values.highlights < 0) addBlend(next, "highlights", "#1b1b1b", "multiply", Math.abs(values.highlights) / 320)
    if (values.shadows > 0) addBlend(next, "shadows", "#cdd8ff", "screen", values.shadows / 360)
    if (values.shadows < 0) addBlend(next, "shadows", "#050505", "multiply", Math.abs(values.shadows) / 260)
    if (values.whites > 0) addBlend(next, "whites", "#ffffff", "screen", values.whites / 340)
    if (values.blacks > 0) addBlend(next, "blacks", "#000000", "multiply", values.blacks / 300)

    for (const wheel of WHEEL_CONFIGS) {
        const amount = Number(values[wheel.key] || 0)
        if (amount > 0) addBlend(next, wheel.key, values[wheel.colorKey], wheel.mode, amount / (wheel.mode === "tint" ? 120 : 260))
    }

    const clarityMatrix = buildConvolution(values.clarity)
    if (clarityMatrix) next.push(markFilter(new filters.Convolute({ opaque: false, matrix: clarityMatrix }), "clarity"))
    if (values.sharpness) {
        const a = values.sharpness / 100
        next.push(markFilter(new filters.Convolute({ opaque: false, matrix: [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0] }), "sharpness"))
    }
    if (values.blur) next.push(markFilter(new filters.Blur({ blur: values.blur / 100 }), "blur"))
    if (values.noise) next.push(markFilter(new filters.Noise({ noise: values.noise * 6 }), "noise"))
    if (values.grain) next.push(markFilter(new filters.Noise({ noise: values.grain * 4 }), "grain"))
    if (values.pixelate !== 1) next.push(markFilter(new filters.Pixelate({ blocksize: values.pixelate }), "pixelate"))
    if (values.mono) next.push(markFilter(new filters.ColorMatrix({ matrix: grayscaleMatrix(values.mono) }), "mono"))

    return next
}

const removeVignetteLayers = (canvasEditor) => {
    const objects = canvasEditor?.getObjects?.() || []
    const layers = objects.filter((obj) =>
        obj?.name === VIGNETTE_LAYER_NAME ||
        obj?.pixxelAdjustmentOverlay === "vignette" ||
        obj?._pixxelAdjustmentOverlay === "vignette"
    )
    layers.forEach((layer) => canvasEditor.remove(layer))
    return layers.length
}

const applyVignetteLayer = (canvasEditor, imageObject, values) => {
    if (!canvasEditor || !imageObject) return
    const amount = Number(values.vignette || 0)
    if (!amount) {
        removeVignetteLayers(canvasEditor)
        return
    }

    removeVignetteLayers(canvasEditor)

    const bounds = imageObject.getBoundingRect()
    const width = Math.max(1, bounds.width)
    const height = Math.max(1, bounds.height)
    const radius = Math.max(width, height) * (clamp(values.vignetteSize, 20, 95) / 100)
    const alpha = Math.min(0.82, Math.abs(amount) / 125)
    const edgeColor = amount > 0 ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha * 0.55})`
    const feather = clamp(values.vignetteFeather, 0, 100) / 100
    const clearStop = Math.max(0.05, Math.min(0.86, 1 - feather * 0.72))

    const vignette = new Rect({
        left: bounds.left,
        top: bounds.top,
        width,
        height,
        originX: "left",
        originY: "top",
        fill: new Gradient({
            type: "radial",
            gradientUnits: "pixels",
            coords: {
                x1: width / 2,
                y1: height / 2,
                r1: radius * clearStop,
                x2: width / 2,
                y2: height / 2,
                r2: radius,
            },
            colorStops: [
                { offset: 0, color: "rgba(0,0,0,0)" },
                { offset: 0.72, color: "rgba(0,0,0,0)" },
                { offset: 1, color: edgeColor },
            ],
        }),
        selectable: false,
        evented: false,
        hasControls: false,
        hasBorders: false,
        objectCaching: false,
        name: VIGNETTE_LAYER_NAME,
        pixxelAdjustmentOverlay: "vignette",
        _pixxelAdjustmentOverlay: "vignette",
    })

    canvasEditor.add(vignette)
    const imageIndex = canvasEditor.getObjects().indexOf(imageObject)
    if (imageIndex >= 0 && typeof canvasEditor.moveObjectTo === "function") {
        canvasEditor.moveObjectTo(vignette, imageIndex + 1)
    }
    canvasEditor.setActiveObject(imageObject)
}

const applyAdjustmentFilters = (canvasEditor, values, sigRef, { commit = false } = {}) => {
    if (!canvasEditor) return
    const img = getActiveImage(canvasEditor)
    if (!img) return
    const normalized = normalizeStoredValues(values)
    const sig = getValuesSignature(normalized)
    const currentFilters = img.filters ?? []
    const preservedFilters = currentFilters.filter((filter) => !filterMatchesManagedKey(filter))
    const managedFilters = buildFabricFilters(normalized)

    try {
        img.filters = [...preservedFilters, ...managedFilters]
        img.pixxelAdjustValues = normalized
        img._pixxelAdjustValues = normalized
        img.applyFilters()
        img.set("dirty", true)
        applyVignetteLayer(canvasEditor, img, normalized)
        canvasEditor.requestRenderAll()
        sigRef.current = sig
        if (commit) canvasEditor.fire("object:modified", { target: img })
    } catch (e) {
        console.error(e)
    }
}

const FILTER_VISUAL = {
    exposure: { fill: "rgba(104, 92, 62, 0.5)", accent: "#ffe39a", trackBg: "rgba(20, 18, 13, 0.98)" },
    brightness: { fill: "rgba(42, 58, 82, 0.5)", accent: "#d2dae6", trackBg: "rgba(20, 24, 32, 0.98)" },
    contrast: { fill: "rgba(38, 44, 56, 0.52)", accent: "#e4eaf2", trackBg: "rgba(18, 20, 28, 0.98)" },
    highlights: { fill: "rgba(102, 94, 64, 0.5)", accent: "#f6d36b", trackBg: "rgba(22, 20, 14, 0.98)" },
    shadows: { fill: "rgba(46, 58, 86, 0.5)", accent: "#92b7ff", trackBg: "rgba(13, 16, 24, 0.98)" },
    whites: { fill: "rgba(215, 220, 230, 0.32)", accent: "#f8fafc", trackBg: "rgba(21, 24, 30, 0.98)" },
    blacks: { fill: "rgba(16, 18, 24, 0.78)", accent: "#8b95a6", trackBg: "rgba(8, 9, 12, 0.98)" },
    gamma: { fill: "rgba(58, 48, 88, 0.5)", accent: "#b8a6f0", trackBg: "rgba(18, 16, 26, 0.98)" },
    fade: { fill: "rgba(82, 76, 68, 0.46)", accent: "#d2c1aa", trackBg: "rgba(18, 16, 14, 0.98)" },
    temperature: { fill: "rgba(118, 108, 72, 0.52)", accent: "#ebc94a", trackBg: "rgba(22, 24, 18, 0.98)", bottomAccent: "linear-gradient(90deg, #3a8fd4 0%, #e8c04a 100%)" },
    tint: { fill: "rgba(80, 54, 92, 0.5)", accent: "#d58cff", trackBg: "rgba(18, 14, 22, 0.98)", bottomAccent: "linear-gradient(90deg, #45d483 0%, #d879f7 100%)" },
    saturation: { fill: "rgba(92, 48, 62, 0.5)", accent: "#f07878", trackBg: "rgba(20, 16, 18, 0.98)" },
    vibrance: { fill: "rgba(40, 88, 78, 0.5)", accent: "#5ec9b0", trackBg: "rgba(14, 20, 20, 0.98)" },
    hue: { fill: "rgba(88, 82, 48, 0.48)", accent: "#a8e070", trackBg: "rgba(18, 18, 16, 0.98)", bottomAccent: "linear-gradient(90deg, #ff4b4b, #ffd84b, #65e56e, #4bdcff, #6a63ff, #ff4bf2)" },
    red: { fill: "rgba(128, 44, 54, 0.5)", accent: "#ff5d65", trackBg: "rgba(22, 12, 14, 0.98)" },
    green: { fill: "rgba(44, 98, 64, 0.5)", accent: "#64d989", trackBg: "rgba(12, 20, 15, 0.98)" },
    blue: { fill: "rgba(42, 64, 112, 0.5)", accent: "#69a7ff", trackBg: "rgba(12, 16, 24, 0.98)" },
    clarity: { fill: "rgba(45, 62, 72, 0.5)", accent: "#9bd5df", trackBg: "rgba(12, 18, 21, 0.98)" },
    sharpness: { fill: "rgba(38, 62, 88, 0.5)", accent: "#9fc8e8", trackBg: "rgba(14, 18, 24, 0.98)" },
    blur: { fill: "rgba(32, 58, 82, 0.5)", accent: "#7eb8dc", trackBg: "rgba(12, 16, 22, 0.98)" },
    noise: { fill: "rgba(58, 62, 72, 0.5)", accent: "#c8ced8", trackBg: "rgba(16, 17, 20, 0.98)" },
    grain: { fill: "rgba(72, 66, 56, 0.48)", accent: "#c9b89a", trackBg: "rgba(18, 16, 13, 0.98)" },
    pixelate: { fill: "rgba(38, 72, 58, 0.5)", accent: "#8ccfb1", trackBg: "rgba(14, 20, 18, 0.98)" },
    mono: { fill: "rgba(76, 82, 92, 0.48)", accent: "#e5e7eb", trackBg: "rgba(15, 17, 20, 0.98)" },
    vignette: { fill: "rgba(10, 10, 12, 0.74)", accent: "#d4d4d8", trackBg: "rgba(7, 7, 9, 0.98)" },
    vignetteSize: { fill: "rgba(52, 58, 68, 0.5)", accent: "#a9b3c4", trackBg: "rgba(13, 14, 17, 0.98)" },
    vignetteFeather: { fill: "rgba(68, 58, 72, 0.5)", accent: "#d0b8da", trackBg: "rgba(16, 13, 18, 0.98)" },
}

const ColorWheelCard = ({ config, values, onColor, onAmount }) => (
    <div className="adjust-color-wheel-card">
        <div className="adjust-color-wheel-top">
            <div>
                <span>{config.label}</span>
                <strong>{values[config.key]}</strong>
            </div>
            <span className="adjust-color-chip" style={{ background: values[config.colorKey] }} />
        </div>
        <Colorful
            color={values[config.colorKey]}
            disableAlpha
            className="adjust-colorful"
            onChange={(color) => onColor(config.colorKey, color.hex)}
        />
        <ProRulerSlider
            variant="instrument"
            value={values[config.key]}
            onPreview={(v) => onAmount(config.key, v, false)}
            onCommit={(v) => onAmount(config.key, v, true)}
            min={0}
            max={100}
            step={1}
            label="Strength"
            visual={{ fill: "rgba(60, 72, 86, 0.48)", accent: values[config.colorKey], trackBg: "rgba(14, 16, 20, 0.98)" }}
        />
    </div>
)

const buildImageKitTokens = (values) => {
    const tokens = []
    if (values.autoContrast) tokens.push("e-contrast")
    if (values.retouch) tokens.push("e-retouch")
    if (values.upscale) tokens.push("e-upscale")
    if (values.grayscale) tokens.push("e-grayscale")
    if (values.sharpen > 0) tokens.push(`e-sharpen-${values.sharpen}`)
    if (values.usm > 0) tokens.push(`e-usm-2-2-${(values.usm / 100).toFixed(2)}-0.02`)
    if (values.urlBlur > 0) tokens.push(`bl-${values.urlBlur}`)
    if (values.colorize > 0) tokens.push(`e-colorize-co-${stripHex(values.colorizeColor)}_in-${values.colorize}`)
    if (values.shadow) {
        tokens.push(`e-shadow-bl-${values.shadowBlur}_st-${values.shadowSaturation}_x-${signedToken(values.shadowX)}_y-${signedToken(values.shadowY)}`)
    }
    if (values.gradient && values.gradientOpacity > 0) {
        const alpha = imageKitOpacity(values.gradientOpacity)
        tokens.push(`e-gradient-ld-${values.gradientAngle}_from-${stripHex(values.gradientFrom)}${alpha}_to-${stripHex(values.gradientTo)}${alpha}_sp-0.5`)
    }
    return tokens
}

const ImageKitPanel = ({ imageKitValues, setImageKitValues, onApply, isApplying }) => {
    const tokens = buildImageKitTokens(imageKitValues)
    const setValue = (key, value) => setImageKitValues((prev) => ({ ...prev, [key]: value }))
    const toggle = (key) => setValue(key, !imageKitValues[key])

    return (
        <div className="adjust-imagekit-panel">
            <div className="adjust-toggle-grid">
                {[
                    ["autoContrast", "Auto contrast"],
                    ["retouch", "AI retouch"],
                    ["upscale", "AI upscale"],
                    ["grayscale", "Grayscale"],
                    ["shadow", "Shadow"],
                    ["gradient", "Gradient"],
                ].map(([key, label]) => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => toggle(key)}
                        className={`adjust-toggle ${imageKitValues[key] ? "is-on" : ""}`}
                    >
                        <span />
                        {label}
                    </button>
                ))}
            </div>

            {[
                { key: "sharpen", label: "URL Sharpen", min: 0, max: 100 },
                { key: "usm", label: "Unsharp Mask", min: 0, max: 100 },
                { key: "urlBlur", label: "URL Blur", min: 0, max: 100 },
                { key: "colorize", label: "Colorize", min: 0, max: 100 },
                { key: "shadowBlur", label: "Shadow Blur", min: 0, max: 15 },
                { key: "shadowSaturation", label: "Shadow Sat", min: 0, max: 100 },
                { key: "shadowX", label: "Shadow X", min: -100, max: 100 },
                { key: "shadowY", label: "Shadow Y", min: -100, max: 100 },
                { key: "gradientAngle", label: "Gradient Angle", min: 0, max: 359, suffix: "º" },
                { key: "gradientOpacity", label: "Gradient Opacity", min: 0, max: 100 },
            ].map((config) => (
                <ProRulerSlider
                    key={config.key}
                    variant="instrument"
                    value={imageKitValues[config.key]}
                    onCommit={(v) => setValue(config.key, v)}
                    min={config.min}
                    max={config.max}
                    step={1}
                    label={config.label}
                    suffix={config.suffix || ""}
                    visual={FILTER_VISUAL.sharpness}
                />
            ))}

            <div className="adjust-mini-color-grid">
                {[
                    ["colorizeColor", "Colorize"],
                    ["gradientFrom", "Gradient A"],
                    ["gradientTo", "Gradient B"],
                ].map(([key, label]) => (
                    <label key={key} className="adjust-rgb-field">
                        <span>{label}</span>
                        <input type="color" value={imageKitValues[key]} onChange={(event) => setValue(key, event.target.value)} />
                    </label>
                ))}
            </div>

            <div className="adjust-token-preview">
                <span>URL chain</span>
                <code>{tokens.length ? tokens.join(",") : "No ImageKit URL transforms selected"}</code>
            </div>

            <button type="button" className="adjust-apply-imagekit" onClick={onApply} disabled={isApplying || tokens.length === 0}>
                {isApplying ? <Sparkles className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}
                {isApplying ? "Applying..." : "Apply ImageKit URL transforms"}
            </button>
        </div>
    )
}

const AdjustControls = () => {
    const { canvasEditor, setProcessingMessage } = useCanvas()
    const [activeTab, setActiveTab] = useState("Tone")
    const [values, setValues] = useState(DEFAULT_VALUES)
    const [imageKitValues, setImageKitValues] = useState(IMAGEKIT_DEFAULTS)
    const [isApplyingImageKit, setIsApplyingImageKit] = useState(false)
    const latestRef = useRef(DEFAULT_VALUES)
    const sigRef = useRef(getValuesSignature(DEFAULT_VALUES))
    const committedSigRef = useRef(getValuesSignature(DEFAULT_VALUES))
    const previewFrame = useRef(null)
    const pendingPreviewRef = useRef(null)
    const isInteractingRef = useRef(false)

    useEffect(() => {
        if (!canvasEditor) return
        const sync = () => {
            if (isInteractingRef.current) return
            const img = getActiveImage(canvasEditor)
            const next = img ? getValuesFromImageFilters(img) : { ...DEFAULT_VALUES }
            pendingPreviewRef.current = null
            if (previewFrame.current) {
                cancelAnimationFrame(previewFrame.current)
                previewFrame.current = null
            }
            latestRef.current = next
            sigRef.current = getValuesSignature(next)
            committedSigRef.current = getValuesSignature(next)
            setValues((cur) => (getValuesSignature(cur) === getValuesSignature(next) ? cur : next))
        }
        sync()
        canvasEditor.on("selection:created", sync)
        canvasEditor.on("selection:updated", sync)
        canvasEditor.on("selection:cleared", sync)
        canvasEditor.on("object:added", sync)
        return () => {
            pendingPreviewRef.current = null
            if (previewFrame.current) cancelAnimationFrame(previewFrame.current)
            canvasEditor.off("selection:created", sync)
            canvasEditor.off("selection:updated", sync)
            canvasEditor.off("selection:cleared", sync)
            canvasEditor.off("object:added", sync)
        }
    }, [canvasEditor])

    const handleBeginChange = () => {
        isInteractingRef.current = true
    }

    const applyNextValues = (next, { commit = false, updateState = false } = {}) => {
        latestRef.current = next
        if (updateState) setValues(next)
        const nextSig = getValuesSignature(next)
        applyAdjustmentFilters(canvasEditor, next, sigRef, { commit: commit && nextSig !== committedSigRef.current })
        if (commit) {
            committedSigRef.current = nextSig
            isInteractingRef.current = false
        }
    }

    const handlePreviewChange = (key, v) => {
        const val = Array.isArray(v) ? v[0] : v
        const prev = latestRef.current
        if (prev[key] === val) return
        applyNextValues({ ...prev, [key]: val })
    }

    const handleCommitChange = (key, v) => {
        const val = Array.isArray(v) ? v[0] : v
        if (previewFrame.current) {
            cancelAnimationFrame(previewFrame.current)
            previewFrame.current = null
        }
        pendingPreviewRef.current = null
        applyNextValues({ ...latestRef.current, [key]: val }, { commit: true, updateState: true })
    }

    const handleColorChange = (key, color) => {
        const next = { ...latestRef.current, [key]: color }
        applyNextValues(next, { commit: true, updateState: true })
    }

    const handleWheelAmount = (key, v, commit) => {
        const val = Array.isArray(v) ? v[0] : v
        const next = { ...latestRef.current, [key]: val }
        applyNextValues(next, { commit, updateState: commit })
    }

    const setLook = (look) => {
        const next = { ...latestRef.current, look }
        applyNextValues(next, { commit: true, updateState: true })
    }

    const reset = () => {
        const next = { ...DEFAULT_VALUES }
        latestRef.current = next
        pendingPreviewRef.current = null
        if (previewFrame.current) {
            cancelAnimationFrame(previewFrame.current)
            previewFrame.current = null
        }
        setValues(next)
        const nextSig = getValuesSignature(next)
        applyAdjustmentFilters(canvasEditor, next, sigRef, { commit: nextSig !== committedSigRef.current })
        committedSigRef.current = nextSig
        isInteractingRef.current = false
    }

    const applyImageKitTransforms = async () => {
        const img = getActiveImage(canvasEditor)
        if (!img) {
            toast.error("Select an image first")
            return
        }

        const sourceUrl = getImageSrc(img)
        if (!isImageKitUrl(sourceUrl)) {
            toast.error("ImageKit URL transforms need an ImageKit-hosted image")
            return
        }

        const tokens = buildImageKitTokens(imageKitValues)
        if (!tokens.length) {
            toast.info("Choose at least one ImageKit transform")
            return
        }

        const baseUrl = img._pixxelImageKitAdjustBaseSrc || img.pixxelImageKitAdjustBaseSrc || sourceUrl
        img._pixxelImageKitAdjustBaseSrc = baseUrl
        img.pixxelImageKitAdjustBaseSrc = baseUrl
        img.pixxelImageKitAdjustValues = imageKitValues

        const nextUrl = buildImageKitTransformUrl(baseUrl, tokens, {
            preserveExistingTransforms: true,
            existingPosition: "before",
        })

        setIsApplyingImageKit(true)
        setProcessingMessage?.("Applying ImageKit URL transforms...")
        try {
            const readyUrl = await waitForImageKitUrl(nextUrl, {
                maxAttempts: 2,
                onStatus: (attempt, max) => setProcessingMessage?.(`Waiting for ImageKit... (${attempt}/${max})`),
            })
            await img.setSrc(readyUrl, { crossOrigin: "anonymous" })
            img.set("dirty", true)
            img.setCoords()
            canvasEditor.requestRenderAll()
            canvasEditor.fire("object:modified", { target: img })
            toast.success("ImageKit transforms applied")
        } catch (error) {
            console.warn("ImageKit adjustment failed:", error)
            toast.error(error?.message || "ImageKit transform failed")
        } finally {
            setIsApplyingImageKit(false)
            setProcessingMessage?.(null)
        }
    }

    if (!canvasEditor) {
        return (
            <div className="p-4">
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>Load an image to adjust</p>
            </div>
        )
    }

    return (
        <div className="adjust-panel">
            <div className="adjust-panel-header">
                <div className="flex items-center gap-2">
                    <SlidersHorizontal className="h-4 w-4" />
                    <span>Professional Adjust</span>
                </div>
                <button type="button" onClick={reset} className="adjust-reset-button">
                    <RotateCcw className="h-3.5 w-3.5" /> Reset
                </button>
            </div>

            <div className="adjust-tabs" role="tablist" aria-label="Adjustment groups">
                {FILTER_GROUPS.map((group) => (
                    <button
                        key={group}
                        type="button"
                        onClick={() => setActiveTab(group)}
                        className={`adjust-tab ${activeTab === group ? "is-active" : ""}`}
                        data-active={activeTab === group}
                        role="tab"
                        aria-selected={activeTab === group}
                    >
                        {group}
                    </button>
                ))}
            </div>

            {activeTab === "Wheels" ? (
                <div className="adjust-control-list">
                    <div className="adjust-look-strip">
                        {LOOKS.map((look) => (
                            <button
                                key={look.id}
                                type="button"
                                onClick={() => setLook(look.id)}
                                className={`adjust-look-button ${values.look === look.id ? "is-active" : ""}`}
                            >
                                {look.label}
                            </button>
                        ))}
                    </div>
                    {WHEEL_CONFIGS.map((config) => (
                        <ColorWheelCard
                            key={config.key}
                            config={config}
                            values={values}
                            onColor={handleColorChange}
                            onAmount={handleWheelAmount}
                        />
                    ))}
                </div>
            ) : activeTab === "ImageKit" ? (
                <div className="adjust-control-list">
                    <ImageKitPanel
                        imageKitValues={imageKitValues}
                        setImageKitValues={setImageKitValues}
                        onApply={applyImageKitTransforms}
                        isApplying={isApplyingImageKit}
                    />
                </div>
            ) : (
                <div className="adjust-control-list">
                    {SLIDER_CONFIGS.filter((cfg) => cfg.group === activeTab).map((cfg) => (
                        <ProRulerSlider
                            key={cfg.key}
                            variant="instrument"
                            value={values[cfg.key]}
                            onBegin={handleBeginChange}
                            onPreview={(v) => handlePreviewChange(cfg.key, v)}
                            onCommit={(v) => handleCommitChange(cfg.key, v)}
                            min={cfg.min}
                            max={cfg.max}
                            step={cfg.step}
                            label={cfg.label}
                            suffix={cfg.suffix ?? ""}
                            visual={FILTER_VISUAL[cfg.key] || FILTER_VISUAL.brightness}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

export default AdjustControls
