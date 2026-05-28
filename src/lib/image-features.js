// Deterministic image feature extractor. Pure function from an HTMLImageElement
// (or Fabric image) to a numeric feature vector that the planner consumes.
//
// Same pixels in → same vector out. No randomness, no clock reads.

const SAMPLE_SIZE = 96

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

const getSourceElement = (input) => {
    if (!input) return null
    if (input._originalElement) return input._originalElement
    if (typeof input.getElement === "function") return input.getElement()
    if (input._element) return input._element
    return input
}

const percentile = (sortedArr, p) => {
    if (!sortedArr.length) return 0
    const idx = clamp(Math.floor(p * (sortedArr.length - 1)), 0, sortedArr.length - 1)
    return sortedArr[idx]
}

// HSV conversion (single pixel)
const rgbToHsv = (r, g, b) => {
    const rn = r / 255
    const gn = g / 255
    const bn = b / 255
    const max = Math.max(rn, gn, bn)
    const min = Math.min(rn, gn, bn)
    const d = max - min
    let h = 0
    if (d !== 0) {
        if (max === rn) h = ((gn - bn) / d) % 6
        else if (max === gn) h = (bn - rn) / d + 2
        else h = (rn - gn) / d + 4
        h *= 60
        if (h < 0) h += 360
    }
    const s = max === 0 ? 0 : d / max
    return { h, s, v: max }
}

const isSkinTone = (h, s, v) =>
    // Permissive HSV range for skin across complexions. Not a face detector,
    // just a "are there skin-ish pixels?" heuristic.
    h >= 0 && h <= 50 && s >= 0.18 && s <= 0.68 && v >= 0.35 && v <= 0.97

export const extractImageFeatures = (input) => {
    if (typeof document === "undefined") return null
    const source = getSourceElement(input)
    if (!source) return null

    const naturalW = source.naturalWidth || source.videoWidth || source.width || 0
    const naturalH = source.naturalHeight || source.videoHeight || source.height || 0
    if (!naturalW || !naturalH) return null

    const aspect = naturalW / naturalH
    const w = aspect >= 1 ? SAMPLE_SIZE : Math.max(8, Math.round(SAMPLE_SIZE * aspect))
    const h = aspect >= 1 ? Math.max(8, Math.round(SAMPLE_SIZE / aspect)) : SAMPLE_SIZE

    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return null

    try {
        ctx.drawImage(source, 0, 0, w, h)
        const { data } = ctx.getImageData(0, 0, w, h)
        const N = w * h

        let sumR = 0, sumG = 0, sumB = 0
        let sumLum = 0, sumLumSq = 0
        let sumSat = 0, sumSatSq = 0
        const lumArr = new Float32Array(N)
        let highClip = 0, lowClip = 0
        let skinHits = 0

        // Edge density via simple horizontal+vertical luminance gradient sampling on a grid
        let edgeAccum = 0
        let edgeSamples = 0

        for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
                const i = (py * w + px) * 4
                const r = data[i], g = data[i + 1], b = data[i + 2]
                sumR += r; sumG += g; sumB += b
                // Rec. 709 luma in [0..255]
                const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
                sumLum += lum
                sumLumSq += lum * lum
                lumArr[py * w + px] = lum
                if (lum >= 253) highClip++
                if (lum <= 2) lowClip++

                const { h: hue, s, v } = rgbToHsv(r, g, b)
                sumSat += s
                sumSatSq += s * s
                if (isSkinTone(hue, s, v)) skinHits++
            }
        }

        // Edge density: average abs gradient at every other pixel (cheap, deterministic)
        for (let py = 1; py < h; py += 2) {
            for (let px = 1; px < w; px += 2) {
                const c = lumArr[py * w + px]
                const left = lumArr[py * w + (px - 1)]
                const up = lumArr[(py - 1) * w + px]
                edgeAccum += Math.abs(c - left) + Math.abs(c - up)
                edgeSamples += 2
            }
        }

        const meanR = sumR / N
        const meanG = sumG / N
        const meanB = sumB / N
        const meanLum = sumLum / N
        const lumVar = Math.max(0, sumLumSq / N - meanLum * meanLum)
        const meanSat = sumSat / N
        const satVar = Math.max(0, sumSatSq / N - meanSat * meanSat)

        const sortedLum = Array.from(lumArr).sort((a, b) => a - b)
        const p05 = percentile(sortedLum, 0.05)
        const p50 = percentile(sortedLum, 0.5)
        const p95 = percentile(sortedLum, 0.95)

        // Normalize features to ~[0..1] or signed ranges the planner expects.
        return {
            // Exposure / luminance: 0..1
            luminance: {
                mean: meanLum / 255,
                std: Math.sqrt(lumVar) / 255,
                p05: p05 / 255,
                p50: p50 / 255,
                p95: p95 / 255,
            },
            // Saturation: 0..1
            saturation: {
                mean: meanSat,
                std: Math.sqrt(satVar),
            },
            // Warmth: -1..+1 (negative cool, positive warm)
            warmth: (meanR - meanB) / 255,
            // Channel means: 0..1
            channelMeans: { r: meanR / 255, g: meanG / 255, b: meanB / 255 },
            // Dynamic range proxy 0..1
            contrast: (p95 - p05) / 255,
            // Highlight/shadow clipping 0..1
            highlightClipping: highClip / N,
            shadowClipping: lowClip / N,
            // Skin-tone heuristic 0..1
            skinToneFraction: skinHits / N,
            // Edge density (busy vs smooth) 0..~1
            edgeDensity: edgeSamples > 0 ? (edgeAccum / edgeSamples) / 255 : 0,
            // For debugging / display
            sampleSize: { width: w, height: h },
        }
    } catch (error) {
        console.warn("[image-features] extraction failed:", error?.message || error)
        return null
    }
}

