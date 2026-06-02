#!/usr/bin/env node
/**
 * End-to-end test for the Depth Anything V2 endpoint.
 *
 * Synthesises a 256×256 test image (a clear green-on-dark "subject"
 * disc), POSTs it to /depth, and asserts the returned depth map is a
 * non-degenerate greyscale PNG with realistic per-image min-max
 * normalisation. A second test confirms the second call hits the
 * server-side cache (sub-millisecond response).
 *
 * Skips gracefully if the service is unreachable or the depth model
 * is not loaded (exit 0, friendly message). Exits 1 only when the
 * service responds with a bad mask.
 */

import sharp from 'sharp'

const MASK_SERVICE_URL = (process.env.MASK_SERVICE_URL || 'http://127.0.0.1:8001')
  .trim()
  .replace(/\/+$/, '')

const W = 256
const H = 256
const NONZERO_MIN = 0.50   // at least 50% non-zero pixels (not a flat-zero mask)
const NONZERO_MAX = 1.00
const MEAN_MIN = 0.10      // mean depth > 10% (not all-black)
const MEAN_MAX = 0.90

const log = (label, msg) => console.log(`[verify-depth] ${label} ${msg}`)

const callDepth = async (imageBuffer) => {
  const t0 = performance.now()
  const res = await fetch(`${MASK_SERVICE_URL}/depth`, {
    method: 'POST',
    body: (() => {
      const fd = new FormData()
      fd.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'test.jpg')
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
    serverElapsedMs: parseFloat(res.headers.get('x-elapsed-ms') || 'NaN'),
    model: res.headers.get('x-model') || '?',
    width: parseInt(res.headers.get('x-width') || '0', 10),
    height: parseInt(res.headers.get('x-height') || '0', 10),
  }
}

const synthesizeTestImage = async () => {
  // Green disc on a dark grey background — the disc should be nearer
  // than the background, so its depth values should be biased higher
  // than the corners. Depth Anything V2 is a monocular model so the
  // absolute ordering depends on learned priors, but the mean depth
  // must be > 0 (the model rarely returns a totally black image).
  const bg = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 30, g: 30, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer()

  const r = W / 4
  const disc = await sharp({
    create: { width: r * 2, height: r * 2, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer()

  return sharp(bg)
    .composite([{ input: disc, left: Math.round(W / 2 - r), top: Math.round(H / 2 - r) }])
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

const analyseDepth = async (pngBuffer) => {
  const { data, info } = await sharp(pngBuffer, { failOn: 'none' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height, channels } = info
  let nonzero = 0
  let sum = 0
  for (let i = 0; i < width * height; i++) {
    const v = data[i * channels]
    sum += v
    if (v > 0) nonzero++
  }
  const total = width * height
  const mean = sum / total / 255
  const nonzeroFraction = nonzero / total
  return { width, height, meanAlpha: mean, nonzeroFraction }
}

const fail = (msg) => {
  console.error(`[verify-depth] FAIL: ${msg}`)
  process.exit(1)
}

const main = async () => {
  console.log(`[verify-depth] service: ${MASK_SERVICE_URL}`)

  const probe = await probeService()
  if (!probe.ok) {
    log('skip', `mask service unreachable (${probe.reason}). Start it with: bun run mask:dev`)
    process.exit(0)
  }
  log('health', JSON.stringify(probe.health))
  if (!probe.health.depth_available) {
    log('skip', 'Depth Anything V2 not loaded on this server. Install torch+transformers and restart.')
    process.exit(0)
  }

  const imageBuffer = await synthesizeTestImage()
  log('input', `${W}x${H} test image: ${imageBuffer.length} bytes`)

  // (1) First call — fresh, should take ~1-4s on CPU, ~100-300ms on CUDA.
  const r1 = await callDepth(imageBuffer)
  log(
    'response[1st]',
    `${r1.buf.length} bytes in ${r1.elapsedMs.toFixed(0)}ms ` +
    `(server: ${Number.isFinite(r1.serverElapsedMs) ? r1.serverElapsedMs.toFixed(0) + 'ms' : '?'}, ` +
    `model: ${r1.model}, dims: ${r1.width}x${r1.height})`,
  )

  // The endpoint resizes the model's 518×518 output back to the
  // input's natural dimensions — so the returned PNG should match
  // the input. (The X-Width/X-Height headers report the input dims.)
  if (r1.width !== W || r1.height !== H) {
    fail(`depth output dims ${r1.width}x${r1.height} do not match input ${W}x${H}`)
  }

  const a1 = await analyseDepth(r1.buf)
  if (a1.width !== W || a1.height !== H) {
    fail(`depth PNG actual dims ${a1.width}x${a1.height} do not match input ${W}x${H}`)
  }
  if (a1.nonzeroFraction < NONZERO_MIN || a1.nonzeroFraction > NONZERO_MAX) {
    fail(`non-zero pixel fraction ${(a1.nonzeroFraction * 100).toFixed(1)}% not in [${(NONZERO_MIN * 100).toFixed(0)}%, ${(NONZERO_MAX * 100).toFixed(0)}%]`)
  }
  if (a1.meanAlpha < MEAN_MIN || a1.meanAlpha > MEAN_MAX) {
    fail(`mean depth ${(a1.meanAlpha * 100).toFixed(1)}% not in [${(MEAN_MIN * 100).toFixed(0)}%, ${(MEAN_MAX * 100).toFixed(0)}%]`)
  }
  log('mask[1st]', `${a1.width}x${a1.height}, mean depth ${(a1.meanAlpha * 100).toFixed(1)}%, non-zero ${(a1.nonzeroFraction * 100).toFixed(1)}%`)

  // (2) Second call — same image, should hit the server-side cache
  // and return in <100ms. The cache key is the SHA-256 of the raw
  // pixel data, so identical bytes = identical hash.
  const r2 = await callDepth(imageBuffer)
  log(
    'response[2nd]',
    `${r2.buf.length} bytes in ${r2.elapsedMs.toFixed(0)}ms ` +
    `(server: ${Number.isFinite(r2.serverElapsedMs) ? r2.serverElapsedMs.toFixed(0) + 'ms' : '?'})`,
  )
  if (r2.serverElapsedMs > 0.5) {
    fail(`expected cache hit (server elapsed ~0ms) on 2nd call; got ${r2.serverElapsedMs.toFixed(2)}ms`)
  }

  console.log('[verify-depth] PASS')
  process.exit(0)
}

main().catch((e) => fail(e?.message || String(e)))
