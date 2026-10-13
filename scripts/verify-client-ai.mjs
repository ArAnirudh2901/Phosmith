#!/usr/bin/env bun
/**
 * Headless-browser verification of the ON-DEVICE AI engine.
 *
 * The in-browser model path (src/lib/client-ai.js — CLIPSeg grounding +
 * Depth Anything via transformers.js) cannot run under bun/node, so the
 * other verify suites can only pin its pure logic. This script closes that
 * gap end-to-end:
 *
 *   1. bundles the REAL production module into a standalone page
 *      (scripts/client-ai-harness/entry.js → bun build, no Next/Clerk/env);
 *   2. serves it locally and drives it with Playwright Chromium;
 *   3. runs runClientAISelfTest() in the browser — the actual models infer
 *      on a synthetic scene with a known answer — and asserts every check.
 *
 * Before that, when the masking service answers with SlimSAM, the same
 * self-test runs with `side: 'server'` (the Selection engine's Server): the
 * page's /api/ai/sam/* and /api/ai/health are proxied to the service the way
 * the Next routes do, and the browser must never fetch or load SlimSAM.
 *
 * Caching: a persistent Chromium profile under .cache/playwright-client-ai
 * keeps the downloaded model files (~200 MB) across runs, so only the first
 * run pays the download.
 *
 * Skips (exit 0, like the other service-dependent verifies) when Playwright
 * or its Chromium build is not installed:
 *   bun add -d playwright && bunx playwright install chromium
 *
 * Usage: bun scripts/verify-client-ai.mjs [--server-only]
 *   HARNESS_TIMEOUT_MS=900000  override the self-test budget (default 15 min)
 *   MASKING_SERVICE_URL        the service for the server pass (default :8002)
 */

import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const HARNESS_DIR = path.join(ROOT, '.cache', 'client-ai-harness')
const PROFILE_DIR = path.join(ROOT, '.cache', 'playwright-client-ai')
const TIMEOUT_MS = Number(process.env.HARNESS_TIMEOUT_MS || 15 * 60 * 1000)
const SERVICE = (process.env.MASKING_SERVICE_URL || process.env.MASK_SERVICE_URL || 'http://127.0.0.1:8002').trim().replace(/\/+$/, '')
const SERVER_ONLY = process.argv.includes('--server-only')

const log = (msg) => console.log(`[verify-client-ai] ${msg}`)
const die = (msg) => { console.error(`[verify-client-ai] ✗ ${msg}`); process.exit(1) }
const skip = (msg) => { log(`skip — ${msg}`); process.exit(0) }

/* ─── 1. Playwright availability ────────────────────────────────────────── */
let chromium
try {
  ({ chromium } = await import('playwright'))
} catch {
  skip('playwright is not installed (bun add -d playwright && bunx playwright install chromium)')
}

/* ─── 2. Bundle the harness ─────────────────────────────────────────────── */
await mkdir(HARNESS_DIR, { recursive: true })
const build = Bun.spawnSync([
  'bun', 'build', path.join(ROOT, 'scripts/client-ai-harness/entry.js'),
  '--outdir', HARNESS_DIR,
  '--target=browser',
  '--splitting',
], { cwd: ROOT })
if (build.exitCode !== 0) {
  die(`harness bundle failed:\n${build.stderr?.toString().slice(0, 1500)}`)
}
await writeFile(
  path.join(HARNESS_DIR, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>client-ai harness</title><script type="module" src="./entry.js"></script>',
)
// Serve the version-matched ORT runtime from /ort/ exactly like the Next app
// (public/ort via scripts/setup-ort.mjs) — client-ai.js probes this path and
// pins wasmPaths to it, which is what fixes the "webgpuInit is not a
// function" / "no available backend found" bundler failure.
{
  const { copyFileSync, readdirSync } = await import('node:fs')
  const ortSrc = [
    path.join(ROOT, 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist'),
    path.join(ROOT, 'node_modules/onnxruntime-web/dist'),
  ].find((d) => existsSync(d))
  if (ortSrc) {
    await mkdir(path.join(HARNESS_DIR, 'ort'), { recursive: true })
    for (const f of readdirSync(ortSrc)) {
      if (/^ort-wasm-simd-threaded.*\.(mjs|wasm)$/.test(f)) {
        copyFileSync(path.join(ortSrc, f), path.join(HARNESS_DIR, 'ort', f))
      }
    }
  }
}
log('harness bundled')

/* ─── 3. Static server ──────────────────────────────────────────────────── */
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.map': 'application/json',
}
// The Next routes' contract, minus Clerk: errors as `{ error }`, status passed through.
const proxyApi = async (req, res, url) => {
  const target = url.pathname === '/api/ai/health' ? `${SERVICE}/health` : `${SERVICE}/sam/${url.pathname.split('/').pop()}`
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {},
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
    })
    const body = await upstream.json().catch(() => ({}))
    const out = url.pathname === '/api/ai/health'
      ? { available: upstream.ok, sam: !!body.sam_available, samLoaded: !!body.sam_loaded, samModel: body.sam_model }
      : upstream.ok ? body : { error: typeof body.detail === 'string' ? body.detail : 'Invalid selection request' }
    res.writeHead(url.pathname === '/api/ai/health' ? 200 : upstream.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  } catch (e) {
    res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(e?.message || e) }))
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.startsWith('/api/ai/')) return proxyApi(req, res, url)
    const rel = url.pathname === '/' ? '/index.html' : url.pathname
    const file = path.join(HARNESS_DIR, path.normalize(rel))
    if (!file.startsWith(HARNESS_DIR) || !existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch (e) {
    res.writeHead(500).end(String(e?.message || e))
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
log(`serving harness on http://127.0.0.1:${port}`)

/* ─── 4. Drive the browser ──────────────────────────────────────────────── */
let context = null
try {
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    // Ask for WebGPU so grounding/depth get the fast device when the host
    // supports it (the RMBG-1.4 matting engine runs fine on plain WASM).
    // Harmless where unsupported: everything falls back to WASM.
    args: ['--enable-unsafe-webgpu', '--enable-gpu'],
  })
} catch (err) {
  server.close()
  if (/executable doesn't exist|browser is not installed/i.test(err?.message || '')) {
    skip('Chromium not installed for playwright (bunx playwright install chromium)')
  }
  die(`could not launch Chromium: ${err?.message}`)
}

