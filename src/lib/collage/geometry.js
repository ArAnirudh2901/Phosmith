// Pure 2D helpers for the collage Composer: seeded randomness and convex
// polygon clipping/inset. Points are { x, y }; polygons are arrays of points.

export const mulberry32 = (seed) => {
    let a = (Number(seed) >>> 0) || 1
    return () => {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export const rectPoly = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
]

export const polygonArea = (poly) => {
    let a = 0
    for (let i = 0; i < poly.length; i += 1) {
        const p = poly[i]
        const q = poly[(i + 1) % poly.length]
        a += p.x * q.y - q.x * p.y
    }
    return a / 2
}

export const polygonCentroid = (poly) => {
    const a = polygonArea(poly)
    if (Math.abs(a) < 1e-9) {
        const n = Math.max(1, poly.length)
        return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n }
    }
    let cx = 0, cy = 0
    for (let i = 0; i < poly.length; i += 1) {
        const p = poly[i]
        const q = poly[(i + 1) % poly.length]
        const f = p.x * q.y - q.x * p.y
        cx += (p.x + q.x) * f
        cy += (p.y + q.y) * f
    }
    return { x: cx / (6 * a), y: cy / (6 * a) }
}

export const polygonBBox = (poly) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const p of poly) {
        if (p.x < x0) x0 = p.x
        if (p.y < y0) y0 = p.y
        if (p.x > x1) x1 = p.x
        if (p.y > y1) y1 = p.y
    }
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

/** Keep the part of a convex polygon where a·x + b·y <= c (Sutherland–Hodgman). */
export const clipHalfPlane = (poly, a, b, c) => {
    const out = []
    const inside = (p) => a * p.x + b * p.y <= c + 1e-9
    for (let i = 0; i < poly.length; i += 1) {
        const p = poly[i]
        const q = poly[(i + 1) % poly.length]
        const pin = inside(p)
        const qin = inside(q)
        if (pin) out.push(p)
        if (pin !== qin) {
            const dp = a * p.x + b * p.y - c
            const dq = a * q.x + b * q.y - c
            const t = dp / (dp - dq)
            out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
        }
    }
    return out
}

/**
 * Shrink a convex polygon by `d` along every edge normal (gutters between
 * shards). Returns null when the polygon collapses.
 */
export const insetConvex = (poly, d) => {
    if (!poly || poly.length < 3) return null
    if (d <= 0) return poly
    const sign = polygonArea(poly) > 0 ? 1 : -1
    let out = poly
    for (let i = 0; i < poly.length; i += 1) {
        const p = poly[i]
        const q = poly[(i + 1) % poly.length]
        const ex = q.x - p.x
        const ey = q.y - p.y
        const len = Math.hypot(ex, ey)
        if (len < 1e-9) continue
        // Inward normal for this winding; keep n·x >= n·p + d  ⇔  -n·x <= -(n·p + d)
        const nx = (-ey / len) * sign
        const ny = (ex / len) * sign
        out = clipHalfPlane(out, -nx, -ny, -(nx * p.x + ny * p.y + d))
        if (out.length < 3) return null
    }
    return Math.abs(polygonArea(out)) < 1 ? null : out
}

export const pointInPolygon = (pt, poly) => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
        const a = poly[i]
        const b = poly[j]
        if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
    return inside
}

/** Corners of a w×h rect centred at (cx, cy) rotated by `deg`. */
export const rotatedRect = (cx, cy, w, h, deg) => {
    const r = (deg * Math.PI) / 180
    const c = Math.cos(r)
    const s = Math.sin(r)
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
        .map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c }))
}

export const shuffleInPlace = (arr, rand) => {
    for (let i = arr.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1))
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
}

/** Clip any (possibly concave) polygon by a CONVEX polygon. */
export const clipByConvex = (subject, convex) => {
    if (!subject || subject.length < 3 || !convex || convex.length < 3) return []
    const sign = polygonArea(convex) > 0 ? 1 : -1
    let out = subject
    for (let i = 0; i < convex.length && out.length >= 3; i += 1) {
        const p = convex[i]
        const q = convex[(i + 1) % convex.length]
        const ex = q.x - p.x
        const ey = q.y - p.y
        // Interior is on the left of each edge for positive winding: ex*(y-py) - ey*(x-px) >= 0
        out = clipHalfPlane(out, sign * ey, -sign * ex, sign * (ey * p.x - ex * p.y))
    }
    return out.length >= 3 ? out : []
}
