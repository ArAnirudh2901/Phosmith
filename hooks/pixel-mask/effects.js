// The remover's motion, in the spirit of Photos' Clean Up: the area being
// regenerated shimmers while the fill runs, and the result dissolves in instead
// of popping. Both are DOM layers over the canvas animated with transform and
// opacity only, so they stay smooth on the compositor even while the on-device
// fill is busy on the main thread.

const STYLE_ID = 'phosmith-fill-effects'
const CSS = `
.phosmith-fill-shimmer { position: absolute; left: 0; top: 0; pointer-events: none; transform-origin: 0 0;
  overflow: hidden; -webkit-mask-size: 100% 100%; mask-size: 100% 100%; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  opacity: 0; transition: opacity 220ms ease-out; z-index: 2; }
.phosmith-fill-shimmer.is-on { opacity: 1; }
.phosmith-fill-shimmer__tint { position: absolute; inset: 0; background: rgba(255, 255, 255, 0.16);
  animation: phosmith-fill-breathe 1.6s ease-in-out infinite; }
.phosmith-fill-shimmer__sweep { position: absolute; top: 0; bottom: 0; left: -100%; width: 300%;
  background: linear-gradient(105deg, transparent 38%, rgba(255,255,255,0.55) 48%, rgba(186,230,253,0.65) 50%, rgba(255,255,255,0.55) 52%, transparent 62%);
  animation: phosmith-fill-sweep 1.25s cubic-bezier(0.45, 0, 0.25, 1) infinite; will-change: transform; }
@keyframes phosmith-fill-sweep { from { transform: translate3d(-33%, 0, 0); } to { transform: translate3d(33%, 0, 0); } }
@keyframes phosmith-fill-breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
.phosmith-fill-fade { position: absolute; pointer-events: none; transition: opacity 360ms cubic-bezier(0.2, 0, 0, 1); }
@media (prefers-reduced-motion: reduce) {
  .phosmith-fill-shimmer__sweep { animation: none; opacity: 0; }
  .phosmith-fill-shimmer__tint { animation: none; }
  .phosmith-fill-fade { transition-duration: 0ms; }
}`

const ensureStyle = () => {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
}

// Bounding box of the white area (mask px), from a small copy.
const maskBox = (mask) => {
    const s = Math.min(1, 256 / Math.max(mask.width, mask.height))
    const w = Math.max(1, Math.round(mask.width * s))
    const h = Math.max(1, Math.round(mask.height * s))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(mask, 0, 0, w, h)
    const d = ctx.getImageData(0, 0, w, h).data
    let x0 = w, y0 = h, x1 = -1, y1 = -1
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            if (d[(y * w + x) * 4] < 16) continue
            if (x < x0) x0 = x
            if (y < y0) y0 = y
            if (x > x1) x1 = x
            if (y > y1) y1 = y
        }
    }
    if (x1 < x0) return null
    return { x: x0 / s, y: y0 / s, w: (x1 - x0 + 1) / s, h: (y1 - y0 + 1) / s, small: c, s }
}

/**
 * Shimmer over the white area of `mask` until disposed; the mask sits at (x, y)
 * in the image's bitmap space, `scale` bitmap px per pixel. Follows pans and zooms.
 */
export function showFillShimmer(canvasEditor, img, mask, { x = 0, y = 0, scale = 1 } = {}) {
    const host = canvasEditor?.wrapperEl
    const box = mask && host ? maskBox(mask) : null
    if (!box) return { dispose() {} }
    ensureStyle()

    // The mask's own box, as an alpha mask image for CSS.
    const m = document.createElement('canvas')
    const mw = Math.max(1, Math.round(box.w * box.s))
    const mh = Math.max(1, Math.round(box.h * box.s))
    m.width = mw
    m.height = mh
    const mctx = m.getContext('2d', { willReadFrequently: true })
    mctx.drawImage(box.small, Math.round(box.x * box.s), Math.round(box.y * box.s), mw, mh, 0, 0, mw, mh)
    const md = mctx.getImageData(0, 0, mw, mh)
    for (let i = 0; i < md.data.length; i += 4) { md.data[i + 3] = md.data[i]; md.data[i] = 255; md.data[i + 1] = 255; md.data[i + 2] = 255 }
    mctx.putImageData(md, 0, 0)
    const url = `url(${m.toDataURL('image/png')})`

    const el = document.createElement('div')
    el.className = 'phosmith-fill-shimmer'
    el.style.webkitMaskImage = url
    el.style.maskImage = url
    el.style.width = `${box.w * scale}px`
    el.style.height = `${box.h * scale}px`
    el.innerHTML = '<div class="phosmith-fill-shimmer__tint"></div><div class="phosmith-fill-shimmer__sweep"></div>'
    host.appendChild(el)

    const place = () => {
        const v = canvasEditor.viewportTransform || [1, 0, 0, 1, 0, 0]
        const t = img.calcTransformMatrix()
        // viewport · object · (bitmap origin at -w/2,-h/2, then the box offset)
        const ox = x + box.x * scale - img.width / 2
        const oy = y + box.y * scale - img.height / 2
        const a = v[0] * t[0] + v[2] * t[1], b = v[1] * t[0] + v[3] * t[1]
        const c = v[0] * t[2] + v[2] * t[3], d = v[1] * t[2] + v[3] * t[3]
        const ex = v[0] * t[4] + v[2] * t[5] + v[4], ey = v[1] * t[4] + v[3] * t[5] + v[5]
        const left = canvasEditor.lowerCanvasEl?.offsetLeft || 0
        const top = canvasEditor.lowerCanvasEl?.offsetTop || 0
        el.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${a * ox + c * oy + ex + left}, ${b * ox + d * oy + ey + top})`
    }
    place()
    canvasEditor.on('after:render', place)
    requestAnimationFrame(() => el.classList.add('is-on'))

    return {
        dispose() {
            canvasEditor.off('after:render', place)
            el.classList.remove('is-on')
            setTimeout(() => el.remove(), 260)
        },
    }
}

/**
 * Run `apply` (which changes the image), then dissolve from the old frame to the
 * new one. The old frame is a copy of the canvas, so whatever `apply` does, the
 * eye sees one continuous change.
 */
export async function crossfade(canvasEditor, apply) {
    const lower = canvasEditor?.lowerCanvasEl
    const host = canvasEditor?.wrapperEl
    if (!lower || !host) return apply()
    ensureStyle()
    const snap = document.createElement('canvas')
    snap.width = lower.width
    snap.height = lower.height
    snap.getContext('2d').drawImage(lower, 0, 0)
    snap.className = 'phosmith-fill-fade'
    snap.style.left = `${lower.offsetLeft}px`
    snap.style.top = `${lower.offsetTop}px`
    snap.style.width = lower.style.width || `${lower.clientWidth}px`
    snap.style.height = lower.style.height || `${lower.clientHeight}px`
    lower.after(snap)
    try {
        const result = await apply()
        canvasEditor.renderAll()
        return result
    } finally {
        requestAnimationFrame(() => {
            snap.style.opacity = '0'
            setTimeout(() => snap.remove(), 420)
        })
    }
}