// Convenience: classify the current style of the image based on its feature vector.
// Used by the deterministic fallback (when no LLM is available) to guess what style
// the image is closest to today.
export const classifyCurrentStyle = (features) => {
    if (!features) return "neutral"
    const { luminance, saturation, warmth, contrast } = features

    // Black & white check first — saturation collapses to near-zero
    if (saturation.mean < 0.06) return "bw-classic"
    // Cinematic: moderate-to-low brightness, warm, lower saturation, decent contrast
    if (
        luminance.mean < 0.55 &&
        saturation.mean < 0.48 &&
        contrast > 0.48 &&
        (warmth > 0.02 || luminance.p05 < 0.12)
    ) {
        return "cinematic"
    }
    // Vintage: lifted blacks (high shadows), faded contrast, warm
    if (luminance.p05 > 0.12 && contrast < 0.55 && warmth > 0.02) return "vintage"
    // Vibrant: very saturated, normal exposure
    if (saturation.mean > 0.55 && luminance.mean > 0.35) return "vibrant"
    // Editorial: clean, high contrast, normal saturation
    if (contrast > 0.6 && saturation.mean >= 0.25 && saturation.mean <= 0.5) return "editorial"
    // Studio: bright, low warmth swing, moderate saturation
    if (luminance.mean > 0.55 && Math.abs(warmth) < 0.06 && saturation.mean < 0.45) return "studio"
    // Warm portrait: skin-tone heavy
    if (features.skinToneFraction > 0.18 && warmth > 0.02) return "warm-portrait"
    return "neutral"
}

const isFiniteNumber = (value) => Number.isFinite(Number(value))

const inRange = (value, min, max) =>
    isFiniteNumber(value) && Number(value) >= min && Number(value) <= max

const atLeast = (value, min) =>
    isFiniteNumber(value) && Number(value) >= min

const atMost = (value, max) =>
    isFiniteNumber(value) && Number(value) <= max

const scoreChecks = (checks, minPasses) => {
    const total = checks.length
    const passed = checks.filter(Boolean).length
    return {
        passed,
        total,
        score: total ? passed / total : 0,
        enough: total ? passed >= minPasses : false,
    }
}

