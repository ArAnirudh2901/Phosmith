/**
 * Summed-area (integral image) box mean — the O(1)-per-pixel primitive the rest
 * of the CV core is built on.
 *
 * A box mean of radius r costs four lookups regardless of r, which is what makes
 * the guided filter O(N) instead of O(N·r²). The accumulator is Float64 on
 * purpose: at 512² a Float32 running sum of luma already loses low bits, and the
 * guided filter subtracts two nearly equal sums (variance), where that loss
 * shows up as blocking.
 *
 * Planes are `{ width, height, data: Float32Array }`, one channel, row-major.
 * Pure: no DOM, no canvas, no Fabric.
 */

/** @typedef {{ width: number, height: number, data: Float32Array }} Plane */

/** A zeroed plane of the given size. */
export const makePlane = (width, height, fill = 0) => {
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    const data = new Float32Array(w * h)
    if (fill) data.fill(fill)
    return { width: w, height: h, data }
}

const assertPlane = (plane, name) => {
    if (!plane || !Number.isFinite(plane.width) || !Number.isFinite(plane.height) || !plane.data) {
        throw new Error(`[cv] ${name} must be a { width, height, data } plane`)
    }
    if (plane.data.length < plane.width * plane.height) {
        throw new Error(`[cv] ${name} data is shorter than width × height`)
    }
}

/** Element-wise map into a new plane. */
export const mapPlane = (plane, fn) => {
    assertPlane(plane, 'plane')
    const out = makePlane(plane.width, plane.height)
    for (let i = 0; i < out.data.length; i += 1) out.data[i] = fn(plane.data[i], i)
    return out
}

/** Element-wise combine of two same-sized planes. */
export const zipPlanes = (a, b, fn) => {
    assertPlane(a, 'a')
    assertPlane(b, 'b')
    if (a.width !== b.width || a.height !== b.height) throw new Error('[cv] zipPlanes: size mismatch')
    const out = makePlane(a.width, a.height)
    for (let i = 0; i < out.data.length; i += 1) out.data[i] = fn(a.data[i], b.data[i], i)
    return out
}

/**
 * Integral image with a zero first row/column, so a box sum is
 * `S[y1][x1] - S[y0][x1] - S[y1][x0] + S[y0][x0]` with no bounds branching.
 * Returns a (w+1)×(h+1) Float64Array.
 */
export const integralImage = (plane) => {
    assertPlane(plane, 'plane')
    const { width: w, height: h, data } = plane
    const stride = w + 1
    const sum = new Float64Array(stride * (h + 1))
    for (let y = 0; y < h; y += 1) {
        let rowSum = 0
        const inRow = y * w
        const outRow = (y + 1) * stride
        const prevRow = y * stride
        for (let x = 0; x < w; x += 1) {
            rowSum += data[inRow + x]
            sum[outRow + x + 1] = sum[prevRow + x + 1] + rowSum
        }
    }
    return { sum, stride, width: w, height: h }
}

/**
 * Mean over the (2r+1)² window around each pixel, clipped at the borders and
 * divided by the ACTUAL window area — dividing by the nominal area instead is
 * the classic bug that darkens every edge of the result.
 */
export const boxMean = (plane, radius) => {
    assertPlane(plane, 'plane')
    const r = Math.max(0, Math.floor(radius))
    if (r === 0) return mapPlane(plane, (v) => v)
    const { width: w, height: h } = plane
    const { sum, stride } = integralImage(plane)
    const out = makePlane(w, h)
    for (let y = 0; y < h; y += 1) {
        const y0 = Math.max(0, y - r)
        const y1 = Math.min(h, y + r + 1)
        const top = y0 * stride
        const bottom = y1 * stride
        for (let x = 0; x < w; x += 1) {
            const x0 = Math.max(0, x - r)
            const x1 = Math.min(w, x + r + 1)
            const total = sum[bottom + x1] - sum[top + x1] - sum[bottom + x0] + sum[top + x0]
            out.data[y * w + x] = total / ((y1 - y0) * (x1 - x0))
        }
    }
    return out
}

