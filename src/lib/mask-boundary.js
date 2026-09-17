// Thin boundary around a texture mask's coverage, ported from Mask Studio's
// drawMaskBoundary. A traced polygon only follows ONE region and reads only the
// red channel, so multi-part masks lost outlines and alpha-coverage brushes got
// none. Dilating the thresholded silhouette and punching the interior out traces
// every region in either coverage channel, as a static raster (no redraw loop).

const MAX_EDGE = 1024
const ACCENT = [0x53, 0xd8, 0xff]

const toCanvas = (tex) => {
    if (!tex) return null
    const w = tex.width || tex.naturalWidth || 0
    const h = tex.height || tex.naturalHeight || 0
    if (!w || !h) return null
    if (typeof ImageData !== 'undefined' && tex instanceof ImageData) {
        const c = document.createElement('canvas')
        c.width = w; c.height = h
        c.getContext('2d').putImageData(tex, 0, 0)
        return c
    }
    return tex
}

const ring = (out, sil, radius, w, h) => {
    const ctx = out.getContext('2d')
    for (let a = 0; a < Math.PI * 2 - 1e-3; a += Math.PI / 8) {
        ctx.drawImage(sil, Math.cos(a) * radius, Math.sin(a) * radius, w, h)
    }
}

/**
 * @param {HTMLCanvasElement|ImageData|ImageBitmap} texture  mask coverage
 * @param {{ screenPxPerSourcePx?: number, widthPx?: number }} [opts]
 *   screenPxPerSourcePx: on-screen px per texture px, so the ring keeps a
 *   roughly constant on-screen width at the current zoom.
 * @returns {HTMLCanvasElement|null} transparent canvas with only the edge drawn,
 *   sized to the texture's aspect (≤ MAX_EDGE on the long side).
 */
export const buildMaskBoundary = (texture, { screenPxPerSourcePx = 1, widthPx = 1.6 } = {}) => {
    const src = toCanvas(texture)
    if (!src) return null
    const sw = src.width || src.naturalWidth
    const sh = src.height || src.naturalHeight
    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh))
    const w = Math.max(2, Math.round(sw * scale))
    const h = Math.max(2, Math.round(sh * scale))

    const sil = document.createElement('canvas')
    sil.width = w; sil.height = h
    const sc = sil.getContext('2d', { willReadFrequently: true })
    sc.drawImage(src, 0, 0, w, h)
    const id = sc.getImageData(0, 0, w, h)
    const d = id.data
    let any = false
    for (let i = 0; i < d.length; i += 4) {
        // Opaque masks carry coverage in luma; painted brushes carry it in alpha.
        const cov = d[i + 3] >= 250 ? d[i] : d[i + 3]
        const on = cov >= 128
        if (on) any = true
        d[i] = ACCENT[0]; d[i + 1] = ACCENT[1]; d[i + 2] = ACCENT[2]; d[i + 3] = on ? 255 : 0
    }
    if (!any) return null
    sc.putImageData(id, 0, 0)

    // Ring radius in working px for a constant on-screen width.
    const screenPerWork = Math.max(1e-3, screenPxPerSourcePx / scale)
    const r = Math.max(1, widthPx / screenPerWork)

    // Dark halo first so the cyan edge reads on light photos too.
    const dark = document.createElement('canvas')
    dark.width = w; dark.height = h
    const dctx = dark.getContext('2d')
    dctx.drawImage(sil, 0, 0)
    dctx.globalCompositeOperation = 'source-in'
    dctx.fillStyle = 'rgba(0,0,0,0.6)'
    dctx.fillRect(0, 0, w, h)

    const out = document.createElement('canvas')
    out.width = w; out.height = h
    ring(out, dark, r + Math.max(1, r * 0.8), w, h)
    ring(out, sil, r, w, h)
    const octx = out.getContext('2d')
    octx.globalCompositeOperation = 'destination-out'
    octx.drawImage(sil, 0, 0)
    return out
}
