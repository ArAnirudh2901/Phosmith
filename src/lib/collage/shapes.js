// Container shapes for Silhouette collages: a subject's own outline (from its
// matte), a typed word, or a symbol. Output: { aspect, polygons } with points
// normalised to the shape's bounding box.

import { traceContour } from '../contour-trace'

const normalise = (polys) => {
    const all = polys.flat()
    if (!all.length) return null
    const x0 = Math.min(...all.map((p) => p.x)), x1 = Math.max(...all.map((p) => p.x))
    const y0 = Math.min(...all.map((p) => p.y)), y1 = Math.max(...all.map((p) => p.y))
    const w = Math.max(1e-6, x1 - x0), h = Math.max(1e-6, y1 - y0)
    return { aspect: w / h, polygons: polys.map((poly) => poly.map((p) => ({ x: (p.x - x0) / w, y: (p.y - y0) / h }))) }
}

/** Largest outline of a matte canvas (white = subject). */
export const shapeFromMatte = (matte) => {
    const traced = traceContour(matte, { simplifyEpsilon: 0.004, minPoints: 12 })
    if (!traced?.polygon?.length) return null
    // traceContour is normalised to the matte; restore pixel aspect before re-normalising.
    return normalise([traced.polygon.map((p) => ({ x: p.x * matte.width, y: p.y * matte.height }))])
}

/** One outline per glyph of a word (spaces keep their width). */
export const shapeFromText = (text, { font = '900 400px "Arial Black", Impact, system-ui, sans-serif' } = {}) => {
    const word = String(text || '').trim().slice(0, 12)
    if (!word) return null
    const measure = document.createElement('canvas').getContext('2d')
    measure.font = font
    const polys = []
    let cursor = 0
    for (const ch of word) {
        const adv = measure.measureText(ch).width
        if (ch.trim()) {
            const m = measure.measureText(ch)
            const gw = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight) + 16
            const gh = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) + 16
            const c = document.createElement('canvas')
            c.width = Math.max(8, gw)
            c.height = Math.max(8, gh)
            const ctx = c.getContext('2d')
            ctx.fillStyle = '#000'
            ctx.fillRect(0, 0, c.width, c.height)
            ctx.fillStyle = '#fff'
            ctx.font = font
            ctx.textBaseline = 'alphabetic'
            ctx.fillText(ch, 8 + m.actualBoundingBoxLeft, 8 + m.actualBoundingBoxAscent)
            const traced = traceContour(c, { simplifyEpsilon: 0.006, minPoints: 6 })
            if (traced?.polygon?.length) {
                const ox = cursor - m.actualBoundingBoxLeft - 8
                const oy = -m.actualBoundingBoxAscent - 8
                polys.push(traced.polygon.map((p) => ({ x: ox + p.x * c.width, y: oy + p.y * c.height })))
            }
        }
        cursor += adv * 1.02
    }
    return polys.length ? normalise(polys) : null
}

const ring = (n, fn) => Array.from({ length: n }, (_, i) => fn((i / n) * Math.PI * 2, i))

export const presetShape = (name) => {
    if (name === 'heart') {
        return normalise([ring(96, (t) => ({ x: 16 * Math.sin(t) ** 3, y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) }))])
    }
    if (name === 'star') {
        return normalise([ring(10, (t, i) => { const r = i % 2 ? 0.46 : 1; return { x: Math.sin(t) * r, y: -Math.cos(t) * r } })])
    }
    if (name === 'circle') return normalise([ring(72, (t) => ({ x: Math.cos(t), y: Math.sin(t) }))])
    return null
}

export const PRESET_SHAPES = ['heart', 'circle', 'star']
