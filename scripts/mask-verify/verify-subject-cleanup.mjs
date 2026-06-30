#!/usr/bin/env bun
/**
 * Subject-mask cleanup verification
 * ---------------------------------
 * Runtime checks for src/lib/subject-mask-cleanup.js — the on-device fallback
 * that turns a soft RMBG-1.4 matte into a solid, hole-free subject selection
 * (the SAM 3.1 mask service is preferred when reachable). Exercises the failure
 * modes that motivated the module on synthetic mattes:
 *
 *   T1  interior HOLES filled, stray sky SPECKS removed, single solid subject
 *   T2  a second, smaller figure is KEPT while specks are dropped
 *   T3  backlit-silhouette dark body recovered by the luminance assist
 *       (and proven inert when the assist is disabled)
 *   T4  the fragmentation signal (holesFilledFrac) is RESOLUTION-INDEPENDENT
 *       for images larger than fillEnclosedMaskRegions' 1536px downscale cap
 *
 * Loads the REAL module (cleanSubjectMatte → growMaskCanvas/growCoverage →
 * fillEnclosedMaskRegions). _canvas-shim.mjs (preloaded) provides a pure-JS
 * pixel-buffer canvas; tsconfig.json maps the @/ alias and stubs the unused
 * megashader barrel. See README.md for why this one needs a shim when the other
 * verify scripts don't.
 *
 * Run:  bun run verify:subject-cleanup        (exit 0 = all pass)
 *   or: cd scripts/mask-verify && bun --preload ./_canvas-shim.mjs ./verify-subject-cleanup.mjs
 */
import { cleanSubjectMatte } from '@/lib/subject-mask-cleanup'

const Canvas = globalThis.Canvas
if (!Canvas) {
  console.error('canvas shim missing — run via `bun run verify:subject-cleanup` (needs --preload ./_canvas-shim.mjs)')
  process.exit(1)
}

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`\x1b[32m✓\x1b[0m ${label}`) }
  else { fail += 1; console.log(`\x1b[31m✗\x1b[0m ${label}`) }
}
const mk = (w, h, v = 0) => {
  const c = new Canvas(w, h)
  const d = c._buf
  for (let i = 0; i < d.length; i += 4) { d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255 }
  return c
}
const rect = (c, x0, y0, x1, y1, v) => {
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const i = (y * c.width + x) * 4; const d = c._buf; d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255
  }
}
const at = (c, x, y) => c._buf[(y * c.width + x) * 4]

const W = 120, H = 120

/* ── T1: holes filled + specks removed, single subject ─────────────── */
{
  const m = mk(W, H, 0)
  rect(m, 30, 20, 90, 110, 255)
  const holes = [[40, 30], [70, 40], [50, 70], [75, 90]]
  for (const [x, y] of holes) rect(m, x, y, x + 8, y + 8, 0)
  const specks = [[8, 8], [110, 12], [12, 110], [105, 105], [100, 8]]
  for (const [x, y] of specks) rect(m, x, y, x + 3, y + 3, 255)

  const { canvas, diagnostics } = cleanSubjectMatte(m, { threshold: 0.5, fillHoles: true, luminanceAssist: false })
  ok(holes.every(([x, y]) => at(canvas, x + 4, y + 4) === 255), 'T1 interior holes filled (all 4 hole centers now 255)')
  ok(specks.every(([x, y]) => at(canvas, x + 1, y + 1) === 0), 'T1 sky specks removed (all 5 speck centers now 0)')
  ok(diagnostics.componentsKept === 1, `T1 single subject kept (componentsKept=${diagnostics.componentsKept})`)
  ok(diagnostics.coverage > 0.33 && diagnostics.coverage < 0.43, `T1 coverage ≈ subject area (${diagnostics.coverage.toFixed(3)})`)
}

/* ── T2: a second smaller figure is kept, specks dropped ───────────── */
{
  const m = mk(W, H, 0)
  rect(m, 30, 20, 80, 90, 255)
  rect(m, 95, 40, 110, 90, 255)
  for (const [x, y] of [[8, 8], [110, 12], [12, 110]]) rect(m, x, y, x + 3, y + 3, 255)
  const { diagnostics } = cleanSubjectMatte(m, { threshold: 0.5, fillHoles: true, luminanceAssist: false })
  ok(diagnostics.componentsKept === 2, `T2 both figures kept, specks dropped (componentsKept=${diagnostics.componentsKept})`)
}

/* ── T3: backlit-silhouette luminance assist recovers dark body ────── */
{
  const src = mk(W, H, 220)               // bright sky
  rect(src, 45, 15, 75, 100, 20)          // dark silhouette, upper+lower (connected)
  const m = mk(W, H, 0)
  rect(m, 45, 15, 75, 55, 255)            // RMBG caught only the upper body…
  rect(m, 48, 24, 72, 48, 0)              // …with a 24×24 interior hole (survives close → fragmented)
  const lower = [60, 80]                   // dark lower body the matte missed

  const off = cleanSubjectMatte(m, { threshold: 0.5, fillHoles: true, luminanceAssist: false })
  const on = cleanSubjectMatte(m, { threshold: 0.5, fillHoles: true, luminanceAssist: true, sourceCanvas: src, darkThreshold: 0.5 })

  ok(on.diagnostics.fragmented === true, `T3 matte flagged fragmented (raw=${on.diagnostics.componentsRaw}, holesFrac=${on.diagnostics.holesFilledFrac.toFixed(4)})`)
  ok(at(off.canvas, lower[0], lower[1]) === 0, 'T3 WITHOUT assist: dark lower body stays unselected (0)')
  ok(at(on.canvas, lower[0], lower[1]) === 255, 'T3 WITH assist: dark lower body recovered (255)')
}

/* ── T4: holes-filled fraction is resolution-INDEPENDENT (>1536px) ─── */
{
  const W2 = 2400, H2 = 80                  // max dim 2400 > 1536 → fillEnclosedMaskRegions downscales internally
  const m = mk(W2, H2, 0)
  rect(m, 50, 10, 2350, 70, 255)           // wide subject
  rect(m, 1000, 22, 1300, 58, 0)           // 300×36 enclosed hole
  const trueFrac = (300 * 36) / (W2 * H2)  // 0.05625
  const { canvas, diagnostics } = cleanSubjectMatte(m, { threshold: 0.5, fillHoles: true, luminanceAssist: false })
  // The full-res-delta measure ≈ trueFrac minus close-shrink. The pre-fix code
  // (downscaled count ÷ full area) yielded ≈ trueFrac × s² (s=1536/2400≈0.64,
  // s²≈0.41) ≈ 0.023 — below 0.7×trueFrac — so this fails on the old formula.
  ok(diagnostics.holesFilledFrac > trueFrac * 0.7, `T4 holesFilledFrac resolution-independent (${diagnostics.holesFilledFrac.toFixed(4)} > ${(trueFrac * 0.7).toFixed(4)}; pre-fix ≈ ${(trueFrac * 0.41).toFixed(4)})`)
  ok(diagnostics.fragmented === true, 'T4 large-image fragmentation still detected')
  ok(at(canvas, 1150, 40) === 255, 'T4 hole filled at full resolution')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
