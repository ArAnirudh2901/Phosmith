#!/usr/bin/env node
/**
 * End-to-end test for the SAM 2 click-to-select endpoint.
 *
 * Synthesises a synthetic image with a high-contrast subject, POSTs it
 * with a positive click to /sam2/click, and asserts the returned mask
 * is a non-degenerate greyscale PNG that covers the subject area.
 *
 * Skips gracefully if the service is unreachable or SAM 2 is not loaded
 * (exit 0, friendly message). Exits 1 only when the service responds
 * with a bad mask.
 */

import sharp from 'sharp'

const MASK_SERVICE_URL = (process.env.MASKING_SERVICE_URL || process.env.MASK_SERVICE_URL || 'http://127.0.0.1:8002')
  .trim()
  .replace(/\/+$/, '')

const W = 512
const H = 512
const SUBJECT_COVERAGE_MIN = 0.05
const SUBJECT_COVERAGE_MAX = 0.95
const SCORE_MIN = 0.10
const SCORE_MAX = 1.0

const log = (label, msg) => console.log(`[verify-semantic] ${label} ${msg}`)

const callSam2 = async (imageBuffer, clicks) => {
  const t0 = performance.now()
  const res = await fetch(`${MASK_SERVICE_URL}/sam2/click`, {
    method: 'POST',
    body: (() => {
      const fd = new FormData()
      fd.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'test.jpg')
      fd.append('clicks', JSON.stringify(clicks))
      return fd
    })(),
    signal: AbortSignal.timeout(180_000),
  })
  const elapsed = performance.now() - t0
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    fail(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('image')) fail(`non-image content-type: ${ct}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return {
    buf,
    elapsedMs: elapsed,
    model: res.headers.get('x-model') || '?',
    score: parseFloat(res.headers.get('x-score') || 'NaN'),
  }
}

const assertScore = (label, score) => {
  if (!Number.isFinite(score)) {
    fail(`${label} score is not finite (got ${score})`)
  }
  if (score < SCORE_MIN || score > SCORE_MAX) {
    fail(`${label} score ${score.toFixed(4)} not in [${SCORE_MIN}, ${SCORE_MAX}]`)
  }
}

const synthesizeTestImage = async () => {
  const cx = W / 2
  const cy = H / 2
  const r = W / 4

  const bg = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 30, g: 140, b: 60, alpha: 1 } },
  })
    .png()
    .toBuffer()

  const circle = await sharp({
    create: { width: r * 2, height: r * 2, channels: 4, background: { r: 220, g: 30, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer()

  return sharp(bg)
    .composite([{ input: circle, left: Math.round(cx - r), top: Math.round(cy - r) }])
    .jpeg({ quality: 90 })
    .toBuffer()
}

const probeService = async () => {
  try {
    const res = await fetch(`${MASK_SERVICE_URL}/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return { ok: false, reason: `health ${res.status}` }
    return { ok: true, health: await res.json() }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

const analyseMask = async (pngBuffer) => {
  const { data, info } = await sharp(pngBuffer, { failOn: 'none' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height, channels } = info
  let opaque = 0
  let sum = 0
  for (let i = 0; i < width * height; i++) {
    const v = data[i * channels]
    sum += v
    if (v > 128) opaque++
  }
  const total = width * height
  const mean = sum / total / 255
  const coverage = opaque / total
  return { width, height, meanAlpha: mean, subjectArea: coverage }
}

const fail = (msg) => {
  console.error(`[verify-semantic] FAIL: ${msg}`)
  process.exit(1)
}

const main = async () => {
  console.log(`[verify-semantic] service: ${MASK_SERVICE_URL}`)

  const probe = await probeService()
  if (!probe.ok) {
    log('skip', `mask service unreachable (${probe.reason}). Start it with: bun run mask:dev`)
    process.exit(0)
  }
  log('health', JSON.stringify(probe.health))
  if (!probe.health.sam2_available) {
    log('skip', 'SAM 2 not loaded on this server. Install torch+torchvision+transformers and restart.')
    process.exit(0)
  }

  const imageBuffer = await synthesizeTestImage()
  log('input', `${W}x${H} test image: ${imageBuffer.length} bytes`)

  // (1) Single-click: model must return a confident, non-degenerate mask.
  const single = [[Math.round(W / 2), Math.round(H / 2), 1]]
  const r1 = await callSam2(imageBuffer, single)
  log('response[1-click]', `${r1.buf.length} bytes in ${r1.elapsedMs.toFixed(0)}ms (model: ${r1.model}, score: ${r1.score.toFixed(4)})`)
  assertScore('1-click', r1.score)
  const a1 = await analyseMask(r1.buf)
  if (a1.subjectArea < SUBJECT_COVERAGE_MIN || a1.subjectArea > SUBJECT_COVERAGE_MAX) {
    fail(
      `1-click mask non-degenerate check failed: subject area ${(a1.subjectArea * 100).toFixed(1)}% not in [${(SUBJECT_COVERAGE_MIN * 100).toFixed(0)}%, ${(SUBJECT_COVERAGE_MAX * 100).toFixed(0)}%]`,
    )
  }
  log('mask[1-click]', `${a1.width}x${a1.height}, mean alpha ${(a1.meanAlpha * 100).toFixed(1)}%, subject area ${(a1.subjectArea * 100).toFixed(1)}%`)

  // (2) Multi-click refinement: two positive points on the same image
  // should still return a confident, non-degenerate mask. This catches
  // bugs in the [image, object, point, [x, y]] / [image, object, label]
  // nested-list construction in main.py.
  const multi = [
    [Math.round(W / 2), Math.round(H / 2), 1],
    [Math.round(W / 2) + 30, Math.round(H / 2) + 30, 1],
  ]
  const r2 = await callSam2(imageBuffer, multi)
  log('response[2-click]', `${r2.buf.length} bytes in ${r2.elapsedMs.toFixed(0)}ms (model: ${r2.model}, score: ${r2.score.toFixed(4)})`)
  assertScore('2-click', r2.score)
  const a2 = await analyseMask(r2.buf)
  if (a2.subjectArea < SUBJECT_COVERAGE_MIN || a2.subjectArea > SUBJECT_COVERAGE_MAX) {
    fail(
      `2-click mask non-degenerate check failed: subject area ${(a2.subjectArea * 100).toFixed(1)}% not in [${(SUBJECT_COVERAGE_MIN * 100).toFixed(0)}%, ${(SUBJECT_COVERAGE_MAX * 100).toFixed(0)}%]`,
    )
  }
  log('mask[2-click]', `${a2.width}x${a2.height}, mean alpha ${(a2.meanAlpha * 100).toFixed(1)}%, subject area ${(a2.subjectArea * 100).toFixed(1)}%`)

  console.log('[verify-semantic] PASS')
  process.exit(0)
}

main().catch((e) => fail(e?.message || String(e)))
