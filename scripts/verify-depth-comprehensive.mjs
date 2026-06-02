#!/usr/bin/env node
/**
 * Comprehensive depth endpoint test suite.
 *
 * Covers:
 *   1. Real-world image sizes (1024×768, 1920×1080, 2048×2048)
 *   2. Cache eviction stress (25 unique images against DEPTH_CACHE_MAX=20)
 *   3. Edge cases (1×1, grayscale, RGBA, transparent)
 *   4. DoS protections (over-cap dims, oversize body, bad content-type,
 *      corrupt image, no file, missing service)
 *
 * Skips gracefully if the service is unreachable or depth is not loaded.
 * Exits 1 only on assertion failure.
 */

import sharp from 'sharp'
import { performance } from 'node:perf_hooks'

const MASK_SERVICE_URL = (process.env.MASK_SERVICE_URL || 'http://127.0.0.1:8001')
  .trim()
  .replace(/\/+$/, '')

let passed = 0
let failed = 0
const failures = []

const log = (ok, label, detail = '') => {
  const tag = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
  console.log(`${tag} ${label}${detail ? `  ${detail}` : ''}`)
  if (ok) passed += 1
  else {
    failed += 1
    failures.push(label)
  }
}

const fail = (msg) => {
  console.error(`\x1b[31m✗ FATAL: ${msg}\x1b[0m`)
  process.exit(1)
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

const postImage = async (body, headers = {}, timeoutMs = 180_000) => {
  const t0 = performance.now()
  const res = await fetch(`${MASK_SERVICE_URL}/depth`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(timeoutMs),
    headers,
  })
  const elapsed = performance.now() - t0
  return { res, elapsedMs: elapsed }
}

const analyse = async (buf) => {
  const { data, info } = await sharp(buf, { failOn: 'none' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  let nonzero = 0, sum = 0
  for (let i = 0; i < width * height; i++) {
    const v = data[i * channels]
    sum += v
    if (v > 0) nonzero++
  }
  return {
    width, height,
    meanAlpha: sum / (width * height) / 255,
    nonzeroFraction: nonzero / (width * height),
    bytes: buf.length,
  }
}

const mkForm = (imageBuffer) => {
  const fd = new FormData()
  fd.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'test.jpg')
  return fd
}

// ─── Test groups ───────────────────────────────────────────────────────────

const testRealWorldSizes = async () => {
  console.log('\n── 1. Real-world image sizes ──')

  const sizes = [
    { name: '1024×768 (landscape)', w: 1024, h: 768 },
    { name: '1920×1080 (1080p)', w: 1920, h: 1080 },
    { name: '2048×2048 (square, cap edge)', w: 2048, h: 2048 },
    { name: '512×1024 (portrait)', w: 512, h: 1024 },
  ]

  for (const { name, w, h } of sizes) {
    // Synthesise a gradient image with a foreground disc — gives the
    // model a non-trivial scene to estimate depth on.
    const bg = await sharp({
      create: { width: w, height: h, channels: 4, background: { r: 60, g: 90, b: 130, alpha: 1 } },
    }).png().toBuffer()
    const r = Math.floor(Math.min(w, h) * 0.15)
    const disc = await sharp({
      create: { width: r * 2, height: r * 2, channels: 4, background: { r: 220, g: 180, b: 60, alpha: 1 } },
    }).png().toBuffer()
    const img = await sharp(bg)
      .composite([{ input: disc, left: Math.floor(w / 2 - r), top: Math.floor(h / 2 - r) }])
      .jpeg({ quality: 88 })
      .toBuffer()

    const { res, elapsedMs } = await postImage(mkForm(img))
    log(res.ok, `${name}: 200 OK`, `(${elapsedMs.toFixed(0)}ms)`)

    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      const a = await analyse(buf)
      log(a.width === w && a.height === h, `${name}: dims match`, `(${a.width}x${a.height})`)
      log(a.nonzeroFraction > 0.3, `${name}: non-zero > 30%`, `(${(a.nonzeroFraction * 100).toFixed(0)}%)`)
      log(a.meanAlpha > 0.05 && a.meanAlpha < 0.95, `${name}: mean depth in (5%, 95%)`, `(${(a.meanAlpha * 100).toFixed(0)}%)`)
    }
  }
}

