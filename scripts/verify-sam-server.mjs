#!/usr/bin/env node
/**
 * The masking service's SlimSAM (/sam/embed, /sam/decode) — the engine the
 * editor's "Selection engine: Server" uses on devices too weak to run SlimSAM
 * in the browser. Tests the SERVICE directly (the Next routes in front of it
 * need a Clerk session and only proxy).
 *
 * Scene: the same red disc and blue square on grey that `verify:client-ai`
 * runs the browser model on, so both engines answer the same question:
 *   - a click on the disc selects the disc, and only it
 *   - a box with seed points around the square selects the square
 *   - a negative point removes what it lands on
 *   - the 6x6 grid (Detect All Subjects) in "low" form has a candidate on each
 *     shape, at the decoder grid size the browser's selection code expects
 *   - embedding is cached by pixels; an unknown key is a 404 (the client
 *     embeds again); hostile prompts are refused, not crashed on
 *
 * Skips (exit 0) when the service is unreachable or has no SlimSAM (501).
 */

import sharp from 'sharp'

const URL_ = (process.env.MASKING_SERVICE_URL || process.env.MASK_SERVICE_URL || 'http://127.0.0.1:8002')
  .trim().replace(/\/+$/, '')

const W = 800, H = 600
const DISC = { cx: 250, cy: 300, r: 100 }
const SQUARE = { x0: 500, y0: 150, x1: 700, y1: 350 }

const log = (msg) => console.log(`[verify-sam-server] ${msg}`)
const fail = (msg) => { console.error(`[verify-sam-server] ✗ ${msg}`); process.exit(1) }
const skip = (msg) => { log(`skip — ${msg}`); process.exit(0) }

let checks = 0
const check = (label, ok, detail = '') => {
  checks += 1
  if (!ok) fail(`${label}${detail ? ` — ${detail}` : ''}`)
  log(`ok ${label}${detail ? ` — ${detail}` : ''}`)
}

const scene = () => sharp(Buffer.from(
  `<svg width="${W}" height="${H}"><rect width="100%" height="100%" fill="rgb(128,128,128)"/>` +
  `<circle cx="${DISC.cx}" cy="${DISC.cy}" r="${DISC.r}" fill="rgb(220,30,30)"/>` +
  `<rect x="${SQUARE.x0}" y="${SQUARE.y0}" width="${SQUARE.x1 - SQUARE.x0}" height="${SQUARE.y1 - SQUARE.y0}" fill="rgb(30,60,220)"/></svg>`,
)).png().toBuffer()

