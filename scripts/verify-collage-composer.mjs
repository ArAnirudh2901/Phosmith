// Collage Composer engine: photo analysis, every layout family, scoring,
// determinism, and the on-device art-direction parser/validator.
import { analyzePixels } from '../src/lib/collage/analyze.js'
import { FAMILIES, composeLayout, composeCandidates, coverWindow, focusTarget } from '../src/lib/collage/compose.js'
import { directionFromPrompt, validateDirection } from '../src/lib/collage/director.js'
import { harmonyAdjustments, synthesizePalette } from '../src/lib/collage/finish.js'

let pass = 0, fail = 0
const check = (ok, name) => { if (ok) pass += 1; else { fail += 1; console.log(`✗ ${name}`) } }

// Synthetic photo: grey field with a saturated red subject block.
const synth = (w, h, sx, sy, sw, sh) => {
    const d = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4
        const inside = x >= sx && x < sx + sw && y >= sy && y < sy + sh
        d[i] = inside ? 220 : 128; d[i + 1] = inside ? 30 : 128; d[i + 2] = inside ? 40 : 128; d[i + 3] = 255
    }
    return d
}
const a = analyzePixels(synth(160, 120, 100, 20, 40, 60), 160, 120)
check(a.focus.x > 0.55 && a.focus.y < 0.6, 'saliency focus lands on the off-centre subject')
check(a.box.x0 <= 100 / 160 + 0.05 && a.box.x1 >= 140 / 160 - 0.05, 'subject box covers the subject horizontally')
check(a.calm.area > 0.05 && a.openSide === 'left', 'calm space found on the empty side')
check(a.palette.length >= 2 && /^#[0-9a-f]{6}$/.test(a.palette[0].hex), 'palette extracted')

const photo = (aspect, cx, cy, s, weight) => ({
    aspect, box: { x0: cx - s, y0: cy - s, x1: cx + s, y1: cy + s }, focus: { x: cx, y: cy }, weight, quality: weight,
    concentration: 1 - 4 * s * s, lineAngle: 8, lineStrength: 0.4, openSide: 'right',
    calm: { x0: 0.6, y0: 0.05, x1: 0.97, y1: 0.6, area: 0.22 }, mean: { r: 0.4 + weight * 0.3, g: 0.4, b: 0.5 },
    luminance: 0.5, contrast: 0.2, colorfulness: 0.25, warmth: 0, palette: [{ hex: '#aa5544', rgb: [170, 85, 68], weight: 0.5, l: 0.4 }],
})
const set = (n) => Array.from({ length: n }, (_, i) => photo([1.5, 0.75, 1, 1.33, 0.8, 1.78][i % 6], 0.35 + (i % 3) * 0.12, 0.45, 0.14, 0.3 + (i % 4) * 0.15))
const heart = { aspect: 1.1, polygons: [Array.from({ length: 64 }, (_, i) => { const t = (i / 64) * Math.PI * 2; return { x: (16 * Math.sin(t) ** 3 + 17) / 34, y: (-(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) + 18) / 31 } })] }
const canvases = [{ width: 1600, height: 1000 }, { width: 1080, height: 1350 }, { width: 1080, height: 1080 }]

for (const fam of FAMILIES) {
    for (const n of [fam.min, Math.min(fam.max, 6), fam.max]) {
        for (const canvas of canvases) {
            const layout = composeLayout(set(n), canvas, { family: fam.id, seed: 11, container: heart })
            const okCells = layout.cells.length === n && layout.cells.every((c) => [c.x, c.y, c.w, c.h].every(Number.isFinite) && c.w > 0 && c.h > 0)
            const indices = new Set(layout.cells.map((c) => c.index))
            check(okCells && indices.size === n, `${fam.id} n=${n} ${canvas.width}x${canvas.height}: one valid cell per photo`)
            check(layout.score > 0.35 && layout.score <= 1, `${fam.id} n=${n} ${canvas.width}x${canvas.height}: score in range (${layout.score.toFixed(2)})`)
        }
    }
}
const photos6 = set(6)
const canvas = canvases[0]
check(composeLayout(photos6, canvas, { family: 'mosaic', seed: 3 }).metrics.safe > 0.9, 'mosaic keeps subjects visible')
check(JSON.stringify(composeLayout(photos6, canvas, { family: 'shards', seed: 5 }).cells) === JSON.stringify(composeLayout(photos6, canvas, { family: 'shards', seed: 5 }).cells), 'same seed ⇒ same layout')
check(JSON.stringify(composeLayout(photos6, canvas, { family: 'shards', seed: 5 }).cells) !== JSON.stringify(composeLayout(photos6, canvas, { family: 'shards', seed: 6 }).cells), 'new seed ⇒ new layout')
const tap = composeLayout(photos6, canvas, { family: 'tapestry', seed: 2 })
check(tap.cells.some((c) => c.mask && c.mask.data.length === c.mask.w * c.mask.h), 'tapestry builds seam masks')
check(tap.metrics.fill > 0.95, 'tapestry fills the canvas')
const sil = composeLayout(photos6, canvas, { family: 'silhouette', seed: 2, container: heart })
check(sil.cells.every((c) => c.pieces.length > 0), 'silhouette gives every photo a piece of the shape')
check(composeLayout(photos6, canvas, { family: 'silhouette', seed: 2 }).family === 'silhouette' && composeLayout(photos6, canvas, { family: 'silhouette', seed: 2 }).cells.every((c) => c.kind === 'rect'), 'silhouette without a shape falls back to tiling')
const prints = composeLayout(photos6, canvas, { family: 'drift', seed: 9 })
check(prints.metrics.safe > 0.8, 'prints avoid covering subjects')
const t0 = performance.now()
const cands = composeCandidates(photos6, canvas, { seed: 1 })
check(cands.length === 6 && new Set(cands.map((c) => c.family)).size >= 5, 'auto gallery is family-diverse')
check(performance.now() - t0 < 1500, 'auto gallery solves fast')
const w = coverWindow(2, 100, 100, focusTarget(photos6[0]))
check(w.vw === 0.5 && w.vh === 1 && w.x0 >= 0 && w.x1 <= 1, 'cover window clamps inside the photo')

const cases = [
    ['moody cinematic film diary, the second photo is the star, no shadows', (d) => d.finish.look === 'moody' && d.hero === 1 && d.finish.shadow === 0],
    ['polaroids scattered on kraft paper', (d) => d.family === 'drift' && d.finish.backdrop === 'paper'],
    ['spell GOA with all the photos', (d) => d.family === 'silhouette' && d.shape === 'text' && d.text === 'GOA'],
    ['shattered stained glass, not dark, icy', (d) => d.family === 'shards' && d.finish.look === 'cool'],
    ['seamless dreamy blend, photos melt together', (d) => d.family === 'tapestry'],
    ['heart shaped anniversary collage, tight with no gaps', (d) => d.shape === 'heart' && d.gutter === 0],
    ['black and white editorial grid, airy, sharp corners', (d) => d.family === 'mosaic' && d.finish.look === 'mono' && d.corner === 0 && d.margin > 0.05],
    ['our wedding pics', (d) => d.family === 'silhouette' && d.finish.look === 'soft'],
    ['something for moms birthday', (d) => d.family === 'orbit' && d.finish.look === 'vivid'],
    ['idk just make it pop', (d) => d.finish.look === 'vivid'],
    ['classy', (d) => d.family === 'mosaic' && d.margin > 0.05],
    ['goa trip dump', (d) => d.family === 'strata'],
]
for (const [prompt, ok] of cases) check(ok(directionFromPrompt(prompt, { photoCount: 6, seed: 1 })), `parser: "${prompt}"`)

const hostile = validateDirection({ family: 'nope', gutter: 99, margin: -5, corner: 'x', angle: 900, order: [9, 9, 1], hero: 42, finish: { backdrop: 'lava', colors: ['red', '#12345g', '#abcdef'], harmony: 7, look: 'evil' }, text: '<script>' }, { photoCount: 4 })
check(hostile.family === 'auto' && hostile.gutter === 0.08 && hostile.margin === 0 && hostile.angle === 35, 'validator clamps geometry')
check(hostile.order === null && hostile.hero === null && hostile.finish.backdrop === 'field' && hostile.finish.colors.length === 1 && hostile.finish.harmony === 1, 'validator clamps finish and indices')
check(hostile.text === 'SCRIPT', 'validator sanitises spelled text')
check(validateDirection({ family: 'orbit' }, { photoCount: 2 }).family === 'auto', 'families outside their photo range fall back to auto')

const adj = harmonyAdjustments([photo(1.5, 0.5, 0.5, 0.1, 0.5), { ...photo(1.5, 0.5, 0.5, 0.1, 0.5), luminance: 0.2, warmth: 0.1 }], { harmony: 1, look: 'natural' })
check(adj[1].exposure > 0 && adj[0].exposure < 0, 'harmony pulls exposures toward each other')
check(harmonyAdjustments([photo(1, 0.5, 0.5, 0.1, 0.5)], { harmony: 0, look: 'mono' })[0].saturation === -100, 'mono look desaturates')
const pal = synthesizePalette([photo(1, 0.5, 0.5, 0.1, 0.5)], { look: 'moody' })
check(pal.dark && /^#[0-9a-f]{6}$/.test(pal.base), 'moody palette goes dark')

console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
