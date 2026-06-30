/**
 * Standalone WebGL test harness for the megashader masking feature.
 * NO auth, NO Next.js, NO Fabric — imports the real render modules directly
 * and exercises: radial / linear / PEN-PATH masks + per-mask local
 * adjustments incl. the new VIBRANCE / TEXTURE / DEHAZE. Bundled with
 * `bun build` and driven by the dev-browser skill.
 */
import { renderMegashader } from '../../src/lib/megashader/megashader-renderer.js'
import {
    radialLayer, linearLayer, pathLayer, sanitiseLayer, setMaskTexture,
} from '../../src/lib/megashader/mask-types.js'
import { rasterisePath, smoothToBezier } from '../../src/lib/megashader/path-raster.js'

const WORK = 1100
const log = (m) => { const el = document.getElementById('log'); el.textContent += m + '\n'; console.log('[harness]', m) }

const meanAbsDiff = (a, b) => {
    let s = 0, n = a.length
    for (let i = 0; i < n; i += 4) { s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) }
    return s / (n / 4 * 3)
}
// mean abs diff over a rectangular patch (x0,y0,x1,y1 in 0..1 of the image)
const patchDiff = (a, b, w, h, x0, y0, x1, y1) => {
    let s = 0, c = 0
    for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y++)
        for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w); x++) {
            const i = (y * w + x) * 4
            s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); c += 3
        }
    return c ? s / c : 0
}

function tile(parent, title) {
    const wrap = document.createElement('div'); wrap.className = 'tile'
    const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = title
    const cv = document.createElement('canvas'); cv.className = 'out'
    wrap.appendChild(cv); wrap.appendChild(cap); parent.appendChild(wrap)
    return cv
}

function drawResult(displayCanvas, resultCanvas) {
    displayCanvas.width = resultCanvas.width; displayCanvas.height = resultCanvas.height
    displayCanvas.getContext('2d').drawImage(resultCanvas, 0, 0)
}

