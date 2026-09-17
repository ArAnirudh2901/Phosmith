// Composer ↔ Fabric: frame each photo into its solved cell (focus-aware cover,
// clip shape, shadow) or place it as a rotated print, draw gallery previews from
// the analysis thumbnails, and apply per-photo harmony as an editable
// megashader layer.

import { Rect, Ellipse, Polygon, Path, Shadow, FabricImage } from 'fabric'
import { getCollageSource } from '../collage-layout'
import { coverWindow, focusTarget } from './compose'
import { isNeutralAdjustment } from './finish'

// Fabric scales shadows by the object's scale; divide so they read the same at any size.
const shadowFor = (strength, S, scale) => (strength > 0.01
    ? new Shadow({
        color: `rgba(8, 10, 16, ${(0.16 + 0.3 * strength).toFixed(3)})`,
        blur: (S * 0.022 * strength) / scale,
        offsetX: 0,
        offsetY: (S * 0.01 * strength) / scale,
    })
    : null)

// Tapestry seam mask → a canvas whose alpha is the cell's coverage.
const maskCanvas = (mask) => {
    const c = document.createElement('canvas')
    c.width = mask.w
    c.height = mask.h
    const ctx = c.getContext('2d')
    const img = ctx.createImageData(mask.w, mask.h)
    for (let p = 0; p < mask.data.length; p += 1) {
        const i = p * 4
        img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = mask.data[p]
    }
    ctx.putImageData(img, 0, 0)
    return c
}

const multiPathData = (pieces) => pieces
    .map((poly) => `M ${poly.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')} Z`)
    .join(' ')

const clipFor = (cell) => {
    const common = { originX: 'left', originY: 'top', absolutePositioned: true }
    if (cell.mask) {
        const el = maskCanvas(cell.mask)
        return new FabricImage(el, { left: cell.x, top: cell.y, scaleX: cell.w / cell.mask.w, scaleY: cell.h / cell.mask.h, ...common })
    }
    if (cell.kind === 'multi') {
        const path = new Path(multiPathData(cell.pieces), common)
        path.set({ left: cell.x, top: cell.y })
        return path
    }
    if (cell.kind === 'ellipse') {
        return new Ellipse({ left: cell.x, top: cell.y, rx: Math.max(1, cell.w / 2), ry: Math.max(1, cell.h / 2), ...common })
    }
    if (cell.kind === 'poly') {
        return new Polygon(cell.points.map((p) => ({ x: p.x, y: p.y })), common)
    }
    const r = Math.min(0.5, Math.max(0, cell.radius || 0)) * Math.min(cell.w, cell.h)
    return new Rect({ left: cell.x, top: cell.y, width: Math.max(1, cell.w), height: Math.max(1, cell.h), rx: r, ry: r, ...common })
}

const shadowStrengthOf = (image) => {
    const m = /rgba\([^)]*,\s*([\d.]+)\)/.exec(image?.shadow?.color || '')
    return m ? Math.max(0, Math.min(1, (Number(m[1]) - 0.16) / 0.3)) : 0
}

/**
 * Frame one photo into a cell: focus-aware cover crop + clip shape, or a
 * rotated print. `cell.maskClip` reuses an existing seam-mask clip.
 */
