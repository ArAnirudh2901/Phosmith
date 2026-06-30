#!/usr/bin/env node
/**
 * End-to-end test for the local mask service.
 *
 * Synthesises a coloured circle on a contrasting background, POSTs it to
 * `MASK_SERVICE_URL/segment` (default http://127.0.0.1:8002/segment), and
 * asserts the returned PNG has a non-degenerate alpha channel that covers
 * the subject region.
 *
 * Skips gracefully if the service is unreachable (exit 0, no failure).
 * Exits 1 only when the service is reachable but returns a bad mask.
 */

import sharp from 'sharp'

const MASK_SERVICE_URL = (process.env.MASKING_SERVICE_URL || process.env.MASK_SERVICE_URL || 'http://127.0.0.1:8002')
  .trim()
  .replace(/\/+$/, '')

const W = 512
const H = 512
const SUBJECT_COVERAGE_MIN = 0.20  // alpha must cover >= 20% of subject bbox
const SUBJECT_COVERAGE_MAX = 0.95  // ... and <= 95% (rejects near-empty masks)

const log = (label, msg) => console.log(`[verify-segment] ${label} ${msg}`)

const synthesizeTestImage = async () => {
  const cx = W / 2
  const cy = H / 2
  const r = W / 4

  // Solid green background
  const bg = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 30, g: 140, b: 60, alpha: 1 } },
  })
    .png()
    .toBuffer()

  // Solid red circle subject
  const circle = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: r * 2, height: r * 2, channels: 4, background: { r: 220, g: 30, b: 30, alpha: 1 } },
        })
          .png()
          .toBuffer(),
        left: Math.round(cx - r),
        top: Math.round(cy - r),
      },
    ])
    .png()
    .toBuffer()

  // Composite subject over background
  return sharp(bg).composite([{ input: circle, blend: 'over' }]).jpeg({ quality: 90 }).toBuffer()
}

const probeService = async () => {
  try {
    const res = await fetch(`${MASK_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return { ok: false, reason: `health ${res.status}` }
    return { ok: true, health: await res.json() }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

const analyseMask = async (pngBuffer) => {
  const { data, info } = await sharp(pngBuffer, { failOn: 'none' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  if (info.channels < 4) {
    return { ok: false, reason: 'no alpha channel in response' }
  }

  const { width, height, channels } = info
  const bbox = { x0: width, y0: height, x1: 0, y1: 0 }
  let alphaSum = 0
  let opaqueCount = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * channels + 3]
      alphaSum += a
      if (a > 128) {
        opaqueCount++
        if (x < bbox.x0) bbox.x0 = x
        if (y < bbox.y0) bbox.y0 = y
        if (x > bbox.x1) bbox.x1 = x
        if (y > bbox.y1) bbox.y1 = y
      }
    }
  }

  const totalPixels = width * height
  const meanAlpha = alphaSum / totalPixels / 255
  const subjectArea = opaqueCount / totalPixels
  const bboxArea = bbox.x1 > bbox.x0
    ? ((bbox.x1 - bbox.x0 + 1) * (bbox.y1 - bbox.y0 + 1)) / totalPixels
    : 0
  const subjectInBbox = bboxArea > 0 ? opaqueCount / (bboxArea * totalPixels) : 0

  return {
    ok: subjectArea >= SUBJECT_COVERAGE_MIN && subjectArea <= SUBJECT_COVERAGE_MAX,
    width,
    height,
    meanAlpha,
    subjectArea,
    bboxArea,
    subjectInBbox,
  }
}

const fail = (msg) => {
  console.error(`[verify-segment] FAIL: ${msg}`)
  process.exit(1)
}

const main = async () => {
  console.log(`[verify-segment] service: ${MASK_SERVICE_URL}`)

  const probe = await probeService()
  if (!probe.ok) {
    log('skip', `mask service unreachable (${probe.reason}). Start it with: bun run mask:dev`)
    process.exit(0)
  }
  log('health', JSON.stringify(probe.health))

  const imageBuffer = await synthesizeTestImage()
  log('input', `${W}x${H} test image: ${imageBuffer.length} bytes`)

  const t0 = performance.now()
  const res = await fetch(`${MASK_SERVICE_URL}/segment`, {
    method: 'POST',
    body: (() => {
      const fd = new FormData()
      fd.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'test.jpg')
      return fd
    })(),
    signal: AbortSignal.timeout(90_000),
  })
  const elapsed = performance.now() - t0

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    fail(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('image')) {
    fail(`non-image content-type: ${ct}`)
  }

  const buf = Buffer.from(await res.arrayBuffer())
  log('response', `${buf.length} bytes in ${elapsed.toFixed(0)}ms (model: ${res.headers.get('x-model') || '?'})`)

  const analysis = await analyseMask(buf)
  if (!analysis.ok) {
    fail(`mask non-degenerate check failed: subject area ${(analysis.subjectArea * 100).toFixed(1)}% not in [${(SUBJECT_COVERAGE_MIN * 100).toFixed(0)}%, ${(SUBJECT_COVERAGE_MAX * 100).toFixed(0)}%]`)
  }

  log('mask', `${analysis.width}x${analysis.height}, mean alpha ${(analysis.meanAlpha * 100).toFixed(1)}%, subject area ${(analysis.subjectArea * 100).toFixed(1)}%, bbox fill ${(analysis.subjectInBbox * 100).toFixed(1)}%`)
  console.log('[verify-segment] PASS')
  process.exit(0)
}

main().catch((e) => fail(e?.message || String(e)))
