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

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
