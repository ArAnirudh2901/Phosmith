// Harness for scripts/verify-collage-render.mjs: exposes the collage render
// path on window so the verifier can drive it in a REAL browser (real canvas
// limits, real JPEG decoder, real anti-aliasing). Kept out of the app bundle.
//
// Everything here runs against the production modules — no mocks — with Fabric
// on a detached canvas instead of the editor, so no Next, Clerk or network.

import { StaticCanvas, FabricImage, Rect, config as fabricConfig } from 'fabric'
import {
    LAYOUTS, computeCollageCells, fitImageToCell, getCellFitScale, assessCellResolution,
    collageFrameFor, defaultWeightsFor, layoutBoundaries, applyBoundaryDrag,
} from '@/lib/collage-layout'
import { radialLayer } from '@/lib/megashader/mask-types'
import { applyMegashaderFilter } from '@/lib/megashader/apply-megashader'
import { getRenderMetrics } from '@/lib/megashader/megashader-renderer'
import { buildCellMatte, isCollageMatte } from '@/lib/collage-styles'
import { assignPhotosToCells, photoDescriptor, focusForCell } from '@/lib/collage-arrange'
import { canvasLimits, maxRenderScale, clampToCanvasLimits, __setCanvasLimits } from '@/lib/canvas-limits'
import { readImageMeta, flattenOrientation, isRawFile, resolveSourceFile, extractRawPreview } from '@/lib/raw-preview'
import { workingEdgeForProject, imagekitResized } from '@/lib/canvas-images'
import { renderLiveCanvasElement, snapshotCanvasToBlob, isTaintError } from '@/lib/canvas-snapshot'

// Match canvas.jsx: the editor forces the Canvas2D filter backend, and the
// megashader's own WebGL context does the work inside applyTo2d.
if (fabricConfig) fabricConfig.enableGLFiltering = false

const BACKDROP = '#ff00ff'      // a colour no test photo uses, so a seam is obvious

/** A solid-colour bitmap of an exact size, as an <img> the way an upload arrives. */
const makeImageElement = (w, h, fill, { quadrant = null } = {}) => new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = fill
    ctx.fillRect(0, 0, w, h)
    if (quadrant) {
        // A marker square, so orientation and focus tests can say WHERE it went.
        ctx.fillStyle = quadrant.fill
        ctx.fillRect(quadrant.x * w, quadrant.y * h, w * 0.25, h * 0.25)
    }
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('image failed to load'))
    el.src = canvas.toDataURL('image/png')
})

const fabricImage = async (w, h, fill, opts) => new FabricImage(await makeImageElement(w, h, fill, opts))

/** Build a collage on a detached Fabric canvas and return it plus its cells. */
const buildCollage = async ({
    width = 1080, height = 1080, layoutId = '4-grid', gap = 0, padding = 0,
    photos = [[1200, 1200], [1200, 1200], [1200, 1200], [1200, 1200]],
    fitMode = 'cover', arrange = false, style = {},
} = {}) => {
    const canvas = new StaticCanvas(document.createElement('canvas'), { width, height })
    canvas.backgroundColor = BACKDROP
    const cells = computeCollageCells({ width, height }, layoutId, gap, padding)
    const images = []
    for (let i = 0; i < photos.length; i += 1) {
        const [w, h, fill] = photos[i]
        images.push(await fabricImage(w, h, fill || ['#1f6feb', '#2ea043', '#d29922', '#a371f7', '#db6d28', '#1b7f79'][i % 6]))
    }
    const descriptors = arrange ? images.map((img, i) => photoDescriptor({ aspect: img.width / img.height, quality: 0.5 + i * 0.1 }, i)) : null
    const assignment = descriptors ? assignPhotosToCells(descriptors, cells) : null
    cells.forEach((cell, cellIndex) => {
        const photoIndex = assignment ? assignment[cellIndex] : cellIndex
        if (photoIndex === null || photoIndex === undefined || photoIndex >= images.length) return
        const focus = descriptors ? focusForCell(descriptors[photoIndex]) : null
        fitImageToCell(images[photoIndex], cell, { ...style, fitMode, ...(focus ? { focus } : {}) })
        canvas.add(images[photoIndex])
    })
    canvas.renderAll()
    return { canvas, cells, images, width, height }
}