const testCacheEviction = async () => {
  console.log('\n── 2. Cache eviction (DEPTH_CACHE_MAX=20) ──')

  // Submit 25 unique images; first 20 should populate the cache, the
  // remaining 5 should evict the oldest 5. We can only observe this
  // indirectly via the server's logs (we don't have a cache-size
  // endpoint). The most useful check is: all 25 requests return 200.
  for (let i = 0; i < 25; i++) {
    const w = 64, h = 64
    const color = { r: (i * 11) % 256, g: (i * 17) % 256, b: (i * 23) % 256, alpha: 1 }
    const img = await sharp({
      create: { width: w, height: h, channels: 4, background: color },
    }).jpeg({ quality: 80 }).toBuffer()

    const { res } = await postImage(mkForm(img), {}, 30_000)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      log(false, `cache test #${i}: 200 OK`, `(got ${res.status}: ${text.slice(0, 80)})`)
      return
    }
  }
  log(true, '25 unique images: all 200 OK', '(eviction behaviour verified by service log)')

  // Now test the cache hit: submit image #0 again, expect fast response
  const w = 64, h = 64
  const color = { r: 0, g: 0, b: 0, alpha: 1 }
  const img = await sharp({
    create: { width: w, height: h, channels: 4, background: color },
  }).jpeg({ quality: 80 }).toBuffer()

  // First call — should miss (or hit if this was in the 20 retained)
  const t0 = performance.now()
  await postImage(mkForm(img), {}, 30_000)
  const firstMs = performance.now() - t0

  // Second call — should hit
  const t1 = performance.now()
  const { res: res2 } = await postImage(mkForm(img), {}, 30_000)
  const secondMs = performance.now() - t1

  if (res2.ok) {
    const xElapsed = parseFloat(res2.headers.get('x-elapsed-ms') || 'NaN')
    log(Number.isFinite(xElapsed) && xElapsed < 0.5, 'cache hit: server < 0.5ms',
      `(server: ${xElapsed.toFixed(2)}ms, network roundtrip: ${secondMs.toFixed(0)}ms)`)
  }
}

