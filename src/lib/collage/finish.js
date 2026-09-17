// Composer finish: backdrop colours derived from the photos, procedural
// backdrops (no generative model, no stock art) and per-photo "harmony"
// adjustments that pull differently-shot photos toward one shared look.

import { mulberry32, clamp } from './geometry'

const hexToRgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
    if (!m) return [128, 128, 128]
    const v = parseInt(m[1], 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}
const rgbToHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`

const rgbToHsl = ([r, g, b]) => {
    r /= 255; g /= 255; b /= 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    const l = (max + min) / 2
    if (max === min) return [0, 0, l]
    const d = max - min
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return [h / 6, s, l]
}
const hslToHex = (h, s, l) => {
    const hue = (p, q, t) => {
        if (t < 0) t += 1
        if (t > 1) t -= 1
        if (t < 1 / 6) return p + (q - p) * 6 * t
        if (t < 1 / 2) return q
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
        return p
    }
    if (s === 0) return rgbToHex(l * 255, l * 255, l * 255)
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    return rgbToHex(hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255)
}
const shade = (hex, { l, s, dh = 0 }) => {
    const [h, sat, lum] = rgbToHsl(hexToRgb(hex))
    return hslToHex((h + dh + 1) % 1, s === undefined ? sat : s, l === undefined ? lum : l)
}

/**
 * Backdrop palette from the photos (or the brief's colours). Picks a base with
 * deliberate contrast against the photos' average brightness.
 */
export const synthesizePalette = (analyses, finish = {}) => {
    const pool = []
    analyses.forEach((a) => a.palette.forEach((c) => pool.push({ hex: c.hex, w: c.weight * (0.4 + a.weight), l: c.l, s: rgbToHsl(c.rgb)[1] })))
    // Prefer chromatic, mid-weight colours as accents.
    const accents = pool.slice().sort((a, b) => (b.w * (0.3 + b.s)) - (a.w * (0.3 + a.s))).map((c) => c.hex)
    const meanL = analyses.reduce((s, a) => s + a.luminance, 0) / Math.max(1, analyses.length)
    const look = finish.look || 'natural'
    const wantsDark = look === 'moody' || look === 'mono' || (look !== 'soft' && meanL > 0.58)
    const brief = (finish.colors || []).filter(Boolean)
    const seed = brief[0] || accents[0] || '#808080'
    const baseL = wantsDark ? 0.09 : look === 'soft' ? 0.93 : 0.9
    const baseS = look === 'mono' ? 0 : look === 'vivid' ? 0.45 : wantsDark ? 0.25 : 0.22
    const base = brief.length && (hexToRgb(brief[0]).reduce((s, v) => s + v, 0) / 765 < 0.2 || hexToRgb(brief[0]).reduce((s, v) => s + v, 0) / 765 > 0.85)
        ? brief[0]
        : shade(seed, { l: baseL, s: baseS })
    const acc = (brief.slice(1).length ? brief.slice(1) : accents.slice(0, 4)).map((hex, i) => (
        look === 'mono' ? shade(hex, { s: 0, l: wantsDark ? 0.22 + i * 0.06 : 0.78 - i * 0.05 })
            : shade(hex, { s: clamp(rgbToHsl(hexToRgb(hex))[1] * (look === 'vivid' ? 1.3 : 0.85), 0, 0.9), l: wantsDark ? 0.3 + i * 0.05 : 0.72 + i * 0.04 })
    ))
    return { base, accents: acc.length ? acc : [shade(base, { l: wantsDark ? 0.28 : 0.78, dh: 0.05 })], dark: wantsDark }
}

/** Instant, serialisable backdrop (no upload) when no texture is needed. */
export const nativeBackdrop = (kind, palette) => {
    if (kind === 'solid') return { type: 'solid', color: palette.base }
    const second = shade(palette.accents[0] || palette.base, { l: rgbToHsl(hexToRgb(palette.base))[2] * (palette.dark ? 1.9 : 0.94) })
    return { type: 'gradient', stops: [palette.base, second] }
}

export const needsRenderedBackdrop = (finish) => finish.backdrop === 'aura' || finish.backdrop === 'echo' || finish.backdrop === 'paper' || finish.grain > 0.05

const addGrain = (ctx, w, h, amount, rand) => {
    if (amount <= 0.02) return
    const tile = document.createElement('canvas')
    tile.width = 256
    tile.height = 256
    const tctx = tile.getContext('2d')
    const img = tctx.createImageData(256, 256)
    for (let i = 0; i < img.data.length; i += 4) {
        const v = 128 + (rand() - 0.5) * 255
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255
    }
    tctx.putImageData(img, 0, 0)
    ctx.save()
    ctx.globalAlpha = clamp(amount, 0, 1) * 0.22
    ctx.globalCompositeOperation = 'overlay'
    ctx.fillStyle = ctx.createPattern(tile, 'repeat')
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
}

/**
 * Paint a textured backdrop. Rendered at ≤ 1600 px (it is soft by design) and
 * uploaded by the caller so canvas state stays small.
 */
export const renderBackdrop = ({ width, height }, finish, palette, { heroEl = null, seed = 1 } = {}) => {
    const scale = Math.min(1, 1600 / Math.max(width, height))
    const w = Math.max(64, Math.round(width * scale))
    const h = Math.max(64, Math.round(height * scale))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    const rand = mulberry32(seed)
    const S = Math.min(w, h)
    ctx.fillStyle = palette.base
    ctx.fillRect(0, 0, w, h)

    if (finish.backdrop === 'echo' && heroEl) {
        const ew = heroEl.naturalWidth || heroEl.width
        const eh = heroEl.naturalHeight || heroEl.height
        const s = Math.max(w / ew, h / eh) * 1.12
        ctx.save()
        ctx.filter = `blur(${Math.round(S * 0.05)}px) saturate(1.15) brightness(${palette.dark ? 0.55 : 0.95})`
        ctx.drawImage(heroEl, (w - ew * s) / 2, (h - eh * s) / 2, ew * s, eh * s)
        ctx.restore()
        ctx.fillStyle = palette.base
        ctx.globalAlpha = palette.dark ? 0.35 : 0.28
        ctx.fillRect(0, 0, w, h)
        ctx.globalAlpha = 1
    } else if (finish.backdrop === 'aura') {
        const blobs = (palette.accents.length ? palette.accents : [palette.base]).slice(0, 4)
        blobs.forEach((hex, i) => {
            const cx = w * (0.15 + rand() * 0.7), cy = h * (0.15 + rand() * 0.7)
            const r = S * (0.55 + rand() * 0.35)
            const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
            const [rr, gg, bb] = hexToRgb(hex)
            g.addColorStop(0, `rgba(${rr},${gg},${bb},${palette.dark ? 0.55 : 0.65})`)
            g.addColorStop(1, `rgba(${rr},${gg},${bb},0)`)
            ctx.fillStyle = g
            ctx.globalCompositeOperation = i === 0 ? 'source-over' : (palette.dark ? 'screen' : 'multiply')
            ctx.fillRect(0, 0, w, h)
        })
        ctx.globalCompositeOperation = 'source-over'
    } else if (finish.backdrop === 'paper') {
        // Mottled stock + fibres.
        for (let i = 0; i < 90; i += 1) {
            const cx = rand() * w, cy = rand() * h, r = S * (0.05 + rand() * 0.2)
            const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
            const tone = palette.dark ? 255 : 0
            g.addColorStop(0, `rgba(${tone},${tone},${tone},${0.018 + rand() * 0.02})`)
            g.addColorStop(1, `rgba(${tone},${tone},${tone},0)`)
            ctx.fillStyle = g
            ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
        }
        ctx.lineWidth = Math.max(0.6, S / 1400)
        for (let i = 0; i < 700; i += 1) {
            const x = rand() * w, y = rand() * h, len = S * (0.006 + rand() * 0.02), a = rand() * Math.PI
            ctx.strokeStyle = palette.dark ? `rgba(255,255,255,${0.03 + rand() * 0.04})` : `rgba(90,70,50,${0.04 + rand() * 0.05})`
            ctx.beginPath()
            ctx.moveTo(x, y)
            ctx.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + (rand() - 0.5) * len * 0.3, y + Math.sin(a) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len)
            ctx.stroke()
        }
    } else {
        const native = nativeBackdrop(finish.backdrop, palette)
        if (native.type === 'gradient') {
            const g = ctx.createLinearGradient(0, 0, w, h)
            native.stops.forEach((hex, i) => g.addColorStop(i / (native.stops.length - 1), hex))
            ctx.fillStyle = g
            ctx.fillRect(0, 0, w, h)
        }
    }
    // Gentle vignette keeps the eye on the photos.
    const v = ctx.createRadialGradient(w / 2, h / 2, S * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.62)
    v.addColorStop(0, 'rgba(0,0,0,0)')
    v.addColorStop(1, `rgba(0,0,0,${palette.dark ? 0.35 : 0.08})`)
    ctx.fillStyle = v
    ctx.fillRect(0, 0, w, h)
    addGrain(ctx, w, h, finish.grain, rand)
    return c
}

const LOOK_SHIFT = {
    natural: { L: 1, warmth: 0, sat: 0, contrast: 0 },
    warm: { L: 1.02, warmth: 0.05, sat: 4, contrast: 2 },
    cool: { L: 1, warmth: -0.05, sat: -2, contrast: 2 },
    moody: { L: 0.82, warmth: -0.01, sat: -14, contrast: 12 },
    vintage: { L: 1.03, warmth: 0.035, sat: -20, contrast: -14 },
    vivid: { L: 1.02, warmth: 0, sat: 20, contrast: 8 },
    soft: { L: 1.06, warmth: 0.01, sat: -8, contrast: -12 },
    mono: { L: 1, warmth: 0, sat: -100, contrast: 10 },
}

/**
 * Per-photo adjustment layers (megashader units) pulling each photo toward the
 * set's weighted mean tone, shifted by the look. `harmony` 0 = only the look.
 */
export const harmonyAdjustments = (analyses, finish = {}) => {
    const h = clamp(Number(finish.harmony) || 0, 0, 1)
    const look = LOOK_SHIFT[finish.look] || LOOK_SHIFT.natural
    const wsum = analyses.reduce((s, a) => s + 0.4 + a.weight, 0) || 1
    const avg = (fn) => analyses.reduce((s, a) => s + fn(a) * (0.4 + a.weight), 0) / wsum
    const Lt = clamp(avg((a) => a.luminance) * look.L, 0.08, 0.85)
    const Wt = avg((a) => a.warmth) + look.warmth
    const Gt = avg((a) => a.mean.g - (a.mean.r + a.mean.b) / 2)
    const Ct = avg((a) => a.colorfulness)
    const Kt = avg((a) => a.contrast)
    return analyses.map((a) => {
        const G = a.mean.g - (a.mean.r + a.mean.b) / 2
        const out = {
            exposure: clamp(Math.log2(Lt / Math.max(0.02, a.luminance)), -0.8, 0.8) * h,
            temperature: clamp((Wt - a.warmth) / 0.01, -45, 45) * h + (h === 0 ? look.warmth / 0.01 : 0),
            tint: clamp(-(Gt - G) / 0.005, -35, 35) * h,
            saturation: look.sat === -100 ? -100 : clamp(clamp((Ct / Math.max(0.02, a.colorfulness) - 1) * 60, -40, 40) * h + look.sat, -100, 100),
            contrast: clamp(clamp((Kt / Math.max(0.02, a.contrast) - 1) * 40, -25, 25) * h + look.contrast, -100, 100),
        }
        Object.keys(out).forEach((k) => { out[k] = Math.round(out[k] * 100) / 100 })
        return out
    })
}

export const isNeutralAdjustment = (adj) => Object.entries(adj).every(([k, v]) => Math.abs(v) < (k === 'exposure' ? 0.02 : 0.5))
