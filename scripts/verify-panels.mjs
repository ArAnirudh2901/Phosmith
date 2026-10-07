#!/usr/bin/env bun
// Mounts the real editor panels and CanvasEditor in headless Chromium — no Next,
// Clerk or network — and fails on anything a build cannot see: a section that
// throws when opened, a page error, an empty canvas written over a saved one.
//
// Every /api call is answered 501 and recorded, so the panels run their offline
// paths and the save checks can read exactly what the editor tried to send.

import path from 'node:path'
import { mkdir } from 'node:fs/promises'

const ROOT = path.resolve(import.meta.dir, '..')
const OUT = path.join(ROOT, '.cache', 'panel-harness-verify')
const log = (msg) => console.log(`[verify-panels] ${msg}`)
const skip = (msg) => { log(`skip — ${msg}`); process.exit(0) }

let chromium
try { ({ chromium } = await import('playwright')) } catch { skip('playwright is not installed (bun add -d playwright)') }

await mkdir(OUT, { recursive: true })
const build = Bun.spawnSync(['bun', 'build', path.join(ROOT, 'scripts/panel-harness/entry.jsx'), '--outdir', OUT,
  '--target=browser', '--define', 'process.env.NODE_ENV="development"'], { cwd: ROOT })
if (build.exitCode !== 0) { console.error(build.stderr.toString().slice(0, 1500)); process.exit(1) }

const html = `<!doctype html><html><head><meta charset="utf-8"><script>window.process = { env: { NODE_ENV: 'development' } }</script></head>
<body style="margin:0;display:flex"><div id="panel" style="width:380px"></div><canvas id="fabric"></canvas>
<div id="editor" style="width:1100px;height:750px;position:relative"></div><script type="module" src="/entry.js"></script></body></html>`
const server = Bun.serve({ port: 0, fetch(req) {
  const p = new URL(req.url).pathname
  if (p === '/') return new Response(html, { headers: { 'content-type': 'text/html' } })
  return new Response(Bun.file(path.join(OUT, p)))
} })

let browser
try { browser = await chromium.launch() } catch (e) {
  server.stop()
  skip(`Chromium not installed for playwright (bunx playwright install chromium): ${e.message.split('\n')[0]}`)
}

let checks = 0, failures = 0
const check = (ok, name) => { checks++; if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`) }

const openPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
  const page = await ctx.newPage()
  const state = { writes: [], logs: [], pageErrors: [] }
  page.on('console', (m) => state.logs.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => state.pageErrors.push(e.message))
  await page.route(/\/api\//, (route) => {
    const req = route.request()
    if (req.method() !== 'GET') state.writes.push({ url: new URL(req.url()).pathname, body: req.postData() || '' })
    if (req.method() === 'GET' && req.url().includes('/api/canvas/snapshot')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"snapshot":null}' })
    }
    return route.fulfill({ status: 501, contentType: 'application/json', body: '{"error":"harness"}' })
  })
  await page.goto(`http://localhost:${server.port}/`)
  await page.waitForFunction(() => typeof window.__mount === 'function', null, { timeout: 30_000 })
  return { ctx, page, state }
}
// DOM clicks: a tool's own canvas overlay covers the page in this layout.
const click = (loc) => loc.evaluate((el) => el.click())
const boundaryErrors = (page) => page.evaluate(() => window.__errors.slice())

