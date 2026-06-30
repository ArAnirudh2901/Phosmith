// Preloaded before verify-subject-cleanup.mjs: installs a pure-JS <canvas> shim
// and DOM globals so the real subject-mask-cleanup module graph runs headlessly
// under bun. The cleanup path uses canvas SOLELY as a pixel buffer
// (getImageData / putImageData / createImageData / drawImage — including the
// 9-arg up/downscale in fillEnclosedMaskRegions) with no path or text
// rasterisation, so this shim is faithful and needs no native deps (node-canvas
// requires system cairo/pango that aren't built here). drawImage implements real
// source-over alpha compositing — fillEnclosedMaskRegions depends on transparent
// source pixels leaving the destination untouched.
//
// The @/ alias (and the @/lib/megashader stub) are resolved by this dir's
// tsconfig.json path mapping.
class ImageData {
  constructor(a, b, c) {
    if (a instanceof Uint8ClampedArray) { this.data = a; this.width = b; this.height = c }
    else { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4) }
  }
}
const parseColor = (s) => {
  if (typeof s !== 'string') return [0, 0, 0, 255]
  if (s === 'white' || s === '#fff' || s === '#ffffff') return [255, 255, 255, 255]
  if (s === 'black' || s === '#000' || s === '#000000') return [0, 0, 0, 255]
  let h = s.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length === 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255]
  return [0, 0, 0, 255]
}
class Ctx2D {
  constructor(canvas) { this.canvas = canvas; this._fill = '#000' }
  set fillStyle(v) { this._fill = v }
  get fillStyle() { return this._fill }
  getImageData(x, y, w, h) {
    const cw = this.canvas.width, ch = this.canvas.height, buf = this.canvas._buf
    const out = new Uint8ClampedArray(w * h * 4)
    for (let r = 0; r < h; r += 1) for (let c = 0; c < w; c += 1) {
      const sx = x + c, sy = y + r
      if (sx < 0 || sy < 0 || sx >= cw || sy >= ch) continue
      const si = (sy * cw + sx) * 4, di = (r * w + c) * 4
      out[di] = buf[si]; out[di + 1] = buf[si + 1]; out[di + 2] = buf[si + 2]; out[di + 3] = buf[si + 3]
    }
    return new ImageData(out, w, h)
  }
  putImageData(img, dx, dy) {
    const cw = this.canvas.width, ch = this.canvas.height, buf = this.canvas._buf
    for (let r = 0; r < img.height; r += 1) for (let c = 0; c < img.width; c += 1) {
      const tx = dx + c, ty = dy + r
      if (tx < 0 || ty < 0 || tx >= cw || ty >= ch) continue
      const si = (r * img.width + c) * 4, ti = (ty * cw + tx) * 4
      buf[ti] = img.data[si]; buf[ti + 1] = img.data[si + 1]; buf[ti + 2] = img.data[si + 2]; buf[ti + 3] = img.data[si + 3]
    }
  }
  createImageData(w, h) { return new ImageData(w, h) }
  // Nearest-neighbour blit with proper source-over alpha compositing — the real
  // <canvas> drawImage semantics. fillEnclosedMaskRegions relies on this:
  // transparent (alpha 0) source pixels must leave the destination unchanged.
  drawImage(src, ...a) {
    let sx = 0, sy = 0, sw = src.width, sh = src.height, dx, dy, dw, dh
    if (a.length === 2) { [dx, dy] = a; dw = src.width; dh = src.height }
    else if (a.length === 4) { [dx, dy, dw, dh] = a }
    else { [sx, sy, sw, sh, dx, dy, dw, dh] = a }
    const sbuf = src._buf, scw = src.width, sch = src.height
    const dbuf = this.canvas._buf, dcw = this.canvas.width, dch = this.canvas.height
    for (let r = 0; r < dh; r += 1) for (let c = 0; c < dw; c += 1) {
      const tx = dx + c, ty = dy + r
      if (tx < 0 || ty < 0 || tx >= dcw || ty >= dch) continue
      const u = sw <= 0 ? 0 : Math.min(sw - 1, (c * sw / dw) | 0)
      const v = sh <= 0 ? 0 : Math.min(sh - 1, (r * sh / dh) | 0)
      const ssx = sx + u, ssy = sy + v
      if (ssx < 0 || ssy < 0 || ssx >= scw || ssy >= sch) continue
      const si = (ssy * scw + ssx) * 4, ti = (ty * dcw + tx) * 4
      const sA = sbuf[si + 3] / 255
      if (sA <= 0) continue                                   // transparent: keep dest
      if (sA >= 1) { dbuf[ti] = sbuf[si]; dbuf[ti + 1] = sbuf[si + 1]; dbuf[ti + 2] = sbuf[si + 2]; dbuf[ti + 3] = 255; continue }
      const dA = dbuf[ti + 3] / 255
      const oA = sA + dA * (1 - sA)
      for (let k = 0; k < 3; k += 1) dbuf[ti + k] = oA <= 0 ? 0 : Math.round((sbuf[si + k] * sA + dbuf[ti + k] * dA * (1 - sA)) / oA)
      dbuf[ti + 3] = Math.round(oA * 255)
    }
  }
  fillRect(x, y, w, h) {
    const [r, g, b, al] = parseColor(this._fill)
    const cw = this.canvas.width, ch = this.canvas.height, buf = this.canvas._buf
    for (let yy = 0; yy < h; yy += 1) for (let xx = 0; xx < w; xx += 1) {
      const tx = x + xx, ty = y + yy
      if (tx < 0 || ty < 0 || tx >= cw || ty >= ch) continue
      const ti = (ty * cw + tx) * 4; buf[ti] = r; buf[ti + 1] = g; buf[ti + 2] = b; buf[ti + 3] = al
    }
  }
  beginPath() {} arc() {} fill() {} closePath() {} moveTo() {} lineTo() {} rect() {}
  save() {} restore() {} translate() {} scale() {} setTransform() {} clearRect() {}
}
class Canvas {
  constructor(w = 1, h = 1) { this._w = 0; this._h = 0; this._ctx = null; this.width = w; this.height = h }
  get width() { return this._w }
  set width(v) { this._w = v | 0; this._alloc() }
  get height() { return this._h }
  set height(v) { this._h = v | 0; this._alloc() }
  _alloc() { this._buf = new Uint8ClampedArray(Math.max(0, this._w) * Math.max(0, this._h) * 4) }
  getContext() { if (!this._ctx) this._ctx = new Ctx2D(this); return this._ctx }
}
globalThis.ImageData = ImageData
globalThis.Canvas = Canvas
globalThis.document = {
  createElement: (tag) => {
    if (tag === 'canvas') return new Canvas(1, 1)
    throw new Error(`unsupported createElement(${tag})`)
  },
}
globalThis.window = globalThis.window || {}
