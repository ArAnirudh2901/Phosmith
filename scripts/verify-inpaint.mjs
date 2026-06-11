#!/usr/bin/env node
/**
 * End-to-end test for the mask service's /inpaint endpoint (LaMa) — the
 * engine behind the AI Object Eraser's remove-and-fill.
 *
 * (Tests the SERVICE directly, like the other verify scripts — the Next
 * route in front of it requires a Clerk session, so it can't be driven
 * headlessly; its backend-selection logic is pure proxying over this.)
 *
 * Synthesises a textured background with an obvious foreign object (a red
 * disc), masks the disc, POSTs both to /inpaint, and asserts:
 *   - the response is a decodable PNG at the source size
 *   - the disc REGION is no longer red (the object was actually removed)
 *   - the filled region's colour resembles the surrounding background
 *   - pixels OUTSIDE the mask are essentially untouched
 *
 * The first call lazy-loads LaMa (downloads the model once), so the request
 * timeout is generous. Skips gracefully (exit 0) when the service is
 * unreachable or LaMa isn't installed (501); exits 1 only on a bad result
 * from a live, LaMa-capable service.
 */

import sharp from 'sharp'

const MASK_SERVICE_URL = (process.env.MASK_SERVICE_URL || 'http://127.0.0.1:8001')
  .trim()
  .replace(/\/+$/, '')

const W = 512
const H = 384
// Disc well inside the frame; mask is a slightly larger circle around it.
const CX = 200
const CY = 190
const R = 60
const MASK_R = 78

const log = (msg) => console.log(`[verify-inpaint] ${msg}`)
const fail = (msg) => { console.error(`[verify-inpaint] ✗ ${msg}`); process.exit(1) }
const skip = (msg) => { log(`skip — ${msg}`); process.exit(0) }

let checks = 0
const check = (label, ok, detail = '') => {
  checks += 1
  if (!ok) fail(`${label}${detail ? ` — ${detail}` : ''}`)
  log(`ok ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Soft green-on-green texture (vertical bands) + a red disc. */
const synthesize = async () => {
  const bands = []
  for (let i = 0; i < 8; i += 1) {
    const g = 120 + (i % 2) * 24
    bands.push(`<rect x="${(W / 8) * i}" y="0" width="${W / 8}" height="${H}" fill="rgb(52,${g},70)"/>`)
  }
  const sceneSvg = Buffer.from(
    `<svg width="${W}" height="${H}">${bands.join('')}<circle cx="${CX}" cy="${CY}" r="${R}" fill="rgb(225,30,30)"/></svg>`,
  )
  const image = await sharp(sceneSvg).png().toBuffer()

  const maskSvg = Buffer.from(
    `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="black"/><circle cx="${CX}" cy="${CY}" r="${MASK_R}" fill="white"/></svg>`,
  )
  const mask = await sharp(maskSvg).png().toBuffer()
  return { image, mask }
}

/** Mean RGB inside the disc, background reference ring, untouched-zone delta. */
const analyze = async (pngBuffer, referencePng) => {
  const { data, info } = await sharp(pngBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.width !== W || info.height !== H) fail(`output is ${info.width}x${info.height}, expected ${W}x${H}`)
  const ref = await sharp(referencePng).removeAlpha().raw().toBuffer()

  let inR = 0; let inG = 0; let inB = 0; let inN = 0
  let outDeltaMax = 0
  let ringG = 0; let ringN = 0
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const d = Math.hypot(x - CX, y - CY)
      const i = (y * W + x) * 3
      if (d <= R) {
        inR += data[i]; inG += data[i + 1]; inB += data[i + 2]; inN += 1
      } else if (d > MASK_R + 6) {
        // Untouched zone: must match the source.
        for (let c = 0; c < 3; c += 1) {
          outDeltaMax = Math.max(outDeltaMax, Math.abs(data[i + c] - ref[i + c]))
        }
        if (d < MASK_R + 40) { ringG += ref[i + 1]; ringN += 1 }
      }
    }
  }
  return {
    inMean: { r: inR / inN, g: inG / inN, b: inB / inN },
    ringGreenMean: ringG / ringN,
    outDeltaMax,
  }
}

const main = async () => {
  let health
  try {
    const resp = await fetch(`${MASK_SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) })
    health = await resp.json()
  } catch {
    skip(`mask service unreachable at ${MASK_SERVICE_URL} (bun run mask:dev)`)
  }
  if (!health?.lama_available) {
    skip('LaMa not available on the service (pip install simple-lama-inpainting)')
  }

  const { image, mask } = await synthesize()
  const form = new FormData()
  form.append('image', new Blob([image], { type: 'image/png' }), 'image.png')
  form.append('mask', new Blob([mask], { type: 'image/png' }), 'mask.png')

  log('POST /inpaint (first call downloads + loads LaMa — may take a few minutes)…')
  const t0 = Date.now()
  let resp
  try {
    resp = await fetch(`${MASK_SERVICE_URL}/inpaint`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    })
  } catch (err) {
    fail(`request failed: ${err?.message}`)
  }
  if (resp.status === 501) skip('service reports LaMa not installed (501)')
  if (!resp.ok) fail(`HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`)
  const ct = resp.headers.get('content-type') || ''
  check('response is an image', ct.startsWith('image/'), ct)

  const out = Buffer.from(await resp.arrayBuffer())
  const stats = await analyze(out, image)
  log(`inpainted in ${((Date.now() - t0) / 1000).toFixed(1)}s — disc region mean rgb(${stats.inMean.r.toFixed(0)},${stats.inMean.g.toFixed(0)},${stats.inMean.b.toFixed(0)})`)

  // The disc was rgb(225,30,30). Removed = no longer red-dominant.
  check('object removed (region not red anymore)',
    stats.inMean.r < 140 && stats.inMean.g > stats.inMean.r,
    `r=${stats.inMean.r.toFixed(0)} g=${stats.inMean.g.toFixed(0)}`)
  // Fill should resemble the surrounding green texture.
  check('fill resembles surrounding background',
    Math.abs(stats.inMean.g - stats.ringGreenMean) < 60,
    `fill g=${stats.inMean.g.toFixed(0)} vs ring g=${stats.ringGreenMean.toFixed(0)}`)
  // Outside the mask the image must be essentially untouched.
  check('pixels outside the mask are untouched', stats.outDeltaMax <= 8, `max delta ${stats.outDeltaMax}`)

  console.log(`\n[verify-inpaint] ✓ all ${checks} checks passed (LaMa object removal verified)`)
}

main().catch((err) => fail(err?.message || String(err)))