export const placeImageInCell = (image, cell, photo, { shadow = 0.45, matColor = '#f7f5ef', S } = {}) => {
    // A cell clip replaces any pixel (erase) mask; drop its state so saves don't resurrect it.
    image._phosmithHasMask = false
    image.phosmithHasMask = false
    image._phosmithMaskCanvas = undefined
    const src = getCollageSource(image)
    const short = S || Math.min(cell.w, cell.h) * 3
    const base = {
        originX: 'center',
        originY: 'center',
        width: src.width,
        height: src.height,
        cropX: src.cropX,
        cropY: src.cropY,
        selectable: true,
        evented: true,
        lockSkewingX: true,
        lockSkewingY: true,
    }
    if (cell.kind === 'print') {
        const scale = Math.min(cell.w / src.width, cell.h / src.height)
        image.set({
            ...base,
            left: cell.cx,
            top: cell.cy,
            scaleX: scale,
            scaleY: scale,
            angle: cell.angle || 0,
            clipPath: undefined,
            // Object units (not strokeUniform, which is zoom-dependent screen px).
            stroke: cell.mat > 0 ? matColor : null,
            strokeWidth: cell.mat > 0 ? (cell.mat * 2) / scale : 0,
            strokeUniform: false,
            shadow: shadowFor(Math.max(shadow, 0.3), short, scale),
            lockRotation: false,
        })
        image.phosmithCollageCell = undefined
        image._phosmithCollageCell = undefined
    } else {
        const scale = Math.max(cell.w / src.width, cell.h / src.height)
        const focus = photo ? focusTarget(photo) : { x: 0.5, y: 0.5 }
        const win = coverWindow(src.width / src.height, cell.w, cell.h, focus)
        image.set({
            ...base,
            left: cell.x + cell.w / 2 + (0.5 - (win.x0 + win.vw / 2)) * src.width * scale,
            top: cell.y + cell.h / 2 + (0.5 - (win.y0 + win.vh / 2)) * src.height * scale,
            scaleX: scale,
            scaleY: scale,
            angle: 0,
            stroke: null,
            strokeWidth: 0,
            strokeUniform: false,
            clipPath: cell.maskClip || clipFor(cell),
            shadow: shadowFor(shadow, short, scale),
            lockRotation: true,
        })
        const box = { x: cell.x, y: cell.y, w: cell.w, h: cell.h }
        image.phosmithCollageCell = box
        image._phosmithCollageCell = box
        image.phosmithCollageCoverScale = scale
        image._phosmithCollageCoverScale = scale
    }
    image.setCoords()
}

