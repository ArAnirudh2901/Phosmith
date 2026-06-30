/**
 * Pen / Bézier path rasteriser for the `path` mask kind.
 *
 * The authoring UI collects a list of ANCHOR points; each anchor may carry
 * outgoing/incoming Bézier control handles:
 *
 *     { x, y, cOut?: {x, y}, cIn?: {x, y} }
 *
 * A segment from anchor A to anchor B is a cubic Bézier using control points
 * `A.cOut` and `B.cIn`. When either handle is missing the segment is a
 * straight line (so this same module also rasterises a plain polygon — the
 * lasso — when no handles are supplied).
 *
 * `rasterisePath` fills the CLOSED path to an alpha texture (white inside,
 * transparent outside) and is uploaded by the renderer exactly like the lasso
 * mask. In the browser it uses Canvas2D `bezierCurveTo` (fast, anti-aliased);
 * in a headless/SSR/Worker context with no canvas it falls back to the pure
 * scanline rasteriser below — which is also what the verify suite exercises.
 */

const hasHandles = (a, b) => !!(a && b && a.cOut && b.cIn)

/** Sample a cubic Bézier at parameter t (0..1). */
const cubicAt = (p0, c0, c1, p1, t) => {
    const u = 1 - t
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
    return {
        x: a * p0.x + b * c0.x + c * c1.x + d * p1.x,
        y: a * p0.y + b * c0.y + c * c1.y + d * p1.y,
    }
}

/**
 * Convert a list of bare anchor points into a smooth Bézier path by deriving
 * Catmull-Rom control handles (cOut/cIn) for each anchor. Turns a polygonal
 * lasso capture into smooth pen-tool curves. `tension` 0 → straight (no curve),
 * 1 → classic Catmull-Rom.
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {object} [opts]
 * @param {boolean} [opts.closed=true]
 * @param {number} [opts.tension=1]
 * @returns {Array<{x:number,y:number,cOut:object,cIn:object}>}
 */
export function smoothToBezier(points, { closed = true, tension = 1 } = {}) {
    const n = points ? points.length : 0
    if (n < 3) return (points || []).map((p) => ({ x: p.x, y: p.y }))
    const k = tension / 6
    const out = []
    for (let i = 0; i < n; i++) {
        const prev = closed ? points[(i - 1 + n) % n] : points[Math.max(0, i - 1)]
        const next = closed ? points[(i + 1) % n] : points[Math.min(n - 1, i + 1)]
        const tx = (next.x - prev.x) * k
        const ty = (next.y - prev.y) * k
        out.push({
            x: points[i].x, y: points[i].y,
            cOut: { x: points[i].x + tx, y: points[i].y + ty },
            cIn: { x: points[i].x - tx, y: points[i].y - ty },
        })
    }
    return out
}

/**
 * Flatten a Bézier path into a dense polyline of {x,y} vertices. Straight
 * segments (no handles) contribute just their endpoint; curved segments are
 * sampled at `steps` points. Always returns a closed-ready vertex list.
 *
 * @param {Array<{x:number,y:number,cOut?:object,cIn?:object}>} points
 * @param {object} [opts]
 * @param {boolean} [opts.closed=true]
 * @param {number} [opts.steps=24]   samples per curved segment
 * @returns {Array<{x:number,y:number}>}
 */
export function flattenPath(points, { closed = true, steps = 24 } = {}) {
    if (!Array.isArray(points) || points.length < 2) return []
    const out = [{ x: points[0].x, y: points[0].y }]
    const n = points.length
    const last = closed ? n : n - 1
    for (let i = 0; i < last; i++) {
        const a = points[i]
        const b = points[(i + 1) % n]
        if (hasHandles(a, b)) {
            for (let s = 1; s <= steps; s++) out.push(cubicAt(a, a.cOut, b.cIn, b, s / steps))
        } else {
            out.push({ x: b.x, y: b.y })
        }
    }
    return out
}

/** Even-odd ray-cast point-in-polygon test against a flattened vertex list. */
export function pointInPolygon(poly, x, y) {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y
        const xj = poly[j].x, yj = poly[j].y
        const intersect = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi)
        if (intersect) inside = !inside
    }
    return inside
}

/**
 * Pure (no-Canvas) rasteriser → ImageData-shaped object. White (R=255) inside
 * the filled path, with 2×2 supersampled coverage at the edge for anti-alias.
 * Used as the headless fallback and by the verify suite.
 *
 * @returns {{width:number, height:number, data:Uint8ClampedArray}}
 */
export function rasterisePathData(points, width, height, { closed = true, steps = 24 } = {}) {
    const poly = flattenPath(points, { closed, steps })
    const data = new Uint8ClampedArray(width * height * 4)
    if (poly.length >= 3) {
        // bounding box to skip empty rows/cols
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const p of poly) {
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
        }
        minX = Math.max(0, Math.floor(minX)); minY = Math.max(0, Math.floor(minY))
        maxX = Math.min(width - 1, Math.ceil(maxX)); maxY = Math.min(height - 1, Math.ceil(maxY))
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                let hits = 0
                for (let sy = 0; sy < 2; sy++) {
                    for (let sx = 0; sx < 2; sx++) {
                        if (pointInPolygon(poly, x + 0.25 + sx * 0.5, y + 0.25 + sy * 0.5)) hits++
                    }
                }
                const cov = (hits / 4) * 255
                const idx = (y * width + x) * 4
                data[idx] = cov; data[idx + 1] = cov; data[idx + 2] = cov; data[idx + 3] = 255
            }
        }
    }
    return { width, height, data }
}

/** Trace a Bézier path onto a Canvas2D context (moveTo + bezier/lineTo). */
function tracePath(ctx, points, closed) {
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    const n = points.length
    const last = closed ? n : n - 1
    for (let i = 0; i < last; i++) {
        const a = points[i]
        const b = points[(i + 1) % n]
        if (hasHandles(a, b)) ctx.bezierCurveTo(a.cOut.x, a.cOut.y, b.cIn.x, b.cIn.y, b.x, b.y)
        else ctx.lineTo(b.x, b.y)
    }
    if (closed) ctx.closePath()
}

/**
 * Rasterise the closed path to an alpha texture sized `width`×`height`.
 * Browser → an (Offscreen)Canvas (fast, AA). Headless → ImageData-shaped
 * object from `rasterisePathData`. Either is accepted by `setMaskTexture`.
 *
 * @param {Array<{x:number,y:number,cOut?:object,cIn?:object}>} points  image-space px
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 * @param {boolean} [opts.closed=true]
 * @returns {HTMLCanvasElement | OffscreenCanvas | {width:number,height:number,data:Uint8ClampedArray}}
 */
export function rasterisePath(points, width, height, { closed = true } = {}) {
    if (!Array.isArray(points) || points.length < 2) {
        return rasterisePathData(points || [], width, height, { closed })
    }
    const canCanvas = typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined'
    if (canCanvas) {
        const canvas = (typeof OffscreenCanvas !== 'undefined')
            ? new OffscreenCanvas(width, height)
            : document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        // Fill white ON OPAQUE BLACK (not transparent) so Canvas2D edge
        // anti-aliasing lands in the R channel the `path` GLSL samples —
        // identical to how `rasterizeLasso` does it. A transparent clear
        // would leave edge pixels at R=255 (premultiplied), hardening the edge.
        ctx.fillStyle = '#000000'
        ctx.fillRect(0, 0, width, height)
        ctx.fillStyle = '#ffffff'
        tracePath(ctx, points, closed)
        ctx.fill('nonzero')
        return canvas
    }
    return rasterisePathData(points, width, height, { closed })
}
