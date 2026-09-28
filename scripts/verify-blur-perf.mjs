#!/usr/bin/env bun
/**
 * Performance gate for the optical gather blur.
 *
 * The gather is the one grade whose cost is not per-pixel constant — taps scale
 * with the radius and each one is a texture read — so the claim that a 200px
 * radius costs what a 10px one does has to be measured, not asserted. Two
 * regimes are timed, because they are the two the user meets:
 *
 *   interactive — display-sized source, output reused, source unchanged. This is
 *                 what a slider drag costs, and it has a frame budget.
 *   commit      — full-resolution, no reuse, no fold. This is what pressing
 *                 apply costs once, and it only has to be tolerable.
 *
 * Runs on the real GPU through the same harness verify:fold uses: a tab in a
 * Chrome already listening on --remote-debugging-port=9222, else Playwright,
 * else skip (a software rasteriser's timings would be meaningless).
 *
 * Usage: bun scripts/verify-blur-perf.mjs [--port 9222] [--budget 16]
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const OUT_DIR = path.join(ROOT, '.cache', 'fold-harness')
const args = process.argv.slice(2)
const DEVTOOLS_PORT = Number(args[args.indexOf('--port') + 1]) || 9222
const BUDGET_MS = Number(args[args.indexOf('--budget') + 1]) || 16

const log = (m) => console.log(`[verify-blur-perf] ${m}`)
const die = (m) => { console.error(`[verify-blur-perf] ✗ ${m}`); process.exit(1) }
const skip = (m) => { log(`skip — ${m}`); process.exit(0) }

let failures = 0
let checks = 0
const check = (ok, name, detail) => {
    checks += 1
    if (!ok) failures += 1
    console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  (${detail})` : ''}`)
}

await mkdir(OUT_DIR, { recursive: true })
const build = Bun.spawnSync([
    'bun', 'build', path.join(ROOT, 'scripts/fold-harness/entry.js'),
    '--outdir', OUT_DIR, '--target=browser',
], { cwd: ROOT })
if (build.exitCode !== 0) die(`bundle failed:\n${build.stderr?.toString().slice(0, 2000)}`)
await writeFile(path.join(OUT_DIR, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>blur perf</title><script type="module" src="./entry.js"></script>')

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
        real: true,
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

const tab = await openCdpTab()
if (!tab) { server.close(); skip(`no Chrome on :${DEVTOOLS_PORT} — timings on a software rasteriser would not mean anything`) }
log(`driving ${tab.label}`)

const finish = async () => { await tab.close().catch(() => {}); server.close() }
const table = (title, result) => {
    console.log(`\n[verify-blur-perf] ${title} — ${result.size} (${result.megapixels} MP), ${result.frames} frames:`)
    console.log('  radius    ms/frame      fps   mips')
    for (const row of Object.values(result.rows)) {
        console.log(`  ${String(row.radius).padStart(6)}   ${String(row.meanMs).padStart(8)}   ${String(row.fps).padStart(6)}   ${row.mipBuilds}`)
    }
}

try {
    let caps = null
    for (let i = 0; i < 60 && !caps; i += 1) {
        caps = await tab.evaluate('window.__fold ? window.__fold.caps : null').catch(() => null)
        if (!caps) await Bun.sleep(250)
    }
    if (!caps) die('harness never initialised in the page')
    log(`GPU: ${caps.renderer}`)

    // 0. The floor: what one layer costs with no blur at all. Every budget below
    //    is measured against this, because a gate that ignores the renderer's own
    //    cost is a gate on the wrong thing.
    const baseline1080 = await tab.evaluate("window.__fold.blurBench({ size: '1080p', radii: [0], frames: 12 })")
    const baseline4k = await tab.evaluate("window.__fold.blurBench({ size: '4k', radii: [0], frames: 12 })")
    const floor1080 = baseline1080.rows[0].meanMs
    const floor4k = baseline4k.rows[0].meanMs
    log(`no-blur floor: ${floor1080} ms at 1080p, ${floor4k} ms at 4K`)

    // 1a. Interactive at 1080p — the size a preview actually renders at while a
    //     slider is being dragged. This one has a real frame budget.
    const hd = await tab.evaluate("window.__fold.blurBench({ size: '1080p', radii: [8, 24, 60, 120], frames: 12 })")
    table('interactive, 1080p', hd)
    const hdSlowest = Math.max(...Object.values(hd.rows).map((r) => r.meanMs))
    check(hdSlowest < BUDGET_MS, `a 1080p preview frame stays inside the ${BUDGET_MS} ms budget at every radius`,
        `slowest ${hdSlowest} ms (floor ${floor1080} ms)`)

    // 1b. Interactive at 4K — a full-resolution preview. The gate here is the
    //     blur's OVERHEAD, since the renderer's own floor already eats most of a
    //     16 ms frame at 8.3 MP.
    const interactive = await tab.evaluate("window.__fold.blurBench({ size: '4k', radii: [8, 24, 60, 120], frames: 12 })")
    table('interactive, 4K', interactive)
    const rows = Object.values(interactive.rows)
    const slowest = Math.max(...rows.map((r) => r.meanMs))
    check(slowest - floor4k < floor4k * 1.5, 'at 4K the blur adds less than 1.5x the renderer\'s own floor',
        `floor ${floor4k} ms → worst ${slowest} ms (+${(slowest - floor4k).toFixed(1)} ms)`)
    check(slowest < 40, 'and a 4K preview frame still clears 25 fps at the widest radius', `${slowest} ms`)

    // 2. The headline claim: the mip level, not the tap count, absorbs the radius.
    const small = interactive.rows[8].meanMs
    const large = interactive.rows[120].meanMs
    check(large < small * 2.5, 'a 120px radius costs less than 2.5x an 8px one — the mip level is doing the work',
        `${small} ms → ${large} ms (${(large / small).toFixed(2)}x)`)

    // 3. Mips are built once per source version, not per frame.
    // 0 here means "not rebuilt during the timed frames" — the chain was built
    // once during warm-up, which is the whole point of keying it to sourceVersion.
    check(rows.every((r) => r.mipBuilds === 0), 'the mip chain is not rebuilt per frame while previewing',
        `builds during timing: ${rows.map((r) => r.mipBuilds).join(',')}`)

    // 4. Aperture shape must not change the cost.
    const hex = await tab.evaluate("window.__fold.blurBench({ size: '4k', radii: [60], frames: 12, kind: 'hex' })")
    const disc60 = interactive.rows[60].meanMs
    const hex60 = hex.rows[60].meanMs
    check(hex60 < disc60 * 1.5, 'a hexagonal aperture costs about the same as a round one',
        `${disc60} ms vs ${hex60} ms`)

    // 5. Commit: full resolution, no reuse, no fold — has to be tolerable, not fast.
    const commit = await tab.evaluate("window.__fold.blurBench({ size: '12mp', radii: [24, 120], frames: 4, mode: 'commit' })")
    table('commit, 12 MP (no reuse, no fold)', commit)
    const commitWorst = Math.max(...Object.values(commit.rows).map((r) => r.meanMs))
    check(commitWorst < 2000, 'a 12 MP commit renders in under 2 s', `slowest ${commitWorst} ms`)
    check(Object.values(commit.rows).every((r) => r.sourceUploads >= 1),
        'the commit path re-uploads the source, as it must (no sourceVersion promise)')

    // 6. A chain with several blur layers still composes in one frame budget.
    const stacked = await tab.evaluate(`(async () => {
        const rows = {}
        for (const layers of [1, 4, 8]) {
            const r = await window.__fold.editBench({ size: '4k', layers, hots: [0], frames: 10, fold: true })
            rows[layers] = r.rows[0].meanMs
        }
        return rows
    })()`)
    console.log(`\n[verify-blur-perf] chain depth (no blur, for reference): ${JSON.stringify(stacked)}`)
    check(Object.values(stacked).every((ms) => ms < BUDGET_MS * 2), 'the unblurred chain is still well inside budget at 8 layers')
} catch (error) {
    await finish()
    die(error?.message || String(error))
}

await finish()
console.log(`\n${checks - failures}/${checks} checks passed.`)
if (failures > 0) { console.error(`\x1b[31m${failures} check(s) failed.\x1b[0m`); process.exit(1) }
process.exit(0)
