import { Gradient, Rect, filters } from "fabric"
import { PhosmithCurvesFilter, arePointsIdentity, buildLut } from "@/lib/curves-filter"
import { applyMegashaderFilter } from "@/lib/megashader/apply-megashader"
import { luminanceLayer } from "@/lib/megashader/mask-types"
import { ALL_VALUE_KEYS, CURVE_POINTS_KEYS, DEFAULT_VALUES, LOOKS, SLIDER_CONFIGS, TEMP_COOL, TEMP_WARM, VIGNETTE_LAYER_NAME, WHEEL_CONFIGS, cloneIdentityPoints } from "./config"
import { ensureAdjustmentObjectId, getAdjustmentTargets, getSelectedImage } from "./targets"
import { clamp } from "./utils"

export const isSharpnessFilter = (filter) => {
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

export const getValuesSignature = (v) => JSON.stringify(v)

export const sanitizeCurvePoints = (raw) => {
    const arr = Array.isArray(raw) ? raw : []
    const cleaned = arr
        .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => ({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }))
        .sort((a, b) => a.x - b.x)
    if (cleaned.length < 2) return cloneIdentityPoints()
    cleaned[0] = { x: 0, y: cleaned[0].y }
    cleaned[cleaned.length - 1] = { x: 1, y: cleaned[cleaned.length - 1].y }
    return cleaned
}

export const normalizeStoredValues = (values) => {
    const next = { ...DEFAULT_VALUES, ...(values || {}) }
    for (const config of SLIDER_CONFIGS) {
        next[config.key] = clamp(Number(next[config.key] ?? config.defaultValue), config.min, config.max)
    }
    for (const config of WHEEL_CONFIGS) {
        next[config.key] = clamp(Number(next[config.key] ?? 0), 0, 100)
        next[config.colorKey] = String(next[config.colorKey] || config.defaultColor)
    }
    for (const key of CURVE_POINTS_KEYS) {
        next[key] = sanitizeCurvePoints(next[key])
    }
    next.look = LOOKS.some((look) => look.id === next.look) ? next.look : "none"
    return next
}

export const filterMatchesManagedKey = (filter) =>
    filter?._phosmithAdjustmentManaged === true ||
    ALL_VALUE_KEYS.has(filter?._phosmithAdjustmentKey) ||
    filter?._phosmithAgentFilter === true ||
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

