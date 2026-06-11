#!/usr/bin/env node
// scripts/verify-inpaint.mjs
// ==========================
// Smoke-test for the /api/ai/inpaint route. Generates a synthetic test image
// and mask, POSTs them to the local dev server, and verifies the response.
//
// Usage:
//   bun run verify:inpaint           # or: node scripts/verify-inpaint.mjs
//   BASE_URL=http://localhost:3000 bun scripts/verify-inpaint.mjs
//
// Requires: the dev server running + a valid Clerk session cookie (or
// CLERK_SECRET_KEY for test auth). For CI, set SKIP_AUTH=1 to bypass.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'

// ─── Generate a synthetic test image (100×100 red square on white) ──────────

function createTestPNG(width, height, fillRgb = [255, 255, 255]) {
  // Minimal uncompressed PNG: IHDR + single IDAT (uncompressed deflate)
  // For simplicity, use a BMP-in-memory approach via canvas if available,
  // or fall back to a raw RGBA buffer.
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = fillRgb[0]
    pixels[i * 4 + 1] = fillRgb[1]
    pixels[i * 4 + 2] = fillRgb[2]
    pixels[i * 4 + 3] = 255
  }
  return pixels
}

function createMaskPNG(width, height, regionX, regionY, regionW, regionH) {
  const pixels = Buffer.alloc(width * height * 4)
  // Black background, white region = inpaint area
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const inRegion = x >= regionX && x < regionX + regionW && y >= regionY && y < regionY + regionH
      const v = inRegion ? 255 : 0
      pixels[i] = v
      pixels[i + 1] = v
      pixels[i + 2] = v
      pixels[i + 3] = 255
    }
  }
  return pixels
}

// Use sharp (already a project dependency) to encode raw RGBA → PNG
async function rawToPng(buffer, width, height) {
  const sharp = (await import('sharp')).default
  return sharp(buffer, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
}

// ─── Test runner ────────────────────────────────────────────────────────────

async function runTest(backend) {
  const W = 100
  const H = 100

  console.log(`\n🔬 Testing /api/ai/inpaint with backend="${backend}" ...`)

  const imageRaw = createTestPNG(W, H, [200, 180, 160])
  const maskRaw = createMaskPNG(W, H, 30, 30, 40, 40) // 40×40 white square in center

  const [imagePng, maskPng] = await Promise.all([
    rawToPng(imageRaw, W, H),
    rawToPng(maskRaw, W, H),
  ])

  const form = new FormData()
  form.append('image', new Blob([imagePng], { type: 'image/png' }), 'test.png')
  form.append('mask', new Blob([maskPng], { type: 'image/png' }), 'mask.png')
  form.append('backend', backend)

  const url = `${BASE_URL}/api/ai/inpaint`
  console.log(`   POST ${url}`)

  try {
    const resp = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    })

    const usedBackend = resp.headers.get('x-inpaint-backend') || 'unknown'

    if (resp.ok) {
      const contentType = resp.headers.get('content-type') || ''
      const body = await resp.arrayBuffer()
      console.log(`   ✅ ${resp.status} — ${contentType} — ${body.byteLength} bytes — backend: ${usedBackend}`)
      return true
    }

    const errText = await resp.text().catch(() => '')
    if (resp.status === 401) {
      console.log(`   ⚠️  401 Unauthorized — need a valid session. Set SKIP_AUTH=1 to bypass auth check.`)
      return 'auth'
    }
    if (resp.status === 501) {
      console.log(`   ⚠️  501 — backend "${backend}" not configured (expected if no HF token / no mask service)`)
      return 'not_configured'
    }
    console.log(`   ❌ ${resp.status}: ${errText.slice(0, 200)}`)
    return false
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      console.log(`   ❌ Timed out after 60s`)
    } else {
      console.log(`   ❌ ${err.message}`)
    }
    return false
  }
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  verify-inpaint: end-to-end inpaint route smoke test')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Base URL: ${BASE_URL}`)

  // Test auto (tries LaMa → HF), then explicit backends
  const results = {}
  for (const backend of ['auto', 'lama', 'hf']) {
    results[backend] = await runTest(backend)
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Results:')
  for (const [backend, result] of Object.entries(results)) {
    const icon = result === true ? '✅' : result === 'auth' ? '🔒' : result === 'not_configured' ? '⚠️' : '❌'
    console.log(`    ${icon} ${backend}: ${result}`)
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const failed = Object.values(results).some(r => r === false)
  if (failed) {
    console.log('\n❌ Some tests failed')
    process.exit(1)
  }
  console.log('\n✅ All tests passed (or expected skip)')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
