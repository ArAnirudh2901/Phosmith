// One rAF loop for every NeoButton's magnet and press.
//
// The old magnet listened only while the pointer was ON the button and mapped
// position linearly from the centre, so the pull was at its strongest the moment
// the pointer crossed the edge: nothing, then a 4-5px lurch. Here the pull is a
// field around the button — zero `reach` px away, rising smoothly (smoothstep) to
// full at the edge — and the offset follows its target through a critically
// damped spring (exponential, frame-rate independent), so nothing ever steps.
// Press is driven by the same spring, since a CSS transition and a per-frame
// writer fight over the same property.

const items = new Set()
let pointer = null
let raf = 0
let last = 0
let listening = false

const FOLLOW_S = 0.09   // magnet time constant
const PRESS_S = 0.025   // sinking into the shadow
const RELEASE_S = 0.11  // coming back up

const reducedMotion = () => typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const smoothstep = (x) => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

const approach = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau))

function write(item) {
  const { node, cur } = item
  const off = item.cfg().offset
  // Pressed, the face slides onto its shadow; the magnet fades out under the press.
  const tx = cur.x * (1 - cur.p) + off * cur.p
  const ty = cur.y * (1 - cur.p) + off * cur.p
  node.style.setProperty('--neo-dx', `${tx.toFixed(2)}px`)
  node.style.setProperty('--neo-dy', `${ty.toFixed(2)}px`)
  node.style.setProperty('--neo-shx', `${((off - cur.x * 0.5) * (1 - cur.p)).toFixed(2)}px`)
  node.style.setProperty('--neo-shy', `${((off - cur.y * 0.5) * (1 - cur.p)).toFixed(2)}px`)
}

function target(item) {
  const cfg = item.cfg()
  if (!cfg.magnetic || cfg.disabled || !pointer || reducedMotion()) return { x: 0, y: 0 }
  const r = item.node.getBoundingClientRect()
  if (!r.width || !r.height) return { x: 0, y: 0 }
  // The rect includes the current translate; measure the button at rest.
  const tx = item.cur.x * (1 - item.cur.p), ty = item.cur.y * (1 - item.cur.p)
  const cx = r.left - tx + r.width / 2, cy = r.top - ty + r.height / 2
  const hw = r.width / 2, hh = r.height / 2
  const dx = pointer.x - cx, dy = pointer.y - cy
  // Distance from the pointer to the button's edge (0 inside).
  const ox = Math.max(0, Math.abs(dx) - hw), oy = Math.max(0, Math.abs(dy) - hh)
  const strength = smoothstep(1 - Math.hypot(ox, oy) / cfg.reach)
  if (strength <= 0) return { x: 0, y: 0 }
  // Direction scaled over the whole field, so the pull is continuous across the
  // edge and eases back to nothing as the pointer reaches the centre.
  const nx = Math.max(-1, Math.min(1, dx / (hw + cfg.reach)))
  const ny = Math.max(-1, Math.min(1, dy / (hh + cfg.reach)))
  return { x: nx * cfg.pull * strength, y: ny * cfg.pull * strength }
}

function frame(now) {
  const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60)
  last = now
  let moving = false
  for (const item of items) {
    const t = target(item)
    const pressTarget = item.pressed ? 1 : 0
    item.cur.x = approach(item.cur.x, t.x, dt, FOLLOW_S)
    item.cur.y = approach(item.cur.y, t.y, dt, FOLLOW_S)
    item.cur.p = reducedMotion() ? pressTarget : approach(item.cur.p, pressTarget, dt, item.pressed ? PRESS_S : RELEASE_S)
    if (Math.abs(item.cur.x - t.x) < 0.01) item.cur.x = t.x
    if (Math.abs(item.cur.y - t.y) < 0.01) item.cur.y = t.y
    if (Math.abs(item.cur.p - pressTarget) < 0.005) item.cur.p = pressTarget
    write(item)
    if (item.cur.x !== t.x || item.cur.y !== t.y || item.cur.p !== pressTarget || t.x !== 0 || t.y !== 0) moving = true
  }
  // Keep running while anything is off rest or the pointer sits in a field; a
  // still pointer far from every button costs nothing.
  raf = moving ? requestAnimationFrame(frame) : 0
  if (!raf) last = 0
}

const kick = () => { if (!raf && items.size) raf = requestAnimationFrame(frame) }

const onMove = (e) => {
  if (e.pointerType && e.pointerType !== 'mouse') return
  pointer = { x: e.clientX, y: e.clientY }
  kick()
}
const onOut = (e) => { if (!e.relatedTarget) { pointer = null; kick() } }
const onUp = () => {
  let any = false
  for (const item of items) if (item.pressed) { item.pressed = false; any = true }
  if (any) kick()
}

function listen(on) {
  const fn = on ? 'addEventListener' : 'removeEventListener'
  window[fn]('pointermove', onMove, { passive: true })
  window[fn]('scroll', kick, { passive: true, capture: true })
  window[fn]('pointerup', onUp)
  window[fn]('pointercancel', onUp)
  document[fn]('pointerout', onOut)
  listening = on
}

/** Track a button. `cfg()` returns { magnetic, disabled, offset, pull, reach }. */
export function registerMagnet(node, cfg) {
  const item = { node, cfg, cur: { x: 0, y: 0, p: 0 }, pressed: false }
  items.add(item)
  if (!listening && typeof window !== 'undefined') listen(true)
  return {
    press() { item.pressed = true; kick() },
    release() { if (item.pressed) { item.pressed = false; kick() } },
    dispose() {
      items.delete(item)
      if (!items.size && listening) {
        listen(false)
        if (raf) cancelAnimationFrame(raf)
        raf = 0
        last = 0
      }
    },
  }
}
