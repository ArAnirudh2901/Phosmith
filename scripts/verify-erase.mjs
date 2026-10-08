#!/usr/bin/env bun
// Drives the real Erase panel on the real CanvasEditor in Chromium (real GPU on a
// Mac) with a 24 MP photo, and measures what a hand on a mouse feels: frame gaps
// while dragging, the hitch on press and on release, and whether the stroke is
// visible WHILE it is drawn. Then checks the result by reading pixels.
//
// Every /api call is answered 501 (no services), so the object remover's
// fallbacks are what gets exercised unless a scenario answers it itself.

import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import sharp from 'sharp'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import { readFile, writeFile } from 'node:fs/promises'

const ROOT = path.resolve(import.meta.dir, '..')
const OUT = path.join(ROOT, '.cache', 'erase-harness')
const log = (msg) => console.log(`[verify-erase] ${msg}`)
const skip = (msg) => { log(`skip — ${msg}`); process.exit(0) }
const args = process.argv.slice(2)
const MEASURE_ONLY = args.includes('--measure')
const W = Number(args.includes('--w') ? args[args.indexOf('--w') + 1] : 6000)
const H = Math.round(W * 2 / 3)

let chromium
try { ({ chromium } = await import('playwright')) } catch { skip('playwright is not installed') }

await mkdir(OUT, { recursive: true })
// Clerk is stubbed (signed-in Pro): the panel's plan gate reads it, and the
// harness has no ClerkProvider and no network.
const stub = path.join(ROOT, 'scripts/erase-harness/clerk-stub.js')
const build = await Bun.build({
  entrypoints: [path.join(ROOT, 'scripts/erase-harness/entry.jsx')], outdir: OUT, target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, minify: false,
  plugins: [{ name: 'clerk-stub', setup(b) { b.onResolve({ filter: /^@clerk\/nextjs/ }, () => ({ path: stub })) } }],
})
if (!build.success) { console.error(build.logs.slice(0, 5).map(String).join('\n')); process.exit(1) }

// The app's own CSS: the editor's layout is Tailwind, and without it the canvas
// container grows with its content instead of filling a fixed viewport.
const globals = path.join(ROOT, 'src/app/globals.css')
const css = await postcss([tailwind({ base: ROOT })]).process(await readFile(globals, 'utf8'), { from: globals })
await writeFile(path.join(OUT, 'app.css'), css.css)

// A real photo scaled up, so texture (not a flat fill) is what gets painted on.
const photo = await sharp(path.join(ROOT, '.cache/preview-photos/moto.jpg')).resize(W, H, { fit: 'fill', kernel: 'lanczos3' }).jpeg({ quality: 88 }).toBuffer()

const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><script>window.process = { env: { NODE_ENV: 'production' } }</script></head>
<body class="dark" style="margin:0;background:#0b0d12"><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`
const server = Bun.serve({ port: 0, fetch(req) {
  const p = new URL(req.url).pathname
  if (p === '/') return new Response(html, { headers: { 'content-type': 'text/html' } })
  if (p === '/photo.jpg') return new Response(photo, { headers: { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*' } })
  // The model runtime, for --sam (onnxruntime-web's files, as the app serves them).
  if (p.startsWith('/ort/')) {
    const f = Bun.file(path.join(ROOT, 'public', p))
    return f.exists().then((ok) => (ok ? new Response(f, { headers: { 'content-type': p.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' } }) : new Response('not found', { status: 404 })))
  }
  const file = Bun.file(path.join(OUT, p))
  return file.exists().then((ok) => (ok ? new Response(file) : new Response('not found', { status: 404 })))
} })

// --sam runs the object remover on the real SlimSAM, from verify:client-ai's
// profile so the model is not downloaded again.
const SAM = args.includes('--sam')
const GPU_ARGS = process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : []
let browser
try {
  browser = SAM ? null : await chromium.launch({ args: GPU_ARGS })
} catch (e) { server.stop(); skip(`Chromium not installed: ${e.message.split('\n')[0]}`) }

let checks = 0, failures = 0
const check = (ok, name) => { checks++; if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`) }

const DPR = Number(args.includes('--dpr') ? args[args.indexOf('--dpr') + 1] : 1)
const ctx = SAM
  ? await chromium.launchPersistentContext(path.join(ROOT, '.cache', 'playwright-client-ai'), { headless: true, args: [...GPU_ARGS, '--enable-unsafe-webgpu'], viewport: { width: 1460, height: 1000 }, deviceScaleFactor: DPR })
  : await browser.newContext({ viewport: { width: 1460, height: 1000 }, deviceScaleFactor: DPR })
