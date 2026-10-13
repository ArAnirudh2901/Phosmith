#!/usr/bin/env bun
// Contact sheet of the selection tools on real photos, for judging masks by
// eye: Select Subject, a box select with a hand-placed box, and Detect All
// Subjects, each through the real client-ai.js in a real browser.
//
//   bun scripts/preview-subject.mjs [--server] [--out file.png] [--label text] [--masks dir]
//
// --server runs them on the masking service (MASKING_SERVICE_URL, default
// :8002) through the same /api/ai/sam/* contract the Next routes keep.
// Photos: .cache/preview-photos (or PHOSMITH_PHOTO_DIR).

import { createServer } from 'node:http'
import { existsSync, readdirSync, copyFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const OUT_DIR = path.join(ROOT, '.cache', 'preview-subject')
const PHOTOS = process.env.PHOSMITH_PHOTO_DIR || path.join(ROOT, '.cache', 'preview-photos')
const SERVICE = (process.env.MASKING_SERVICE_URL || 'http://127.0.0.1:8002').replace(/\/+$/, '')
const args = process.argv.slice(2)
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
const SERVER = args.includes('--server')
const OUT = path.resolve(flag('--out', path.join(OUT_DIR, `subject-${SERVER ? 'server' : 'device'}.png`)))
const LABEL = flag('--label', SERVER ? 'server' : 'device')
// Each tool's mask per photo as a PNG at the photo's size, for measuring.
const MASKS = flag('--masks', null)

// A box around what a person would mean by "the subject" (fractions of the frame).
const BOXES = {
  'astro.jpg': [0.0, 0.25, 0.75, 1.0],
  'cat.jpg': [0.0, 0.0, 1.0, 1.0],
  'coffee.jpg': [0.1, 0.0, 0.8, 1.0],
  'moto.jpg': [0.1, 0.15, 0.97, 0.95],
  'rocket.jpg': [0.47, 0.25, 0.6, 1.0],
}
const photos = readdirSync(PHOTOS).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort()
  .map((file) => ({ file, box: BOXES[file] || [0.1, 0.1, 0.9, 0.9] }))

const { chromium } = await import('playwright')
await mkdir(OUT_DIR, { recursive: true })
const build = await Bun.build({ entrypoints: [path.join(ROOT, 'scripts/preview-subject/entry.js')], outdir: OUT_DIR, target: 'browser' })
if (!build.success) { console.error(build.logs.map(String).join('\n')); process.exit(1) }
const ortSrc = [path.join(ROOT, 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist'), path.join(ROOT, 'node_modules/onnxruntime-web/dist')].find(existsSync)
await mkdir(path.join(OUT_DIR, 'ort'), { recursive: true })
for (const f of readdirSync(ortSrc)) if (/^ort-wasm-simd-threaded.*\.(mjs|wasm)$/.test(f)) copyFileSync(path.join(ortSrc, f), path.join(OUT_DIR, 'ort', f))

const html = '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#111"><script type="module" src="/entry.js"></script>'
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname.startsWith('/api/ai/')) {
    const chunks = []; for await (const c of req) chunks.push(c)
    const health = url.pathname === '/api/ai/health'
    const up = await fetch(health ? `${SERVICE}/health` : `${SERVICE}/sam/${url.pathname.split('/').pop()}`, {
      method: req.method, headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {},
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
    }).catch((e) => ({ ok: false, status: 503, json: async () => ({ detail: e.message }) }))
    const body = await up.json().catch(() => ({}))
    res.writeHead(health ? 200 : up.status, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(health ? { available: up.ok, sam: !!body.sam_available } : up.ok ? body : { error: body.detail || 'error' }))
  }
  const file = url.pathname === '/' ? null : url.pathname.startsWith('/photos/') ? path.join(PHOTOS, path.basename(url.pathname)) : path.join(OUT_DIR, path.normalize(url.pathname))
  if (!file) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html) }
  if (!existsSync(file)) { res.writeHead(404); return res.end() }
  const ext = path.extname(file)
  res.writeHead(200, { 'content-type': ext === '.js' || ext === '.mjs' ? 'text/javascript' : ext === '.wasm' ? 'application/wasm' : 'application/octet-stream' })
  res.end(await readFile(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

const ctx = await chromium.launchPersistentContext(path.join(ROOT, '.cache', 'playwright-client-ai'), {
  headless: true, args: ['--enable-unsafe-webgpu', '--enable-gpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
})
try {
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('pageerror', e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.evaluate((s) => localStorage.setItem('phosmith:ai-routing', JSON.stringify(s ? { sam: 'server', segment: 'server', subjects: 'server' } : { sam: 'client', segment: 'client', subjects: 'client' })), SERVER)
  await page.reload()
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30_000 })
  const { png, report } = await page.evaluate((a) => window.__run(a), { photos, label: LABEL, withMasks: !!MASKS })
  await writeFile(OUT, Buffer.from(png.split(',')[1], 'base64'))
  if (MASKS) await mkdir(MASKS, { recursive: true })
  for (const r of report) {
    for (const key of Object.keys(r).filter((k) => k.endsWith('Png'))) {
      await writeFile(path.join(MASKS, `${path.parse(r.file).name}-${key.slice(0, -3)}.png`), Buffer.from(r[key], 'base64'))
      delete r[key]
    }
    console.log(JSON.stringify(r))
  }
  console.log(`[preview-subject] ${OUT}`)
} finally {
  await ctx.close()
  server.closeAllConnections?.(); server.close()
}
process.exit(0)
