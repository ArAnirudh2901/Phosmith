import { hexToRgb, hsvToRgb, rgbToHsv } from '@/lib/color-utils'

export const CLOSED_BRUSH_MIN_POINTS = 8

export const CLOSED_BRUSH_MIN_AREA = 64

export const pathLength = (points) => {
    let length = 0
    for (let i = 1; i < points.length; i += 1) {
        const dx = points[i].x - points[i - 1].x
        const dy = points[i].y - points[i - 1].y
        length += Math.sqrt(dx * dx + dy * dy)
    }
    return length
}

export const polygonArea = (points) => {
    let area = 0
    for (let i = 0; i < points.length; i += 1) {
        const a = points[i]
        const b = points[(i + 1) % points.length]
        area += a.x * b.y - b.x * a.y
    }
    return Math.abs(area) / 2
}

export const isClosedBrushPath = (points, brushSize) => {
    if (!Array.isArray(points) || points.length < CLOSED_BRUSH_MIN_POINTS) return false
    const first = points[0]
    const last = points[points.length - 1]
    const dx = last.x - first.x
    const dy = last.y - first.y
    const closeDistance = Math.sqrt(dx * dx + dy * dy)
    const radius = Math.max(0.5, brushSize / 2)
    const closeThreshold = Math.max(10, Math.min(96, radius * 1.5))
    const area = polygonArea(points)
    return (
        closeDistance <= closeThreshold &&
        pathLength(points) >= closeThreshold * 3 &&
        area >= Math.max(CLOSED_BRUSH_MIN_AREA, radius * radius * 3)
    )
}

// The megashader engine, the brush canvas, the layer geometry, and the SAM
// upload dims all speak the source element's NATURAL pixels, but Fabric's
// transform matrix (and pointToImageSpace) speak the object's logical
// width/height. These are equal for a freshly loaded image, but diverge when
// the object's width was set independently of its element (resize, re-encode,
// a chain restored from JSON). These two helpers convert between the spaces and
// are a strict no-op when the two sizes match, so they never touch the common
// case — they only rescue the mismatch that otherwise makes every brush/click
// land off-target while the marker overlay (same matrix) still tracks the cursor.
// Fabric swaps _element for the filtered canvas once a filter runs, and a
// canvas has no naturalWidth, so size reads must use the untouched source.
export const sourceNaturalSize = (img) => {
    const el = img?._originalElement || img?._element || img?.getElement?.()
    return {
        w: el?.naturalWidth || el?.width || 0,
        h: el?.naturalHeight || el?.height || 0,
    }
}

export const naturalVsObject = (img) => {
    const { w: natW, h: natH } = sourceNaturalSize(img)
    const bw = Math.max(1, Math.round(img?.width || natW || 1))
    const bh = Math.max(1, Math.round(img?.height || natH || 1))
    const differs = natW > 0 && natH > 0 && (natW !== bw || natH !== bh)
    return { natW, natH, bw, bh, differs }
}

export const toNaturalPx = (img, p) => {
    if (!p) return p
    const { natW, natH, bw, bh, differs } = naturalVsObject(img)
    return differs ? { x: p.x * (natW / bw), y: p.y * (natH / bh) } : p
}

export const toObjectPx = (img, p) => {
    if (!p) return p
    const { natW, natH, bw, bh, differs } = naturalVsObject(img)
    return differs ? { x: p.x * (bw / natW), y: p.y * (bh / natH) } : p
}

// Kinds whose mask texture is luma-styled — safe for click-select refine
// compositing (brush textures are alpha-styled; refine those with the brush).
export const REFINABLE_KINDS = ['semantic', 'lasso', 'path']

// 0..255 coverage → opaque luma canvas (the lasso/semantic texture convention).
export const coverToCanvas = (cover, w, h) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    const img = ctx.createImageData(w, h)
    const d = img.data
    for (let p = 0, i = 0; p < cover.length; p += 1, i += 4) {
        const v = cover[p]
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    return c
}

// Marquee outline in image px. Shift constrains to a square/circle, Alt draws
// from the centre (Photoshop modifiers).
export const marqueePoints = (a, b, shape, constrain, fromCenter) => {
    let dx = b.x - a.x
    let dy = b.y - a.y
    if (constrain) {
        const m = Math.max(Math.abs(dx), Math.abs(dy))
        dx = Math.sign(dx || 1) * m
        dy = Math.sign(dy || 1) * m
    }
    const x0 = fromCenter ? a.x - dx : a.x
    const y0 = fromCenter ? a.y - dy : a.y
    const l = Math.min(x0, a.x + dx), r = Math.max(x0, a.x + dx)
    const t = Math.min(y0, a.y + dy), btm = Math.max(y0, a.y + dy)
    if (shape === 'ellipse') {
        const cx = (l + r) / 2, cy = (t + btm) / 2, rx = (r - l) / 2, ry = (btm - t) / 2
        return Array.from({ length: 96 }, (_, i) => {
            const ang = (i / 96) * Math.PI * 2
            return { x: cx + rx * Math.cos(ang), y: cy + ry * Math.sin(ang) }
        })
    }
    return [{ x: l, y: t }, { x: r, y: t }, { x: r, y: btm }, { x: l, y: btm }]
}

// getMaskTexture may return ImageData — drawImage needs a canvas/image.
export const asDrawable = (t) => {
    if (!t) return null
    if (typeof ImageData !== 'undefined' && t instanceof ImageData) {
        const c = document.createElement('canvas')
        c.width = t.width
        c.height = t.height
        c.getContext('2d').putImageData(t, 0, 0)
        return c
    }
    return t
}

export const fillClosedBrushPath = (ctx, points, scale, brushSize) => {
    if (!ctx || !isClosedBrushPath(points, brushSize)) return false
    const s = Math.max(0.0001, scale || 1)
    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = 'rgba(255, 255, 255, 1)'
    ctx.beginPath()
    ctx.moveTo(points[0].x * s, points[0].y * s)
    for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x * s, points[i].y * s)
    }
    ctx.closePath()
    ctx.fill('evenodd')
    ctx.restore()
    return true
}

// A fill/tint that CONTRASTS with the image's dominant hue, so a freshly
// created selection's 'fill' output is visible instantly instead of blending
// in (the old fixed-magenta default vanished on magenta/pink photos). Rotate
// the dominant hue 180° and force a vivid, bright colour. Returns a 0-1 triple
// (the megashader fillColor space). Cyan fallback if the hex can't be parsed.
export const contrastFillFromHex = (hex) => {
    try {
        const hsv = rgbToHsv(hexToRgb(hex))
        const out = hsvToRgb((hsv.h + 180) % 360, Math.max(0.72, hsv.s), hsv.v < 0.55 ? 0.96 : 0.9)
        return { r: out.r / 255, g: out.g / 255, b: out.b / 255 }
    } catch {
        return { r: 0, g: 0.85, b: 1 }
    }
}
