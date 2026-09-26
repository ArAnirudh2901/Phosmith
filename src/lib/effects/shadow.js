/**
 * Drop shadows, two kinds.
 *
 * **Frame shadow** — Photoshop's parameter set (angle, distance, spread, size,
 * opacity, colour) mapped onto the offset/blur/colour a renderer actually takes.
 * Angle is the direction the LIGHT comes from, so the shadow falls the other way;
 * that sign is the thing everyone gets wrong.
 *
 * **Cast shadow** — the subject's own silhouette, skewed onto the ground plane and
 * softened with distance from the contact edge, which is what makes a cut-out look
 * lit rather than pasted.
 */

import { makePlane } from '../cv/box-filter'
import { distanceTransform } from '../cv/distance-transform'
import { gaussianBlur } from '../cv/box-filter'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** Photoshop's default light angle: up and to the left. */
export const GLOBAL_LIGHT_ANGLE = 120

/**
 * Frame-shadow parameters → renderer values.
 *
 * `spread` hardens the core: Photoshop grows the matte before blurring, and the
 * equivalent with a single blur is to keep more of the blur's centre, so it is
 * expressed as a blur reduction plus an opacity gain rather than pretended to be
 * a second morphology pass.
 */
export const frameShadowParams = ({
    angle = GLOBAL_LIGHT_ANGLE,
    distance = 12,
    size = 24,
    spread = 0,
    opacity = 0.35,
    color = '#0b0d12',
} = {}) => {
    const rad = (angle * Math.PI) / 180
    const d = Math.max(0, distance)
    const s = clamp(spread, 0, 1)
    const blur = Math.max(0, size) * (1 - s * 0.75)
    const alpha = clamp(opacity, 0, 1) * (1 + s * 0.4)
    return {
        // Light from `angle` ⇒ shadow 180° opposite. Canvas Y grows downward, so
        // the sine is negated once for the flip and once for the opposition.
        offsetX: -Math.cos(rad) * d,
        offsetY: Math.sin(rad) * d,
        blur,
        color: rgbaFromHex(color, Math.min(1, alpha)),
        angle,
        distance: d,
        spread: s,
        size: Math.max(0, size),
        opacity: clamp(opacity, 0, 1),
        baseColor: color,
    }
}

export const rgbaFromHex = (hex, alpha) => {
    const h = String(hex || '#000000').replace('#', '')
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    const n = parseInt(full.slice(0, 6), 16)
    if (!Number.isFinite(n)) return `rgba(0,0,0,${clamp(alpha, 0, 1)})`
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(alpha, 0, 1)})`
}

/**
 * Cast-shadow alpha from a subject matte.
 *
 * The silhouette is projected onto the ground: squashed vertically by `length`,
 * sheared by the light angle, anchored at the subject's lowest covered row (its
 * contact line). Softness then grows with distance FROM that contact line, which
 * is the part that sells it — a real shadow is crisp at the feet and diffuse away
 * from them.
 *
 * Pure: matte plane in, alpha plane out.
 */
export const castShadowAlpha = (matte, {
    angle = GLOBAL_LIGHT_ANGLE,
    length = 0.55,
    softness = 0.5,
    opacity = 0.45,
    threshold = 0.5,
} = {}) => {
    const { width, height } = matte
    const out = makePlane(width, height)

    // Contact line: the lowest row the subject actually covers.
    let contactY = 0
    for (let y = height - 1; y >= 0; y -= 1) {
        let covered = false
        for (let x = 0; x < width; x += 1) if (matte.data[y * width + x] >= threshold) { covered = true; break }
        if (covered) { contactY = y; break }
    }

    const rad = (angle * Math.PI) / 180
    const squash = clamp(length, 0.05, 2)
    // Light from the left throws the shadow right, and vice versa.
    const shear = -Math.cos(rad) * squash * 1.6

    for (let y = 0; y < height; y += 1) {
        // Height above the contact line, in source rows.
        const rows = contactY - y
        if (rows < 0) continue
        const targetY = Math.round(contactY - rows * squash)
        if (targetY < 0 || targetY >= height) continue
        for (let x = 0; x < width; x += 1) {
            const v = matte.data[y * width + x]
            if (v < 0.02) continue
            const targetX = Math.round(x + rows * shear)
            if (targetX < 0 || targetX >= width) continue
            const i = targetY * width + targetX
            if (v > out.data[i]) out.data[i] = v
        }
    }

    // Distance-graded softness: blur the whole projection once, then mix more of
    // the blurred copy the further a pixel is from the contact line.
    const soft = clamp(softness, 0, 1)
    if (soft > 0) {
        const maxSigma = Math.max(1, soft * Math.min(width, height) * 0.05)
        const blurred = gaussianBlur(out, maxSigma)
        const contact = makePlane(width, height)
        for (let x = 0; x < width; x += 1) {
            if (contactY >= 0 && contactY < height) contact.data[contactY * width + x] = 1
        }
        const dist = distanceTransform(contact, { threshold: 0.5 })
        const reach = Math.max(1, Math.min(width, height) * 0.35)
        for (let i = 0; i < out.data.length; i += 1) {
            const t = Math.min(1, dist.data[i] / reach)
            out.data[i] = out.data[i] * (1 - t) + blurred.data[i] * t
        }
    }

    const a = clamp(opacity, 0, 1)
    for (let i = 0; i < out.data.length; i += 1) out.data[i] = clamp(out.data[i] * a, 0, 1)
    return { alpha: out, contactY }
}

/** Colour a cast-shadow alpha plane into an RGBA canvas ready to composite. */
export const castShadowCanvas = (alphaPlane, { color = '#0b0d12' } = {}) => {
    const canvas = document.createElement('canvas')
    canvas.width = alphaPlane.width
    canvas.height = alphaPlane.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const rgba = rgbaFromHex(color, 1)
    const [r, g, b] = rgba.replace(/[^\d,]/g, '').split(',').map(Number)
    const imageData = ctx.createImageData(canvas.width, canvas.height)
    for (let p = 0, i = 0; p < alphaPlane.data.length; p += 1, i += 4) {
        imageData.data[i] = r
        imageData.data[i + 1] = g
        imageData.data[i + 2] = b
        imageData.data[i + 3] = Math.round(clamp(alphaPlane.data[p], 0, 1) * 255)
    }
    ctx.putImageData(imageData, 0, 0)
    return canvas
}
