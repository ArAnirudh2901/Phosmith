// Visual preview of the focus/light effects on real photos. Bundled by
// scripts/preview-effects.mjs; nothing here ships in the app.
//
// It renders the SAME production modules the editor uses (megashader + the CV
// core) side by side with the untouched original, so the output can be judged by
// eye instead of by an assertion.

import { StaticCanvas, FabricImage, config as fabricConfig } from 'fabric'
import { applyMegashaderFilter } from '../../src/lib/megashader/apply-megashader.js'
import { luminanceLayer, setMaskTexture, gradientLayer, semanticLayer } from '../../src/lib/megashader/mask-types.js'
import { buildDepthOfField, motionBlurLayer, tiltShiftLayer } from '../../src/lib/effects/focus.js'
import { buildColorPop } from '../../src/lib/effects/color-pop.js'
import { castShadowAlpha, castShadowCanvas, frameShadowParams } from '../../src/lib/effects/shadow.js'
import { canvasToPlane, imageToLumaPlane, planeToCoverageCanvas } from '../../src/lib/cv/plane-image.js'
import { defocusMap } from '../../src/lib/cv/defocus-map.js'
import { fromMatte } from '../../src/lib/cv/coc.js'
import { makePlane } from '../../src/lib/cv/box-filter.js'

if (fabricConfig) fabricConfig.enableGLFiltering = false

const CELL = 420

const loadImage = (src) => new Promise((resolve, reject) => {
    const el = new Image()
    el.crossOrigin = 'anonymous'
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error(`load failed: ${src}`))
    el.src = src
})

const fitCanvas = (el) => {
    const scale = Math.min(1, CELL / Math.max(el.naturalWidth, el.naturalHeight))
    const w = Math.round(el.naturalWidth * scale)
    const h = Math.round(el.naturalHeight * scale)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d').drawImage(el, 0, 0, w, h)
    return c
}

const renderLayers = (sourceCanvas, layers, { shadow = null, overlay = false } = {}) => {
    const holder = document.createElement('canvas')
    holder.width = sourceCanvas.width
    holder.height = sourceCanvas.height
    const fcanvas = new StaticCanvas(holder, { width: holder.width, height: holder.height, renderOnAddRemove: false, enableRetinaScaling: false })
    const img = new FabricImage(sourceCanvas, { left: 0, top: 0, objectCaching: false })
    if (shadow) img.set({ shadow })
    fcanvas.add(img)
    if (layers.length) {
        applyMegashaderFilter(img, { chain: layers.map((layer, i) => ({ op: i === 0 ? 'replace' : 'add', layer })) },
            { globalMaskAlpha: 1, maskOverlay: overlay, maskView: overlay ? 'bw' : 'tint' })
    }
    fcanvas.renderAll()
    // Read the FILTERED element, which is what the editor draws — the Fabric
    // canvas here is only a host and its sizing is not what is under test.
    const out = img._element || img.getElement()
    const shown = document.createElement('canvas')
    shown.width = out.width || sourceCanvas.width
    shown.height = out.height || sourceCanvas.height
    shown.getContext('2d').drawImage(out, 0, 0)
    return shown
}

const tile = (title, canvas, note) => {
    const wrap = document.createElement('figure')
    wrap.style.margin = '0'
    wrap.style.background = '#111418'
    wrap.style.borderRadius = '10px'
    wrap.style.overflow = 'hidden'
    wrap.style.border = '1px solid #222831'
    const cap = document.createElement('figcaption')
    cap.textContent = note ? `${title} — ${note}` : title
    cap.style.cssText = 'font:12px/1.5 ui-sans-serif,system-ui;color:#cfd6e4;padding:8px 10px;background:#0b0e12'
    canvas.style.cssText = 'display:block;width:100%;height:auto'
    wrap.appendChild(cap)
    wrap.appendChild(canvas)
    return wrap
}

