#!/usr/bin/env bun
/**
 * Verifies the collage RENDER path in a real browser: real canvas limits, the
 * platform JPEG decoder, real anti-aliasing. `verify:collage-grid` proves the
 * maths; this proves what actually gets drawn and exported.
 *
 * Driving order (same as verify:fold):
 *   1. an already-running Chrome with --remote-debugging-port=9222 — the real
 *      browser the user tests in, so its canvas ceiling is the real one;
 *   2. otherwise Playwright Chromium;
 *   3. otherwise skip.
 *
 * With PHOSMITH_PHOTO_DIR set, the listed photos are also fed through the real
 * intake checks (header parse, orientation, CMYK) so the run covers actual DSLR
 * files rather than only generated ones.
 *
 * Usage: bun scripts/verify-collage-render.mjs [--port 9222]
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const OUT_DIR = path.join(ROOT, '.cache', 'collage-harness')
const args = process.argv.slice(2)
const DEVTOOLS_PORT = Number(args[args.indexOf('--port') + 1]) || 9222
const PHOTO_DIR = process.env.PHOSMITH_PHOTO_DIR || ''
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.tif', '.tiff'])

const log = (m) => console.log(`[verify-collage-render] ${m}`)
const die = (m) => { console.error(`[verify-collage-render] ✗ ${m}`); process.exit(1) }
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
    'bun', 'build', path.join(ROOT, 'scripts/collage-harness/entry.js'),
    '--outdir', OUT_DIR, '--target=browser',
], { cwd: ROOT })
if (build.exitCode !== 0) die(`bundle failed:\n${build.stderr?.toString().slice(0, 2000)}`)
await writeFile(path.join(OUT_DIR, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>collage</title><script type="module" src="./entry.js"></script>')
log('harness bundled')

// The user's own photos, when offered: served next to the harness so the page
// can decode the real files.
let photoFiles = []
if (PHOTO_DIR) {
    try {
        const names = await readdir(PHOTO_DIR)
        for (const name of names) {
            if (!PHOTO_EXTS.has(path.extname(name).toLowerCase())) continue
            const full = path.join(PHOTO_DIR, name)
            const info = await stat(full).catch(() => null)
            if (!info?.isFile()) continue
            photoFiles.push({ name, full, size: info.size })
            if (photoFiles.length >= 24) break
        }
        log(photoFiles.length
            ? `using ${photoFiles.length} photo(s) from ${PHOTO_DIR}`
            : `no supported photos found in ${PHOTO_DIR}`)
    } catch (error) {
        log(`could not read PHOSMITH_PHOTO_DIR (${error?.message || error}) — generated inputs only`)
    }
} else {
    log('PHOSMITH_PHOTO_DIR not set — generated inputs only (set it to include your own DSLR files)')
}

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.json': 'application/json',
}
const server = createServer(async (req, res) => {
    const rel = new URL(req.url, 'http://localhost').pathname
    if (rel === '/photos.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(photoFiles.map((p) => ({ name: p.name, size: p.size, url: `/photo/${encodeURIComponent(p.name)}` }))))
        return
    }
    if (rel.startsWith('/photo/')) {
        const name = decodeURIComponent(rel.slice('/photo/'.length))
        const entry = photoFiles.find((p) => p.name === name)
        if (!entry) { res.writeHead(404).end('nf'); return }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream' })
        res.end(await readFile(entry.full))
        return
    }
    const file = path.join(OUT_DIR, path.normalize(rel === '/' ? '/index.html' : rel))
    if (!file.startsWith(OUT_DIR) || !existsSync(file)) { res.writeHead(404).end('nf'); return }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(await readFile(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}/`

// ── driver: an existing Chrome over CDP, else Playwright ────────────────────
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
    const browser = await chromium.launch().catch(() => null)
    if (!browser) return null
    const page = await browser.newPage()
    await page.goto(BASE, { waitUntil: 'load' })
    return {
        label: 'Playwright Chromium',
        evaluate: (expression) => page.evaluate(expression),
        close: () => browser.close(),
    }
}

const tab = await openCdpTab() || await openPlaywrightTab()
if (!tab) { server.close(); skip(`no browser — start Chrome with --remote-debugging-port=${DEVTOOLS_PORT}, or install playwright`) }
log(`driving ${tab.label}`)

const finish = async () => { await tab.close().catch(() => {}); server.close() }

try {
    let ready = null
    for (let i = 0; i < 60 && !ready; i += 1) {
        ready = await tab.evaluate('window.__collage ? window.__collage.ready : null').catch(() => null)
        if (!ready) await Bun.sleep(250)
    }
    if (!ready) die('harness never initialised in the page')

    // 1. Seams — the sub-pixel rounding case, on every layout.
    {
        const rows = await tab.evaluate('window.__collage.seamsAll({ width: 1081, height: 1921 })')
        const bad = rows.filter((r) => r.seamPixels > 0 || r.interiorBackdrop > 0)
        check(bad.length === 0, 'no layout leaves a seam at an odd canvas size (1081×1921)',
            bad.length
                ? bad.slice(0, 3).map((r) => `${r.layoutId}: ${r.seamPixels} on boundaries, ${r.interiorBackdrop} inside`).join('; ')
                : `${rows.length} layouts clean`)
        const square = await tab.evaluate("window.__collage.seams({ width: 1080, height: 1080, layoutId: '3-split-v' })")
        check(square.seamPixels === 0 && square.interiorBackdrop === 0,
            '1080 ÷ 3 = 360.33 leaves no hairline between columns', `${square.interiorBackdrop} backdrop px inside the frame`)
    }

    // 2. Fit modes: contain shows backdrop deliberately, cover never does.
    {
        const r = await tab.evaluate('window.__collage.fitModes()')
        check(r.cover.interiorBackdrop === 0, 'cover fills every frame even with a 16:1 panorama and a 1:5 screenshot',
            `${r.cover.interiorBackdrop} backdrop px inside the frame`)
        check(r.contain.totalBackdrop > 0, 'contain shows the whole photo and lets the backdrop frame it',
            `${r.contain.totalBackdrop} backdrop px`)
    }

    // 3. Fewer photos than cells: the rest of the template stays empty, not broken.
    {
        const r = await tab.evaluate('window.__collage.partial()')
        check(r.placed === 2 && r.cells === 4, 'a 4-cell layout accepts 2 photos', `${r.placed} placed of ${r.cells}`)
        check(r.totalBackdrop > 0, 'the unfilled cells read as empty space rather than stretched photos')
    }

    // 4. Resolution honesty.
    {
        const r = await tab.evaluate('window.__collage.resolution()')
        check(r.thumb.low === true, 'a 200×200 photo in an 800 px frame is flagged as low resolution',
            `ratio ${r.thumb.ratio.toFixed(3)}`)
        check(r.dslr.low === false, 'a 6000×4000 frame is not flagged', `ratio ${r.dslr.ratio.toFixed(2)}`)
    }

    // 5. The real device ceiling, and the scale maths on top of it.
    {
        const r = await tab.evaluate('window.__collage.limits()')
        check(r.real.maxEdge >= 4096 && r.real.maxArea >= 16_777_216,
            'the canvas probe reports this browser\'s real ceiling', `${r.real.maxEdge}px edge, ${(r.real.maxArea / 1e6).toFixed(0)} MP area`)
        check(r.forced.scale3x < 3, 'on an iOS-shaped ceiling a 3× export is reduced', `${r.forced.scale3x.toFixed(3)}×`)
        check(r.forced.clampBig.clamped && r.forced.clampBig.width <= 4096, 'an over-sized canvas is fitted first')
        check(r.forced.smallUntouched === 2, 'a small project still exports at the scale asked for')
    }

    // 6. A capped export must still be painted — blank is the bug.
    {
        const r = await tab.evaluate('window.__collage.exportCap()')
        check(Boolean(r.capped?.limitedBy), 'the export reports that it was capped', r.capped?.limitedBy
            ? `${r.capped.limitedBy.requestedScale}× → ${r.capped.limitedBy.effectiveScale.toFixed(2)}×` : 'no report')
        check(r.capped.width <= 4096 && r.capped.height <= 4096, 'the capped export fits the ceiling',
            `${r.capped.width}×${r.capped.height}`)
        check(r.capped.painted > 0, 'the capped export contains pixels (not the blank canvas iOS would return)',
            `${r.capped.painted} opaque samples`)
        check(r.uncappedLimitedBy === null, 'an export that fits is not reported as capped')
    }

    // 7. EXIF orientation: the tag becomes pixels, so stripping metadata is safe.
    {
        for (const [value, corner, described] of [[6, 'topRight', '90° clockwise'], [3, 'bottomRight', '180°'], [8, 'bottomLeft', '90° anticlockwise']]) {
            const r = await tab.evaluate(`window.__collage.orientation(${value})`)
            check(r.meta?.orientation === value, `orientation ${value} is read from the file`, `got ${r.meta?.orientation}`)
            const swapped = value >= 5 && value <= 8
            const displayOk = swapped
                ? r.display.width === r.meta.h && r.display.height === r.meta.w
                : r.display.width === r.meta.w && r.display.height === r.meta.h
            check(displayOk, `orientation ${value}: the browser shows it ${described} from the stored pixels`,
                `stored ${r.meta.w}×${r.meta.h}, shown ${r.display.width}×${r.display.height}`)
            const isMarker = (c) => c.r > 150 && c.g < 110 && c.b < 140
            check(isMarker(r.display[corner]), `orientation ${value}: the marker belongs in the ${corner}`,
                `rgb(${r.display[corner].r},${r.display[corner].g},${r.display[corner].b})`)
            // The point of the whole exercise: after flattening, the pixels alone
            // say what the tag used to say.
            check((r.flatMeta?.orientation || 1) === 1, `orientation ${value}: the flattened file needs no tag`,
                `tag ${r.flatMeta?.orientation}`)
            check(r.flat.width === r.display.width && r.flat.height === r.display.height,
                `orientation ${value}: flattening keeps the displayed dimensions`,
                `${r.flat.width}×${r.flat.height}`)
            check(isMarker(r.flat[corner]), `orientation ${value}: the marker stays put once the tag is gone`,
                `${corner} = rgb(${r.flat[corner].r},${r.flat[corner].g},${r.flat[corner].b})`)
        }
        const upright = await tab.evaluate('window.__collage.orientation(1)')
        check(upright.display.width === upright.meta.w, 'an upright photo is shown exactly as stored')
    }

    // 8. CMYK refusal happens on the header, before any decode.
    {
        const r = await tab.evaluate('window.__collage.cmyk()')
        check(r.cmyk?.components === 4, 'a 4-component (CMYK) JPEG is recognisable from its header',
            `components ${r.cmyk?.components}`)
        check(r.normal?.components === 3, 'an ordinary photo reports 3 components', `components ${r.normal?.components}`)
    }

    // 9. Tainted-canvas recovery still wraps the export.
    {
        const r = await tab.evaluate('window.__collage.taint()')
        check(r.recognised === true, 'a SecurityError from toBlob is recognised as a taint')
    }

    // 10. Transparency: the per-cell panel replaces backdrop-through-the-hole.
    {
        const bare = await tab.evaluate('window.__collage.transparency()')
        check(bare.backdropPixels > 0 && bare.holeColour.r > 200 && bare.holeColour.b > 200,
            'without a panel, a cut-out PNG shows the canvas backdrop through its hole',
            `hole = rgb(${bare.holeColour.r},${bare.holeColour.g},${bare.holeColour.b})`)
        const matted = await tab.evaluate("window.__collage.transparency({ matte: '#ffffff' })")
        check(matted.mattes === 2, 'one panel is built per filled cell', `${matted.mattes} panels`)
        const c = matted.holeColour
        check(c.r > 240 && c.g > 240 && c.b > 240, 'with a panel, the hole shows the panel colour instead',
            `hole = rgb(${c.r},${c.g},${c.b})`)
        check(matted.backdropPixels === 0, 'and no backdrop is left showing through the photo')
    }

    // 11. A dragged divider still renders without a seam.
    {
        for (const layoutId of ['4-grid', '5-mosaic', '4-columns']) {
            const r = await tab.evaluate(`window.__collage.dividerDrag({ layoutId: '${layoutId}' })`)
            check(r.seamPixels === 0 && r.interiorBackdrop === 0,
                `${layoutId}: resizing frames leaves no seam`, `${r.interiorBackdrop} backdrop px inside`)
            const widths = r.cells.map((cell) => cell.w)
            check(widths.every((w) => w >= 2), `${layoutId}: no frame was squeezed to nothing`, widths.join('/'))
        }
    }

    // 12. A viewport flip (phone rotation) must not move the cells.
    {
        const r = await tab.evaluate('window.__collage.viewportFlip()')
        const same = JSON.stringify(r.before) === JSON.stringify(r.after)
        check(same, 'rotating the device leaves every cell where it was in image space',
            same ? `${r.before.length} cells` : `${JSON.stringify(r.before[0])} → ${JSON.stringify(r.after[0])}`)
    }

    // 11. The user's own photos, when offered.
    if (photoFiles.length) {
        const r = await tab.evaluate(`(async () => {
            const list = await fetch('/photos.json').then((res) => res.json())
            const out = []
            for (const item of list) {
                const blob = await fetch(item.url).then((res) => res.blob())
                const meta = await window.__collage.metaOf(blob)
                let decoded = null
                try {
                    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' })
                    decoded = { width: bmp.width, height: bmp.height }
                    bmp.close && bmp.close()
                } catch (error) { decoded = { error: String(error && error.message || error) } }
                out.push({ name: item.name, size: item.size, meta, decoded })
            }
            return out
        })()`).catch((error) => ({ error: String(error?.message || error) }))

        if (r?.error) {
            check(false, 'the real photo folder could be read in the page', r.error.slice(0, 120))
        } else {
            const readable = r.filter((p) => p.meta && p.meta.w > 0 && p.meta.h > 0)
            check(readable.length === r.length, 'every real photo\'s dimensions are readable from its header',
                `${readable.length}/${r.length}`)
            const decoded = r.filter((p) => p.decoded && !p.decoded.error)
            check(decoded.length === r.length, 'every real photo decodes in the browser', `${decoded.length}/${r.length}`)
            const rotated = r.filter((p) => p.meta?.orientation > 1)
            const orientedOk = rotated.every((p) => {
                const swapped = p.meta.orientation >= 5 && p.meta.orientation <= 8
                return swapped
                    ? p.decoded.width === p.meta.h && p.decoded.height === p.meta.w
                    : p.decoded.width === p.meta.w && p.decoded.height === p.meta.h
            })
            check(orientedOk, 'photos carrying an orientation tag decode the way the tag says',
                `${rotated.length} of ${r.length} are tagged`)
            const cmyk = r.filter((p) => p.meta?.components === 4)
            check(true, 'CMYK files in the folder are counted', `${cmyk.length} found`)
            const biggest = r.reduce((m, p) => (p.meta && p.meta.w * p.meta.h > (m?.meta?.w * m?.meta?.h || 0) ? p : m), null)
            if (biggest?.meta) {
                log(`largest photo: ${biggest.name} — ${biggest.meta.w}×${biggest.meta.h} (${((biggest.meta.w * biggest.meta.h) / 1e6).toFixed(1)} MP, ${(biggest.size / 1e6).toFixed(1)} MB)`)
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
