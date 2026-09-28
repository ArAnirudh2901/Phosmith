#!/usr/bin/env bun
/**
 * Renders the focus/light effects on real photos and leaves the page open for a
 * human (or a screenshot) to judge. Not a test — a look.
 *
 * Usage: bun scripts/preview-effects.mjs --photos <dir>   (dir holds portrait.jpg,
 * street.jpg, lights.jpg). Prints the URL; opens a tab in Chrome on :9222 when one
 * is listening.
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const OUT_DIR = path.join(ROOT, '.cache', 'effects-preview')
const args = process.argv.slice(2)
const PHOTOS = args.includes('--photos') ? args[args.indexOf('--photos') + 1] : path.join(ROOT, '.cache', 'preview-photos')
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 0)
const DEVTOOLS = 9222

await mkdir(OUT_DIR, { recursive: true })
const build = Bun.spawnSync([
    'bun', 'build', path.join(ROOT, 'scripts/effects-preview/entry.js'),
    '--outdir', OUT_DIR, '--target=browser',
], { cwd: ROOT })
if (build.exitCode !== 0) {
    console.error(build.stderr?.toString().slice(0, 2000))
    process.exit(1)
}
await writeFile(path.join(OUT_DIR, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>effects preview</title><body style="background:#06080b"><script type="module" src="./entry.js"></script>')

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.map': 'application/json' }
const server = createServer(async (req, res) => {
    const rel = new URL(req.url, 'http://localhost').pathname
    const file = rel.startsWith('/photos/')
        ? path.join(PHOTOS, path.basename(rel))
        : path.join(OUT_DIR, path.normalize(rel === '/' ? '/index.html' : rel))
    if (!existsSync(file)) { res.writeHead(404).end('nf'); return }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(await readFile(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/`
console.log(`[preview-effects] ${url}  (photos from ${PHOTOS})`)

const probe = await fetch(`http://127.0.0.1:${DEVTOOLS}/json/version`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json()).catch(() => null)
if (probe) {
    const target = await fetch(`http://127.0.0.1:${DEVTOOLS}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json()).catch(() => null)
    if (target?.id) console.log(`[preview-effects] opened in ${probe.Browser} (target ${target.id})`)
}
console.log('[preview-effects] Ctrl-C to stop serving.')
