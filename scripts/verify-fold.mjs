#!/usr/bin/env bun
/**
 * Verifies the megashader SUFFIX FOLD on a real GPU.
 *
 * The fold replaces every layer above the one being edited with two per-pixel
 * maps (see src/lib/megashader/chain-fold.js), so editing cost stops depending
 * on WHERE in the chain the user is working. `verify:chain-fold` proves the
 * algebra; this proves the GPU implementation of it, by comparing a folded
 * render against a full single-pass re-render of the same stack, and then
 * reports the throughput of editing at several chain depths.
 *
 * Driving order:
 *   1. an already-running Chrome with --remote-debugging-port=9222 (real GPU,
 *      so the timings mean something) — a tab is opened and closed again;
 *   2. otherwise Playwright Chromium (correctness only; SwiftShader timings
 *      are not comparable);
 *   3. otherwise skip.
 *
 * Usage: bun scripts/verify-fold.mjs [--port 9222] [--no-bench]
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const OUT_DIR = path.join(ROOT, '.cache', 'fold-harness')
const args = process.argv.slice(2)
const DEVTOOLS_PORT = Number(args[args.indexOf('--port') + 1]) || 9222
const RUN_BENCH = !args.includes('--no-bench')

const log = (m) => console.log(`[verify-fold] ${m}`)
const die = (m) => { console.error(`[verify-fold] ✗ ${m}`); process.exit(1) }
const skip = (m) => { log(`skip — ${m}`); process.exit(0) }

let failures = 0
let checks = 0
const check = (ok, name, detail) => {
    checks += 1
    if (!ok) failures += 1
    console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  (${detail})` : ''}`)
}

// ── bundle + serve ──────────────────────────────────────────────────────────
await mkdir(OUT_DIR, { recursive: true })
const build = Bun.spawnSync([
    'bun', 'build', path.join(ROOT, 'scripts/fold-harness/entry.js'),
    '--outdir', OUT_DIR, '--target=browser',
], { cwd: ROOT })
if (build.exitCode !== 0) die(`bundle failed:\n${build.stderr?.toString().slice(0, 2000)}`)
await writeFile(path.join(OUT_DIR, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>fold</title><script type="module" src="./entry.js"></script>')
log('harness bundled')

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' }
const server = createServer(async (req, res) => {
    const rel = new URL(req.url, 'http://localhost').pathname
    const file = path.join(OUT_DIR, path.normalize(rel === '/' ? '/index.html' : rel))
    if (!file.startsWith(OUT_DIR) || !existsSync(file)) { res.writeHead(404).end('nf'); return }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(await readFile(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}/`

// ── driver: an existing Chrome over CDP, else Playwright ────────────────────
/** Minimal CDP session over one target's WebSocket. */
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
    const browser = await chromium.launch({
        args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    }).catch(() => null)
    if (!browser) return null
    const page = await browser.newPage()
    await page.goto(BASE, { waitUntil: 'load' })
    return {
        label: 'Playwright Chromium (software GPU — timings not comparable)',
        evaluate: (expression) => page.evaluate(expression),
        close: () => browser.close(),
    }
}

const tab = await openCdpTab() || await openPlaywrightTab()
if (!tab) { server.close(); skip(`no browser — start Chrome with --remote-debugging-port=${DEVTOOLS_PORT}, or install playwright`) }
log(`driving ${tab.label}`)

const finish = async () => { await tab.close().catch(() => {}); server.close() }

