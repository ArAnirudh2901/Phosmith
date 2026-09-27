#!/usr/bin/env bun
/**
 * Renders the Pixel Stretch engine on real photos and writes the frames to
 * .cache/stretch-preview so they can be judged by eye. Not a test — a look.
 *
 * Drives the real Chrome on --remote-debugging-port=9222 (Canvas2D output is
 * driver-dependent, so a software rasteriser would not tell the truth).
 *
 * Usage: bun scripts/preview-stretch.mjs --photos <dir> [--specs <file.json>]
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const OUT_DIR = path.join(ROOT, '.cache', 'stretch-preview')
const args = process.argv.slice(2)
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const PHOTOS = arg('--photos', path.join(ROOT, '.cache', 'preview-photos'))
const SPECS = arg('--specs', null)
const DEVTOOLS = Number(arg('--port', 9222))

const die = (m) => { console.error(`[preview-stretch] ✗ ${m}`); process.exit(1) }

await mkdir(OUT_DIR, { recursive: true })
const build = Bun.spawnSync(['bun', 'build', path.join(ROOT, 'scripts/stretch-preview/entry.js'),
    '--outdir', OUT_DIR, '--target=browser'], { cwd: ROOT })
if (build.exitCode !== 0) die(`bundle failed:\n${build.stderr?.toString().slice(0, 2000)}`)
await writeFile(path.join(OUT_DIR, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>stretch preview</title><body style="background:#06080b"><script type="module" src="./entry.js"></script>')

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.map': 'application/json', '.arw': 'application/octet-stream', '.nef': 'application/octet-stream', '.cr2': 'application/octet-stream', '.dng': 'application/octet-stream' }
const server = createServer(async (req, res) => {
    const rel = new URL(req.url, 'http://localhost').pathname
    const file = rel.startsWith('/photos/') ? path.join(PHOTOS, path.basename(rel))
        : path.join(OUT_DIR, path.normalize(rel === '/' ? '/index.html' : rel))
    if (!existsSync(file)) { res.writeHead(404).end('nf'); return }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(await readFile(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}/`

const probe = await fetch(`http://127.0.0.1:${DEVTOOLS}/json/version`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.json()).catch(() => null)
if (!probe) { server.close(); die(`no Chrome on :${DEVTOOLS}`) }
const target = await fetch(`http://127.0.0.1:${DEVTOOLS}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })
    .then((r) => r.json()).catch(() => null)
if (!target?.webSocketDebuggerUrl) { server.close(); die('could not open a tab') }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('cdp socket failed')), { once: true })
})
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    const slot = pending.get(m.id)
    if (!slot) return
    pending.delete(m.id)
    m.error ? slot.reject(new Error(m.error.message)) : slot.resolve(m.result)
})
const send = (method, params) => new Promise((resolve, reject) => {
    id += 1
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate threw')
    return r.result.value
}

const finish = async () => {
    ws.close()
    await fetch(`http://127.0.0.1:${DEVTOOLS}/json/close/${target.id}`).catch(() => {})
    server.close()
}

const DEFAULT_SPECS = [
    { name: '01-straight', photo: 'p2.jpg', params: { axis: 'vertical', band: { x: 0.30, y: 0.40, w: 0.40, h: 0.30 }, seed: 0.5, length: 1.6 } },
    { name: '02-bend', photo: 'p2.jpg', params: { axis: 'vertical', band: { x: 0.30, y: 0.40, w: 0.40, h: 0.30 }, seed: 0.5, length: 2.2, bend: 0.55, taper: 0.35, fade: 0.3 } },
    { name: '03-warp-arch', photo: 'p2.jpg', warpPreset: 'arch', params: { axis: 'vertical', band: { x: 0.30, y: 0.42, w: 0.40, h: 0.28 }, seed: 0.5, length: 2.0 } },
    { name: '04-flow', photo: 'p2.jpg', flowPreset: 'ribbon', params: { axis: 'vertical', band: { x: 0.30, y: 0.42, w: 0.40, h: 0.28 }, seed: 0.5, length: 2.0 } },
    { name: '05-straight-h', photo: 'p5.jpg', params: { axis: 'horizontal', band: { x: 0.25, y: 0.30, w: 0.30, h: 0.40 }, seed: 0.5, length: 2.4 } },
]
const specs = SPECS ? JSON.parse(await readFile(SPECS, 'utf8')) : DEFAULT_SPECS

try {
    let ready = false
    for (let i = 0; i < 60 && !ready; i += 1) {
        ready = await evaluate('!!(window.__stretch && window.__stretch.ready)').catch(() => false)
        if (!ready) await Bun.sleep(200)
    }
    if (!ready) die('harness never initialised')
    if (args.includes('--sheet')) {
        const cols = Number(arg('--cols', 3))
        const r = await evaluate(`window.__stretch.sheet(${JSON.stringify(specs)}, ${cols})`)
        const file = path.join(OUT_DIR, `${arg('--out', 'sheet')}.png`)
        await writeFile(file, Buffer.from(r.png.split(',')[1], 'base64'))
        for (const p of r.plans) console.log(`${p.ok ? '✓' : '✗'} ${p.name}  ${p.ms} ms${p.plan ? `  plan: ${JSON.stringify(p.plan)}` : ''}`)
        console.log(file)
    } else {
        for (const spec of specs) {
            const r = await evaluate(`window.__stretch.shot(${JSON.stringify(spec)})`)
            const file = path.join(OUT_DIR, `${spec.name}.png`)
            await writeFile(file, Buffer.from(r.png.split(',')[1], 'base64'))
            console.log(`${r.ok ? '✓' : '✗'} ${spec.name}  ${r.W}x${r.H}  ${r.ms} ms  ${file}`)
        }
    }
} catch (e) {
    await finish()
    die(e?.message || String(e))
}
await finish()