const run = async () => {
    const grid = document.createElement('div')
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:12px;background:#06080b;font:12px ui-sans-serif'
    document.body.style.margin = '0'
    document.body.appendChild(grid)

    const portrait = fitCanvas(await loadImage('/photos/portrait.jpg'))
    const street = fitCanvas(await loadImage('/photos/street.jpg'))
    const lights = fitCanvas(await loadImage('/photos/lights.jpg'))

    grid.appendChild(tile('Original — portrait', renderLayers(portrait, [])))
    grid.appendChild(tile('Original — street', renderLayers(street, [])))
    grid.appendChild(tile('Original — night lights', renderLayers(lights, [])))

    // Tilt-shift, radial and band.
    grid.appendChild(tile('Tilt-shift radial', renderLayers(street, [tiltShiftLayer({
        mode: 'radial', imageSize: { width: street.width, height: street.height },
        radius: 0.26, feather: 0.45, blurPx: 26, shape: 'disc', highlightGain: 1.5,
    })]), 'blur 26px, feather 45%'))
    grid.appendChild(tile('Tilt-shift band + miniature', renderLayers(street, [tiltShiftLayer({
        mode: 'linear', imageSize: { width: street.width, height: street.height },
        radius: 0.12, feather: 0.3, blurPx: 30, miniature: 60,
    })]), 'band, miniature 60%'))

    // Depth of field from the photo's own defocus, no model at all.
    const dof = buildDepthOfField(street, { blurPx: 34, shape: 'disc', highlightGain: 2, aperture: 1 })
    grid.appendChild(tile(`Depth of field (${dof.source})`, renderLayers(street, [dof.layer]),
        `on-device, ${(dof.coverage * 100).toFixed(1)}% of pixels carried an estimate`))

    // The CoC map that produced it, so the falloff can be judged directly.
    const luma = imageToLumaPlane(street)
    const dense = defocusMap(luma)
    grid.appendChild(tile('Defocus map (street)', planeToCoverageCanvas(dense.map, { width: street.width, height: street.height }),
        'white = softest in the original frame'))

    // Bokeh shapes on point lights — the case that separates bokeh from a smudge.
    for (const shape of ['disc', 'hex', 'ring']) {
        grid.appendChild(tile(`Bokeh ${shape}`, renderLayers(lights, [{
            ...luminanceLayer({ min: 0, max: 1, softness: 0 }),
            blurPx: 30, blurKind: shape, highlightGain: 5, highlightThreshold: 0.55,
        }]), 'full-frame, bloom 5'))
    }

    // Motion + spin.
    grid.appendChild(tile('Motion blur 0°', renderLayers(street, [motionBlurLayer({ angle: 0, length: 0.8, blurPx: 40 })]), 'horizontal'))
    grid.appendChild(tile('Spin blur', renderLayers(lights, [motionBlurLayer({ angle: 0, length: 0.7, blurPx: 36, spin: true })]), 'rotational'))

    // Colour pop by colour range (model-free).
    try {
        const pop = buildColorPop({
            imageEl: portrait, target: { r: 0.78, g: 0.45, b: 0.36 },
            tolerance: 0.2, keep: 12, feather: 0.2, spatial: 0,
        })
        grid.appendChild(tile('Colour pop (skin tones kept)', renderLayers(portrait, [pop.layer]),
            `${(pop.keptFraction * 100).toFixed(0)}% kept, surround at 12%`))
    } catch (error) {
        grid.appendChild(tile('Colour pop failed', renderLayers(portrait, []), String(error.message)))
    }

    // A synthetic matte stands in for SlimSAM here (no model in this bundle): an
    // ellipse over the subject, so the matte→CoC→blur path is still exercised.
    const matte = makePlane(Math.round(street.width / 4), Math.round(street.height / 4))
    for (let y = 0; y < matte.height; y += 1) {
        for (let x = 0; x < matte.width; x += 1) {
            const dx = (x - matte.width * 0.5) / (matte.width * 0.22)
            const dy = (y - matte.height * 0.62) / (matte.height * 0.34)
            if (dx * dx + dy * dy < 1) matte.data[y * matte.width + x] = 1
        }
    }
    const matteCanvas = planeToCoverageCanvas(matte, { width: street.width, height: street.height })
    const portraitDof = buildDepthOfField(street, { matteCanvas, blurPx: 40, highlightGain: 2, reach: 0.3, gamma: 1.3 })
    grid.appendChild(tile('Portrait DoF (matte + distance ramp)', renderLayers(street, [portraitDof.layer]),
        'subject sharp, background softening with distance'))
    grid.appendChild(tile('Its CoC map', planeToCoverageCanvas(
        fromMatte(canvasToPlane(matteCanvas, 'luma'), { reach: 0.3, gamma: 1.3, aperture: 1 }),
    ), 'black = sharp'))

    // Diagnostics: what coverage do these layers actually have?
    const tiltLayer = tiltShiftLayer({
        mode: 'radial', imageSize: { width: street.width, height: street.height },
        radius: 0.26, feather: 0.45, blurPx: 26,
    })
    grid.appendChild(tile('DIAG tilt-shift coverage', renderLayers(street, [tiltLayer], { overlay: true }), 'white = blurred'))
    grid.appendChild(tile('DIAG portrait-DoF coverage', renderLayers(street, [portraitDof.layer], { overlay: true }), 'white = blurred'))
    grid.appendChild(tile('DIAG defocus-DoF coverage', renderLayers(street, [dof.layer], { overlay: true }), 'white = blurred'))

    // Orientation probe: white ONLY in the top-left quadrant of the map. Whatever
    // the coverage tile shows is exactly how a mask texture maps onto the image.
    {
        const probe = makePlane(street.width, street.height)
        for (let y = 0; y < Math.round(street.height * 0.4); y += 1) {
            for (let x = 0; x < Math.round(street.width * 0.4); x += 1) probe.data[y * probe.width + x] = 1
        }
        const probeCanvas = planeToCoverageCanvas(probe)
        const probeKey = `probe-${Math.random().toString(36).slice(2, 7)}`
        setMaskTexture(probeKey, probeCanvas)
        grid.appendChild(tile('DIAG probe map (top-left white)', probeCanvas, 'what was uploaded'))
        grid.appendChild(tile('DIAG probe coverage', renderLayers(street, [{
            ...gradientLayer({ gradientMapKey: probeKey, low: 0, high: 1 }), exposure: 1,
        }], { overlay: true }), 'where the shader thinks it is'))
    }

    // Instagram trio.
    grid.appendChild(tile('Lux 60', renderLayers(street, [{ ...luminanceLayer({ min: 0, max: 1, softness: 0 }), lux: 60 }]), 'local tone mapping'))
    grid.appendChild(tile('Structure 70', renderLayers(portrait, [{ ...luminanceLayer({ min: 0, max: 1, softness: 0 }), structure: 70 }]), 'edge-aware local contrast'))
    grid.appendChild(tile('Fade 55', renderLayers(portrait, [{ ...luminanceLayer({ min: 0, max: 1, softness: 0 }), fade: 55 }]), 'faded print'))

    // Shadows.
    const frame = frameShadowParams({ angle: 120, distance: 22, size: 34, spread: 0.2, opacity: 0.45 })
    const framed = document.createElement('canvas')
    framed.width = portrait.width + 120
    framed.height = portrait.height + 120
    const fctx = framed.getContext('2d')
    fctx.fillStyle = '#e9e5dd'
    fctx.fillRect(0, 0, framed.width, framed.height)
    fctx.save()
    fctx.shadowColor = frame.color
    fctx.shadowBlur = frame.blur
    fctx.shadowOffsetX = frame.offsetX
    fctx.shadowOffsetY = frame.offsetY
    fctx.drawImage(portrait, 60, 60)
    fctx.restore()
    grid.appendChild(tile('Frame shadow', framed, `light 120°, offset ${frame.offsetX.toFixed(0)}/${frame.offsetY.toFixed(0)}, blur ${frame.blur.toFixed(0)}`))

    const { alpha } = castShadowAlpha(matte, { angle: 120, length: 0.6, softness: 0.5, opacity: 0.55 })
    const cast = castShadowCanvas(alpha, { color: '#0b0d12' })
    const grounded = document.createElement('canvas')
    grounded.width = street.width
    grounded.height = street.height
    const gctx = grounded.getContext('2d')
    gctx.fillStyle = '#d8d4cc'
    gctx.fillRect(0, 0, grounded.width, grounded.height)
    gctx.drawImage(cast, 0, 0, grounded.width, grounded.height)
    gctx.globalAlpha = 0.9
    gctx.drawImage(matteCanvas, 0, 0, grounded.width, grounded.height)
    grid.appendChild(tile('Cast shadow (matte silhouette)', grounded, 'sharp at the contact line, soft away from it'))

    // Numeric probe: does a gradient-kind layer see its texture at all, and in
    // which orientation? Canvas vs ImageData upload, sampled at known points.
    window.__probe = (asImageData) => {
        const w = 200
        const h = 140
        const src = document.createElement('canvas')
        src.width = w
        src.height = h
        const sctx = src.getContext('2d')
        sctx.fillStyle = 'rgb(128,128,128)'
        sctx.fillRect(0, 0, w, h)

        const map = makePlane(w, h)
        for (let y = 0; y < Math.round(h * 0.4); y += 1) {
            for (let x = 0; x < Math.round(w * 0.4); x += 1) map.data[y * w + x] = 1
        }
        const mapCanvas = planeToCoverageCanvas(map)
        const k = `probe-${Math.random().toString(36).slice(2, 7)}`
        setMaskTexture(k, asImageData
            ? mapCanvas.getContext('2d').getImageData(0, 0, w, h)
            : mapCanvas)

        const layer = window.__probeKind === 'luminance'
            ? { ...luminanceLayer({ min: 0, max: 1, softness: 0 }), exposure: 1.5 }
            : window.__probeKind === 'semantic'
            ? { ...semanticLayer({ maskTextureKey: k, feather: 0 }), exposure: 1.5 }
            : { ...gradientLayer({ gradientMapKey: k, low: 0, high: 1 }), exposure: 1.5 }
        const out = renderLayers(src, [layer])
        const ctx = out.getContext('2d', { willReadFrequently: true })
        const at = (fx, fy) => Array.from(ctx.getImageData(Math.round(fx * w), Math.round(fy * h), 1, 1).data).slice(0, 3)
        const grid3 = []
        for (const fy of [0.15, 0.5, 0.85]) {
            grid3.push([0.15, 0.5, 0.85].map((fx) => at(fx, fy).join(',')))
        }
        return {
            kind: window.__probeKind || 'gradient',
            upload: asImageData ? 'ImageData' : 'canvas',
            out: `${out.width}x${out.height}`,
            src: `${src.width}x${src.height}`,
            mapWhiteAt: `${Math.round(w * 0.4)}x${Math.round(h * 0.4)}`,
            grid: grid3,
        }
    }

    // Does a gradient-kind layer actually blur? Half-white map, hard edge source.
    window.__blurProbe = (kind) => {
        const w = 200
        const h = 140
        const src = document.createElement('canvas')
        src.width = w
        src.height = h
        const sctx = src.getContext('2d')
        for (let x = 0; x < w; x += 1) {
            sctx.fillStyle = (Math.floor(x / 8) % 2) ? 'rgb(240,240,240)' : 'rgb(20,20,20)'
            sctx.fillRect(x, 0, 1, h)
        }
        const map = makePlane(w, h)
        map.data.fill(1)
        const k = `blurprobe-${Math.random().toString(36).slice(2, 7)}`
        setMaskTexture(k, planeToCoverageCanvas(map))
        const layer = kind === 'gradient'
            ? { ...gradientLayer({ gradientMapKey: k, low: 0, high: 1 }), blurPx: 24 }
            : { ...luminanceLayer({ min: 0, max: 1, softness: 0 }), blurPx: 24 }
        const out = renderLayers(src, [layer])
        const ctx = out.getContext('2d', { willReadFrequently: true })
        const row = Array.from({ length: 24 }, (_, i) => ctx.getImageData(i * 8 + 4, 70, 1, 1).data[0])
        let variance = 0
        const mean = row.reduce((a, b) => a + b, 0) / row.length
        for (const v of row) variance += (v - mean) ** 2
        return { kind, mean: Math.round(mean), variance: Math.round(variance / row.length), sample: row.slice(0, 8) }
    }

    window.__cocProbe = () => {
        const out = renderLayers(street, [portraitDof.layer], { overlay: true })
        const ctx = out.getContext('2d', { willReadFrequently: true })
        const at = (fx, fy) => ctx.getImageData(Math.round(fx * out.width), Math.round(fy * out.height), 1, 1).data[0]
        const refined = renderLayers(street, [{ ...portraitDof.layer, blurPx: 0, exposure: 1.5 }])
        const rctx = refined.getContext('2d', { willReadFrequently: true })
        const rat = (fx, fy) => rctx.getImageData(Math.round(fx * refined.width), Math.round(fy * refined.height), 1, 1).data[0]
        return {
            source: portraitDof.source,
            coverage: [[at(0.1, 0.1), at(0.5, 0.1), at(0.9, 0.1)], [at(0.1, 0.62), at(0.5, 0.62), at(0.9, 0.62)], [at(0.1, 0.95), at(0.5, 0.95), at(0.9, 0.95)]],
            exposureTest: [[rat(0.1, 0.1), rat(0.5, 0.1)], [rat(0.5, 0.62), rat(0.9, 0.95)]],
        }
    }

    // Colour pop by picked colour, driven the way the panel drives it: a seed
    // point on the subject, magic-wand flood, guided refinement.
    window.__popProbe = ({ x = 0.5, y = 0.62, tolerance = 0.24, contiguous = true } = {}) => {
        const el = portrait
        const ctx = el.getContext('2d', { willReadFrequently: true })
        const d = ctx.getImageData(Math.round(x * el.width), Math.round(y * el.height), 1, 1).data
        const target = { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255 }
        try {
            const pop = buildColorPop({
                imageEl: el, target, tolerance, point: { x, y }, contiguous, keep: 12, feather: 0.15,
            })
            return { picked: [d[0], d[1], d[2]], keptFraction: Number(pop.keptFraction.toFixed(4)), ok: true }
        } catch (error) {
            return { picked: [d[0], d[1], d[2]], ok: false, error: String(error.message).slice(0, 120) }
        }
    }

    window.__previewReady = true
}