async function main() {
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'test.png?' + Date.now() })

    const scale = Math.min(1, WORK / Math.max(img.naturalWidth, img.naturalHeight))
    const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale)
    const src = document.createElement('canvas'); src.width = W; src.height = H
    const sctx = src.getContext('2d', { willReadFrequently: true })
    sctx.drawImage(img, 0, 0, W, H)
    const origData = sctx.getImageData(0, 0, W, H).data
    const imageSize = { width: W, height: H }
    log(`image ${img.naturalWidth}×${img.naturalHeight} → working ${W}×${H}`)
    log(`WebGL2 available: ${(() => { try { return !!document.createElement('canvas').getContext('webgl2') } catch { return false } })()}`)

    const grid = document.getElementById('grid')
    const adj = (base, props) => sanitiseLayer({ ...base, ...props, fillMode: props.fillMode || 'adjust' })
    const center = { x: W * 0.46, y: H * 0.42 }

    // result reader: render → copy to display → return its ImageData
    const run = (title, chain) => {
        const cv = tile(grid, title)
        const result = renderMegashader(src, { chain })
        drawResult(cv, result)
        const data = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data
        return data
    }

    // ── 0 · Original (identity) ──
    run('0 · Original', [])

    // ── 1 · Radial mask · FILL (shows the mask shape as a red overlay) ──
    {
        const layer = sanitiseLayer({
            ...radialLayer({ center, radius: { x: W * 0.34, y: H * 0.34 }, feather: 0.5, imageSize }),
            fillMode: 'fill', fillColor: { r: 1, g: 0.15, b: 0.2 }, fillStrength: 0.6,
        })
        run('1 · Radial FILL (shape)', [{ layer, op: 'replace' }])
    }

    // ── 2 · Radial · ADJUST · Exposure + Saturation + VIBRANCE (subject pop) ──
    {
        const base = radialLayer({ center, radius: { x: W * 0.34, y: H * 0.34 }, feather: 0.55, imageSize })
        const layer = adj(base, { exposure: 1.3, saturation: 35, vibrance: 85, contrast: 18 })
        const d = run('2 · Radial ADJUST exp+sat+VIBRANCE', [{ layer, op: 'replace' }])
        const inside = patchDiff(origData, d, W, H, 0.38, 0.34, 0.54, 0.5)
        const outside = patchDiff(origData, d, W, H, 0.86, 0.04, 0.99, 0.2)
        log(`#2 local? inside Δ=${inside.toFixed(1)}  outside Δ=${outside.toFixed(1)}  → ${inside > outside * 3 ? 'LOCAL ✓' : 'check'}`)
    }

    // ── 3 · Linear mask (top→bottom) · ADJUST · Temp + DEHAZE (cool sky) ──
    {
        const base = linearLayer({ p1: { x: W / 2, y: 0 }, p2: { x: W / 2, y: H * 0.55 }, feather: 0.6, imageSize })
        const layer = adj(base, { temperature: -55, contrast: 22, dehaze: 60 })
        const d = run('3 · Linear ADJUST temp+DEHAZE', [{ layer, op: 'replace' }])
        const top = patchDiff(origData, d, W, H, 0.4, 0.05, 0.6, 0.18)
        const bottom = patchDiff(origData, d, W, H, 0.4, 0.85, 0.6, 0.98)
        log(`#3 gradient? top Δ=${top.toFixed(1)}  bottom Δ=${bottom.toFixed(1)}  → ${top > bottom + 2 ? 'GRADIENT ✓' : 'check'}`)
    }

    // ── 4 · NEW ops in isolation: TEXTURE only, then DEHAZE only ──
    {
        const base = radialLayer({ center, radius: { x: W * 0.4, y: H * 0.4 }, feather: 0.4, imageSize })
        const tex = adj(base, { texture: 95 })
        const dt = run('4a · Radial TEXTURE +95 (only)', [{ layer: tex, op: 'replace' }])
        log(`#4a TEXTURE fires? overall Δ=${meanAbsDiff(origData, dt).toFixed(2)}  → ${meanAbsDiff(origData, dt) > 0.3 ? 'YES ✓' : 'NO ✗'}`)
        const deh = adj(base, { dehaze: 85 })
        const dd = run('4b · Radial DEHAZE +85 (only)', [{ layer: deh, op: 'replace' }])
        log(`#4b DEHAZE fires? overall Δ=${meanAbsDiff(origData, dd).toFixed(2)}  → ${meanAbsDiff(origData, dd) > 0.3 ? 'YES ✓' : 'NO ✗'}`)
    }

    // ── 5 · PEN-PATH mask (new kind): bezier-smoothed loop around the figure ──
    {
        // rough anchor loop around the central silhouette (image-space px)
        const pts = [
            { x: W * 0.42, y: H * 0.26 }, { x: W * 0.6, y: H * 0.32 }, { x: W * 0.64, y: H * 0.55 },
            { x: W * 0.6, y: H * 0.74 }, { x: W * 0.46, y: H * 0.72 }, { x: W * 0.4, y: H * 0.5 },
        ]
        const anchors = smoothToBezier(pts, { closed: true })
        const canvas = rasterisePath(anchors, W, H, { closed: true })
        const key = 'harness-path-1'; setMaskTexture(key, canvas)
        // 5a — show the path shape (fill)
        const fillLayer = sanitiseLayer({ ...pathLayer({ maskTextureKey: key, feather: 0.04 }), fillMode: 'fill', fillColor: { r: 0.32, g: 0.85, b: 1 }, fillStrength: 0.55 })
        run('5a · PEN-PATH FILL (shape)', [{ layer: fillLayer, op: 'replace' }])
        // 5b — adjust inside the path
        const adjLayer = adj({ ...pathLayer({ maskTextureKey: key, feather: 0.06 }) }, { exposure: 1.0, vibrance: 70, texture: 50 })
        const d = run('5b · PEN-PATH ADJUST exp+vib+tex', [{ layer: adjLayer, op: 'replace' }])
        const inside = patchDiff(origData, d, W, H, 0.46, 0.4, 0.56, 0.55)
        const outside = patchDiff(origData, d, W, H, 0.05, 0.05, 0.18, 0.2)
        log(`#5 path local? inside Δ=${inside.toFixed(1)}  outside Δ=${outside.toFixed(1)}  → ${inside > outside * 3 ? 'LOCAL ✓' : 'check'}`)
    }

    log('DONE — all cases rendered')
    window.__done = true
}

main().catch((e) => { log('ERROR: ' + (e && e.message || e)); window.__error = String(e); window.__done = true })