if (SAM) browser = ctx
const page = ctx.pages?.()[0] || await ctx.newPage()
const pageErrors = []
const apiCalls = []
const writes = []
page.on('pageerror', (e) => pageErrors.push(e.message))
page.on('console', (m) => { if (args.includes('--console')) console.log(`    [page ${m.type()}] ${m.text()}`) })
if (!SAM) await page.route(/huggingface\.co|hf\.co|cdn-lfs|xethub/, (route) => route.abort())
let inpaintResponder = null
await page.route(/\/api\//, async (route) => {
  const req = route.request()
  const url = new URL(req.url()).pathname
  apiCalls.push(url)
  if (req.method() !== 'GET' && url !== '/api/ai/inpaint' && url !== '/api/imagekit/upload') writes.push({ url, body: req.postData() || '' })
  if (url === '/api/ai/inpaint' && inpaintResponder) return inpaintResponder(route)
  if (req.method() === 'GET' && url.includes('/api/canvas/snapshot')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"snapshot":null}' })
  }
  return route.fulfill({ status: 501, contentType: 'application/json', body: '{"error":"harness"}' })
})
await page.goto(`http://localhost:${server.port}/`)
await page.waitForFunction(() => typeof window.__run === 'function', null, { timeout: 30_000 })
await page.evaluate(({ W, H }) => window.__run({ width: W, height: H, src: '/photo.jpg' }), { W, H })
await page.waitForFunction(() => {
  const img = window.__canvas?.getObjects?.().find((o) => o.type?.toLowerCase() === 'image')
  return img && img._element?.naturalWidth > 0
}, null, { timeout: 60_000 })
await page.waitForTimeout(1500)
await page.evaluate(() => window.__showPanel(true))
await page.waitForSelector('text=Click-to-remove', { timeout: 20_000 }).catch(async (e) => { console.log('PANEL:', await page.evaluate(() => document.getElementById('panel')?.innerText.slice(0, 600)), 'ERR:', pageErrors, await page.evaluate(() => window.__errors)); throw e })
await page.waitForTimeout(800)

// Image px → page px through the image transform and the viewport.
const toScreen = (x, y) => page.evaluate(([x, y]) => {
  const c = window.__canvas
  const img = c.getObjects().find((o) => o.type?.toLowerCase() === 'image')
  const m = img.calcTransformMatrix()
  const lx = x - img.width / 2, ly = y - img.height / 2
  const sx = m[0] * lx + m[2] * ly + m[4], sy = m[1] * lx + m[3] * ly + m[5]
  const v = c.viewportTransform
  const r = c.upperCanvasEl.getBoundingClientRect()
  return { x: r.left + v[0] * sx + v[2] * sy + v[4], y: r.top + v[1] * sx + v[3] * sy + v[5] }
}, [x, y])

// What the user sees at a page point: lower + upper canvas, composited by a screenshot.
const seen = async (pt) => {
  if (!Number.isFinite(pt?.x) || !Number.isFinite(pt?.y)) throw new Error(`bad point ${JSON.stringify(pt)}`)
  const buf = await page.screenshot({ scale: 'css', clip: { x: Math.round(pt.x) - 1, y: Math.round(pt.y) - 1, width: 3, height: 3 } }).catch(async (e) => {
    throw new Error(`${e.message.split('\n')[0]} at ${JSON.stringify(pt)} page ${JSON.stringify(await page.evaluate(() => ({ sx: scrollX, sy: scrollY, w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, iw: innerWidth, ih: innerHeight })))}`)
  })
  const { data } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
  return [data[12], data[13], data[14]]
}
const near = (a, b, tol = 30) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol

// Frame and long-task recorder.
const startRecording = () => page.evaluate(() => {
  const rec = { frames: [], longTasks: [], marks: {} }
  window.__rec = rec
  let last = performance.now()
  const tick = (t) => { rec.frames.push(t - last); last = t; if (window.__rec === rec) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  try {
    rec.obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) rec.longTasks.push(Math.round(e.duration)) })
    rec.obs.observe({ type: 'longtask', buffered: false })
  } catch { /* no longtask */ }
})
const stopRecording = () => page.evaluate(() => {
  const rec = window.__rec; window.__rec = null; rec.obs?.disconnect()
  const f = rec.frames.slice(1).sort((a, b) => a - b)
  const pct = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))] || 0
  return { n: f.length, mean: f.reduce((s, v) => s + v, 0) / Math.max(1, f.length), p95: pct(0.95), max: f[f.length - 1] || 0,
    over33: f.filter((v) => v > 33).length, longTasks: rec.longTasks, blocked: rec.longTasks.reduce((s, v) => s + v, 0) }
})

