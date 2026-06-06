#!/usr/bin/env bun
/**
 * Mask edge-snap + new-kind verification
 * --------------------------------------
 * Runtime checks for the masking work that can't be exercised in the
 * auth-gated browser editor:
 *
 *   A. The magnetic-lasso edge engine (`src/lib/mask-edge-snap.js`) on
 *      synthetic images — gradient magnitude lands on real edges, and the
 *      proximity-dominant snap hugs the NEAREST edge (the reviewed fix).
 *   B. The new `brush` megashader kind compiles, is visible, and routes
 *      fill/erase; and per-region feather is a distinct per-slot uniform
 *      (so one region's feather never bleeds into another).
 *
 * Run: `bun scripts/verify-mask-edge-snap.mjs`  (exit 0 = all pass)
 */

import { computeGradientMagnitude, snapToEdgePoint } from '../src/lib/mask-edge-snap.js'
import { compileMegashader } from '../src/lib/megashader/megashader-compiler.js'
import { brushLayer, lassoLayer, stackHasNoVisibleEffect } from '../src/lib/megashader/mask-types.js'
import { KIND_SCHEMAS, getKindBuilder, getKindSchema } from '../src/lib/megashader/glsl-mask-kinds.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`\x1b[32m✓\x1b[0m ${label}`) }
  else { fail += 1; console.log(`\x1b[31m✗\x1b[0m ${label}`) }
}

/** Build RGBA for an image where a per-pixel callback returns [r,g,b]. */
const makeImage = (w, h, fn) => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = fn(x, y)
      const i = (y * w + x) * 4
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
    }
  }
  return data
}

/* ── A. Gradient magnitude ─────────────────────────────────────────── */
const W = 64, H = 48
// Vertical edge at x=32: left black, right white.
const edgeImg = makeImage(W, H, (x) => (x < 32 ? [0, 0, 0] : [255, 255, 255]))
const gmap = computeGradientMagnitude(edgeImg, W, H)
const at = (m, x, y) => m.mag[y * m.w + x]

ok(gmap.mag.length === W * H, 'gradient map sized w*h')
const edgeStrength = Math.max(at(gmap, 31, 24), at(gmap, 32, 24))
ok(edgeStrength > 0.8, `edge column has high gradient (${edgeStrength.toFixed(3)} > 0.8)`)
ok(at(gmap, 10, 24) < 0.05, `flat-left region has ~0 gradient (${at(gmap, 10, 24).toFixed(3)})`)
ok(at(gmap, 55, 24) < 0.05, `flat-right region has ~0 gradient (${at(gmap, 55, 24).toFixed(3)})`)
ok(at(gmap, 32, 0) === 0, 'top border row left at 0 (kernel needs full 3x3)')

// Uniform image → no edges anywhere.
const flat = computeGradientMagnitude(makeImage(W, H, () => [120, 120, 120]), W, H)
ok(flat.mag.every((v) => v === 0), 'uniform image → all-zero gradient map')

/* ── B. snapToEdgePoint ────────────────────────────────────────────── */
// A point just left of the edge snaps onto it.
const s1 = snapToEdgePoint(gmap, 28, 24, 8, 0.1)
ok(Math.abs(s1.x - 31.5) <= 2 && Math.abs(s1.y - 24) <= 2, `snap (28,24)→edge (${s1.x},${s1.y})`)
// A point just right of the edge snaps back onto it.
const s2 = snapToEdgePoint(gmap, 34, 24, 8, 0.1)
ok(Math.abs(s2.x - 31.5) <= 2, `snap (34,24)→edge (${s2.x},${s2.y})`)
// No edge within the search radius → point returned unchanged.
const s3 = snapToEdgePoint(gmap, 10, 24, 6, 0.1)
ok(s3.x === 10 && s3.y === 24, 'no edge in window → unchanged')
// Gradient map missing → unchanged (graceful).
const s4 = snapToEdgePoint(null, 5, 5, 8, 0.1)
ok(s4.x === 5 && s4.y === 5, 'null map → unchanged')

// Proximity dominance: a NEAR weak edge must beat a FAR strong edge.
// Weak edge at x≈20 (gray 100→140), strong edge at x≈50 (black→white).
const twoEdge = makeImage(W, H, (x) => {
  if (x < 20) return [100, 100, 100]
  if (x < 50) return [140, 140, 140]
  return [255, 255, 255]
})
const tg = computeGradientMagnitude(twoEdge, W, H)
const sNear = snapToEdgePoint(tg, 22, 24, 30, 0.04) // radius spans both edges
ok(sNear.x < 30, `proximity-dominant: snaps to NEAR edge x=${sNear.x} (not far strong edge ~50)`)

/* ── C. brush kind + per-region feather ────────────────────────────── */
ok(!!KIND_SCHEMAS.brush, 'brush kind registered in KIND_SCHEMAS')
ok(getKindSchema('brush').samplers.length === 1, 'brush schema has one sampler')
ok(getKindSchema('brush').uniforms.length === 0, 'brush schema has zero uniforms')
ok(typeof getKindBuilder('brush') === 'function', 'brush kind has a GLSL builder')

const brushFill = { chain: [{ layer: brushLayer({ maskTextureKey: 'k', fillMode: 'fill' }), op: 'replace' }] }
const cFill = compileMegashader(brushFill)
ok(!cFill.passthrough, 'brush fill layer compiles (not passthrough)')
ok(cFill.frag.includes('uLayer_0_kind_brush_mask'), 'brush frag declares its mask sampler')
ok(cFill.frag.includes('kind_brush_mask, vTextureCoord).a'), 'brush samples the ALPHA channel')
ok(stackHasNoVisibleEffect(brushFill) === false, 'brush fill selection IS visible (renders)')

const brushErase = { chain: [{ layer: brushLayer({ maskTextureKey: 'k', fillMode: 'erase' }), op: 'replace' }] }
ok(stackHasNoVisibleEffect(brushErase) === false, 'brush erase selection IS visible (renders)')

// Per-region feather: two lasso layers → two DISTINCT per-slot feather uniforms,
// proving each region owns its feather (no shared/global feather).
const twoLasso = {
  chain: [
    { layer: lassoLayer({ maskTextureKey: 'a', feather: 0.05 }), op: 'replace' },
    { layer: lassoLayer({ maskTextureKey: 'b', feather: 0.30 }), op: 'add' },
  ],
}
const cTwo = compileMegashader(twoLasso)
ok(cTwo.frag.includes('uLayer_0_kind_lasso_feather') && cTwo.frag.includes('uLayer_1_kind_lasso_feather'),
  'per-region feather: each lasso layer gets its own feather uniform')

console.log(`\n${pass}/${pass + fail} verifications passed.`)
process.exit(fail === 0 ? 0 : 1)
