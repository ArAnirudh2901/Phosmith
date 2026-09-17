// Photoshop-style Magic Wand: select pixels whose colour is within `tolerance`
// of the sampled seed colour, either the connected region (contiguous) or the
// whole image. Pure and DOM-free so it's unit-testable.

import { boxBlur } from './mask-grow-core'

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)))

// Seed colour: the clicked pixel, or the mean of its 3×3 / 5×5 neighbourhood.
const sampleSeed = (rgba, w, h, x, y, sample) => {
    const r = sample === '5x5' ? 2 : sample === '3x3' ? 1 : 0
    let sr = 0, sg = 0, sb = 0, n = 0
    for (let dy = -r; dy <= r; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -r; dx <= r; dx += 1) {
            const xx = x + dx
            if (xx < 0 || xx >= w) continue
            const i = (yy * w + xx) * 4
            sr += rgba[i]; sg += rgba[i + 1]; sb += rgba[i + 2]; n += 1
        }
    }
    return [sr / n, sg / n, sb / n]
}

/**
 * @param {Uint8ClampedArray} rgba  source pixels (w×h×4)
 * @param {number} w
 * @param {number} h
 * @param {number} x  seed column (working px)
 * @param {number} y  seed row (working px)
 * @param {{ tolerance?: number, contiguous?: boolean, antiAlias?: boolean, sample?: 'point'|'3x3'|'5x5' }} [opts]
 *   tolerance 0..255 — max per-channel difference from the seed (Photoshop default 32).
 * @returns {{ cover: Uint8ClampedArray, count: number }} 0..255 coverage and selected pixel count
 */
export const magicWandMask = (rgba, w, h, x, y, { tolerance = 32, contiguous = true, antiAlias = true, sample = 'point' } = {}) => {
    const n = w * h
    const cover = new Uint8ClampedArray(n)
    if (!rgba || w < 1 || h < 1 || rgba.length < n * 4) return { cover, count: 0 }
    const sx = clampInt(x, 0, w - 1)
    const sy = clampInt(y, 0, h - 1)
    const tol = clampInt(tolerance, 0, 255)
    const [r0, g0, b0] = sampleSeed(rgba, w, h, sx, sy, sample)
    const match = (p) => {
        const i = p * 4
        return Math.abs(rgba[i] - r0) <= tol && Math.abs(rgba[i + 1] - g0) <= tol && Math.abs(rgba[i + 2] - b0) <= tol
    }

    let count = 0
    let minX = w, minY = h, maxX = -1, maxY = -1
    if (!contiguous) {
        for (let p = 0; p < n; p += 1) if (match(p)) { cover[p] = 255; count += 1 }
        minX = 0; minY = 0; maxX = w - 1; maxY = h - 1
    } else {
        // Scanline flood fill; `cover` doubles as the visited set.
        const stack = [sx, sy]
        while (stack.length) {
            const yy = stack.pop()
            let xx = stack.pop()
            const row = yy * w
            if (cover[row + xx] || !match(row + xx)) continue
            while (xx > 0 && !cover[row + xx - 1] && match(row + xx - 1)) xx -= 1
            let up = false, down = false
            for (; xx < w && !cover[row + xx] && match(row + xx); xx += 1) {
                cover[row + xx] = 255
                count += 1
                if (xx < minX) minX = xx
                if (xx > maxX) maxX = xx
                if (yy < minY) minY = yy
                if (yy > maxY) maxY = yy
                if (yy > 0) {
                    const m = !cover[row - w + xx] && match(row - w + xx)
                    if (m && !up) stack.push(xx, yy - 1)
                    up = m
                }
                if (yy < h - 1) {
                    const m = !cover[row + w + xx] && match(row + w + xx)
                    if (m && !down) stack.push(xx, yy + 1)
                    down = m
                }
            }
        }
    }

    if (antiAlias && count > 0) {
        // Blur only the selection's bounding box (+1px) instead of the whole image.
        const x0 = Math.max(0, minX - 1), y0 = Math.max(0, minY - 1)
        const bw = Math.min(w - 1, maxX + 1) - x0 + 1, bh = Math.min(h - 1, maxY + 1) - y0 + 1
        const sub = new Uint8ClampedArray(bw * bh)
        for (let y = 0; y < bh; y += 1) sub.set(cover.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + bw), y * bw)
        const soft = boxBlur(sub, bw, bh, 1)
        for (let y = 0; y < bh; y += 1) {
            for (let x = 0; x < bw; x += 1) cover[(y0 + y) * w + x0 + x] = soft[y * bw + x]
        }
    }
    return { cover, count }
}