export const getValuesFromImageFilters = (imageObject) => {
    const stored = imageObject?.phosmithAdjustValues || imageObject?._phosmithAdjustValues
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

export const markFilter = (filter, key) => {
    filter._phosmithAdjustmentManaged = true
    filter._phosmithAdjustmentKey = key
    return filter
}

export const buildChannelMatrix = (values) => {
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

export const buildGammaValues = (values) => {
    const base = Number(values.gamma || 100) / 100
    return [base, base, base]
}

export const buildCurvesFilter = (values) => {
    const masterPts = sanitizeCurvePoints(values.curvePointsMaster)
    const redPts = sanitizeCurvePoints(values.curvePointsRed)
    const greenPts = sanitizeCurvePoints(values.curvePointsGreen)
    const bluePts = sanitizeCurvePoints(values.curvePointsBlue)
    if (
        arePointsIdentity(masterPts) &&
        arePointsIdentity(redPts) &&
        arePointsIdentity(greenPts) &&
        arePointsIdentity(bluePts)
    ) {
        return null
    }
    return new PhosmithCurvesFilter({
        lutR: buildLut(redPts),
        lutG: buildLut(greenPts),
        lutB: buildLut(bluePts),
        lutMaster: buildLut(masterPts),
    })
}

export const grayscaleMatrix = (amount) => {
    const a = clamp(amount, 0, 100) / 100
    const inv = 1 - a
    return [
        inv + 0.2126 * a, 0.7152 * a, 0.0722 * a, 0, 0,
        0.2126 * a, inv + 0.7152 * a, 0.0722 * a, 0, 0,
        0.2126 * a, 0.7152 * a, inv + 0.0722 * a, 0, 0,
        0, 0, 0, 1, 0,
    ]
}

export const buildConvolution = (amount) => {
    const a = Math.abs(amount) / 100
    if (a <= 0) return null
    if (amount < 0) {
        return [a / 9, a / 9, a / 9, a / 9, 1 - (8 * a) / 9, a / 9, a / 9, a / 9, a / 9]
    }
    return [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0]
}

export const addBlend = (acc, key, color, mode, alpha) => {
    if (alpha <= 0) return
    acc.push(markFilter(new filters.BlendColor({ color, mode, alpha: clamp(alpha, 0, 1) }), key))
}

export const buildFabricFilters = (values) => {
    const next = []
    const look = LOOKS.find((item) => item.id === values.look)

    if (look?.filterClass) next.push(markFilter(new look.filterClass(), "look"))
    if (values.brightness) next.push(markFilter(new filters.Brightness({ brightness: values.brightness / 100 }), "brightness"))
    if (values.contrast) next.push(markFilter(new filters.Contrast({ contrast: values.contrast / 100 }), "contrast"))
    const gamma = buildGammaValues(values)
    if (gamma.some((value) => Math.abs(value - 1) > 0.001)) next.push(markFilter(new filters.Gamma({ gamma }), "gamma"))
    if (values.temperature) addBlend(next, "temperature", values.temperature >= 0 ? TEMP_WARM : TEMP_COOL, "tint", Math.abs(values.temperature) / 280)
    if (values.tint) addBlend(next, "tint", values.tint >= 0 ? "#e879f9" : "#46d68c", "tint", Math.abs(values.tint) / 320)
    if (values.saturation) next.push(markFilter(new filters.Saturation({ saturation: values.saturation / 100 }), "saturation"))
    if (values.vibrance) next.push(markFilter(new filters.Vibrance({ vibrance: values.vibrance / 100 }), "vibrance"))
    if (values.hue) next.push(markFilter(new filters.HueRotation({ rotation: values.hue / 180 }), "hue"))

    const channelMatrix = buildChannelMatrix(values)
    if (channelMatrix) next.push(markFilter(new filters.ColorMatrix({ matrix: channelMatrix }), "rgb-mixer"))

    const curvesFilter = buildCurvesFilter(values)
    if (curvesFilter) next.push(markFilter(curvesFilter, "curves"))

    // ── Highlights / Shadows / Whites / Blacks ──────────────────────────
    // Fabric's BlendColor "multiply" mode does NOT lerp between the original
    // pixel and the blended result — it bakes alpha into the blend color first
    // (tr = color_channel * alpha) and then does pixel*tr/255. With dark blend
    // colors (#000000, #050505, #1b1b1b) this drives every pixel to near-zero
    // (black) at any noticeable alpha. The fix: use a ColorMatrix that linearly
    // scales pixel brightness — `lerp(1.0, darkFactor, strength)` — so the
    // image darkens smoothly instead of crushing to black.
    //
    // Positive values (lighten) still use BlendColor "screen" which works fine
    // because screen with bright colors correctly lifts pixel values.

    if (values.highlights > 0) addBlend(next, "highlights", "#ffffff", "screen", values.highlights / 260)
    if (values.highlights < 0) {
        // Darken highlights: scale brightness toward ~0.7 at max (-100)
        const s = 1 - Math.abs(values.highlights) / 330
        next.push(markFilter(new filters.ColorMatrix({
            matrix: [s, 0, 0, 0, 0, 0, s, 0, 0, 0, 0, 0, s, 0, 0, 0, 0, 0, 1, 0],
        }), "highlights"))
    }
    if (values.shadows > 0) addBlend(next, "shadows", "#cdd8ff", "screen", values.shadows / 360)
    if (values.shadows < 0) {
        // Darken shadows: scale brightness toward ~0.62 at max (-100)
        const s = 1 - Math.abs(values.shadows) / 260
        next.push(markFilter(new filters.ColorMatrix({
            matrix: [s, 0, 0, 0, 0, 0, s, 0, 0, 0, 0, 0, s, 0, 0, 0, 0, 0, 1, 0],
        }), "shadows"))
    }
    if (values.whites > 0) addBlend(next, "whites", "#ffffff", "screen", values.whites / 340)
    if (values.blacks > 0) {
        // Crush blacks: scale brightness toward ~0.67 at max (100)
        const s = 1 - values.blacks / 300
        next.push(markFilter(new filters.ColorMatrix({
            matrix: [s, 0, 0, 0, 0, 0, s, 0, 0, 0, 0, 0, s, 0, 0, 0, 0, 0, 1, 0],
        }), "blacks"))
    }

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

export const isVignetteLayer = (obj) =>
    obj?.name === VIGNETTE_LAYER_NAME ||
    obj?.phosmithAdjustmentOverlay === "vignette" ||
    obj?._phosmithAdjustmentOverlay === "vignette"

export const removeVignetteLayers = (canvasEditor, targetId = null) => {
    const objects = canvasEditor?.getObjects?.() || []
    const layers = objects.filter((obj) => {
        if (!isVignetteLayer(obj)) return false
        if (!targetId) return true
        const layerTarget = obj.phosmithAdjustmentTargetId || obj._phosmithAdjustmentTargetId
        return layerTarget === targetId || !layerTarget
    })
    layers.forEach((layer) => canvasEditor.remove(layer))
    return layers.length
}

export const applyVignetteLayer = (canvasEditor, imageObject, values) => {
    if (!canvasEditor || !imageObject) return
    const targetId = ensureAdjustmentObjectId(imageObject)
    const amount = Number(values.vignette || 0)
    if (!amount) {
        removeVignetteLayers(canvasEditor, targetId)
        return
    }

    removeVignetteLayers(canvasEditor, targetId)

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
        phosmithAdjustmentOverlay: "vignette",
        _phosmithAdjustmentOverlay: "vignette",
        phosmithAdjustmentTargetId: targetId,
        _phosmithAdjustmentTargetId: targetId,
    })

    canvasEditor.add(vignette)
    const imageIndex = canvasEditor.getObjects().indexOf(imageObject)
    if (imageIndex >= 0 && typeof canvasEditor.moveObjectTo === "function") {
        canvasEditor.moveObjectTo(vignette, imageIndex + 1)
    }
}

/** Id of the full-frame layer this panel owns inside the megashader stack. */
export const ADJUST_SHADER_LAYER_ID = 'adjust-tone'

/**
 * Lux and Structure need neighbouring pixels, which no Fabric filter can read, so
 * they ride a full-frame megashader layer. It is merged into the existing stack by
 * id — the Mask tool's layers on the same image must survive.
 */
export const syncAdjustShaderLayer = (image, values) => {
    const lux = Number(values.lux) || 0
    const structure = Number(values.structure) || 0
    const mega = image.filters?.find((f) => f && f.type === 'Megashader')
    const existing = Array.isArray(mega?.stack?.chain) ? mega.stack.chain : []
    const others = existing.filter((entry) => entry?.layer?.id !== ADJUST_SHADER_LAYER_ID)
    if (lux === 0 && structure === 0) {
        if (others.length === existing.length) return
        applyMegashaderFilter(image, { chain: others, base: mega?.stack?.base }, {})
        return
    }
    const layer = {
        ...luminanceLayer({ min: 0, max: 1, softness: 0 }),
        id: ADJUST_SHADER_LAYER_ID,
        label: 'Lux / Structure',
        lux,
        structure,
    }
    // Slot 0 acts as `replace`, so a stack that starts with this layer keeps the
    // rest of the chain composing on top of the graded result.
    const chain = others.length
        ? [{ op: others[0].op === 'replace' ? 'add' : 'add', layer }, ...others]
        : [{ op: 'replace', layer }]
    applyMegashaderFilter(image, { chain, base: mega?.stack?.base }, {})
}

export const applyAdjustmentFilters = (canvasEditor, values, sigRef, { commit = false } = {}) => {
    if (!canvasEditor) return
    const selectedImage = getSelectedImage(canvasEditor)
    const targets = getAdjustmentTargets(canvasEditor)
    if (!targets.length) return
    const normalized = normalizeStoredValues(values)
    const sig = getValuesSignature(normalized)
    const originalActiveObject = canvasEditor.getActiveObject()

    try {
        targets.forEach((img) => {
            const currentFilters = img.filters ?? []
            const preservedFilters = currentFilters.filter((filter) => !filterMatchesManagedKey(filter))
            const managedFilters = buildFabricFilters(normalized)
            img.filters = [...preservedFilters, ...managedFilters]
            img.phosmithAdjustValues = normalized
            img._phosmithAdjustValues = normalized
            img.applyFilters()
            const previewScale = img.__phosmithAdjustmentPreviewScale
            if (previewScale) {
                img._filterScalingX = previewScale.x
                img._filterScalingY = previewScale.y
            }
            img.set("dirty", true)
            applyVignetteLayer(canvasEditor, img, normalized)
            syncAdjustShaderLayer(img, normalized)
            if (commit) canvasEditor.fire("object:modified", { target: img })
        })
        if (selectedImage) canvasEditor.setActiveObject(selectedImage)
        else if (originalActiveObject) canvasEditor.setActiveObject(originalActiveObject)
        else canvasEditor.discardActiveObject()
        canvasEditor.requestRenderAll()
        sigRef.current = sig
    } catch (e) {
        console.error(e)
    }
}
