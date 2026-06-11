#!/usr/bin/env node
/**
 * Invariant tests for the AI Extender's expansion-frame math
 * (src/lib/expansion-pipeline.js). Pure functions — no services needed.
 *
 * Pins the resize edge cases:
 *   - unionFrameBounds keeps every edge independent: dragging one handle
 *     inward past the image boundary must NOT move the opposite extension
 *     (the original max(width)/min(left) clamp regressed exactly this way)
 *   - frameToPixelExpansion maps canvas-space frames to pixel insets,
 *     drops sub-pixel jitter, and respects the 4096 output cap
 *   - validateExpansion rejects a no-inset frame and over-cap outputs
 *
 * Usage: bun scripts/verify-extend-frame.mjs
 */

import {
  frameToPixelExpansion,
  unionFrameBounds,
  validateExpansion,
  MAX_OUTPUT_DIMENSION,
} from '../src/lib/expansion-pipeline.js'

let failures = 0
const check = (label, cond, detail = '') => {
  if (cond) {
    console.log(`[verify-extend-frame] ok ${label}`)
  } else {
    failures += 1
    console.error(`[verify-extend-frame] ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── unionFrameBounds ────────────────────────────────────────────────────────
{
  const img = { left: 100, top: 50, width: 300, height: 200 }

  // Frame extended 100px to the right, left handle then dragged inward to 150
  // (past the image's left edge at 100). The right edge must stay at 500.
  const dragged = { left: 150, top: 50, width: 350, height: 200 }
  const u = unionFrameBounds(img, dragged)
  check(
    'left-handle inward drag preserves right extension',
    u.left === 100 && u.left + u.width === 500,
    `got left=${u.left} right=${u.left + u.width}`
  )

  // Same vertically: top handle dragged inward must not move the bottom edge.
  const draggedV = { left: 100, top: 120, width: 300, height: 230 } // bottom = 350
  const uv = unionFrameBounds(img, draggedV)
  check(
    'top-handle inward drag preserves bottom extension',
    uv.top === 50 && uv.top + uv.height === 350,
    `got top=${uv.top} bottom=${uv.top + uv.height}`
  )

  // Frame fully inside the image collapses to the image bounds.
  const inside = { left: 150, top: 80, width: 100, height: 100 }
  const ui = unionFrameBounds(img, inside)
  check(
    'frame inside image collapses to image bounds',
    ui.left === img.left && ui.top === img.top && ui.width === img.width && ui.height === img.height
  )

  // Frame covering the image on all sides is returned unchanged.
  const around = { left: 60, top: 10, width: 400, height: 300 }
  const ua = unionFrameBounds(img, around)
  check(
    'frame around image is unchanged',
    ua.left === 60 && ua.top === 10 && ua.width === 400 && ua.height === 300
  )
}

// ── frameToPixelExpansion ───────────────────────────────────────────────────
{
  const pixelDims = { width: 1600, height: 1200 }
  const imageBounds = { left: 0, top: 0, width: 800, height: 600 } // 2x display scale

  // 100 canvas px on the right = 200 source px.
  const frame = { left: 0, top: 0, width: 900, height: 600 }
  const e = frameToPixelExpansion(imageBounds, frame, pixelDims)
  check(
    'right-only expansion maps to scaled insets',
    e.insets.right === 200 && e.insets.left === 0 && e.insets.top === 0 && e.insets.bottom === 0,
    JSON.stringify(e.insets)
  )
  check(
    'target dims add the insets',
    e.targetWidth === 1800 && e.targetHeight === 1200,
    `${e.targetWidth}x${e.targetHeight}`
  )
  check('offsets follow left/top insets', e.offsetX === 0 && e.offsetY === 0)

  // Sub-pixel handle jitter (<2 source px) is dropped.
  const jitter = frameToPixelExpansion(
    imageBounds,
    { left: -0.5, top: 0, width: 800.5, height: 600 },
    pixelDims
  )
  check(
    'sub-pixel jitter produces no insets',
    Object.values(jitter.insets).every((v) => v === 0),
    JSON.stringify(jitter.insets)
  )

  // Output is capped at MAX_OUTPUT_DIMENSION even for a huge frame.
  const huge = frameToPixelExpansion(
    imageBounds,
    { left: -2000, top: -2000, width: 4800, height: 4600 },
    pixelDims
  )
  check(
    `output capped at ${MAX_OUTPUT_DIMENSION}`,
    huge.targetWidth <= MAX_OUTPUT_DIMENSION && huge.targetHeight <= MAX_OUTPUT_DIMENSION,
    `${huge.targetWidth}x${huge.targetHeight}`
  )
  check(
    'capped expansion stays self-consistent',
    huge.targetWidth === huge.sourceWidth + huge.insets.left + huge.insets.right &&
      huge.targetHeight === huge.sourceHeight + huge.insets.top + huge.insets.bottom
  )
}

// ── validateExpansion ───────────────────────────────────────────────────────
{
  const noInset = {
    sourceWidth: 800,
    sourceHeight: 600,
    targetWidth: 800,
    targetHeight: 600,
    insets: { top: 0, left: 0, right: 0, bottom: 0 },
  }
  check('no-inset frame is rejected', validateExpansion(noInset).valid === false)

  const ok = {
    sourceWidth: 800,
    sourceHeight: 600,
    targetWidth: 1000,
    targetHeight: 600,
    insets: { top: 0, left: 0, right: 200, bottom: 0 },
  }
  check('valid expansion passes', validateExpansion(ok).valid === true)

  const overCap = {
    sourceWidth: 4000,
    sourceHeight: 600,
    targetWidth: MAX_OUTPUT_DIMENSION + 10,
    targetHeight: 600,
    insets: { top: 0, left: 0, right: MAX_OUTPUT_DIMENSION + 10 - 4000, bottom: 0 },
  }
  check('over-cap output is rejected', validateExpansion(overCap).valid === false)
}

if (failures > 0) {
  console.error(`\n[verify-extend-frame] ✗ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n[verify-extend-frame] ✓ all checks passed')
