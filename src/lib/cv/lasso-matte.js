/**
 * Hand-drawn lasso → subject matte, decided by colour where the outline is loose.
 *
 * A lasso drawn around a subject is reliable deep inside and outside, and wrong
 * in a rim along its own edge: it takes in background wherever the hand went
 * wide. That rim is the trimap's unknown region. Colour statistics come from the
 * two regions the lasso IS right about — the interior well away from the edge
 * (subject) and a ring just outside it (background) — as two 16³ histograms, the
 * same likelihood model GrabCut seeds with, minus the graph cut. Each rim pixel
 * gets the subject posterior, trusted less near the drawn edge and more with
 * depth; a 3×3 mean removes speckle and the guided filter then lays the boundary
 * on the photo's own edges.
 *
 * Pure: an ImageData-shaped photo and a plane in, a plane out.
 */

import { boxMean, makePlane } from './box-filter.js'
import { signedDistanceTransform } from './distance-transform.js'
import { refineMatte } from './guided-filter.js'

const LUMA = [0.2126, 0.7152, 0.0722]
const bin = (r, g, b) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)

/**
 * @param {{ width:number, height:number, data:Uint8ClampedArray }} rgba  the photo
 * @param {{ width:number, height:number, data:Float32Array }} lasso  1 inside, 0 outside
 * @param {{ band?:number, guideRadius?:number }} [opts]  rim width and guided-filter
 *   radius, as fractions of the short side
 * @returns {{ width:number, height:number, data:Float32Array }} 0..1 matte
 */
export const lassoColourMatte = (rgba, lasso, { band = 0.07, guideRadius = 0.012 } = {}) => {
    const { width: W, height: H } = lasso
    const N = W * H
    if (!W || !H || rgba?.width !== W || rgba?.height !== H) return lasso
    const B = Math.max(2, Math.round(Math.min(W, H) * band))
    const sd = signedDistanceTransform(lasso)
    const d = rgba.data

    const fg = new Float64Array(4096)
    const bg = new Float64Array(4096)
    let nf = 0
    let nb = 0
    for (let p = 0, i = 0; p < N; p += 1, i += 4) {
        const s = sd.data[p]
        if (s < -B) { fg[bin(d[i], d[i + 1], d[i + 2])] += 1; nf += 1 }
        else if (s > 0 && s <= 2 * B) { bg[bin(d[i], d[i + 1], d[i + 2])] += 1; nb += 1 }
    }
    // Too thin a lasso, or one hugging the frame, leaves nothing to learn from.
    if (nf < 256 || nb < 256) return lasso

    const out = makePlane(W, H)
    const luma = makePlane(W, H)
    for (let p = 0, i = 0; p < N; p += 1, i += 4) {
        luma.data[p] = (d[i] * LUMA[0] + d[i + 1] * LUMA[1] + d[i + 2] * LUMA[2]) / 255
        const s = sd.data[p]
        if (s >= 0) continue                        // outside: the user said no
        if (s < -B) { out.data[p] = 1; continue }   // deep inside: the user said yes
        const k = bin(d[i], d[i + 1], d[i + 2])
        const pf = (fg[k] + 0.5) / nf
        const pb = (bg[k] + 0.5) / nb
        const post = pf / (pf + pb)
        const depth = -s / B
        out.data[p] = post + (1 - post) * depth * depth
    }
    const radius = Math.max(2, Math.round(Math.min(W, H) * guideRadius))
    return refineMatte(boxMean(out, 1), luma, { radius, eps: 1e-3, subsample: 2 })
}
