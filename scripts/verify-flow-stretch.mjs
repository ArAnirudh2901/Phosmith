#!/usr/bin/env node
/**
 * Invariant tests for the Flow Path pixel-stretch engine — pure Node, no canvas
 * or services required (matches the verify-agent-loop / verify-megashader
 * pattern). Covers only the canvas-free geometry layer:
 *
 *   sanitizeFlowPath:        via clampStretchParams — clamps, drops malformed,
 *                            enforces the anchor cap, survives round-trips.
 *   buildFlowLUT:            arc length is monotonic non-decreasing, total > 0,
 *                            (seg, local-t) origin is consistent, tangents unit.
 *   createFlowPathFromPoints: smooth Catmull-Rom handles (hin = -hout), width.
 *   createDefaultFlowPath:   inherits the simple-mode arch as a usable path.
 *   insertFlowAnchor:        adds one anchor, preserves endpoints + curve shape,
 *                            respects FLOW_MAX_ANCHORS.
 *   removeFlowAnchor:        drops one, never below FLOW_MIN_ANCHORS.
 *   applyFlowPreset:         every preset yields a renderable path.
 *   analyzeStretchPlan-ish:  createFlowPathFromPoints accepts a planner path.
 */

import assert from 'node:assert/strict'
import {
  DEFAULT_STRETCH,
  clampStretchParams,
  buildFlowLUT,
  createFlowPathFromPoints,
  createDefaultFlowPath,
  insertFlowAnchor,
  removeFlowAnchor,
  smoothFlowPath,
  applyFlowPreset,
  getFlowPathHandles,
  FLOW_PRESETS,
  FLOW_MIN_ANCHORS,
  FLOW_MAX_ANCHORS,
} from '../src/lib/pixel-stretch.js'