/** Recover a photo's cell (shape included) from its clip, or its print placement. */
export const cellFromImage = (image) => {
    if (!image) return null
    const cp = image.clipPath
    if (!cp) {
        if (!image.stroke && !image.angle) return null
        const scale = image.scaleX || 1
        return {
            kind: 'print', cx: image.left, cy: image.top, angle: image.angle || 0,
            w: (image.width || 0) * scale, h: (image.height || 0) * (image.scaleY || scale),
            mat: image.stroke ? ((image.strokeWidth || 0) * scale) / 2 : 0,
        }
    }
    if (!cp.absolutePositioned) return null
    const type = (cp.type || '').toLowerCase()
    const w = (cp.width || 0) * (cp.scaleX || 1)
    const h = (cp.height || 0) * (cp.scaleY || 1)
    if (type === 'rect') return { kind: 'rect', x: cp.left, y: cp.top, w, h, radius: (cp.rx || 0) / Math.max(1, Math.min(cp.width || 1, cp.height || 1)) }
    if (type === 'ellipse') return { kind: 'ellipse', x: cp.left, y: cp.top, w: (cp.rx || 0) * 2 * (cp.scaleX || 1), h: (cp.ry || 0) * 2 * (cp.scaleY || 1) }
    if (type === 'polygon' && Array.isArray(cp.points)) {
        const xs = cp.points.map((p) => p.x), ys = cp.points.map((p) => p.y)
        const x = Math.min(...xs), y = Math.min(...ys)
        return { kind: 'poly', points: cp.points.map((p) => ({ x: p.x, y: p.y })), x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
    }
    if (type === 'path' && Array.isArray(cp.path)) {
        const pieces = []
        let cur = null
        for (const cmd of cp.path) {
            if (cmd[0] === 'M') { cur = [{ x: cmd[1], y: cmd[2] }]; pieces.push(cur) }
            else if (cmd[0] === 'L' && cur) cur.push({ x: cmd[1], y: cmd[2] })
        }
        return { kind: 'multi', pieces: pieces.filter((pc) => pc.length >= 3), x: cp.left, y: cp.top, w, h }
    }
    return { kind: 'rect', x: cp.left, y: cp.top, w, h, radius: 0, maskClip: cp }
}

/**
 * @param {object} canvasEditor
 * @param {object[]} images  Fabric images, index-aligned with `analyses`
 * @param {object} layout    from composeLayout / composeCandidates
 * @param {object[]} analyses
 */
export const applyComposition = (canvasEditor, images, layout, analyses, { shadow = 0.45, matColor = '#f7f5ef' } = {}) => {
    const S = Math.min(layout.canvas.width, layout.canvas.height)
    const placed = []
    for (const cell of layout.cells) {
        const image = images[cell.index]
        const photo = analyses[cell.index]
        if (!image || !photo) continue
        placeImageInCell(image, cell, photo, { shadow, matColor, S })
        placed.push([cell.z ?? 0, image])
    }
    placed.sort((a, b) => a[0] - b[0]).forEach(([, img]) => canvasEditor.bringObjectToFront(img))
    canvasEditor.requestRenderAll()
}

/** Re-apply the composer shadow at a new strength, keeping each photo's placement. */
export const applyShadowStrength = (images, strength, S) => {
    for (const img of images) {
        const scale = img.scaleX || 1
        img.set({ shadow: shadowFor(img.clipPath ? strength : Math.max(strength, 0.3), S, scale) })
    }
}

/** Swap two framed photos' cells (shapes, masks, prints and stacking order). */
export const swapFramedPhotos = (canvasEditor, a, b, photoA, photoB, S) => {
    const ca = cellFromImage(a), cb = cellFromImage(b)
    if (!ca || !cb) return false
    const sa = shadowStrengthOf(a), sb = shadowStrengthOf(b)
    placeImageInCell(a, cb, photoA, { shadow: sb, S })
    placeImageInCell(b, ca, photoB, { shadow: sa, S })
    const objs = canvasEditor.getObjects()
    const ia = objs.indexOf(a), ib = objs.indexOf(b)
    if (ia >= 0 && ib >= 0 && typeof canvasEditor.moveObjectTo === 'function') {
        canvasEditor.moveObjectTo(a, ib)
        canvasEditor.moveObjectTo(b, ia)
    }
    canvasEditor.requestRenderAll()
    return true
}

const tracePath = (ctx, cell, k) => {
    ctx.beginPath()
    if (cell.kind === 'ellipse') {
        ctx.ellipse((cell.x + cell.w / 2) * k, (cell.y + cell.h / 2) * k, (cell.w / 2) * k, (cell.h / 2) * k, 0, 0, Math.PI * 2)
    } else if (cell.kind === 'poly' || cell.kind === 'multi') {
        for (const poly of cell.kind === 'multi' ? cell.pieces : [cell.points]) {
            poly.forEach((p, i) => (i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k)))
            ctx.closePath()
        }
    } else {
        const r = Math.min(0.5, cell.radius || 0) * Math.min(cell.w, cell.h) * k
        if (ctx.roundRect) ctx.roundRect(cell.x * k, cell.y * k, cell.w * k, cell.h * k, r)
        else ctx.rect(cell.x * k, cell.y * k, cell.w * k, cell.h * k)
    }
}