// One timed stroke along image-space points, ~60 Hz, like a hand.
const stroke = async (pts, { midCheck } = {}) => {
  const screen = []
  for (const p of pts) screen.push(await toScreen(p[0], p[1]))
  await page.mouse.move(screen[0].x - 40, screen[0].y)
  await page.waitForTimeout(200)
  await startRecording()
  const t0 = Date.now()
  await page.mouse.move(screen[0].x, screen[0].y)
  await page.mouse.down()
  const pressMs = await page.evaluate(() => new Promise((r) => { const t = performance.now(); requestAnimationFrame(() => r(performance.now() - t)) }))
  let mid = null
  const steps = 48
  for (let i = 1; i <= steps; i++) {
    const f = i / steps * (screen.length - 1)
    const k = Math.min(screen.length - 2, Math.floor(f)), u = f - k
    await page.mouse.move(screen[k].x + (screen[k + 1].x - screen[k].x) * u, screen[k].y + (screen[k + 1].y - screen[k].y) * u)
    await page.waitForTimeout(16)
    if (midCheck && i === steps - 6) { mid = await seen(screen[0]); await shot('1-mid-stroke') }
  }
  const dragMs = Date.now() - t0
  const drag = await stopRecording()
  await startRecording()
  await page.mouse.up()
  const releaseMs = await page.evaluate(() => new Promise((r) => { const t = performance.now(); requestAnimationFrame(() => r(performance.now() - t)) }))
  await page.waitForTimeout(2500)
  const after = await stopRecording()
  return { pressMs, drag, dragMs, releaseMs, after, mid, screen }
}

const SHOTS = args.includes('--shots') ? path.join(OUT, 'shots') : null
if (SHOTS) await mkdir(SHOTS, { recursive: true })
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), clip: { x: 340, y: 0, width: 1100, height: 760 } }) }
const fmt = (r) => `press→frame ${r.pressMs.toFixed(0)} ms · drag frames mean ${r.drag.mean.toFixed(1)} p95 ${r.drag.p95.toFixed(0)} max ${r.drag.max.toFixed(0)} (${r.drag.over33} >33ms) · release→frame ${r.releaseMs.toFixed(0)} ms · after: blocked ${r.after.blocked} ms in [${r.after.longTasks.join(',')}]`

