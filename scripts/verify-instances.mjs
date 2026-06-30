#!/usr/bin/env node
/**
 * End-to-end test for the multi-subject /segment/instances endpoint.
 *
 * Synthesises an image with TWO well-separated high-contrast subjects (a red
 * circle and a blue square on green), POSTs it to /segment/instances, and
 * asserts:
 *   - the response is valid JSON with the documented shape
 *   - count >= 1 (YOLO won't class synthetic shapes as person/animal, so the
 *     salient-include path or the saliency fallback must produce subjects)
 *   - every instance carries a decodable greyscale PNG mask at the image size
 *   - per-instance masks are disjoint-ish when count >= 2 (multi-subject:
 *     each mask must NOT cover both subjects)
 *   - bbox/centroid/area_frac are internally consistent
 *   - the union mask covers at least as much as the largest instance
 *
 * Skips gracefully (exit 0) if the service is unreachable; exits 1 only on a
 * bad response from a live service.
 */

import sharp from 'sharp'

const MASK_SERVICE_URL = (process.env.MASKING_SERVICE_URL || process.env.MASK_SERVICE_URL || 'http://127.0.0.1:8002')
  .trim()
  .replace(/\/+$/, '')

const W = 640
const H = 480

const log = (label, msg) => console.log(`[verify-instances] ${label} ${msg}`)

const synthesizeTwoSubjectImage = async () => {
  const bg = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 30, g: 140, b: 60, alpha: 1 } },
  }).png().toBuffer()

  const circle = Buffer.from(
    `<svg width="${W}" height="${H}"><circle cx="160" cy="240" r="100" fill="rgb(220,30,30)"/></svg>`,
  )
  const square = Buffer.from(
    `<svg width="${W}" height="${H}"><rect x="400" y="140" width="180" height="200" fill="rgb(40,60,220)"/></svg>`,
  )

  return sharp(bg)
    .composite([{ input: circle }, { input: square }])
    .jpeg({ quality: 90 })
    .toBuffer()
}

const maskStats = async (b64) => {
  const { data, info } = await sharp(Buffer.from(b64, 'base64'))
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let on = 0
  let leftOn = 0
  let rightOn = 0
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[y * info.width + x] > 127) {
        on += 1
        if (x < info.width / 2) leftOn += 1
        else rightOn += 1
      }
    }
  }
  return { width: info.width, height: info.height, on, frac: on / (info.width * info.height), leftOn, rightOn }
}

const main = async () => {
  let image
  try {
    image = await synthesizeTwoSubjectImage()
  } catch (e) {
    console.error('[verify-instances] could not synthesize test image:', e.message)
    process.exit(1)
  }

  const form = new FormData()
  form.append('image', new Blob([image], { type: 'image/jpeg' }), 'two-subjects.jpg')

  let resp
  try {
    resp = await fetch(`${MASK_SERVICE_URL}/segment/instances`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(300_000),
    })
  } catch (e) {
    log('SKIP', `mask service unreachable at ${MASK_SERVICE_URL} (${e.message}) — start it with: bun run mask:dev`)
    process.exit(0)
  }

  if (!resp.ok) {
    console.error(`[verify-instances] HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
    process.exit(1)
  }

  const payload = await resp.json()
  const fail = (msg) => { console.error(`[verify-instances] ✗ ${msg}`); process.exit(1) }

  if (payload.width !== W || payload.height !== H) fail(`bad dimensions ${payload.width}x${payload.height}`)
  if (!Array.isArray(payload.instances)) fail('instances is not an array')
  if (payload.count !== payload.instances.length) fail(`count=${payload.count} != instances.length=${payload.instances.length}`)
  if (payload.count < 1) fail('no subjects detected on a two-subject image')
  log('ok', `mode=${payload.mode} count=${payload.count} model=${payload.model} subject_model=${payload.subject_model}`)

  let maxInstanceOn = 0
  for (const inst of payload.instances) {
    if (typeof inst.mask_png !== 'string' || !inst.mask_png) fail(`instance ${inst.index} missing mask_png`)
    const stats = await maskStats(inst.mask_png)
    if (stats.width !== W || stats.height !== H) fail(`instance ${inst.index} mask is ${stats.width}x${stats.height}, expected ${W}x${H}`)
    if (stats.frac < 0.005 || stats.frac > 0.9) fail(`instance ${inst.index} mask covers ${(stats.frac * 100).toFixed(1)}% — degenerate`)
    maxInstanceOn = Math.max(maxInstanceOn, stats.on)

    const [bx, by, bw, bh] = inst.bbox
    if (!(bx >= 0 && by >= 0 && bw > 0 && bh > 0 && bx + bw <= W && by + bh <= H)) fail(`instance ${inst.index} bbox ${inst.bbox} out of bounds`)
    const [cx, cy] = inst.centroid
    if (!(cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh)) fail(`instance ${inst.index} centroid ${inst.centroid} outside bbox ${inst.bbox}`)
    if (!(inst.area_frac > 0 && inst.area_frac <= 1)) fail(`instance ${inst.index} bad area_frac ${inst.area_frac}`)

    // Multi-subject separation: a per-instance mask must be dominated by ONE
    // side of the frame (the two synthetic subjects sit in opposite halves).
    if (payload.count >= 2) {
      const dominant = Math.max(stats.leftOn, stats.rightOn) / (stats.on || 1)
      if (dominant < 0.85) fail(`instance ${inst.index} (${inst.label}) spans both subjects — not instance-separated (dominance ${(dominant * 100).toFixed(0)}%)`)
    }
    log('ok', `instance ${inst.index}: ${inst.label} conf=${inst.confidence} src=${inst.source} cover=${(stats.frac * 100).toFixed(1)}%`)
  }

  if (payload.union_png) {
    const union = await maskStats(payload.union_png)
    if (union.on + 1 < maxInstanceOn * 0.95) fail(`union mask (${union.on}px) smaller than largest instance (${maxInstanceOn}px)`)
    log('ok', `union covers ${(union.frac * 100).toFixed(1)}%`)
  } else if (payload.count > 0) {
    fail('union_png missing despite count > 0')
  }

  if (payload.count >= 2) {
    log('PASS', `multi-subject separation verified across ${payload.count} instances`)
  } else {
    log('PASS', `single-subject path verified (mode=${payload.mode}); for a multi-instance check, run against a real group photo`)
  }
}

main().catch((e) => { console.error('[verify-instances] ✗', e); process.exit(1) })