let passed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`)
    process.exitCode = 1
  }
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

console.log('[verify-flow-stretch] sanitize')

test('clampStretchParams keeps a valid flow path and clamps width', () => {
  const fp = { anchors: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }], width: 9 }
  const p = clampStretchParams({ ...DEFAULT_STRETCH, flowPath: fp })
  assert.ok(p.flowPath, 'flow path survived')
  assert.equal(p.flowPath.anchors.length, 2)
  assert.ok(p.flowPath.width <= 1.5 && p.flowPath.width > 0, 'width clamped')
})

test('clampStretchParams rejects a sub-minimum flow path', () => {
  const p = clampStretchParams({ ...DEFAULT_STRETCH, flowPath: { anchors: [{ x: 0.5, y: 0.5 }] } })
  assert.equal(p.flowPath, null)
})

test('clampStretchParams drops NaN anchors and caps the count', () => {
  const anchors = [{ x: 0.1, y: 0.1 }, { x: NaN, y: 0.5 }]
  for (let i = 0; i < FLOW_MAX_ANCHORS + 10; i++) anchors.push({ x: i / 100, y: 0.5 })
  const p = clampStretchParams({ ...DEFAULT_STRETCH, flowPath: { anchors } })
  assert.ok(p.flowPath, 'still valid after dropping NaN')
  assert.ok(p.flowPath.anchors.length <= FLOW_MAX_ANCHORS, 'count capped')
  assert.ok(p.flowPath.anchors.every((a) => Number.isFinite(a.x) && Number.isFinite(a.y)), 'no NaN')
})

console.log('[verify-flow-stretch] buildFlowLUT')

test('arc length is monotonic non-decreasing and total > 0', () => {
  const fp = createFlowPathFromPoints([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.4 }, { x: 0.9, y: 0.9 }])
  const lut = buildFlowLUT(fp.anchors, 1000, 1000, 48)
  assert.ok(lut.total > 0, 'total length positive')
  for (let i = 1; i < lut.pts.length; i++) {
    assert.ok(lut.pts[i].s >= lut.pts[i - 1].s - 1e-9, `s monotonic at ${i}`)
  }
  assert.ok(near(lut.pts[lut.pts.length - 1].s, lut.total, 1e-6), 'last s == total')
})

test('LUT tangents are unit length and seg/local-t are in range', () => {
  const fp = createFlowPathFromPoints([{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.3 }, { x: 0.5, y: 0.9 }])
  const lut = buildFlowLUT(fp.anchors, 800, 600, 32)
  for (const pt of lut.pts) {
    assert.ok(near(Math.hypot(pt.tx, pt.ty), 1, 1e-3), 'tangent unit')
    assert.ok(pt.seg >= 0 && pt.seg < fp.anchors.length - 1, 'seg in range')
    assert.ok(pt.lt >= 0 && pt.lt <= 1, 'local t in range')
  }
})

test('buildFlowLUT on degenerate input is empty, not a throw', () => {
  const lut = buildFlowLUT([{ x: 0.5, y: 0.5 }], 100, 100)
  assert.equal(lut.total, 0)
  assert.equal(lut.pts.length, 0)
})

console.log('[verify-flow-stretch] createFlowPathFromPoints / default / smooth')

test('Catmull-Rom anchors are smooth (hin = -hout)', () => {
  const fp = createFlowPathFromPoints([{ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.2 }, { x: 0.9, y: 0.5 }])
  for (const a of fp.anchors) {
    assert.ok(near(a.hix, -a.hox) && near(a.hiy, -a.hoy), 'tangents mirrored')
  }
})

test('createFlowPathFromPoints needs >= 2 points', () => {
  assert.equal(createFlowPathFromPoints([{ x: 0.5, y: 0.5 }]), null)
  assert.equal(createFlowPathFromPoints([]), null)
})

test('createDefaultFlowPath inherits a usable arch', () => {
  const fp = createDefaultFlowPath({ ...DEFAULT_STRETCH, length: 2.5, bend: 0.6 }, 4)
  assert.ok(fp && fp.anchors.length >= 2, 'has anchors')
  const lut = buildFlowLUT(fp.anchors, 1000, 1000, 40)
  assert.ok(lut.total > 0, 'renderable length')
})

test('smoothFlowPath preserves anchor count and per-anchor width', () => {
  let fp = createFlowPathFromPoints([{ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.4 }, { x: 0.9, y: 0.9 }])
  fp.anchors[1].w = 2.3
  const sm = smoothFlowPath(fp)
  assert.equal(sm.anchors.length, fp.anchors.length)
  assert.ok(near(sm.anchors[1].w, 2.3), 'width carried through')
})

console.log('[verify-flow-stretch] insert / remove')

test('insertFlowAnchor adds exactly one and preserves endpoints', () => {
  const fp = createFlowPathFromPoints([{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }])
  const before = fp.anchors.length
  const out = insertFlowAnchor(fp, 0.5, 0.5, 1000, 1000)
  assert.equal(out.anchors.length, before + 1, 'one anchor added')
  const a0 = fp.anchors[0], b0 = out.anchors[0]
  const aN = fp.anchors.at(-1), bN = out.anchors.at(-1)
  assert.ok(near(a0.x, b0.x) && near(a0.y, b0.y), 'first endpoint fixed')
  assert.ok(near(aN.x, bN.x) && near(aN.y, bN.y), 'last endpoint fixed')
})

test('insertFlowAnchor preserves the curve shape (de Casteljau)', () => {
  const fp = createFlowPathFromPoints([{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.8 }, { x: 0.9, y: 0.2 }])
  const lutA = buildFlowLUT(fp.anchors, 1000, 1000, 60)
  const out = insertFlowAnchor(fp, 0.5, 0.8, 1000, 1000)
  const lutB = buildFlowLUT(out.anchors, 1000, 1000, 60)
  // total arc length should barely change (same shape, finer control net)
  assert.ok(Math.abs(lutA.total - lutB.total) / lutA.total < 0.02, 'shape preserved within 2%')
})

test('insertFlowAnchor respects FLOW_MAX_ANCHORS', () => {
  let fp = createFlowPathFromPoints([{ x: 0.05, y: 0.05 }, { x: 0.95, y: 0.95 }])
  for (let i = 0; i < FLOW_MAX_ANCHORS + 5; i++) fp = insertFlowAnchor(fp, 0.4 + (i % 3) * 0.05, 0.4, 1000, 1000)
  assert.ok(fp.anchors.length <= FLOW_MAX_ANCHORS, 'never exceeds cap')
})

test('removeFlowAnchor drops one but never below the minimum', () => {
  const fp = createFlowPathFromPoints([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.9 }])
  const out = removeFlowAnchor(fp, 1)
  assert.equal(out.anchors.length, 2)
  const floor = removeFlowAnchor(out, 0)
  assert.equal(floor.anchors.length, FLOW_MIN_ANCHORS, 'stays at the floor')
})

console.log('[verify-flow-stretch] presets + handles')

test('every flow preset yields a renderable path', () => {
  for (const preset of FLOW_PRESETS) {
    const fp = applyFlowPreset({ ...DEFAULT_STRETCH }, preset.id)
    assert.ok(fp && fp.anchors.length >= 2, `${preset.id} has anchors`)
    const lut = buildFlowLUT(fp.anchors, 1000, 1000, 40)
    assert.ok(lut.total > 0, `${preset.id} has length`)
  }
})

test('getFlowPathHandles exposes anchors + interior tangents', () => {
  const fp = createFlowPathFromPoints([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.9 }])
  const handles = getFlowPathHandles({ ...DEFAULT_STRETCH, flowPath: fp }, 1000, 1000)
  const anchors = handles.filter((h) => h.kind === 'anchor')
  assert.equal(anchors.length, 3, 'one handle entry per anchor')
  // first anchor: out only; last: in only; middle: both
  assert.ok(!handles.some((h) => h.idx === 0 && h.kind === 'in'), 'first has no in-handle')
  assert.ok(!handles.some((h) => h.idx === 2 && h.kind === 'out'), 'last has no out-handle')
  assert.ok(handles.some((h) => h.idx === 1 && h.kind === 'in') && handles.some((h) => h.idx === 1 && h.kind === 'out'), 'middle has both')
})

console.log(`\n[verify-flow-stretch] ${passed} checks passed`)
if (process.exitCode) console.error('[verify-flow-stretch] FAILED')