let failed = false
try {
  const page = await context.newPage()
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.startsWith('[selftest]') || text.startsWith('[harness]') || msg.type() === 'error') {
      log(`browser: ${text.slice(0, 200)}`)
    }
  })
  page.on('pageerror', (err) => log(`pageerror: ${String(err).slice(0, 200)}`))

  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForFunction(() => window.__harnessReady === true, null, { timeout: 30_000 })

  const runSelfTest = (opts) => Promise.race([
    page.evaluate((o) => window.__clientAI.run(o), opts),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`self-test exceeded ${Math.round(TIMEOUT_MS / 1000)}s`)), TIMEOUT_MS)),
  ])
  const report = (r) => {
    for (const c of r.checks) {
      console.log(`[verify-client-ai] ${c.ok ? 'ok' : '✗'} ${c.label} — ${c.detail}`)
      if (!c.ok) failed = true
    }
  }

  // Server first, while the page has never loaded SlimSAM.
  const health = await fetch(`${SERVICE}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null)
  if (health?.sam_available) {
    log(`server pass — SlimSAM on ${SERVICE}`)
    const modelFetches = []
    const onRequest = (r) => { if (/huggingface|hf\.co/.test(r.url())) modelFetches.push(r.url()) }
    page.on('request', onRequest)
    const r = await runSelfTest({ side: 'server' })
    page.off('request', onRequest)
    log(`server total=${(r.totalMs / 1000).toFixed(1)}s`)
    report(r)
    const state = await page.evaluate(() => window.__clientAI.state())
    const quiet = modelFetches.length === 0 && !state.samReady && !state.groundReady
    console.log(`[verify-client-ai] ${quiet ? 'ok' : '✗'} the server pass downloaded and loaded no model in the browser — ${modelFetches.length} model requests, samReady ${state.samReady}`)
    if (!quiet) failed = true
    const ok = r.checks.length >= 5 && r.device === 'server'
    console.log(`[verify-client-ai] ${ok ? 'ok' : '✗'} the server pass ran the subject, click and every-subject checks — ${r.checks.length} checks, device ${r.device}`)
    if (!ok) failed = true
  } else {
    log(`server pass: skip — no SlimSAM at ${SERVICE} (bun run masking:dev)`)
  }

  if (!SERVER_ONLY) {
    log('device pass — running self-test (first run downloads the models)…')
    const r = await runSelfTest({})
    log(`device=${r.device} total=${(r.totalMs / 1000).toFixed(1)}s`)
    report(r)
    if (r.ground?.error) log(`ground error: ${r.ground.error}`)
  }
} catch (err) {
  console.error(`[verify-client-ai] ✗ ${err?.message || err}`)
  failed = true
} finally {
  await context.close().catch(() => {})
  // Keep-alive sockets (the browser's, the proxy's) would hold the process open.
  server.closeAllConnections?.()
  server.close()
}

if (failed) {
  console.error('\n[verify-client-ai] ✗ AI self-test FAILED')
  process.exit(1)
}
console.log('\n[verify-client-ai] ✓ selection AI verified in a real browser')
process.exit(0)