const toPixels = (canvas, width, height) => {
    const el = canvas.toCanvasElement(1, { width, height, left: 0, top: 0 })
    return el.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, el.width, el.height)
}

const isBackdrop = (data, i) => data[i] > 200 && data[i + 1] < 60 && data[i + 2] > 200

/**
 * Walk every interior cell boundary and count backdrop-coloured pixels. At gap 0
 * a collage must show no backdrop at all: any hit is the hairline seam that
 * fractional cell maths used to leave behind.
 */
const seamScan = ({ canvas, cells, width, height }) => {
    const img = toPixels(canvas, width, height)
    const { data } = img
    let seamPixels = 0
    const at = (x, y) => (y * img.width + x) * 4
    const xs = new Set()
    const ys = new Set()
    for (const cell of cells) {
        xs.add(cell.x)
        xs.add(cell.x + cell.w)
        ys.add(cell.y)
        ys.add(cell.y + cell.h)
    }
    for (const x of xs) {
        if (x <= 0 || x >= img.width - 1) continue
        for (let y = 1; y < img.height - 1; y += 1) if (isBackdrop(data, at(x, y))) seamPixels += 1
    }
    for (const y of ys) {
        if (y <= 0 || y >= img.height - 1) continue
        for (let x = 1; x < img.width - 1; x += 1) if (isBackdrop(data, at(x, y))) seamPixels += 1
    }
    let totalBackdrop = 0
    let interiorBackdrop = 0
    for (let y = 0; y < img.height; y += 1) {
        for (let x = 0; x < img.width; x += 1) {
            if (!isBackdrop(data, at(x, y))) continue
            totalBackdrop += 1
            // The outermost pixel ring is anti-aliased against nothing, so a
            // corner there is cosmetic; a backdrop pixel anywhere else is a seam.
            if (x > 0 && y > 0 && x < img.width - 1 && y < img.height - 1) interiorBackdrop += 1
        }
    }
    return { seamPixels, totalBackdrop, interiorBackdrop, pixels: img.width * img.height }
}

/** JPEG with an EXIF orientation tag, built byte by byte (no fixtures on disk). */
const jpegWithOrientation = async (orientation, w = 120, h = 60) => {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#101820'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#ff2d55'
    ctx.fillRect(0, 0, w * 0.25, h * 0.25)      // marker in the top-left
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92))
    const bytes = new Uint8Array(await blob.arrayBuffer())

    // APP1/Exif: header, TIFF little-endian, one IFD entry (0x0112 orientation).
    const exif = []
    const push = (...v) => exif.push(...v)
    push(0xff, 0xe1)
    const payload = []
    const p = (...v) => payload.push(...v)
    p(0x45, 0x78, 0x69, 0x66, 0x00, 0x00)               // "Exif\0\0"
    p(0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00)   // II, 42, IFD0 at 8
    p(0x01, 0x00)                                        // one entry
    p(0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00)    // tag 0x0112, SHORT, count 1
    p(orientation & 0xff, 0x00, 0x00, 0x00)              // value
    p(0x00, 0x00, 0x00, 0x00)                            // next IFD = 0
    const segLen = payload.length + 2
    push((segLen >> 8) & 0xff, segLen & 0xff, ...payload)

    const out = new Uint8Array(2 + exif.length + (bytes.length - 2))
    out.set(bytes.subarray(0, 2), 0)                     // SOI
    out.set(new Uint8Array(exif), 2)                     // APP1 right after SOI
    out.set(bytes.subarray(2), 2 + exif.length)
    return new Blob([out], { type: 'image/jpeg' })
}

/** JPEG-shaped header whose SOF declares 4 components — a CMYK scan. */
const cmykJpegHeader = () => {
    const bytes = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x80, 0x04]
    for (let i = 0; i < 12; i += 1) bytes.push(0x00)
    return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })
}

// Corners as the BROWSER shows the file: a decoder always applies an EXIF
// orientation tag, and there is no option left to ask it not to.
const cornerColours = async (blob) => {
    const bmp = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bmp, 0, 0)
    const pick = (x, y) => {
        const d = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data
        return { r: d[0], g: d[1], b: d[2] }
    }
    const m = 0.06
    const out = {
        width: bmp.width,
        height: bmp.height,
        topLeft: pick(bmp.width * m, bmp.height * m),
        topRight: pick(bmp.width * (1 - m), bmp.height * m),
        bottomLeft: pick(bmp.width * m, bmp.height * (1 - m)),
        bottomRight: pick(bmp.width * (1 - m), bmp.height * (1 - m)),
    }
    bmp.close?.()
    return out
}

