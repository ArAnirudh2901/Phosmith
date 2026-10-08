// Brush-stroke undo as copy-on-write tiles. A stroke saves each 256 px tile of
// the mask the first time a dab reaches it, instead of RLE-encoding the whole
// mask on pointer-down (two full readbacks, ~130 ms at 24 MP, before the first
// dab could land). Tiles keep only the grey channel; an untouched white tile is
// stored as `null`.

export const TILE = 256

export const beginTileUndo = (maskCanvas) => ({
    width: maskCanvas.width,
    height: maskCanvas.height,
    tiles: new Map(),
})

const packTile = (x, y, w, h, rgba) => {
    const n = w * h
    const grey = new Uint8Array(n)
    let white = true
    for (let p = 0, i = 0; p < n; p += 1, i += 4) {
        const v = rgba[i]
        grey[p] = v
        if (v !== 255) white = false
    }
    return { x, y, w, h, data: white ? null : grey }
}

/** Save every not-yet-saved tile touching the rect [x0, x1] × [y0, y1] (mask px). */
export function captureTiles(tx, maskCanvas, x0, y0, x1, y1) {
    if (!tx || !maskCanvas) return
    const cols = Math.ceil(tx.width / TILE)
    const rows = Math.ceil(tx.height / TILE)
    const c0 = Math.max(0, Math.floor(x0 / TILE))
    const r0 = Math.max(0, Math.floor(y0 / TILE))
    const c1 = Math.min(cols - 1, Math.floor(x1 / TILE))
    const r1 = Math.min(rows - 1, Math.floor(y1 / TILE))
    if (c1 < c0 || r1 < r0) return
    let ctx = null
    for (let r = r0; r <= r1; r += 1) {
        for (let c = c0; c <= c1; c += 1) {
            const key = r * cols + c
            if (tx.tiles.has(key)) continue
            const x = c * TILE
            const y = r * TILE
            const w = Math.min(TILE, tx.width - x)
            const h = Math.min(TILE, tx.height - y)
            ctx = ctx || maskCanvas.getContext('2d')
            tx.tiles.set(key, packTile(x, y, w, h, ctx.getImageData(x, y, w, h).data))
        }
    }
}

const entryOf = (width, height, tiles, at) => ({
    kind: 'tiles',
    width,
    height,
    tiles,
    at,
    bytes: tiles.reduce((sum, t) => sum + (t.data ? t.data.length : 0), 0),
})

/** The undo entry for a finished stroke, or null if no dab landed. */
export const finishTileUndo = (tx, at = Date.now()) =>
    tx?.tiles.size ? entryOf(tx.width, tx.height, [...tx.tiles.values()], at) : null

/** Write an entry's tiles into the mask; returns the entry that undoes this write. */
export function applyTileEntry(entry, maskCanvas) {
    const ctx = maskCanvas.getContext('2d')
    const inverse = []
    for (const t of entry.tiles) {
        const image = ctx.getImageData(t.x, t.y, t.w, t.h)
        const d = image.data
        inverse.push(packTile(t.x, t.y, t.w, t.h, d))
        for (let p = 0, i = 0; p < t.w * t.h; p += 1, i += 4) {
            const v = t.data ? t.data[p] : 255
            d[i] = v
            d[i + 1] = v
            d[i + 2] = v
            d[i + 3] = 255
        }
        ctx.putImageData(image, t.x, t.y)
    }
    return entryOf(entry.width, entry.height, inverse, entry.at)
}

/** Bounding rect of an entry's tiles. */
export function tileEntryRect(entry) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const t of entry.tiles) {
        x0 = Math.min(x0, t.x)
        y0 = Math.min(y0, t.y)
        x1 = Math.max(x1, t.x + t.w)
        y1 = Math.max(y1, t.y + t.h)
    }
    return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}