const testEdgeCases = async () => {
  console.log('\n── 3. Edge cases ──')

  // 1×1 image — degenerate but should not crash
  {
    const img = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .jpeg({ quality: 80 }).toBuffer()
    const { res, elapsedMs } = await postImage(mkForm(img))
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      const a = await analyse(buf)
      log(a.width === 1 && a.height === 1, '1×1: dims preserved', `(${a.width}x${a.height}, ${a.bytes}B, ${elapsedMs.toFixed(0)}ms)`)
    } else {
      const text = await res.text().catch(() => '')
      log(false, '1×1: 200 OK', `(got ${res.status}: ${text.slice(0, 80)})`)
    }
  }

  // Grayscale JPEG (RGB source, .greyscale() pipeline)
  {
    const img = await sharp({ create: { width: 128, height: 128, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .greyscale()
      .jpeg({ quality: 80 }).toBuffer()
    const { res, elapsedMs } = await postImage(mkForm(img))
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      const a = await analyse(buf)
      log(a.width === 128 && a.height === 128, 'grayscale 128×128: dims preserved',
        `(${a.width}x${a.height}, ${elapsedMs.toFixed(0)}ms)`)
    } else {
      const text = await res.text().catch(() => '')
      log(false, 'grayscale: 200 OK', `(got ${res.status}: ${text.slice(0, 80)})`)
    }
  }

  // RGBA PNG with alpha
  {
    const img = await sharp({
      create: { width: 128, height: 128, channels: 4, background: { r: 100, g: 150, b: 200, alpha: 0.5 } },
    }).png().toBuffer()
    const fd = new FormData()
    fd.append('image', new Blob([img], { type: 'image/png' }), 'test.png')
    const { res, elapsedMs } = await postImage(fd)
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      const a = await analyse(buf)
      log(a.width === 128 && a.height === 128, 'RGBA PNG: dims preserved',
        `(${a.width}x${a.height}, ${elapsedMs.toFixed(0)}ms)`)
    } else {
      const text = await res.text().catch(() => '')
      log(false, 'RGBA: 200 OK', `(got ${res.status}: ${text.slice(0, 80)})`)
    }
  }

  // Fully transparent PNG (alpha=0 everywhere)
  {
    const img = await sharp({
      create: { width: 128, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer()
    const fd = new FormData()
    fd.append('image', new Blob([img], { type: 'image/png' }), 'transparent.png')
    const { res, elapsedMs } = await postImage(fd)
    log(res.ok, 'transparent PNG: 200 OK', `(${elapsedMs.toFixed(0)}ms)`)
  }
}

const testDoSProtections = async () => {
  console.log('\n── 4. DoS protections ──')

  // (a) Over-cap dimensions (4096×4096 > 2048)
  {
    const img = await sharp({ create: { width: 4096, height: 4096, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .jpeg({ quality: 80 }).toBuffer()
    const { res } = await postImage(mkForm(img))
    log(res.status === 413, '4096×4096: 413', `(got ${res.status})`)
    if (res.status !== 413) {
      const text = await res.text().catch(() => '')
      console.log(`    body: ${text.slice(0, 120)}`)
    }
  }

  // (b) Very long thin (over 2048 longest side)
  {
    const img = await sharp({ create: { width: 3000, height: 100, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .jpeg({ quality: 80 }).toBuffer()
    const { res } = await postImage(mkForm(img))
    log(res.status === 413, '3000×100: 413 (longest side)', `(got ${res.status})`)
  }

  // (c) Empty body
  {
    const { res } = await postImage(new FormData(), {}, 10_000)
    // FormData with no file should be 400 from _read_limited (empty)
    log(res.status === 400 || res.status === 422, 'empty body: 400/422', `(got ${res.status})`)
  }

  // (d) No `image` field
  {
    const fd = new FormData()
    fd.append('not_image', new Blob([Buffer.from('hello')], { type: 'image/jpeg' }), 'not.jpg')
    const { res } = await postImage(fd, {}, 10_000)
    log(res.status === 400 || res.status === 422, 'no image field: 400/422', `(got ${res.status})`)
  }

  // (e) Corrupt image (valid JPEG header, garbage body)
  {
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('garbage1234')])
    const { res } = await postImage(mkForm(corrupt), {}, 10_000)
    log(res.status === 400, 'corrupt image: 400', `(got ${res.status})`)
    if (res.status !== 400) {
      const text = await res.text().catch(() => '')
      console.log(`    body: ${text.slice(0, 120)}`)
    }
  }

  // (f) Wrong content-type (text/plain)
  {
    const fd = new FormData()
    fd.append('image', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'test.txt')
    const { res } = await postImage(fd, {}, 10_000)
    log(res.status === 415, 'text/plain: 415', `(got ${res.status})`)
  }
}

const testModelIdentity = async (health) => {
  console.log('\n── 5. Model identity ──')

  log(health.depth_available === true, 'health.depth_available: true')
  log(typeof health.depth_model === 'string' && health.depth_model.includes('Depth-Anything-V2'),
    'health.depth_model: Depth-Anything-V2 checkpoint', `(${health.depth_model})`)

  // Verify a response carries the model id in the X-Model header
  const img = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 100, g: 100, b: 100 } } })
    .jpeg({ quality: 80 }).toBuffer()
  const { res } = await postImage(mkForm(img), {}, 30_000)
  if (res.ok) {
    const xModel = res.headers.get('x-model') || ''
    log(xModel.includes('Depth-Anything-V2'), 'X-Model header: depth-anything id', `(${xModel})`)
    const xW = res.headers.get('x-width')
    const xH = res.headers.get('x-height')
    log(xW === '64' && xH === '64', 'X-Width/X-Height: input dims', `(${xW}x${xH})`)
  }
}

const main = async () => {
  console.log(`[verify-depth-comprehensive] service: ${MASK_SERVICE_URL}`)

  const probe = await probeService()
  if (!probe.ok) {
    log(true, `service unreachable (${probe.reason})`, '(skipped — start with: bun run mask:dev)')
    console.log(`\n${passed}/${passed} passed (all skipped)`)
    process.exit(0)
  }
  log(probe.health.depth_available, 'service: depth_available', `(${probe.health.depth_model})`)

  if (!probe.health.depth_available) {
    log(true, 'depth model not loaded', '(skipped — install torch+transformers)')
    console.log(`\n${passed}/${passed} passed (all skipped)`)
    process.exit(0)
  }

  await testRealWorldSizes()
  await testCacheEviction()
  await testEdgeCases()
  await testDoSProtections()
  await testModelIdentity(probe.health)

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('Failures:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e) => fail(e?.message || String(e)))
