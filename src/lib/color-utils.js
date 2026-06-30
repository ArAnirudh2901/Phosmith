/**
 * Colour Conversion Utilities
 * ---------------------------
 * Pure-JS colour-space conversions used by the editor's layer editor.
 * The GLSL equivalents of `rgbToHsb` live in
 * `megashader/glsl-fragments.js` (inlined in the generated shader
 * because GLSL is a different language) — these JS implementations
 * must produce the same HSB triples the GLSL will see at render time,
 * otherwise a colour picked in the UI would be stored as one HSB
 * triple and the shader would highlight a different set of pixels.
 *
 * If you change the algorithm here, mirror the change in the GLSL
 * `rgbToHsb` function. The verify-megashader suite does not currently
 * cross-check the two (it runs in pure Node), so this is a
 * maintainer-discipline check.
 *
 * @module color-utils
 */

/**
 * Convert an sRGB triple (0..255) to HSB. The hue is returned in
 * degrees 0..360 (matching the rest of the megashader); saturation
 * and brightness are 0..1. The output is a plain object so the
 * caller can store it directly on a layer's `target` field.
 *
 * @param {number} r 0..255
 * @param {number} g 0..255
 * @param {number} b 0..255
 * @returns {{ h: number, s: number, b: number }}
 */
export const rgbToHsb = (r, g, b) => {
    const rN = clamp01(r / 255)
    const gN = clamp01(g / 255)
    const bN = clamp01(b / 255)
    const max = Math.max(rN, gN, bN)
    const min = Math.min(rN, gN, bN)
    const d = max - min
    let h = 0
    if (d !== 0) {
        // The JS `%` operator preserves sign for negative numerators
        // (unlike the GLSL `mod`), so the post-`*= 60` correction is
        // needed to wrap negative hues into the 0..360 range. The
        // GLSL version avoids this by adding 6 in the red branch.
        if (max === rN) h = ((gN - bN) / d) % 6
        else if (max === gN) h = (bN - rN) / d + 2
        else h = (rN - gN) / d + 4
        h *= 60
        if (h < 0) h += 360
    }
    const s = max === 0 ? 0 : d / max
    return { h, s, b: max }
}

/**
 * Convert a 6-digit hex colour (e.g. `#facc15`) to `rgba()` with
 * the given alpha. Falls back to the input string if the format is
 * not a 6-digit hex — that lets callers pass through named colours
 * or 8-digit hex unchanged rather than silently corrupting them.
 *
 * @param {string} hex    e.g. '#facc15'
 * @param {number} alpha  0..1
 * @returns {string}
 */
export const hexToRgba = (hex, alpha = 1) => {
    if (typeof hex !== 'string' || hex.length < 7 || hex[0] !== '#') return hex
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    if ([r, g, b].some((n) => Number.isNaN(n))) return hex
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Convert a hex colour to an `{ r, g, b }` triple (0..255). Tolerates a
 * missing `#` and short/long input by trimming/padding to 6 digits, so a
 * partially-typed value never throws. Mirrors the helper in `adjust.jsx`
 * so the colour-wheel maths matches the production Adjust tool.
 *
 * @param {string} hex   e.g. '#facc15' or 'facc15'
 * @returns {{ r: number, g: number, b: number }}
 */
export const hexToRgb = (hex) => {
    const clean = String(hex || '000000').replace('#', '').slice(0, 6).padEnd(6, '0')
    return {
        r: parseInt(clean.slice(0, 2), 16),
        g: parseInt(clean.slice(2, 4), 16),
        b: parseInt(clean.slice(4, 6), 16),
    }
}

/**
 * Convert an `{ r, g, b }` triple (0..255, may be fractional) to a 6-digit
 * hex string. Components are rounded and clamped to 0..255.
 *
 * @param {number} r 0..255
 * @param {number} g 0..255
 * @param {number} b 0..255
 * @returns {string} e.g. '#facc15'
 */
export const rgbToHex = (r, g, b) =>
    `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`

/**
 * Convert an sRGB triple (0..255) to HSV. Hue is in degrees 0..360;
 * saturation and value are 0..1. Distinct from {@link rgbToHsb} only in
 * naming convention (HSV ≡ HSB); kept separate to match the colour-wheel
 * code ported from `adjust.jsx`.
 *
 * @param {{ r: number, g: number, b: number }} rgb 0..255 components
 * @returns {{ h: number, s: number, v: number }}
 */
export const rgbToHsv = ({ r, g, b }) => {
    const rn = r / 255
    const gn = g / 255
    const bn = b / 255
    const max = Math.max(rn, gn, bn)
    const min = Math.min(rn, gn, bn)
    const delta = max - min
    let h = 0
    if (delta) {
        if (max === rn) h = ((gn - bn) / delta) % 6
        else if (max === gn) h = (bn - rn) / delta + 2
        else h = (rn - gn) / delta + 4
        h *= 60
    }
    if (h < 0) h += 360
    return { h, s: max === 0 ? 0 : delta / max, v: max }
}

/**
 * Convert HSV (hue 0..360, saturation/value 0..1) to an sRGB `{ r, g, b }`
 * triple (0..255, fractional). Inverse of {@link rgbToHsv}.
 *
 * @param {number} h 0..360
 * @param {number} s 0..1
 * @param {number} v 0..1
 * @returns {{ r: number, g: number, b: number }}
 */
export const hsvToRgb = (h, s, v) => {
    const c = v * s
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = v - c
    let rp = 0
    let gp = 0
    let bp = 0
    if (h < 60) [rp, gp, bp] = [c, x, 0]
    else if (h < 120) [rp, gp, bp] = [x, c, 0]
    else if (h < 180) [rp, gp, bp] = [0, c, x]
    else if (h < 240) [rp, gp, bp] = [0, x, c]
    else if (h < 300) [rp, gp, bp] = [x, 0, c]
    else [rp, gp, bp] = [c, 0, x]
    return { r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
