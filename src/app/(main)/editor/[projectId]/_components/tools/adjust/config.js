import { filters } from "fabric"

export const TEMP_WARM = "#ffb45f"

export const TEMP_COOL = "#72b7ff"

export const VIGNETTE_LAYER_NAME = "phosmith-vignette-overlay"

// During a slider/curve drag we filter a downscaled proxy of the source (this
// long-edge cap) instead of the full-res image, so each RAF-gated applyFilters()
// touches ~1 MP instead of 50 MP. Full-res is restored + refiltered on commit.
export const PROXY_MAX_PX = 1000

export const CURVE_GRAPH = {
    left: 8,
    top: 8,
    right: 92,
    bottom: 92,
}

export const SLIDER_CONFIGS = [
    { group: "Tone", key: "exposure", label: "Exposure", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "brightness", label: "Brightness", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "contrast", label: "Contrast", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "highlights", label: "Highlights", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "shadows", label: "Shadows", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "whites", label: "Whites", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "blacks", label: "Blacks", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Tone", key: "gamma", label: "Gamma", min: 20, max: 220, step: 1, defaultValue: 100, suffix: "%" },
    { group: "Tone", key: "fade", label: "Fade", min: 0, max: 100, step: 1, defaultValue: 0 },
    // Lux is local tone mapping in the shader, not a curve — see the megashader
    // grade. Kept next to the tone sliders because that is what it reads as.
    { group: "Tone", key: "lux", label: "Lux", min: 0, max: 100, step: 1, defaultValue: 0 },

    { group: "Color", key: "temperature", label: "Temperature", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Color", key: "tint", label: "Tint", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Color", key: "saturation", label: "Saturation", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Color", key: "vibrance", label: "Vibrance", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Color", key: "hue", label: "Hue", min: -180, max: 180, step: 1, defaultValue: 0, suffix: "º" },
    { group: "Color", key: "red", label: "Red", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Color", key: "green", label: "Green", min: -100, max: 100, step: 1, defaultValue: 0 },
    { group: "Color", key: "blue", label: "Blue", min: -100, max: 100, step: 1, defaultValue: 0 },

    { group: "Detail", key: "clarity", label: "Clarity", min: -100, max: 100, step: 1, defaultValue: 0 },
    // Structure = edge-aware local contrast (halo-free), also shader-side.
    { group: "Detail", key: "structure", label: "Structure", min: -100, max: 100, step: 1, defaultValue: 0 },
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

export const WHEEL_CONFIGS = [
    // NOTE: "multiply" can't be used here — Fabric's BlendColor.applyTo2d bakes
    // alpha into the color BEFORE multiplying (tr = color * alpha), producing
    // near-black pixels instead of a subtle tint. "overlay" gives a similar
    // shadow-darkening effect that actually works in the Canvas2D pipeline.
    { key: "shadowTone", colorKey: "shadowColor", label: "Shadows", defaultColor: "#2342ff", mode: "overlay" },
    { key: "midtoneTone", colorKey: "midtoneColor", label: "Midtones", defaultColor: "#00c2a8", mode: "overlay" },
    { key: "highlightTone", colorKey: "highlightColor", label: "Highlights", defaultColor: "#ffd76d", mode: "screen" },
    { key: "colorizeIntensity", colorKey: "colorizeColor", label: "Colorize", defaultColor: "#ff3f7f", mode: "tint" },
]

export const CURVE_CHANNELS = [
    { id: "rgb", label: "RGB", shortLabel: "RGB", color: "#e5e7eb", histogramChannels: ["red", "green", "blue"], pointsKey: "curvePointsMaster" },
    { id: "red", label: "Red", shortLabel: "Red", color: "#ff5d65", histogramChannels: ["red"], pointsKey: "curvePointsRed" },
    { id: "green", label: "Green", shortLabel: "Green", color: "#64d989", histogramChannels: ["green"], pointsKey: "curvePointsGreen" },
    { id: "blue", label: "Blue", shortLabel: "Blue", color: "#69a7ff", histogramChannels: ["blue"], pointsKey: "curvePointsBlue" },
    { id: "luma", label: "Luminance", shortLabel: "Luma", color: "#d8dde7", histogramChannels: ["luma"], pointsKey: "curvePointsMaster" },
]

export const CURVE_POINTS_KEYS = ["curvePointsMaster", "curvePointsRed", "curvePointsGreen", "curvePointsBlue"]

export const LOOKS = [
    { id: "none", label: "Clean", filterClass: null },
    { id: "vibrant", label: "Vibrant", filterClass: null, preset: { contrast: 10, saturation: 18, vibrance: 42, clarity: 12 } },
    { id: "dramatic", label: "Dramatic", filterClass: null, preset: { contrast: 28, highlights: -18, shadows: -24, clarity: 34, vibrance: 18, vignette: 22 } },
    { id: "cinematic", label: "Cinematic", filterClass: null, preset: { contrast: 18, saturation: -8, vibrance: 18, temperature: -10, shadows: -10, highlights: -8, vignette: 16 } },
    { id: "golden", label: "Golden Hour", filterClass: null, preset: { temperature: 30, tint: 8, highlights: 14, shadows: 12, vibrance: 24 } },
    { id: "matte", label: "Matte", filterClass: null, preset: { contrast: -12, fade: 34, blacks: -14, saturation: -8, grain: 12 } },
    { id: "coolfade", label: "Cool Fade", filterClass: null, preset: { temperature: -24, tint: -8, fade: 20, saturation: -10, blue: 10 } },
    { id: "noir", label: "Noir", filterClass: filters.BlackWhite, preset: { contrast: 34, clarity: 24, blacks: 24, grain: 18, vignette: 28 } },
    { id: "vintage", label: "Vintage", filterClass: filters.Vintage },
    { id: "kodachrome", label: "Kodachrome", filterClass: filters.Kodachrome },
    { id: "technicolor", label: "Technicolor", filterClass: filters.Technicolor },
    { id: "polaroid", label: "Polaroid", filterClass: filters.Polaroid },
    { id: "brownie", label: "Brownie", filterClass: filters.Brownie },
    { id: "sepia", label: "Sepia", filterClass: filters.Sepia },
    { id: "blackwhite", label: "B&W", filterClass: filters.BlackWhite },
]

export const cloneIdentityPoints = () => [{ x: 0, y: 0 }, { x: 1, y: 1 }]

export const DEFAULT_VALUES = {
    ...SLIDER_CONFIGS.reduce((acc, c) => {
        acc[c.key] = c.defaultValue
        return acc
    }, {}),
    ...WHEEL_CONFIGS.reduce((acc, c) => {
        acc[c.key] = 0
        acc[c.colorKey] = c.defaultColor
        return acc
    }, {}),
    ...CURVE_POINTS_KEYS.reduce((acc, key) => {
        acc[key] = cloneIdentityPoints()
        return acc
    }, {}),
    look: "none",
}

export const LOOK_PRESET_KEYS = Array.from(new Set(LOOKS.flatMap((look) => Object.keys(look.preset || {}))))

export const IMAGEKIT_DEFAULTS = {
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

export const FILTER_GROUPS = ["Tone", "Color", "Curves", "Wheels", "Detail", "ImageKit"]

export const ALL_VALUE_KEYS = new Set([...Object.keys(DEFAULT_VALUES)])

export const FILTER_VISUAL = {
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
