// Empty collage slot: a persistent canvas object shaped like its cell (rect,
// ellipse, polygon, multi-piece silhouette or rotated print) with a "+" badge.
// Clicking it in the Collage tool uploads a photo into exactly that shape.

import { FabricObject, classRegistry } from 'fabric'

export const COLLAGE_SLOT_TYPE = 'CollageSlot'

export class CollageSlot extends FabricObject {
    static type = COLLAGE_SLOT_TYPE

    constructor(options = {}) {
        super(options)
        this.slot = options.slot || { kind: 'rect' }
        this.set({
            // Clicks still reach it (evented) without a selection box.
            selectable: false,
            evented: true,
            hasControls: false,
            lockMovementX: true,
            lockMovementY: true,
            lockRotation: true,
            lockScalingX: true,
            lockScalingY: true,
            hoverCursor: 'pointer',
            objectCaching: false,
        })
    }

    // Local geometry: slot points are absolute; the object renders around its centre.
    _trace(ctx) {
        const s = this.slot
        const w = this.width, h = this.height
        ctx.beginPath()
        if (s.kind === 'ellipse') {
            ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2)
            return
        }
        if (s.kind === 'poly' || s.kind === 'multi') {
            const ox = this.left + (this.originX === 'center' ? 0 : w / 2)
            const oy = this.top + (this.originY === 'center' ? 0 : h / 2)
            for (const poly of s.kind === 'multi' ? s.pieces : [s.points]) {
                poly.forEach((p, i) => (i ? ctx.lineTo(p.x - ox, p.y - oy) : ctx.moveTo(p.x - ox, p.y - oy)))
                ctx.closePath()
            }
            return
        }
        const r = Math.min(0.5, s.radius || 0) * Math.min(w, h)
        if (ctx.roundRect) ctx.roundRect(-w / 2, -h / 2, w, h, r)
        else ctx.rect(-w / 2, -h / 2, w, h)
    }

    _render(ctx) {
        const w = this.width, h = this.height
        const m = Math.min(w, h)
        ctx.save()
        this._trace(ctx)
        ctx.fillStyle = 'rgba(18, 20, 26, 0.62)'
        ctx.fill()
        ctx.lineWidth = Math.max(1.5, m * 0.008)
        ctx.setLineDash([m * 0.04, m * 0.03])
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)'
        ctx.stroke()
        ctx.setLineDash([])
        const r = Math.max(8, m * 0.09)
        ctx.beginPath()
        ctx.arc(0, 0, r, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'
        ctx.fill()
        ctx.lineWidth = Math.max(2, r * 0.18)
        ctx.lineCap = 'round'
        ctx.strokeStyle = '#0b0d12'
        ctx.beginPath()
        ctx.moveTo(-r * 0.45, 0); ctx.lineTo(r * 0.45, 0)
        ctx.moveTo(0, -r * 0.45); ctx.lineTo(0, r * 0.45)
        ctx.stroke()
        ctx.restore()
    }

    toObject(propertiesToInclude = []) {
        return super.toObject(['slot', ...propertiesToInclude])
    }
}

classRegistry.setClass(CollageSlot)

export const isCollageSlot = (obj) => obj?.type === COLLAGE_SLOT_TYPE || obj instanceof CollageSlot

/** Build a slot object for a solved cell. */
export const createSlot = (cell) => {
    if (cell.kind === 'print') {
        const w = cell.w + 2 * (cell.mat || 0), h = cell.h + 2 * (cell.mat || 0)
        return new CollageSlot({
            left: cell.cx, top: cell.cy, width: w, height: h, angle: cell.angle || 0,
            originX: 'center', originY: 'center',
            slot: { kind: 'print', cx: cell.cx, cy: cell.cy, w: cell.w, h: cell.h, angle: cell.angle || 0, mat: cell.mat || 0 },
        })
    }
    // Tapestry cells overlap their neighbours; an empty slot uses the core tile.
    const box = cell.core || cell
    const slot = { kind: cell.kind === 'multi' || cell.kind === 'poly' || cell.kind === 'ellipse' ? cell.kind : 'rect', x: box.x, y: box.y, w: box.w, h: box.h, radius: cell.radius || 0 }
    if (cell.kind === 'poly') slot.points = cell.points
    if (cell.kind === 'multi') slot.pieces = cell.pieces
    return new CollageSlot({ left: box.x, top: box.y, width: box.w, height: box.h, originX: 'left', originY: 'top', slot })
}

/** The cell a slot stands for (inverse of createSlot). */
export const cellFromSlot = (slotObj) => {
    const s = slotObj.slot || {}
    if (s.kind === 'print') return { kind: 'print', cx: s.cx, cy: s.cy, w: s.w, h: s.h, angle: s.angle, mat: s.mat, z: 0 }
    return { ...s, z: 0 }
}