// Deterministic target-style fit check used after model analysis. This is the
// guardrail that prevents repeated prompts from pushing an already-finished
// image into an overprocessed look.
export const getStyleFit = (features, targetStyle = "neutral") => {
    const currentStyle = classifyCurrentStyle(features)
    if (!features) {
        return {
            currentStyle,
            targetStyle,
            alreadyMatches: false,
            score: 0,
            passed: 0,
            total: 0,
        }
    }

    const lum = features.luminance || {}
    const sat = features.saturation || {}
    const warmth = Number(features.warmth || 0)
    const contrast = Number(features.contrast || 0)
    const highlightClipping = Number(features.highlightClipping || 0)
    const shadowClipping = Number(features.shadowClipping || 0)
    const edgeDensity = Number(features.edgeDensity || 0)
    const skinToneFraction = Number(features.skinToneFraction || 0)

    const checksByStyle = {
        cinematic: {
            minPasses: 5,
            checks: [
                inRange(lum.mean, 0.24, 0.58),
                inRange(sat.mean, 0.08, 0.48),
                atLeast(contrast, 0.42),
                inRange(warmth, -0.08, 0.18),
                atMost(highlightClipping, 0.04),
                atMost(shadowClipping, 0.12),
            ],
        },
        vintage: {
            minPasses: 4,
            checks: [
                atLeast(lum.p05, 0.08),
                atMost(contrast, 0.6),
                atMost(sat.mean, 0.5),
                atLeast(warmth, -0.03),
                atMost(highlightClipping, 0.05),
            ],
        },
        editorial: {
            minPasses: 4,
            checks: [
                inRange(lum.mean, 0.34, 0.68),
                inRange(sat.mean, 0.18, 0.55),
                atLeast(contrast, 0.5),
                atMost(highlightClipping, 0.035),
                atLeast(edgeDensity, 0.08),
            ],
        },
        vibrant: {
            minPasses: 4,
            checks: [
                atLeast(sat.mean, 0.46),
                inRange(lum.mean, 0.35, 0.72),
                atLeast(contrast, 0.42),
                atMost(highlightClipping, 0.04),
                atMost(shadowClipping, 0.1),
            ],
        },
        studio: {
            minPasses: 4,
            checks: [
                inRange(lum.mean, 0.5, 0.78),
                atMost(Math.abs(warmth), 0.08),
                inRange(sat.mean, 0.1, 0.45),
                atMost(shadowClipping, 0.04),
                atMost(highlightClipping, 0.04),
            ],
        },
        "warm-portrait": {
            minPasses: 4,
            checks: [
                atLeast(skinToneFraction, 0.12),
                inRange(lum.mean, 0.34, 0.72),
                inRange(warmth, 0.01, 0.18),
                atMost(highlightClipping, 0.04),
                atMost(sat.mean, 0.55),
            ],
        },
        "bw-classic": {
            minPasses: 3,
            checks: [
                atMost(sat.mean, 0.08),
                inRange(lum.mean, 0.28, 0.72),
                atLeast(contrast, 0.38),
                atMost(highlightClipping, 0.05),
            ],
        },
        neutral: {
            minPasses: 4,
            checks: [
                inRange(lum.mean, 0.34, 0.68),
                inRange(sat.mean, 0.08, 0.55),
                inRange(contrast, 0.35, 0.75),
                atMost(highlightClipping, 0.04),
                atMost(shadowClipping, 0.08),
            ],
        },
    }

    const definition = checksByStyle[targetStyle] || checksByStyle.neutral
    const result = scoreChecks(definition.checks, definition.minPasses)
    const exactStyleMatch = currentStyle === targetStyle && targetStyle !== "neutral"

    return {
        currentStyle,
        targetStyle,
        alreadyMatches: exactStyleMatch || result.enough,
        score: result.score,
        passed: result.passed,
        total: result.total,
    }
}