try {
    // The module is loaded as an ES module, so give it a moment to evaluate.
    let caps = null
    for (let i = 0; i < 60 && !caps; i += 1) {
        caps = await tab.evaluate('window.__fold ? window.__fold.caps : null').catch(() => null)
        if (!caps) await Bun.sleep(250)
    }
    if (!caps) die('harness never initialised in the page')
    log(`GPU: ${caps.renderer} · WebGL2 ${caps.webgl2} · float targets ${caps.floatTargets} · ${caps.textureUnits} texture units`)
    check(caps.webgl2 === true, 'the page has a WebGL2 context')
    check(caps.floatTargets === true, 'EXT_color_buffer_float is available (the fold needs float map targets)')

    // 1. Batched-vs-single parity must still hold (the fold sits on top of it).
    for (const [layers, batch] of [[8, 2], [16, 4], [32, 8]]) {
        const r = await tab.evaluate(`window.__fold.parity({ layers: ${layers}, batch: ${batch} })`)
        check(r.maxDiff <= 1, `batched render matches single-pass at ${layers} layers (batch ${batch})`, `maxDiff ${r.maxDiff}`)
    }

    // 2. The fold itself: edit one layer at several depths of a deep chain.
    for (const [layers, hot] of [[16, 0], [16, 5], [24, 3], [24, 22], [32, 16], [32, 31], [64, 1], [64, 32], [64, 63]]) {
        const r = await tab.evaluate(`window.__fold.foldParity({ layers: ${layers}, hot: ${hot} })`)
        check(r.engaged, `the fold engages when layer ${hot} of ${layers} is edited`)
        check(r.maxDiff <= 2, `folded render matches a full re-render — layer ${hot} of ${layers}`,
            `maxDiff ${r.maxDiff}, ${r.pixelsOver2} px over 2`)
    }

    // 3. Erase layers ride in their own texture; the edited one must not.
    for (const mode of ['above', 'below', true, 'hot']) {
        const r = await tab.evaluate(`window.__fold.foldParity({ layers: 24, hot: 6, erase: ${JSON.stringify(mode)} })`)
        check(r.maxDiff <= 2, `the fold is exact with an erase layer ${mode === true ? 'both sides' : mode}`,
            `engaged ${r.engaged}, maxDiff ${r.maxDiff}, ${r.pixelsOver2} px over 2`)
    }
    {
        const r = await tab.evaluate('window.__fold.foldParity({ layers: 24, hot: 6 })')
        check(r.maxDiff <= 2, 'control: no erase layers at the same depth', `maxDiff ${r.maxDiff}`)
    }

    // 4. overlay is piecewise, so the fold must refuse it — and still be right.
    {
        const r = await tab.evaluate('window.__fold.foldParity({ layers: 24, hot: 4, overlayAbove: true })')
        check(r.engaged === false, 'the fold refuses to run past an overlay op')
        check(r.maxDiff <= 1, 'refusing to fold still renders the chain correctly', `maxDiff ${r.maxDiff}`)
    }

    // 5. Throughput: editing deep in the chain must not cost more than the top.
    if (RUN_BENCH) {
        for (const layers of [8, 32, 64]) {
            const hots = [0, Math.floor(layers / 2), layers - 1]
            const call = (fold) => tab.evaluate(
                `window.__fold.editBench({ size: '4k', layers: ${layers}, hots: ${JSON.stringify(hots)}, frames: 30, fold: ${fold} })`)
            const off = await call(false)
            const on = await call(true)
            console.log(`\n[verify-fold] editing one layer of a ${layers}-layer chain at ${on.size} (ms/frame):`)
            console.log('  edited layer   no fold    fold    speed-up')
            for (const hot of hots) {
                const a = off.rows[hot]
                const b = on.rows[hot]
                console.log(`  ${String(hot).padStart(12)}   ${String(a.meanMs).padStart(7)}   ${String(b.meanMs).padStart(5)}   ${(a.meanMs / b.meanMs).toFixed(2)}×   (fold ${b.foldFrames}/30)`)
            }
            const times = hots.map((hot) => on.rows[hot].meanMs)
            const spread = Math.max(...times) / Math.min(...times)
            check(spread < 2, `${layers} layers: frame time is flat across edit depth`, `slowest / fastest = ${spread.toFixed(2)}×`)
            const bottom = off.rows[0].meanMs / on.rows[0].meanMs
            if (layers <= 8) {
                // A chain that already fits one GPU pass has nothing above the
                // edited layer to fold, so the fold must stay out of the way.
                check(hots.every((hot) => on.rows[hot].foldFrames === 0),
                    `${layers} layers: a single-pass chain is left alone by the fold`)
                check(bottom > 0.9, `${layers} layers: leaving it alone costs nothing`, `${bottom.toFixed(2)}×`)
            } else {
                check(hots.every((hot) => on.rows[hot].foldFrames === 30),
                    `${layers} layers: every timed frame at 4K went through the fold`)
                check(bottom > 1.2, `${layers} layers: the fold beats replaying the chain above the edited layer`,
                    `${bottom.toFixed(2)}× editing the bottom layer`)
            }
        }
    }
} catch (error) {
    await finish()
    die(error?.message || String(error))
}

await finish()
console.log(`\n${checks - failures}/${checks} checks passed.`)
if (failures > 0) { console.error(`\x1b[31m${failures} check(s) failed.\x1b[0m`); process.exit(1) }
process.exit(0)