try {
  const target = [W * 0.30, H * 0.55], end = [W * 0.60, H * 0.55]
  const before = await seen(await toScreen(...target))
  // Brush size in image px (the panel's own shortcut: } = +16): big enough to see at fit zoom.
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.keyboard.type('}'.repeat(17))
  await page.waitForTimeout(300)

  log(`photo ${W}×${H} at DPR ${DPR}`)
  let cdp = null
  if (args.includes('--cpu')) { cdp = await ctx.newCDPSession(page); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start') }
  const r1 = await stroke([target, end], { midCheck: true })
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop')
    const self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]))
    const dt = profile.timeDeltas; const counts = new Map()
    profile.samples.forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (dt[i] || 0)))
    for (const [id, us] of counts) { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + us) }
    log('cpu self (ms): ' + [...self].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}=${(v / 1000).toFixed(0)}`).join(' | '))
  }
  log(`stroke 1: ${fmt(r1)}`)
  const r2 = await stroke([[W * 0.3, H * 0.3], [W * 0.6, H * 0.3]])
  log(`stroke 2: ${fmt(r2)}`)
  const afterPx = await seen(r1.screen[0])
  log(`pixel at stroke: before ${before} · mid-stroke ${r1.mid} · after ${afterPx}`)

  if (!MEASURE_ONLY) {
    console.log('brush')
    check(!near(afterPx, before), 'stroke removes the pixels it covered')
    check(r1.mid && !near(r1.mid, before), 'the erase is visible WHILE dragging, not only after release')
    check(r1.drag.p95 <= 20 && r1.drag.over33 === 0 && r2.drag.over33 === 0, `drag stays at frame rate (p95 ${r1.drag.p95.toFixed(0)} ms, ${r1.drag.over33 + r2.drag.over33} frames >33ms)`)
    check(r1.pressMs <= 34 && r2.pressMs <= 34, `press reaches the next frame within two frames (${r1.pressMs.toFixed(0)}, ${r2.pressMs.toFixed(0)} ms)`)
    check(r1.releaseMs <= 34 && r2.releaseMs <= 34, `release reaches the next frame within two frames (${r1.releaseMs.toFixed(0)}, ${r2.releaseMs.toFixed(0)} ms)`)
    check(r1.after.blocked <= 120 && r2.after.blocked <= 120, `committing a stroke blocks the main thread ≤120 ms in total (${r1.after.blocked}, ${r2.after.blocked} ms)`)

    // The commit is deferred, but it happens: one save carrying the mask as RLE,
    // and no PNG of the clip in it.
    const saved = writes.filter((w) => w.body.includes('phosmithMask'))
    check(saved.length >= 1, `the mask is saved (${saved.length} writes carry it)`)
    check(saved.every((w) => !w.body.includes('data:image/png')), 'the save carries no PNG-encoded clip')

    // The banded, cached encoding decodes to exactly the mask, like a fresh one.
    const roundTrip = await page.evaluate(() => {
      const L = window.__lib
      const img = window.__canvas.getObjects().find((o) => o.type?.toLowerCase() === 'image')
      const mask = img._phosmithMaskCanvas
      const a = mask.getContext('2d').getImageData(0, 0, mask.width, mask.height).data
      const cached = L.decodeMaskCanvas(L.encodeMaskCanvasCached(mask)).getContext('2d').getImageData(0, 0, mask.width, mask.height).data
      const fresh = L.decodeMaskCanvas(L.encodeMaskCanvas(mask)).getContext('2d').getImageData(0, 0, mask.width, mask.height).data
      let diff = 0, dark = 0
      for (let i = 0; i < a.length; i += 4) { if (a[i] !== cached[i] || a[i] !== fresh[i]) diff += 1; if (a[i] < 250) dark += 1 }
      return { diff, dark }
    })
    check(roundTrip.diff === 0 && roundTrip.dark > 1000, `the saved mask decodes to exactly what is on screen (${roundTrip.dark} erased px, ${roundTrip.diff} differ)`)

    console.log('undo')
    const maskAt = (x, y) => page.evaluate(([x, y]) => {
      const img = window.__canvas.getObjects().find((o) => o.type?.toLowerCase() === 'image')
      return img._phosmithMaskCanvas.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data[0]
    }, [x, y])
    const undo = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('phosmith:mask-undo')))
    const redo = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('phosmith:mask-redo')))
    await undo(); await undo(); await page.waitForTimeout(150)
    check(near(await seen(r1.screen[0]), before, 12) && (await maskAt(...target)) === 255, 'two undos bring both strokes back')
    await redo(); await page.waitForTimeout(150)
    check(!near(await seen(r1.screen[0]), before) && (await maskAt(...target)) < 50, 'redo erases the first stroke again')
    await undo(); await page.waitForTimeout(150)

    console.log('generative fill (service answers)')
    inpaintResponder = async (route) => {
      const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff00ff' } }).png().toBuffer()
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'X-Inpaint-Backend': 'lama' }, body: png })
    }
    const V = [W * 0.5, H * 0.75]
    // Its own baseline: only this stroke is new.
    await page.evaluate(() => window.__showPanel(false)); await page.waitForTimeout(300)
    await page.evaluate(() => window.__showPanel(true)); await page.waitForSelector('text=Click-to-remove'); await page.waitForTimeout(500)
    await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.type('}'.repeat(17))
    const outside = await seen(await toScreen(V[0], V[1] - 400))
    await stroke([[V[0] - 100, V[1]], [V[0] + 100, V[1]]])
    await page.getByRole('button', { name: /Generative Fill/ }).click()
    await page.waitForFunction(() => /Generative fill applied with LaMa/.test(document.body.innerText), null, { timeout: 30_000 })
    await page.waitForTimeout(800)
    check(near(await seen(await toScreen(...V)), [255, 0, 255], 40), 'the server fill lands exactly on the painted area')
    check(near(await seen(await toScreen(V[0], V[1] - 400)), outside, 6), 'pixels outside the fill are untouched')
    inpaintResponder = null

    console.log('generative fill (no service: filled on this device)')
    const Y = [W * 0.15, H * 0.80], Z = [W * 0.80, H * 0.80]
    await stroke([[Y[0] - 120, Y[1]], [Y[0] + 120, Y[1]]])
    // Remount: the fill baseline restarts, so Y is an erasure made before it.
    await page.evaluate(() => window.__showPanel(false)); await page.waitForTimeout(300)
    await page.evaluate(() => window.__showPanel(true)); await page.waitForSelector('text=Click-to-remove'); await page.waitForTimeout(500)
    await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.type('}'.repeat(17))
    await stroke([[Z[0] - 120, Z[1]], [Z[0] + 120, Z[1]]])
    const zErased = await seen(await toScreen(...Z))
    await shot('2-before-fill')
    await startRecording()
    let fcdp = null
    if (args.includes('--cpu-fill')) { fcdp = await ctx.newCDPSession(page); await fcdp.send('Profiler.enable'); await fcdp.send('Profiler.setSamplingInterval', { interval: 500 }); await fcdp.send('Profiler.start') }
    const t0 = Date.now()
    await page.getByRole('button', { name: /Generative Fill/ }).click()
    if (SHOTS) { await page.waitForTimeout(350); await shot('3-shimmer') }
    await page.waitForFunction(() => /Generative fill applied|fill failed/i.test(document.body.innerText), null, { timeout: 60_000 })
    const fillMs = Date.now() - t0
    const fillRec = await stopRecording()
    if (fcdp) {
      const { profile } = await fcdp.send('Profiler.stop')
      const self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]))
      const dt = profile.timeDeltas; const counts = new Map()
      profile.samples.forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (dt[i] || 0)))
      for (const [id, us] of counts) { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + us) }
      log('fill cpu self (ms): ' + [...self].sort((a, b) => b[1] - a[1]).slice(0, 22).map(([k, v]) => `${k}=${(v / 1000).toFixed(0)}`).join(' | '))
      const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id)
      const focus = args[args.indexOf('--cpu-fill') + 1]
      if (focus && !focus.startsWith('--')) {
        const paths = new Map()
        for (const [id, us] of counts) { const n = byId.get(id); if (n.callFrame.functionName !== focus) continue; let chain = []; let cur = parent.get(id); for (let k = 0; k < 6 && cur; k++) { const pn = byId.get(cur); chain.push(`${pn.callFrame.functionName || '(anon)'}:${pn.callFrame.lineNumber}`); cur = parent.get(cur) } const key = chain.join(' < '); paths.set(key, (paths.get(key) || 0) + us) }
        log(`${focus} callers: ` + [...paths].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${(v / 1000).toFixed(0)}ms ${k}`).join('\n    '))
      }
    }
    const toastText = await page.evaluate(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.innerText).join(' | '))
    await page.waitForTimeout(800)
    const zAfter = await seen(await toScreen(...Z))
    await shot('4-after-fill')
    log(`fill ${fillMs} ms · frames p95 ${fillRec.p95.toFixed(0)} max ${fillRec.max.toFixed(0)} · long tasks [${fillRec.longTasks.join(',')}] · toast "${toastText}"`)
    check(/on this device/.test(toastText), 'with no fill service, the fill runs on this device and says so')
    check((await maskAt(...Z)) === 255 && !near(zAfter, zErased), 'the painted area is filled with picture, not left erased')
    check((await maskAt(...Y)) < 50, 'an erasure made before the fill stays erased (it used to be wiped)')
    // The shimmer and the dissolve run on the compositor; what the main thread
    // owes is never to stall input for long.
    check(Math.max(0, ...fillRec.longTasks) <= 150, `the fill never blocks the page for more than 150 ms at a time (longest ${Math.max(0, ...fillRec.longTasks)} ms)`)
    check(fillMs <= 4000, `a 24 MP fill on this device finishes in under 4 s (${fillMs} ms)`)

    console.log('feathered brush')
    const slider = page.getByRole('slider', { name: 'Edge Feather' })
    await slider.focus(); await page.keyboard.press('PageUp'); await page.keyboard.press('PageUp')
    await page.evaluate(() => document.activeElement?.blur?.())
    await page.waitForTimeout(600)
    const F = [W * 0.25, H * 0.12]
    const rf = await stroke([[F[0] - 300, F[1]], [F[0] + 300, F[1]]])
    log(`feathered stroke: ${fmt(rf)}`)
    const ramp = await page.evaluate(([x, y]) => {
      const img = window.__canvas.getObjects().find((o) => o.type?.toLowerCase() === 'image')
      const live = img._phosmithLiveClip
      const f = live.feathered.getContext('2d').getImageData(Math.round(x), Math.round(y) - 220, 1, 440).data
      let soft = 0
      for (let i = 3; i < f.length; i += 4) if (f[i] > 20 && f[i] < 235) soft += 1
      return { soft, centre: f[220 * 4 + 3], feather: img.phosmithMaskFeather, element: img.clipPath?.getElement() === live.feathered }
    }, F)
    check(ramp.feather === 20 && ramp.element && ramp.centre < 20 && ramp.soft >= 20, `a feathered stroke has a soft edge as it is drawn (${ramp.soft} px of ramp, feather ${ramp.feather})`)
    check(rf.drag.p95 <= 20 && rf.drag.over33 <= 1 && rf.after.blocked <= 120, `and stays at frame rate (p95 ${rf.drag.p95.toFixed(0)} ms, ${rf.drag.over33} frames >33 ms, ${rf.after.blocked} ms after)`)
    await slider.focus(); await page.keyboard.press('Home'); await page.evaluate(() => document.activeElement?.blur?.())
    await page.waitForTimeout(600)

    console.log('circle to remove')
    await page.getByRole('button', { name: /Circle to Remove/ }).click()
    const C = [W * 0.45, H * 0.4], rad = 350
    const loop = Array.from({ length: 25 }, (_, i) => [C[0] + rad * Math.cos(i / 24 * 2 * Math.PI), C[1] + rad * Math.sin(i / 24 * 2 * Math.PI)])
    const cBefore = await seen(await toScreen(...C))
    await stroke(loop)
    const erasedLook = await seen(r1.screen[0]) // stroke 1 area: erased again after redo
    const cHighlighted = await seen(await toScreen(...C))
    await shot('5-circle')
    check((await maskAt(...C)) < 50 && !near(cHighlighted, erasedLook, 20) && !near(cHighlighted, cBefore, 8), 'a drawn loop selects its inside and only highlights it until you choose')
    await page.getByRole('button', { name: /^Erase$/ }).click()
    await page.waitForTimeout(400)
    check((await maskAt(...C)) < 50 && !near(await seen(await toScreen(...C)), cBefore), "Erase removes the loop's whole inside")
    await page.getByRole('button', { name: /Circle to Remove/ }).click()

    if (SAM) {
      console.log('object remover (real SlimSAM, no fill service)')
      await page.getByRole('button', { name: /Click-to-remove/ }).click()
      // The front headlight.
      const head = [W * 0.725, H * 0.31]
      const hp = await toScreen(...head)
      const headBefore = await seen(hp)
      await shot('6a-before-object')
      await page.evaluate(() => document.querySelectorAll('[data-sonner-toast]').forEach((t) => t.remove()))
      const t0 = Date.now()
      await page.mouse.click(hp.x, hp.y)
      await page.waitForFunction(() => /Object removed|cut the object out|No object found|failed/i.test(document.body.innerText), null, { timeout: 240_000 })
      const removeMs = Date.now() - t0
      await page.waitForTimeout(800)
      const toast = await page.evaluate(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.innerText).join(' | '))
      await shot('6-object-removed')
      log(`object removal ${removeMs} ms · "${toast}"`)
      check(/Object removed/.test(toast) && !near(await seen(hp), headBefore, 25), 'clicking an object removes it and fills the background')
      await page.getByRole('button', { name: /Click-to-remove/ }).click()
    }

    if (!SAM) {
    console.log('object remover without the model')
    await page.getByRole('button', { name: /Click-to-remove/ }).click()
    const o = await toScreen(W * 0.4, H * 0.5)
    await page.mouse.click(o.x, o.y)
    await page.waitForFunction(() => document.querySelectorAll('[data-sonner-toast]').length > 0 && !/Detecting object/.test(document.getElementById('panel').innerText), null, { timeout: 60_000 }).catch(() => {})
    const objToast = await page.evaluate(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.innerText).at(-1) || '')
    check(objToast && !/fetch|\[object/i.test(objToast), `a model that cannot load gives a readable message ("${objToast.slice(0, 80)}")`)
    }
  }
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.slice(0, 3).join(' | ')}` : ''}`)
  const errs = await page.evaluate(() => window.__errors.slice())
  check(errs.length === 0, `no render errors${errs.length ? `: ${errs[0]}` : ''}`)
} finally {
  await browser.close()
  server.stop()
}
log(`${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