const embed = async (png, type = 'image/png') => {
  const form = new FormData()
  form.append('image', new Blob([png], { type }), 'scene.png')
  const res = await fetch(`${URL_}/sam/embed`, { method: 'POST', body: form, signal: AbortSignal.timeout(300_000) })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

const decode = async (body) => {
  const res = await fetch(`${URL_}/sam/decode`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

/** Decoded RGB mask PNG → per-channel stats: area and bbox. */
const channels = async (b64) => {
  const { data, info } = await sharp(Buffer.from(b64, 'base64')).raw().toBuffer({ resolveWithObject: true })
  const out = []
  for (let c = 0; c < 3; c += 1) {
    let area = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
    for (let p = 0; p < info.width * info.height; p += 1) {
      if (data[p * info.channels + c] <= 127) continue
      area += 1
      const x = p % info.width, y = Math.floor(p / info.width)
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
    }
    out.push({ area, bbox: [x0, y0, x1, y1] })
  }
  return { width: info.width, height: info.height, out }
}

const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const best = (scores) => scores.indexOf(Math.max(...scores))

let health
try {
  const res = await fetch(`${URL_}/health`, { signal: AbortSignal.timeout(10_000) })
  health = await res.json()
} catch (e) {
  skip(`service unreachable at ${URL_} (${e.message})`)
}
if (!health?.sam_available) skip('service has no SlimSAM (sam_available false)')
check('health reports SlimSAM', health.sam_model?.includes('slimsam'), health.sam_model)

const png = await scene()
const t0 = Date.now()
const first = await embed(png)
if (first.status === 501) skip('SlimSAM not installed (501)')
check('embed answers with a key at the image size', first.status === 200 && first.body.key && first.body.width === W && first.body.height === H,
  `${first.status} ${first.body.width}x${first.body.height} in ${Date.now() - t0} ms${first.body.cold ? ' (cold load)' : ''}`)
const again = await embed(png)
check('the same pixels are not encoded twice', again.body.key === first.body.key && again.body.cached === true, `${again.body.elapsed_ms} ms`)
const { key } = first.body

// Click on the disc.
const t1 = Date.now()
const click = await decode({ key, prompts: [{ points: [[DISC.cx, DISC.cy]], labels: [1] }] })
check('a click decodes to three candidates and scores', click.status === 200 && click.body.results?.[0]?.scores?.length === 3,
  `${Date.now() - t1} ms, scores ${JSON.stringify(click.body.results?.[0]?.scores)}`)
const clickMasks = await channels(click.body.results[0].png)
check('masks come back at the embedded image size', clickMasks.width === W && clickMasks.height === H, `${clickMasks.width}x${clickMasks.height}`)
const discMask = clickMasks.out[best(click.body.results[0].scores)]
const discArea = Math.PI * DISC.r ** 2
check('the best-scored candidate is the disc', near(discMask.bbox, [150, 200, 350, 400], 4) && Math.abs(discMask.area / discArea - 1) < 0.05,
  `bbox ${discMask.bbox}, area ${(discMask.area / discArea).toFixed(3)} of the disc`)

// Box + seed points around the square (how Select Subject prompts).
const box = await decode({ key, prompts: [{ box: [490, 140, 710, 360], points: [[600, 250], [560, 200]], labels: [1, 1] }] })
const boxMasks = await channels(box.body.results[0].png)
const sq = boxMasks.out[best(box.body.results[0].scores)]
check('a box with seed points selects the square', box.status === 200 && near(sq.bbox, [SQUARE.x0, SQUARE.y0, SQUARE.x1, SQUARE.y1], 4),
  `bbox ${sq.bbox}`)

// Box alone (no points): the browser's SlimSAM cannot do this, the server can.
const boxOnly = await decode({ key, prompts: [{ box: [490, 140, 710, 360] }] })
check('a box with no points is answered', boxOnly.status === 200 && boxOnly.body.results[0].scores.length === 3)

// Positive on the disc + negative on the square: still only the disc.
const neg = await decode({ key, prompts: [{ points: [[DISC.cx, DISC.cy], [600, 250]], labels: [1, 0] }] })
const negMask = (await channels(neg.body.results[0].png)).out[best(neg.body.results[0].scores)]
check('a negative point keeps its object out', neg.status === 200 && negMask.bbox[2] < SQUARE.x0, `bbox ${negMask.bbox}`)

// The Detect All Subjects grid, in the low form the browser's selection reads.
const grid = []
for (let gy = 0; gy < 6; gy += 1) for (let gx = 0; gx < 6; gx += 1) grid.push({ points: [[((gx + 0.5) / 6) * W, ((gy + 0.5) / 6) * H]], labels: [1] })
const t2 = Date.now()
const low = await decode({ key, prompts: grid, output: 'low' })
check('the 36-prompt grid decodes in one call', low.status === 200 && low.body.results?.length === 36, `${Date.now() - t2} ms`)
// 800x600 → 1024x768 in the model frame → 256x192 of the decoder's 256 grid.
check('low masks are the valid region of the 256 grid', low.body.low?.vw === 256 && low.body.low?.vh === 192 && low.body.low.grid === 256,
  `${low.body.low?.vw}x${low.body.low?.vh}`)
const atlas = await sharp(Buffer.from(low.body.low.png, 'base64')).raw().toBuffer({ resolveWithObject: true })
check('the atlas stacks one mask per prompt', atlas.info.width === 256 && atlas.info.height === 192 * 36, `${atlas.info.width}x${atlas.info.height}`)
const onCell = (i, x, y) => atlas.data[((i * 192) + Math.round((y / H) * 192)) * 256 * atlas.info.channels + Math.round((x / W) * 256) * atlas.info.channels] > 127
const cellOf = (x, y) => Math.floor((y / H) * 6) * 6 + Math.floor((x / W) * 6)
check('the grid point on the disc selects the disc', onCell(cellOf(DISC.cx, DISC.cy), DISC.cx, DISC.cy) && !onCell(cellOf(DISC.cx, DISC.cy), 600, 250))
check('the grid point on the square selects the square', onCell(cellOf(600, 250), 600, 250) && !onCell(cellOf(600, 250), DISC.cx, DISC.cy))
check('every result names a best candidate', low.body.results.every((r) => [0, 1, 2].includes(r.best) && r.scores.length === 3))

// Select Subject scores every candidate: `all` sends all three per prompt.
const every = await decode({ key, prompts: grid.slice(0, 4), output: 'low', all: true })
const atlas3 = await sharp(Buffer.from(every.body.low.png, 'base64')).raw().toBuffer({ resolveWithObject: true })
check('`all` sends three candidates per prompt, prompt by prompt', every.status === 200 && every.body.low.candidates === 3 && atlas3.info.height === 192 * 4 * 3,
  `${atlas3.info.width}x${atlas3.info.height}`)
const one = await decode({ key, prompts: grid.slice(0, 4), output: 'low' })
const atlas1 = await sharp(Buffer.from(one.body.low.png, 'base64')).raw().toBuffer({ resolveWithObject: true })
const rowOf = (img, r) => img.data.subarray(r * 192 * 256 * img.info.channels, (r + 1) * 192 * 256 * img.info.channels)
check('and the best candidate in it is the one `low` sends', [0, 1, 2, 3].every((i) => Buffer.compare(rowOf(atlas3, i * 3 + one.body.results[i].best), rowOf(atlas1, i)) === 0))

// Failure modes.
check('an unknown key is a 404 (the client embeds again)', (await decode({ key: 'nope', prompts: grid.slice(0, 1) })).status === 404)
const hostile = [
  ['65 prompts', { key, prompts: Array.from({ length: 65 }, () => grid[0]) }],
  ['17 prompts with full masks', { key, prompts: grid.slice(0, 17) }],
  ['mismatched labels', { key, prompts: [{ points: [[1, 1], [2, 2]], labels: [1] }] }],
  ['a label of 2', { key, prompts: [{ points: [[1, 1]], labels: [2] }] }],
  ['a point a billion px away', { key, prompts: [{ points: [[1e9, 1]], labels: [1] }] }],
  ['a three-number box', { key, prompts: [{ box: [1, 2, 3] }] }],
  ['an empty prompt', { key, prompts: [{}] }],
  ['an unknown output', { key, prompts: grid.slice(0, 1), output: 'everything' }],
  ['a null coordinate', { key, prompts: [{ points: [[null, 1]], labels: [1] }] }],
]
for (const [label, body] of hostile) {
  const r = await decode(body)
  check(`refuses ${label}`, r.status === 400 || r.status === 422, String(r.status))
}
const big = await sharp({ create: { width: 1500, height: 900, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer()
check('refuses an image over 1024 px (the client sends its model input)', (await embed(big)).status === 413)

log(`✓ ${checks}/${checks} checks passed (SlimSAM on the service)`)
