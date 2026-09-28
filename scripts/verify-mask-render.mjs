#!/usr/bin/env bun
/**
 * Headless-browser verification of the phosmith EDITOR megashader render path.
 * Bundles scripts/mask-render-harness/entry.js and drives it with Playwright
 * Chromium — proves applyMegashaderFilter() renders a LOCALISED effect on a
 * real Fabric canvas through Fabric's Canvas2D filter backend.
 *
 * Usage: bun scripts/verify-mask-render.mjs
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const HARNESS_DIR = path.join(ROOT, '.cache', 'mask-render-harness')
const PROFILE_DIR = path.join(ROOT, '.cache', 'playwright-client-ai')
const log = (m) => console.log(`[verify-mask-render] ${m}`)
const die = (m) => { console.error(`[verify-mask-render] ✗ ${m}`); process.exit(1) }
const skip = (m) => { log(`skip — ${m}`); process.exit(0) }

const args = process.argv.slice(2)
const DEVTOOLS_PORT = Number(args[args.indexOf('--port') + 1]) || 9222

await mkdir(HARNESS_DIR, { recursive: true })
const build = Bun.spawnSync([
    'bun', 'build', path.join(ROOT, 'scripts/mask-render-harness/entry.js'),
    '--outdir', HARNESS_DIR, '--target=browser', '--splitting',
], { cwd: ROOT })
if (build.exitCode !== 0) die(`bundle failed:\n${build.stderr?.toString().slice(0, 2000)}`)
await writeFile(path.join(HARNESS_DIR, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>mask-render</title><script type="module" src="./entry.js"></script>')
log('harness bundled')

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json' }
const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost')
        const rel = url.pathname === '/' ? '/index.html' : url.pathname
        const file = path.join(HARNESS_DIR, path.normalize(rel))
        if (!file.startsWith(HARNESS_DIR) || !existsSync(file)) { res.writeHead(404).end('nf'); return }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
        res.end(await readFile(file))
    } catch (e) { res.writeHead(500).end(String(e?.message || e)) }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
log(`serving on http://127.0.0.1:${port}`)

const BASE = `http://127.0.0.1:${port}/`

// Prefer a Chrome that is already running with remote debugging: it is the real
// browser with the real GPU, which is what the blur path has to be measured on.
// Playwright Chromium is the fallback, and a skip is better than a false pass.
const openCdpTab = async () => {
    const probe = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
        .then((r) => r.json()).catch(() => null)
    if (!probe) return null
    const target = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })
        .then((r) => r.json()).catch(() => null)
    if (!target?.webSocketDebuggerUrl) return null
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', () => reject(new Error('cdp socket failed')), { once: true })
    })
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data)
        const slot = pending.get(msg.id)
        if (!slot) return
        pending.delete(msg.id)
        if (msg.error) slot.reject(new Error(msg.error.message))
        else slot.resolve(msg.result)
    })
    const send = (method, params) => new Promise((resolve, reject) => {
        id += 1
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
    })
    return {
        label: `Chrome ${probe.Browser?.split('/')[1] || ''} on :${DEVTOOLS_PORT}`,
        evaluate: async (expression) => {
            const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
            if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'evaluate threw')
            return res.result.value
        },
        close: async () => {
            ws.close()
            await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/close/${target.id}`).catch(() => {})
        },
    }
}

const openPlaywrightTab = async () => {
    let chromium
    try { ({ chromium } = await import('playwright')) } catch { return null }
    let context = null
    try {
        context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true, args: ['--enable-unsafe-webgpu', '--enable-gpu'] })
    } catch { return null }
    const page = await context.newPage()
    page.on('console', (m) => { const t = m.text(); if (t.startsWith('[harness]') || t.includes('[megashader]') || m.type() === 'error' || m.type() === 'warning') log(`browser(${m.type()}): ${t.slice(0, 400)}`) })
    page.on('pageerror', (e) => log(`pageerror: ${String(e).slice(0, 300)}`))
    await page.goto(BASE)
    return {
        label: 'Playwright Chromium',
        evaluate: (expression) => page.evaluate(expression),
        close: () => context.close(),
    }
}

let failed = false
const tab = await openCdpTab() || await openPlaywrightTab()
if (!tab) { server.close(); skip(`no browser — start Chrome with --remote-debugging-port=${DEVTOOLS_PORT}, or install playwright`) }
log(`driving ${tab.label}`)
try {
    let ready = false
    for (let i = 0; i < 80 && !ready; i += 1) {
        ready = await tab.evaluate('window.__harnessReady === true').catch(() => false)
        if (!ready) await Bun.sleep(250)
    }
    if (!ready) die('harness never initialised in the page')
    const report = await tab.evaluate('window.__maskRender.run()')
    for (const c of report.checks) {
        console.log(`[verify-mask-render] ${c.ok ? 'ok' : '✗'} ${c.label} — ${c.detail}`)
        if (!c.ok) failed = true
    }
} catch (err) {
    console.error(`[verify-mask-render] ✗ ${err?.message || err}`)
    failed = true
} finally {
    await tab.close().catch(() => {})
    server.close()
}
if (failed) { console.error('\n[verify-mask-render] ✗ editor render path FAILED'); process.exit(1) }
console.log('\n[verify-mask-render] ✓ editor megashader render path verified')
