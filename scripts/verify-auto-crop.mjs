#!/usr/bin/env node
/**
 * End-to-end test for the auto-crop endpoint.
 *
 * Synthesises a test image with a clear off-centre subject inside a thick
 * solid border (white mat). POSTs it to /crop/auto on the local mask service
 * for each of the four strategies, plus mode=all, and asserts:
 *   - the response shape matches the documented contract
 *   - the subject-aware crop's bbox is INSIDE the image and contains the
 *     known subject centroid
 *   - the content-fill crop strips most of the border
 *   - the aspect-preset crop returns a box whose ratio is within 2% of the
 *     requested ratio
 *   - mode=all picks a "recommended" strategy from the strategies that ran
 *   - boxes are non-degenerate and stay within image bounds
 *
 * Skips with exit 0 if MASK_SERVICE_URL is unreachable. Exits 1 on a bad
 * response from a live service.
 *
 * Usage:
 *   bun scripts/verify-auto-crop.mjs           # against http://127.0.0.1:8001
 *   MASK_SERVICE_URL=http://… bun scripts/verify-auto-crop.mjs
 */

import sharp from 'sharp'

const MASK_SERVICE_URL = (process.env.MASK_SERVICE_URL || 'http://127.0.0.1:8001')
  .trim()
  .replace(/\/+$/, '')

const W = 800
const H = 600
const MAT = 80               // border width in pixels
const SUBJECT_CX = 280       // off-centre to make subject-aware ≠ centre
const SUBJECT_CY = 360
const SUBJECT_R = 90

const log = (label, msg) => console.log(`[verify-auto-crop] ${label} ${msg}`)
const die = (msg) => { console.error(`[verify-auto-crop] ✗ ${msg}`); process.exit(1) }

const synthImage = async () => {
  // White outer mat + dark grey "photo" + a red disc subject off-centre.
  const bg = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  }).png().toBuffer()

  const inner = Buffer.from(
    `<svg width="${W}" height="${H}">
       <rect x="${MAT}" y="${MAT}" width="${W - 2 * MAT}" height="${H - 2 * MAT}" fill="rgb(60,60,70)"/>
       <circle cx="${SUBJECT_CX}" cy="${SUBJECT_CY}" r="${SUBJECT_R}" fill="rgb(220,40,40)"/>
     </svg>`,
  )
  return sharp(bg).composite([{ input: inner }]).jpeg({ quality: 92 }).toBuffer()
}

const post = async (image, fields = {}) => {
  const form = new FormData()
  form.append('image', new Blob([image], { type: 'image/jpeg' }), 'mat.jpg')
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v))
  const resp = await fetch(`${MASK_SERVICE_URL}/crop/auto`, { method: 'POST', body: form })
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    return { ok: false, status: resp.status, txt }
  }
  return { ok: true, json: await resp.json() }
}

const reachable = async () => {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 1500)
    const resp = await fetch(`${MASK_SERVICE_URL}/health`, { signal: ac.signal })
    clearTimeout(t)
    return resp.ok
  } catch { return false }
}

const inBounds = (box, w, h) => {
  if (!Array.isArray(box) || box.length !== 4) return false
  const [x, y, bw, bh] = box
  return x >= 0 && y >= 0 && x + bw <= w && y + bh <= h && bw > 1 && bh > 1
}

const contains = (box, cx, cy) => {
  const [x, y, w, h] = box
  return cx >= x && cx <= x + w && cy >= y && cy <= y + h
}

const main = async () => {
  if (!(await reachable())) {
    log('skip', `mask service at ${MASK_SERVICE_URL} is unreachable — start it with: bun run mask:dev`)
    process.exit(0)
  }

  const image = await synthImage()

  // ── 1. subject-aware ───────────────────────────────────────────────────
  {
    const r = await post(image, { mode: 'subject' })
    if (!r.ok) die(`subject mode failed: ${r.status} ${r.txt}`)
    const data = r.json
    if (data.width !== W || data.height !== H) die(`wrong dims: ${data.width}x${data.height}`)
    const c = data.crops?.subject
    if (!c?.box) die('subject crop missing box')
    if (!inBounds(c.box, W, H)) die(`subject box out of bounds: ${c.box}`)
    if (!contains(c.box, SUBJECT_CX, SUBJECT_CY)) {
      die(`subject box ${c.box} does not contain the known subject centroid (${SUBJECT_CX}, ${SUBJECT_CY})`)
    }
    log('subject', `box=${c.box.join(',')} score=${c.score} rationale="${c.rationale}"`)
  }

  // ── 2. content-fill (trim white mat) ───────────────────────────────────
  {
    const r = await post(image, { mode: 'content' })
    if (!r.ok) die(`content mode failed: ${r.status} ${r.txt}`)
    const c = r.json.crops?.content
    if (!c?.box) die('content crop missing box')
    if (!inBounds(c.box, W, H)) die(`content box out of bounds: ${c.box}`)
    const [x, y, bw, bh] = c.box
    // We expect the box to be roughly the inner region (MAT..W-MAT) ± a few px.
    if (x > MAT + 10 || y > MAT + 10) die(`content box did not trim the mat: ${c.box}`)
    if (x + bw < W - MAT - 10 || y + bh < H - MAT - 10) die(`content box trimmed too much: ${c.box}`)
    log('content', `box=${c.box.join(',')} score=${c.score} (trimmed ~${MAT}px mat)`)
  }

  // ── 3. aspect preset ────────────────────────────────────────────────────
  for (const aspect of ['1:1', '16:9', '4:5']) {
    const r = await post(image, { mode: 'aspect', aspect })
    if (!r.ok) die(`aspect ${aspect} failed: ${r.status} ${r.txt}`)
    const c = r.json.crops?.aspect
    if (!c?.box) die(`aspect ${aspect} crop missing box`)
    if (!inBounds(c.box, W, H)) die(`aspect ${aspect} box out of bounds: ${c.box}`)
    const want = aspect.includes(':') ? aspect.split(':').map(Number).reduce((a, b) => a / b) : Number(aspect)
    const got = c.box[2] / c.box[3]
    if (Math.abs(got - want) / want > 0.02) {
      die(`aspect ${aspect}: requested ${want.toFixed(3)} got ${got.toFixed(3)}`)
    }
    log('aspect', `${aspect} box=${c.box.join(',')} ratio=${got.toFixed(3)}`)
  }

  // ── 4. mode=all → recommended ──────────────────────────────────────────
  {
    const r = await post(image, { mode: 'all', aspect: '4:5' })
    if (!r.ok) die(`all mode failed: ${r.status} ${r.txt}`)
    const data = r.json
    if (!Array.isArray(data.ran) || data.ran.length === 0) die('mode=all reported no ran strategies')
    if (data.recommended == null) die('mode=all picked no recommendation')
    if (!data.crops?.[data.recommended]?.box) die(`recommended "${data.recommended}" has no box`)
    log('all', `ran=${data.ran.join('+')} recommended=${data.recommended} (${data.elapsed_ms}ms)`)
  }

  console.log('\n[verify-auto-crop] ✓ all checks passed')
}

main().catch((e) => die(e?.stack || e?.message || String(e)))