run().catch((error) => {
    document.body.innerHTML = `<pre style="color:#f88;font:12px ui-monospace;padding:16px">${String(error && error.stack || error)}</pre>`
    // Numeric probe: does a gradient-kind layer see its texture at all, and in
    // which orientation? Canvas vs ImageData upload, sampled at known points.
    window.__probe = (asImageData) => {
        const w = 200
        const h = 140
        const src = document.createElement('canvas')
        src.width = w
        src.height = h
        const sctx = src.getContext('2d')
        sctx.fillStyle = 'rgb(128,128,128)'
        sctx.fillRect(0, 0, w, h)

        const map = makePlane(w, h)
        for (let y = 0; y < Math.round(h * 0.4); y += 1) {
            for (let x = 0; x < Math.round(w * 0.4); x += 1) map.data[y * w + x] = 1
        }
        const mapCanvas = planeToCoverageCanvas(map)
        const k = `probe-${Math.random().toString(36).slice(2, 7)}`
        setMaskTexture(k, asImageData
            ? mapCanvas.getContext('2d').getImageData(0, 0, w, h)
            : mapCanvas)

        const layer = window.__probeKind === 'luminance'
            ? { ...luminanceLayer({ min: 0, max: 1, softness: 0 }), exposure: 1.5 }
            : window.__probeKind === 'semantic'
            ? { ...semanticLayer({ maskTextureKey: k, feather: 0 }), exposure: 1.5 }
            : { ...gradientLayer({ gradientMapKey: k, low: 0, high: 1 }), exposure: 1.5 }
        const out = renderLayers(src, [layer])
        const ctx = out.getContext('2d', { willReadFrequently: true })
        const at = (fx, fy) => Array.from(ctx.getImageData(Math.round(fx * w), Math.round(fy * h), 1, 1).data).slice(0, 3)
        const grid3 = []
        for (const fy of [0.15, 0.5, 0.85]) {
            grid3.push([0.15, 0.5, 0.85].map((fx) => at(fx, fy).join(',')))
        }
        return {
            kind: window.__probeKind || 'gradient',
            upload: asImageData ? 'ImageData' : 'canvas',
            out: `${out.width}x${out.height}`,
            src: `${src.width}x${src.height}`,
            mapWhiteAt: `${Math.round(w * 0.4)}x${Math.round(h * 0.4)}`,
            grid: grid3,
        }
    }

    // Does a gradient-kind layer actually blur? Half-white map, hard edge source.
    window.__blurProbe = (kind) => {
        const w = 200
        const h = 140
        const src = document.createElement('canvas')
        src.width = w
        src.height = h
        const sctx = src.getContext('2d')
        for (let x = 0; x < w; x += 1) {
            sctx.fillStyle = (Math.floor(x / 8) % 2) ? 'rgb(240,240,240)' : 'rgb(20,20,20)'
            sctx.fillRect(x, 0, 1, h)
        }
        const map = makePlane(w, h)
        map.data.fill(1)
        const k = `blurprobe-${Math.random().toString(36).slice(2, 7)}`
        setMaskTexture(k, planeToCoverageCanvas(map))
        const layer = kind === 'gradient'
            ? { ...gradientLayer({ gradientMapKey: k, low: 0, high: 1 }), blurPx: 24 }
            : { ...luminanceLayer({ min: 0, max: 1, softness: 0 }), blurPx: 24 }
        const out = renderLayers(src, [layer])
        const ctx = out.getContext('2d', { willReadFrequently: true })
        const row = Array.from({ length: 24 }, (_, i) => ctx.getImageData(i * 8 + 4, 70, 1, 1).data[0])
        let variance = 0
        const mean = row.reduce((a, b) => a + b, 0) / row.length
        for (const v of row) variance += (v - mean) ** 2
        return { kind, mean: Math.round(mean), variance: Math.round(variance / row.length), sample: row.slice(0, 8) }
    }

    window.__cocProbe = () => {
        const out = renderLayers(street, [portraitDof.layer], { overlay: true })
        const ctx = out.getContext('2d', { willReadFrequently: true })
        const at = (fx, fy) => ctx.getImageData(Math.round(fx * out.width), Math.round(fy * out.height), 1, 1).data[0]
        const refined = renderLayers(street, [{ ...portraitDof.layer, blurPx: 0, exposure: 1.5 }])
        const rctx = refined.getContext('2d', { willReadFrequently: true })
        const rat = (fx, fy) => rctx.getImageData(Math.round(fx * refined.width), Math.round(fy * refined.height), 1, 1).data[0]
        return {
            source: portraitDof.source,
            coverage: [[at(0.1, 0.1), at(0.5, 0.1), at(0.9, 0.1)], [at(0.1, 0.62), at(0.5, 0.62), at(0.9, 0.62)], [at(0.1, 0.95), at(0.5, 0.95), at(0.9, 0.95)]],
            exposureTest: [[rat(0.1, 0.1), rat(0.5, 0.1)], [rat(0.5, 0.62), rat(0.9, 0.95)]],
        }
    }

    // Colour pop by picked colour, driven the way the panel drives it: a seed
    // point on the subject, magic-wand flood, guided refinement.
    window.__popProbe = ({ x = 0.5, y = 0.62, tolerance = 0.24, contiguous = true } = {}) => {
        const el = portrait
        const ctx = el.getContext('2d', { willReadFrequently: true })
        const d = ctx.getImageData(Math.round(x * el.width), Math.round(y * el.height), 1, 1).data
        const target = { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255 }
        try {
            const pop = buildColorPop({
                imageEl: el, target, tolerance, point: { x, y }, contiguous, keep: 12, feather: 0.15,
            })
            return { picked: [d[0], d[1], d[2]], keptFraction: Number(pop.keptFraction.toFixed(4)), ok: true }
        } catch (error) {
            return { picked: [d[0], d[1], d[2]], ok: false, error: String(error.message).slice(0, 120) }
        }
    }

    window.__previewReady = true
})
