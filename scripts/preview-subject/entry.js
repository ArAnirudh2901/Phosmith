// Browser side of scripts/preview-subject.mjs: runs the real selection entry
// points on photos and paints a contact sheet row per photo.
import { clientSamBox, clientSubjectInstances, clientSubjectMask, releaseClientModels } from '../../src/lib/client-ai.js'
import { findSubjectMatte } from '../../src/lib/stretch-auto.js'

const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src })

const tint = (ctx, mask, x, y, w, h, rgb) => {
    const t = document.createElement('canvas')
    t.width = w; t.height = h
    const tc = t.getContext('2d')
    tc.drawImage(mask, 0, 0, w, h)
    const d = tc.getImageData(0, 0, w, h)
    for (let i = 0; i < d.data.length; i += 4) {
        const a = d.data[i] / 255
        d.data[i] = rgb[0]; d.data[i + 1] = rgb[1]; d.data[i + 2] = rgb[2]; d.data[i + 3] = Math.round(a * 150)
    }
    tc.putImageData(d, 0, 0)
    ctx.drawImage(t, x, y)
}

const coverage = (mask) => {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128
    const x = c.getContext('2d'); x.drawImage(mask, 0, 0, 128, 128)
    const d = x.getImageData(0, 0, 128, 128).data
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 127) n++
    return n / (128 * 128)
}

window.__run = async ({ photos, label, withMasks = false }) => {
    const H = 200, GAP = 8, cols = 5
    const imgs = await Promise.all(photos.map((p) => load(`/photos/${p.file}`)))
    const cellW = imgs.map((im) => Math.round((im.naturalWidth * H) / im.naturalHeight))
    const width = Math.max(...cellW) * cols + GAP * (cols + 1)
    const sheet = document.createElement('canvas')
    sheet.width = width; sheet.height = 30 + photos.length * (H + 22 + GAP)
    const ctx = sheet.getContext('2d')
    ctx.fillStyle = '#141414'; ctx.fillRect(0, 0, sheet.width, sheet.height)
    ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'
    ctx.fillText(`${label} — original · Select Subject · box select (yellow box) · Detect All Subjects · Auto Stretch subject`, GAP, 20)
    const report = []
    for (const [r, p] of photos.entries()) {
        const im = imgs[r]
        const W0 = im.naturalWidth, H0 = im.naturalHeight, dims = { width: W0, height: H0 }
        const w = cellW[r], y = 30 + r * (H + 22 + GAP)
        const cell = (c) => GAP + c * (Math.max(...cellW) + GAP)
        const row = { file: p.file }
        for (let c = 0; c < cols; c++) ctx.drawImage(im, cell(c), y, w, H)
        const caption = (c, text) => { ctx.fillStyle = '#ddd'; ctx.font = '12px sans-serif'; ctx.fillText(text, cell(c), y + H + 15) }
        caption(0, p.file)
        const run = async (c, name, fn, rgb) => {
            const t0 = performance.now()
            try {
                const m = await fn()
                const ms = Math.round(performance.now() - t0)
                tint(ctx, m, cell(c), y, w, H, rgb)
                const cov = coverage(m)
                row[name] = { ms, coverage: +cov.toFixed(3) }
                if (withMasks) {
                    const c = document.createElement('canvas'); c.width = W0; c.height = H0
                    c.getContext('2d').drawImage(m, 0, 0, W0, H0)
                    row[`${name}Png`] = c.toDataURL('image/png').split(',')[1]
                }
                caption(c, `${name} ${(cov * 100).toFixed(1)}% · ${ms} ms`)
            } catch (err) {
                row[name] = { error: String(err?.message || err) }
                caption(c, `${name} failed: ${String(err?.message || err).slice(0, 40)}`)
            }
        }
        await run(1, 'subject', () => clientSubjectMask(im, dims), [0, 220, 255])
        const b = p.box
        const box = [b[0] * W0, b[1] * H0, b[2] * W0, b[3] * H0]
        await run(2, 'box', () => clientSamBox(im, box, dims), [255, 60, 200])
        ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 2
        ctx.strokeRect(cell(2) + b[0] * w, y + b[1] * H, (b[2] - b[0]) * w, (b[3] - b[1]) * H)
        await run(3, 'all', async () => {
            const res = await clientSubjectInstances(im, dims)
            if (!res.unionPng) throw new Error('nothing found')
            row.allCount = res.count
            return load(`data:image/png;base64,${res.unionPng}`)
        }, [120, 255, 80])
        // Auto Stretch's own subject search (no Gemini hint), on its ≤1024 px copy.
        await run(4, 'stretch', async () => {
            const k = Math.min(1, 1024 / Math.max(W0, H0))
            const small = document.createElement('canvas')
            small.width = Math.round(W0 * k); small.height = Math.round(H0 * k)
            small.getContext('2d').drawImage(im, 0, 0, small.width, small.height)
            const m = await findSubjectMatte(small)
            if (!m) throw new Error('no subject')
            return m
        }, [255, 160, 40])
        report.push(row)
    }
    await releaseClientModels()
    return { png: sheet.toDataURL('image/png'), report }
}
window.__ready = true