/** Box mean by area-averaging down to `width × height` — the downsample the fast
 *  guided filter needs (a plain nearest-neighbour pick aliases badly). */
export const resamplePlane = (plane, width, height) => {
    assertPlane(plane, 'plane')
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    if (w === plane.width && h === plane.height) return mapPlane(plane, (v) => v)
    const out = makePlane(w, h)
    const { sum, stride } = integralImage(plane)
    const sx = plane.width / w
    const sy = plane.height / h
    for (let y = 0; y < h; y += 1) {
        const y0 = Math.min(plane.height - 1, Math.floor(y * sy))
        const y1 = Math.max(y0 + 1, Math.min(plane.height, Math.ceil((y + 1) * sy)))
        const top = y0 * stride
        const bottom = y1 * stride
        for (let x = 0; x < w; x += 1) {
            const x0 = Math.min(plane.width - 1, Math.floor(x * sx))
            const x1 = Math.max(x0 + 1, Math.min(plane.width, Math.ceil((x + 1) * sx)))
            const total = sum[bottom + x1] - sum[top + x1] - sum[bottom + x0] + sum[top + x0]
            out.data[y * w + x] = total / ((y1 - y0) * (x1 - x0))
        }
    }
    return out
}

/** Bilinear upsample to `width × height` — how the fast guided filter's low-res
 *  coefficients get back to full size before being evaluated. */
export const upsamplePlane = (plane, width, height) => {
    assertPlane(plane, 'plane')
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    if (w === plane.width && h === plane.height) return mapPlane(plane, (v) => v)
    const out = makePlane(w, h)
    const { width: sw, height: sh, data } = plane
    // Map pixel CENTRES, so the result is not shifted by half a low-res pixel.
    const fx = sw / w
    const fy = sh / h
    for (let y = 0; y < h; y += 1) {
        const syf = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5))
        const y0 = Math.floor(syf)
        const y1 = Math.min(sh - 1, y0 + 1)
        const wy = syf - y0
        for (let x = 0; x < w; x += 1) {
            const sxf = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5))
            const x0 = Math.floor(sxf)
            const x1 = Math.min(sw - 1, x0 + 1)
            const wx = sxf - x0
            const a = data[y0 * sw + x0]
            const b = data[y0 * sw + x1]
            const c = data[y1 * sw + x0]
            const d = data[y1 * sw + x1]
            out.data[y * w + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy
        }
    }
    return out
}

/**
 * Separable Gaussian blur. Only used where a Gaussian is what the maths calls
 * for — the defocus estimator's known-σ re-blur — never as a general blur, since
 * the box mean above is cheaper and the GPU owns the visible blurs.
 */
export const gaussianBlur = (plane, sigma) => {
    assertPlane(plane, 'plane')
    const s = Math.max(0, Number(sigma) || 0)
    if (s < 1e-3) return mapPlane(plane, (v) => v)
    const radius = Math.max(1, Math.ceil(s * 3))
    const kernel = new Float64Array(radius * 2 + 1)
    let total = 0
    for (let i = -radius; i <= radius; i += 1) {
        const v = Math.exp(-(i * i) / (2 * s * s))
        kernel[i + radius] = v
        total += v
    }
    for (let i = 0; i < kernel.length; i += 1) kernel[i] /= total

    const { width: w, height: h, data } = plane
    const tmp = makePlane(w, h)
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            let acc = 0
            for (let k = -radius; k <= radius; k += 1) {
                const xx = Math.min(w - 1, Math.max(0, x + k))   // clamp at the border
                acc += data[y * w + xx] * kernel[k + radius]
            }
            tmp.data[y * w + x] = acc
        }
    }
    const out = makePlane(w, h)
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            let acc = 0
            for (let k = -radius; k <= radius; k += 1) {
                const yy = Math.min(h - 1, Math.max(0, y + k))
                acc += tmp.data[yy * w + x] * kernel[k + radius]
            }
            out.data[y * w + x] = acc
        }
    }
    return out
}