/** Draw a layout preview (gallery tile) from the analysis thumbnails. */
export const drawLayoutPreview = (canvas, layout, analyses, { background = '#1b1d22', matColor = '#f7f5ef' } = {}) => {
    const ctx = canvas.getContext('2d')
    const k = canvas.width / layout.canvas.width
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (Array.isArray(background)) {
        const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height)
        background.forEach((c, i) => g.addColorStop(i / Math.max(1, background.length - 1), c))
        ctx.fillStyle = g
    } else {
        ctx.fillStyle = background
    }
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const cells = layout.cells.slice().sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
    for (const cell of cells) {
        const a = analyses[cell.index]
        const thumb = a?.thumb
        ctx.save()
        if (!thumb) {
            // Empty slot: soft panel with a "+" badge.
            if (cell.kind === 'print') {
                ctx.translate(cell.cx * k, cell.cy * k)
                ctx.rotate((cell.angle * Math.PI) / 180)
                ctx.beginPath()
                ctx.rect((-cell.w / 2 - cell.mat) * k, (-cell.h / 2 - cell.mat) * k, (cell.w + 2 * cell.mat) * k, (cell.h + 2 * cell.mat) * k)
            } else {
                tracePath(ctx, cell, k)
            }
            ctx.fillStyle = 'rgba(255,255,255,0.16)'
            ctx.fill()
            ctx.setLineDash([3, 3])
            ctx.strokeStyle = 'rgba(255,255,255,0.7)'
            ctx.stroke()
            ctx.setLineDash([])
            const cx = cell.kind === 'print' ? 0 : (cell.x + cell.w / 2) * k
            const cy = cell.kind === 'print' ? 0 : (cell.y + cell.h / 2) * k
            const r = Math.max(3, Math.min(cell.w, cell.h) * k * 0.12)
            ctx.strokeStyle = 'rgba(255,255,255,0.9)'
            ctx.lineWidth = Math.max(1, r * 0.3)
            ctx.beginPath()
            ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r)
            ctx.stroke()
            ctx.restore()
            continue
        }
        if (cell.kind === 'print') {
            ctx.translate(cell.cx * k, cell.cy * k)
            ctx.rotate((cell.angle * Math.PI) / 180)
            ctx.shadowColor = 'rgba(0,0,0,0.35)'
            ctx.shadowBlur = 6
            ctx.fillStyle = matColor
            const mw = (cell.w + cell.mat * 2) * k, mh = (cell.h + cell.mat * 2) * k
            ctx.fillRect(-mw / 2, -mh / 2, mw, mh)
            ctx.shadowColor = 'transparent'
            ctx.drawImage(thumb, (-cell.w / 2) * k, (-cell.h / 2) * k, cell.w * k, cell.h * k)
        } else if (cell.mask) {
            const win = coverWindow(a.aspect, cell.w, cell.h, focusTarget(a))
            const tmp = document.createElement('canvas')
            tmp.width = Math.max(1, Math.round(cell.w * k))
            tmp.height = Math.max(1, Math.round(cell.h * k))
            const t = tmp.getContext('2d')
            t.drawImage(thumb, win.x0 * thumb.width, win.y0 * thumb.height, win.vw * thumb.width, win.vh * thumb.height, 0, 0, tmp.width, tmp.height)
            t.globalCompositeOperation = 'destination-in'
            t.drawImage(maskCanvas(cell.mask), 0, 0, tmp.width, tmp.height)
            ctx.drawImage(tmp, cell.x * k, cell.y * k)
        } else {
            tracePath(ctx, cell, k)
            ctx.clip()
            const win = coverWindow(a.aspect, cell.w, cell.h, focusTarget(a))
            ctx.drawImage(thumb, win.x0 * thumb.width, win.y0 * thumb.height, win.vw * thumb.width, win.vh * thumb.height, cell.x * k, cell.y * k, cell.w * k, cell.h * k)
        }
        ctx.restore()
    }
}

/**
 * Apply per-photo harmony as a full-coverage "Harmony" adjust layer. Photos that
 * already carry user mask layers are left alone (never clobber real edits).
 */
export const applyHarmony = async (images, adjustments) => {
    const mod = await import('@/lib/megashader')
    let applied = 0, skipped = 0
    images.forEach((img, i) => {
        const adj = adjustments[i]
        if (!img || !adj) return
        const existing = (img.filters || []).find((f) => f && f.type === 'Megashader')
        const chain = existing?.stack?.chain || []
        if (chain.some((e) => e?.layer?.tool !== 'harmony')) { skipped += 1; return }
        const base = existing?.stack?.base || null
        if (isNeutralAdjustment(adj)) {
            if (chain.length) mod.applyMegashaderFilter(img, { chain: [], base })
            return
        }
        const layer = mod.sanitiseLayer({ ...mod.luminanceLayer({ min: 0, max: 1, softness: 0, label: 'Harmony' }), ...adj })
        mod.applyMegashaderFilter(img, { chain: [{ op: 'replace', layer: { ...layer, tool: 'harmony' } }], base })
        applied += 1
    })
    return { applied, skipped }
}