/** A photo with a transparent hole through the middle, as a cut-out arrives. */
const holedImage = async (w, h) => {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#1f6feb'
    ctx.fillRect(0, 0, w, h)
    ctx.clearRect(w * 0.3, h * 0.3, w * 0.4, h * 0.4)
    const el = new Image()
    await new Promise((resolve, reject) => {
        el.onload = resolve
        el.onerror = () => reject(new Error('holed image failed'))
        el.src = canvas.toDataURL('image/png')
    })
    return new FabricImage(el)
}

window.__collage = {
    ready: true,

    /** Where the backdrop shows through, for diagnosing a seam failure. */
    backdropMap: async ({ width = 1081, height = 1921, layoutId = '4-columns' } = {}) => {
        const cellCount = LAYOUTS.find((l) => l.id === layoutId)?.cellCount || 4
        const built = await buildCollage({
            width, height, layoutId, gap: 0, padding: 0,
            photos: Array.from({ length: cellCount }, () => [1400, 1000]),
        })
        const img = toPixels(built.canvas, width, height)
        const { data } = img
        const cols = new Map()
        const rows = new Map()
        for (let y = 0; y < img.height; y += 1) {
            for (let x = 0; x < img.width; x += 1) {
                if (!isBackdrop(data, (y * img.width + x) * 4)) continue
                cols.set(x, (cols.get(x) || 0) + 1)
                rows.set(y, (rows.get(y) || 0) + 1)
            }
        }
        const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        return {
            canvas: { width: img.width, height: img.height },
            cells: built.cells,
            worstColumns: top(cols),
            worstRows: top(rows),
        }
    },

    /** Seams: gap 0 must leave no backdrop pixel anywhere. */
    seams: async ({ width, height, layoutId, gap = 0, photos } = {}) => {
        const built = await buildCollage({ width, height, layoutId, gap, padding: 0, photos })
        return { layoutId: layoutId || '4-grid', ...seamScan(built), cells: built.cells }
    },

    /** Every layout at an awkward canvas size, one call. */
    seamsAll: async ({ width = 1081, height = 1921 } = {}) => {
        const rows = []
        for (const layout of LAYOUTS) {
            const photos = Array.from({ length: layout.cellCount }, () => [1400, 1000])
            const built = await buildCollage({ width, height, layoutId: layout.id, gap: 0, padding: 0, photos })
            rows.push({ layoutId: layout.id, ...seamScan(built) })
        }
        return rows
    },

    /** Contain leaves backdrop ON PURPOSE; cover must not. */
    fitModes: async () => {
        const photos = [[6400, 400], [1200, 1200], [400, 2000], [1200, 1200]]
        const cover = await buildCollage({ layoutId: '4-grid', gap: 0, photos, fitMode: 'cover' })
        const contain = await buildCollage({ layoutId: '4-grid', gap: 0, photos, fitMode: 'contain' })
        return { cover: seamScan(cover), contain: seamScan(contain) }
    },

    /** Empty cells: a 4-cell layout with 2 photos leaves 2 cells unfilled. */
    partial: async () => {
        const built = await buildCollage({ layoutId: '4-grid', gap: 0, photos: [[1200, 1200], [1200, 1200]] })
        const scan = seamScan(built)
        return { ...scan, placed: built.canvas.getObjects().length, cells: built.cells.length }
    },

    /** Low-resolution detection against real decoded sizes. */
    resolution: async () => {
        const thumb = await fabricImage(200, 200, '#1f6feb')
        const dslr = await fabricImage(6000, 4000, '#2ea043')
        const cell = { x: 0, y: 0, w: 800, h: 800 }
        return {
            thumb: assessCellResolution(thumb, cell, window.devicePixelRatio || 1),
            dslr: assessCellResolution(dslr, cell, window.devicePixelRatio || 1),
            coverScale: getCellFitScale(thumb, cell, 'cover'),
        }
    },

    /** This machine's real canvas ceiling, and the scale maths on top of it. */
    limits: () => {
        const real = canvasLimits()
        __setCanvasLimits({ maxEdge: 4096, maxArea: 16_777_216 })
        const forced = {
            scale3x: maxRenderScale(1080, 1920, 3),
            clampBig: clampToCanvasLimits(9000, 9000),
            smallUntouched: maxRenderScale(800, 600, 2),
        }
        __setCanvasLimits(null)
        return { real, forced }
    },

    /** A 3× export on a device that cannot hold it must shrink, not blank out. */
    exportCap: async () => {
        const { canvas } = await buildCollage({ width: 1080, height: 1920, layoutId: '2-split-h', photos: [[1200, 1600], [1200, 1600]] })
        __setCanvasLimits({ maxEdge: 4096, maxArea: 16_777_216 })
        let capped = null
        try {
            const out = renderLiveCanvasElement(canvas, { project: { width: 1080, height: 1920 }, scale: 3 })
            capped = {
                limitedBy: out.limitedBy ? { requestedScale: out.limitedBy.requestedScale, effectiveScale: out.limitedBy.effectiveScale } : null,
                width: out.canvasElement.width,
                height: out.canvasElement.height,
                // A blank export is the failure this guard exists to prevent.
                painted: (() => {
                    const ctx = out.canvasElement.getContext('2d', { willReadFrequently: true })
                    const d = ctx.getImageData(0, 0, out.canvasElement.width, out.canvasElement.height).data
                    let opaque = 0
                    for (let i = 3; i < d.length; i += 4000) if (d[i] > 0) opaque += 1
                    return opaque
                })(),
            }
        } finally {
            __setCanvasLimits(null)
        }
        const uncapped = renderLiveCanvasElement(canvas, { project: { width: 1080, height: 1920 }, scale: 1 })
        return { capped, uncappedLimitedBy: uncapped.limitedBy, uncappedWidth: uncapped.canvasElement.width }
    },

    /**
     * EXIF orientation. The tag is read from the header, the file is flattened,
     * and the flattened copy must LOOK the same while no longer needing the tag —
     * which is what survives having its metadata stripped before upload.
     */
    orientation: async (value) => {
        const blob = await jpegWithOrientation(value)
        const meta = await readImageMeta(blob)
        const display = await cornerColours(blob)
        const flat = await flattenOrientation(blob, 'image/jpeg')
        const flatMeta = await readImageMeta(flat)
        const flatCorners = await cornerColours(flat)
        return { meta, display, flatMeta, flat: flatCorners }
    },

    /**
     * A transparent cut-out over the collage backdrop, with and without the
     * per-cell panel. Without it the backdrop shows through the hole; with it the
     * panel colour does.
     */
    transparency: async ({ matte = null } = {}) => {
        const canvas = new StaticCanvas(document.createElement('canvas'), { width: 600, height: 600 })
        canvas.backgroundColor = BACKDROP
        const cells = computeCollageCells({ width: 600, height: 600 }, '2-split-h', 0, 0)
        const style = { shape: 'rect', radiusPct: 0, shadow: false, fitMode: 'cover', matte }
        const photos = [await holedImage(800, 800), await holedImage(800, 800)]
        if (matte) {
            cells.forEach((cell) => {
                const panel = buildCellMatte(cell, style)
                canvas.add(panel)
            })
        }
        photos.forEach((photo, i) => {
            fitImageToCell(photo, cells[i], style)
            canvas.add(photo)
        })
        canvas.renderAll()
        const img = toPixels(canvas, 600, 600)
        const centre = (cell) => {
            const x = Math.round(cell.x + cell.w / 2)
            const y = Math.round(cell.y + cell.h / 2)
            const i = (y * img.width + x) * 4
            return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] }
        }
        return {
            mattes: canvas.getObjects().filter(isCollageMatte).length,
            holeColour: centre(cells[0]),
            backdropPixels: (() => {
                let n = 0
                for (let i = 0; i < img.data.length; i += 4) if (isBackdrop(img.data, i)) n += 1
                return n
            })(),
        }
    },

    /** Drag a divider for real, then check the render has no seam. */
    dividerDrag: async ({ layoutId = '4-grid', deltaPx = 140 } = {}) => {
        const width = 1081
        const height = 1921
        const info = collageFrameFor({ width, height }, layoutId, 0, 0)
        const divider = layoutBoundaries(layoutId, info.frame, info.gap)[0]
        const weights = applyBoundaryDrag(layoutId, defaultWeightsFor(layoutId), divider, deltaPx)
        const cellCount = LAYOUTS.find((l) => l.id === layoutId)?.cellCount || 4
        const cells = computeCollageCells({ width, height }, layoutId, 0, 0, weights)
        const canvas = new StaticCanvas(document.createElement('canvas'), { width, height })
        canvas.backgroundColor = BACKDROP
        for (let i = 0; i < cellCount; i += 1) {
            const photo = await fabricImage(1400, 1000, ['#1f6feb', '#2ea043', '#d29922', '#a371f7', '#db6d28', '#1b7f79'][i % 6])
            fitImageToCell(photo, cells[i], { fitMode: 'cover' })
            canvas.add(photo)
        }
        canvas.renderAll()
        return { cells, ...seamScan({ canvas, cells, width, height }) }
    },

    /** Header facts for a real file the verifier hands over. */
    metaOf: (blob) => readImageMeta(blob),

    /**
     * The production intake path for a camera RAW: container → embedded preview →
     * orientation baked → the dimensions the editor would actually work at.
     * This is what a DSLR file meets, and it is not the same as decoding a JPEG.
     */
    rawIntake: async (blob, name) => {
        const file = new File([blob], name, { type: '' })
        const started = performance.now()
        const out = { name, bytes: blob.size, isRaw: isRawFile(file) }
        try {
            const meta = await readImageMeta(blob)
            out.containerMeta = meta ? { w: meta.w, h: meta.h, orientation: meta.orientation } : null
            const preview = await extractRawPreview(file)
            out.preview = preview ? { bytes: preview.blob?.size ?? null, orientation: preview.orientation ?? null } : null
            const resolved = await resolveSourceFile(file)
            out.resolvedBytes = resolved?.size ?? null
            out.resolvedType = resolved?.type || 'unknown'
            const bmp = await createImageBitmap(resolved)
            out.decoded = { width: bmp.width, height: bmp.height, megapixels: +((bmp.width * bmp.height) / 1e6).toFixed(1) }
            bmp.close?.()
            out.ms = Math.round(performance.now() - started)
        } catch (error) {
            out.error = String(error?.message || error).slice(0, 160)
            out.ms = Math.round(performance.now() - started)
        }
        return out
    },

    /**
     * A full-resolution DSLR frame through the real effect pipeline: resolve the
     * RAW, build the Fabric image at native size, apply a depth-of-field blur,
     * and time the commit render. This is the case the matrix calls "50MP
     * crashes the browser".
     */
    dslrEffects: async (blob, name, { blurPx = 60, scale = 1 } = {}) => {
        const out = { name }
        const warnings = []
        const origWarn = console.warn.bind(console)
        console.warn = (...a) => { warnings.push(a.map(String).join(' ').slice(0, 200)); origWarn(...a) }
        try {
            const resolved = await resolveSourceFile(new File([blob], name, { type: '' }))
            const bmp = await createImageBitmap(resolved)
            const full = document.createElement('canvas')
            full.width = Math.round(bmp.width * scale)
            full.height = Math.round(bmp.height * scale)
            full.getContext('2d').drawImage(bmp, 0, 0, full.width, full.height)
            bmp.close?.()
            // Is anything actually in the source canvas?
            const srcCtx = full.getContext('2d', { willReadFrequently: true })
            out.sourcePixel = Array.from(srcCtx.getImageData(Math.round(full.width / 2), Math.round(full.height / 2), 1, 1).data)
            out.size = `${full.width}x${full.height}`
            out.megapixels = +((full.width * full.height) / 1e6).toFixed(1)

            const el = document.createElement('canvas')
            el.width = full.width
            el.height = full.height
            const fcanvas = new StaticCanvas(el, { width: el.width, height: el.height, renderOnAddRemove: false, enableRetinaScaling: false })
            const img = new FabricImage(full, { left: 0, top: 0, objectCaching: false })
            fcanvas.add(img)

            const t0 = performance.now()
            applyMegashaderFilter(img, {
                chain: [{
                    op: 'replace',
                    layer: {
                        ...radialLayer({
                            imageSize: { width: full.width, height: full.height },
                            center: { x: full.width / 2, y: full.height * 0.42 },
                            radius: { x: full.width * 0.28, y: full.height * 0.3 },
                            feather: 0.4,
                        }),
                        inverted: true,
                        blurPx,
                        blurKind: 'disc',
                        highlightGain: 2,
                    },
                }],
            }, { globalMaskAlpha: 1 })
            fcanvas.renderAll()
            out.commitMs = Math.round(performance.now() - t0)
            out.filters = (img.filters || []).map((f) => f?.type || '?')
            out.metrics = (() => { const m = getRenderMetrics(); return { uploads: m.sourceUploads, mips: m.sourceMipBuilds, cpuFallbacks: m.cpuFallbacks ?? null, cacheMisses: m.cacheMisses ?? null } })()
            out.glLimits = (() => {
                const gl = document.createElement('canvas').getContext('webgl2')
                return gl ? { maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxRenderbuffer: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) } : null
            })()

            const filtered = img._element || img.getElement()
            out.filteredSize = `${filtered.width}x${filtered.height}`
            const ctx = filtered.getContext('2d', { willReadFrequently: true })
            const at = (fx, fy) => Array.from(ctx.getImageData(Math.round(fx * filtered.width), Math.round(fy * filtered.height), 1, 1).data).slice(0, 3)
            out.centre = at(0.5, 0.42)
            out.corner = at(0.05, 0.95)

            // A small visual so the result can be judged by eye.
            const view = document.createElement('canvas')
            const viewScale = Math.min(1, 900 / Math.max(filtered.width, filtered.height))
            view.width = Math.round(filtered.width * viewScale)
            view.height = Math.round(filtered.height * viewScale)
            const vctx = view.getContext('2d')
            vctx.imageSmoothingQuality = 'high'
            vctx.drawImage(filtered, 0, 0, view.width, view.height)
            out.preview = view.toDataURL('image/jpeg', 0.85)
        } catch (error) {
            out.error = String(error?.message || error).slice(0, 200)
        } finally {
            console.warn = origWarn
            out.warnings = warnings.slice(0, 4)
        }
        return out
    },

    /** What the working-resolution rule would fetch for a project of this size. */
    workingEdge: (w, h) => ({
        edge: workingEdgeForProject({ width: w, height: h }),
        url: imagekitResized('https://ik.imagekit.io/demo/photo.jpg', workingEdgeForProject({ width: w, height: h })),
    }),

    /** A CMYK JPEG must be recognisable from its header alone. */
    cmyk: async () => {
        const meta = await readImageMeta(cmykJpegHeader())
        const normal = await readImageMeta(await jpegWithOrientation(1))
        return { cmyk: meta, normal }
    },

    /** Tainted-canvas recovery: a SecurityError on encode must be retried once. */
    taint: async () => {
        const { canvas } = await buildCollage({ layoutId: '2-split-h', photos: [[1200, 1200], [1200, 1200]] })
        const err = new Error('Tainted canvases may not be exported.')
        err.name = 'SecurityError'
        const recognised = isTaintError(err)
        let threwOnce = false
        const element = document.createElement('canvas')
        const realToBlob = element.constructor.prototype.toBlob
        element.constructor.prototype.toBlob = function patched(cb, ...rest) {
            if (!threwOnce) { threwOnce = true; throw err }
            return realToBlob.call(this, cb, ...rest)
        }
        let result = null
        try {
            result = await snapshotCanvasToBlob(canvas, { project: { width: 1080, height: 1080 }, format: 'png' })
        } catch (error) {
            result = { error: error?.name || String(error) }
        } finally {
            element.constructor.prototype.toBlob = realToBlob
        }
        return { recognised, threwOnce, result: result?.blob ? { size: result.blob.size, type: result.mimeType } : result }
    },

    /** Orientation change mid-edit: cells live in image space, so a viewport flip
     *  must not move them. */
    viewportFlip: async () => {
        const built = await buildCollage({ width: 1080, height: 1080, layoutId: '4-grid', gap: 8, padding: 8 })
        const before = built.images.map((img) => ({ ...img.phosmithCollageCell }))
        built.canvas.setDimensions({ width: 600, height: 340 })
        built.canvas.setViewportTransform([0.5, 0, 0, 0.5, 12, 7])
        built.canvas.renderAll()
        built.canvas.setDimensions({ width: 340, height: 600 })
        built.canvas.setViewportTransform([0.31, 0, 0, 0.31, 3, 19])
        built.canvas.renderAll()
        const after = built.images.map((img) => ({ ...img.phosmithCollageCell }))
        return { before, after }
    },
}