// ── Panels ──────────────────────────────────────────────────────────────────
{
  const { ctx, page, state } = await openPage()
  await page.evaluate(() => window.__setup())
  const mount = async (name) => { await page.evaluate((n) => window.__mount(n), name); await page.waitForTimeout(1200) }

  await mount('mask')
  const headers = page.locator('.mask-section__header')
  const sections = await headers.count()
  for (let i = 0; i < sections; i++) {
    if ((await headers.nth(i).getAttribute('aria-expanded')) === 'false') { await click(headers.nth(i)); await page.waitForTimeout(150) }
  }
  await page.waitForTimeout(500)
  const open = await page.locator('.mask-section__header[aria-expanded="true"]').count()
  check(sections >= 14 && open === sections, `Mask: all ${sections} sections open (${open} open)`)

  await mount('stretch')
  const skipBtn = page.getByRole('button', { name: /skip/i })
  if (await skipBtn.count()) { await click(skipBtn.first()); await page.waitForTimeout(600) }
  const modeCard = await page.locator('#panel', { hasText: 'Mode' }).count()
  for (const name of ['Warp', 'Scanline']) {
    const b = page.locator('#panel button', { hasText: new RegExp(`^\\s*${name}\\s*$`) })
    if (await b.count()) { await click(b.first()); await page.waitForTimeout(300) }
  }
  const refine = page.locator('#panel button', { hasText: /refine/i })
  if (await refine.count()) { await click(refine.first()); await page.waitForTimeout(300) }
  check(modeCard > 0 && (await page.locator('#panel', { hasText: /Twist \(S-curve\)/ }).count()) > 0,
    'Pixel Stretch: reaches the stretch phase, switches modes and opens Refine')

  await mount('adjust')
  const tabs = page.locator('.adjust-tabs button')
  const tabCount = await tabs.count()
  let rendered = 0
  for (let i = 0; i < tabCount; i++) {
    await click(tabs.nth(i)); await page.waitForTimeout(250)
    if ((await page.locator('#panel *').count()) > 20) rendered++
  }
  check(tabCount >= 6 && rendered === tabCount, `Adjust: every tab renders (${rendered}/${tabCount})`)

  await mount('collage')
  check((await page.locator('#panel', { hasText: 'Spacing' }).count()) > 0, 'Collage: mounts with its sections')
  await mount('agent')
  check((await page.locator('#panel textarea').count()) > 0, 'Agent: mounts with its composer')

  const errs = await boundaryErrors(page)
  check(errs.length === 0, `no panel threw while rendering${errs.length ? ': ' + errs[0] : ''}`)
  check(state.pageErrors.length === 0, `no uncaught page errors${state.pageErrors.length ? ': ' + state.pageErrors[0] : ''}`)
  await ctx.close()
}

// ── CanvasEditor: what it loads, and what it is willing to send ──────────────
const editor = async (opts, act) => {
  const { ctx, page, state } = await openPage()
  await page.evaluate((o) => window.__runEditor(o), opts)
  await page.waitForFunction(() => window.__editorCanvas, null, { timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(800)
  const loaded = await page.evaluate(() => window.__editorCanvas?.getObjects().length ?? -1)
  await act?.(page)
  await page.waitForTimeout(1500)
  const errs = await boundaryErrors(page)
  await ctx.close()
  return { loaded, ...state, errs }
}
const emptyWrites = (writes) => writes.filter((w) => /"objects":\[\]/.test(w.body))
const save = (page) => page.evaluate(() => window.__editorCanvas?.__saveCanvasState?.({ immediate: true }).catch(() => {}))

{
  const r = await editor({ saved: 1, local: 0 }, async (page) => {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await save(page)
  })
  check(r.loaded === 1, `a newer EMPTY local copy does not hide the saved object (loaded ${r.loaded})`)
  check(emptyWrites(r.writes).length === 0, `…and no empty canvas is sent anywhere (${r.writes.length} writes)`)
}
{
  const r = await editor({ saved: 1, local: 2 })
  check(r.loaded === 2, `a newer local copy WITH objects still wins (loaded ${r.loaded})`)
}
{
  const r = await editor({ saved: 1, local: null }, async (page) => {
    await page.evaluate(() => { const c = window.__editorCanvas; c.getObjects().forEach((o) => c.remove(o)) })
    await save(page)
  })
  const empties = emptyWrites(r.writes)
  check(r.loaded === 1 && empties.length > 0 && empties.every((w) => w.body.includes('"intentionallyEmpty":true')),
    `deleting the only object saves an empty canvas marked intentionallyEmpty (${empties.length} writes)`)
  check(r.errs.length === 0 && r.pageErrors.length === 0, 'CanvasEditor ran without errors')
}

await browser.close()
server.stop()
console.log(`\n[verify-panels] ${checks - failures}/${checks} checks passed.`)
if (failures) process.exit(1)
