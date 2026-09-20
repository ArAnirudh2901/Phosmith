#!/usr/bin/env node
/**
 * Invariants for the analysis-driven auto-crop engine (src/lib/auto-crop-core.js)
 * and the vision contract (src/lib/crop-analysis.js). Pure — no browser, no
 * services, no SAM: subject edges come from a matte, composition from the analysis.
 *
 * Usage: bun scripts/verify-crop-compose.mjs
 */

import {
    composeAnalyzedCrop,
    computeContentFillCrop,
    computeDepthCrop,
    detectHorizon,
    heuristicCropAnalysis,
    mirrorSymmetry,
    refineBoxWithMatte,
    recommendCrop,
} from '../src/lib/auto-crop-core.js'
import { aspectFromChoice, normalizeBox2d, validateCropAnalysis } from '../src/lib/crop-analysis.js'

let failures = 0
const check = (label, cond, detail = '') => {
    if (cond) console.log(`[verify-crop-compose] ok ${label}`)
    else { failures += 1; console.error(`[verify-crop-compose] ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol
const inside = (outer, box, margin = 0) => {
    const [x, y, w, h] = outer
    return box.x0 >= x - margin && box.y0 >= y - margin && box.x1 <= x + w + margin && box.y1 <= y + h + margin
}
const px = (b, W, H) => ({ x0: b.x0 * W, y0: b.y0 * H, x1: b.x1 * W, y1: b.y1 * H })

const W = 4000, H = 3000
const baseAnalysis = (over = {}) => ({
    scene: 'portrait',
    hasDistinctSubject: true,
    subjects: [{ label: 'person', box: { x0: 0.18, y0: 0.22, x1: 0.42, y1: 0.95 }, importance: 1, facing: 'right' }],
    mustKeep: [],
    eyeLine: 0.3,
    horizon: null,
    emphasis: 'none',
    symmetric: false,
    symmetryAxis: null,
    clutterEdges: [],
    suggestedAspect: 'original',
    intent: 'keep the subject on the left third',
    ...over,
})

// ── portrait: lead room + eye line ─────────────────────────────────────────
{
    const a = baseAnalysis()
    const r = composeAnalyzedCrop({ W, H, aspect: 0.8, analysis: a, source: 'gemini' })
    check('portrait crop is produced', Boolean(r?.box), JSON.stringify(r))
    const [x, y, w, h] = r.box
    check('crop honours the 4:5 ratio', near(w / h, 0.8, 0.01), `${(w / h).toFixed(3)}`)
    check('crop stays inside the image', x >= 0 && y >= 0 && x + w <= W && y + h <= H)
    check('box values are integers', [x, y, w, h].every(Number.isInteger))
    const subj = px(a.subjects[0].box, W, H)
    check('the whole subject is inside the crop', inside(r.box, subj, 1))
    const subjCx = (subj.x0 + subj.x1) / 2
    check('facing right leaves room on the right', subjCx < x + w / 2, `subject ${subjCx.toFixed(0)} vs crop centre ${(x + w / 2).toFixed(0)}`)
    check('eyes land near the upper third', near((a.eyeLine * H - y) / h, 1 / 3, 0.05), `${((a.eyeLine * H - y) / h).toFixed(3)}`)
    check('rationale explains the composition', /eyes on the upper third/.test(r.rationale) && /room on the side/.test(r.rationale), r.rationale)

    const mirrored = composeAnalyzedCrop({
        W, H, aspect: 0.8, source: 'gemini',
        analysis: baseAnalysis({ subjects: [{ label: 'person', box: { x0: 0.58, y0: 0.22, x1: 0.82, y1: 0.95 }, importance: 1, facing: 'left' }] }),
    })
    const m = mirrored.box
    const msubj = px({ x0: 0.58, y0: 0.22, x1: 0.82, y1: 0.95 }, W, H)
    check('facing left leaves room on the left', (msubj.x0 + msubj.x1) / 2 > m[0] + m[2] / 2)
    check('mirrored subject is kept whole', inside(m, msubj, 1))
}

// ── determinism ────────────────────────────────────────────────────────────
{
    const a = baseAnalysis()
    const one = composeAnalyzedCrop({ W, H, aspect: 1, analysis: a, source: 'gemini' })
    const two = composeAnalyzedCrop({ W, H, aspect: 1, analysis: a, source: 'gemini' })
    check('same inputs give the same crop', JSON.stringify(one.box) === JSON.stringify(two.box))
}

// ── group: every face survives, or the trim is balanced ────────────────────
{
    const faces = [
        { label: 'face', box: { x0: 0.06, y0: 0.3, x1: 0.16, y1: 0.45 } },
        { label: 'face', box: { x0: 0.45, y0: 0.28, x1: 0.55, y1: 0.43 } },
        { label: 'face', box: { x0: 0.84, y0: 0.31, x1: 0.94, y1: 0.46 } },
    ]
    const a = baseAnalysis({
        scene: 'group',
        subjects: [
            { label: 'people', box: { x0: 0.05, y0: 0.27, x1: 0.95, y1: 0.98 }, importance: 1, facing: 'camera' },
        ],
        mustKeep: faces,
        eyeLine: 0.36,
    })
    const wide = composeAnalyzedCrop({ W, H, aspect: 16 / 9, analysis: a, source: 'gemini' })
    check('group at 16:9 keeps every face', faces.every((f) => inside(wide.box, px(f.box, W, H), 1)), JSON.stringify(wide.box))
    const square = composeAnalyzedCrop({ W, H, aspect: 1, analysis: a, source: 'gemini' })
    const keepCx = (px(faces[0].box, W, H).x0 + px(faces[2].box, W, H).x1) / 2
    check('a square that cannot hold the group trims symmetrically',
        square.compromised === true && near(square.box[0] + square.box[2] / 2, keepCx, 0.02 * W),
        `${JSON.stringify(square.box)} compromised=${square.compromised}`)
    check('balanced-trim rationale is stated', /balanced/.test(square.rationale), square.rationale)
}

// ── scene: horizon on a third, max-area box ───────────────────────────────
{
    const a = baseAnalysis({ scene: 'landscape', hasDistinctSubject: false, subjects: [], eyeLine: null, horizon: 0.62, emphasis: 'sky' })
    const r = composeAnalyzedCrop({ W, H, aspect: 16 / 9, analysis: a, source: 'gemini' })
    const [x, y, w, h] = r.box
    check('scene crop is the max-area ratio fit', near(w, W, 2) && near(h, W / (16 / 9), 2), JSON.stringify(r.box))
    check('dramatic sky puts the horizon on the lower third', near((0.62 * H - y) / h, 2 / 3, 0.06), `${((0.62 * H - y) / h).toFixed(3)}`)
    check('scene rationale mentions the horizon', /horizon on the lower third/.test(r.rationale), r.rationale)
    // 0.45 keeps the upper-third placement reachable inside a 16:9 frame.
    const ground = composeAnalyzedCrop({ W, H, aspect: 16 / 9, analysis: { ...a, horizon: 0.45, emphasis: 'ground' }, source: 'gemini' })
    check('interesting foreground puts the horizon on the upper third',
        near((0.45 * H - ground.box[1]) / ground.box[3], 1 / 3, 0.06), `${((0.45 * H - ground.box[1]) / ground.box[3]).toFixed(3)}`)
}

// ── symmetry and clutter ──────────────────────────────────────────────────
{
    const a = baseAnalysis({ scene: 'architecture', symmetric: true, symmetryAxis: 0.42, eyeLine: null, subjects: [{ label: 'facade', box: { x0: 0.1, y0: 0.1, x1: 0.8, y1: 0.9 }, importance: 1, facing: 'none' }] })
    const r = composeAnalyzedCrop({ W, H, aspect: 1, analysis: a, source: 'gemini' })
    check('symmetric shots centre on the symmetry axis', near(r.box[0] + r.box[2] / 2, 0.42 * W, 0.06 * W), JSON.stringify(r.box))

    const plain = composeAnalyzedCrop({ W, H, aspect: 1, analysis: baseAnalysis(), source: 'gemini' })
    const cluttered = composeAnalyzedCrop({ W, H, aspect: 1, analysis: baseAnalysis({ clutterEdges: ['left'] }), source: 'gemini' })
    check('a cluttered left edge shifts the crop right', cluttered.box[0] >= plain.box[0])
    check('trimmed edge is reported', /distracting left edge/.test(cluttered.rationale), cluttered.rationale)
}

// ── never zoom into a fragment ────────────────────────────────────────────
{
    const a = baseAnalysis({ scene: 'animal', eyeLine: null, subjects: [{ label: 'bird', box: { x0: 0.46, y0: 0.47, x1: 0.53, y1: 0.54 }, importance: 1, facing: 'none' }] })
    const r = composeAnalyzedCrop({ W, H, aspect: W / H, analysis: a, source: 'gemini' })
    check('a tiny subject still yields a usable crop size', (r.box[2] * r.box[3]) / (W * H) >= 0.27, `${((r.box[2] * r.box[3]) / (W * H)).toFixed(3)}`)
}

// ── matte refinement ──────────────────────────────────────────────────────
{
    const w = 200, h = 200
    const mask = new Uint8Array(w * h)
    for (let y = 60; y < 140; y += 1) mask.fill(255, y * w + 60, y * w + 140)
    const loose = { x0: 40, y0: 40, x1: 160, y1: 160 }
    const tightened = refineBoxWithMatte(loose, mask, w, h)
    check('a loose model box is tightened toward the matte', tightened.x0 > loose.x0 && tightened.x1 < loose.x1)
    check('tightening is capped at 15% per side', tightened.x0 <= loose.x0 + 0.15 * 120 + 0.01)
    const clipped = { x0: 80, y0: 80, x1: 120, y1: 120 }
    const grown = refineBoxWithMatte(clipped, mask, w, h)
    check('a clipped model box grows to the matte edges', grown.x0 < clipped.x0 && grown.x1 > clipped.x1)
    const wrongMatte = new Uint8Array(w * h)
    wrongMatte.fill(255, 0, 5 * w)
    const kept = refineBoxWithMatte(loose, wrongMatte, w, h)
    check('an unrelated matte is ignored', JSON.stringify(kept) === JSON.stringify(loose))
    check('no matte leaves the box untouched', JSON.stringify(refineBoxWithMatte(loose, null, w, h)) === JSON.stringify(loose))
}

// ── horizon / symmetry detectors ──────────────────────────────────────────
{
    const w = 120, h = 90
    const sky = new Uint8Array(w * h)
    for (let y = 0; y < h; y += 1) sky.fill(y < h * 0.5 ? 210 : 70, y * w, y * w + w)
    check('a sky/ground split is detected as a horizon', near(detectHorizon(sky, w, h) ?? -1, 0.5, 0.05), String(detectHorizon(sky, w, h)))
    const noise = new Uint8Array(w * h)
    let seed = 7
    for (let i = 0; i < noise.length; i += 1) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise[i] = seed % 256 }
    check('noise has no horizon', detectHorizon(noise, w, h) === null)
    const mirroredImg = new Uint8Array(w * h)
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) mirroredImg[y * w + x] = Math.round(255 * Math.abs(0.5 - x / w) * 2)
    check('a mirrored frame scores symmetric', mirrorSymmetry(mirroredImg, w, h) >= 0.8, String(mirrorSymmetry(mirroredImg, w, h)))
    check('noise does not score symmetric', mirrorSymmetry(noise, w, h) < 0.8)
}

// ── heuristic analysis (no vision model) ──────────────────────────────────
{
    const w = 200, h = 150
    const compact = new Uint8Array(w * h)
    for (let y = 40; y < 110; y += 1) compact.fill(255, y * w + 20, y * w + 70)
    const a = heuristicCropAnalysis({ W: w, H: h, mask: compact })
    check('a compact matte is treated as a distinct subject', a.hasDistinctSubject && a.subjects.length === 1)
    check('a left-placed subject is assumed to face right', a.subjects[0].facing === 'right', a.subjects[0].facing)
    const sprawl = new Uint8Array(w * h).fill(255)
    const scene = heuristicCropAnalysis({ W: w, H: h, mask: sprawl })
    check('a frame-filling matte falls back to a scene', scene.hasDistinctSubject === false && scene.scene === 'landscape')
    const composed = composeAnalyzedCrop({ W: w, H: h, aspect: 1, analysis: a, mask: compact, source: 'device' })
    check('the heuristic analysis still composes a crop', Boolean(composed?.box) && composed.analysis_source === 'device')
    check('heuristic crops score below vision crops',
        composed.score < composeAnalyzedCrop({ W: w, H: h, aspect: 1, analysis: a, mask: compact, source: 'gemini' }).score)
}

// ── vision contract validation ────────────────────────────────────────────
{
    const hostile = validateCropAnalysis({
        scene: 'spaceship',
        has_distinct_subject: 'yes',
        subjects: [
            { label: 'x'.repeat(200), box_2d: [900, 800, 100, 200], importance: 5, facing: 'sideways' },
            { label: 'tiny', box_2d: [10, 10, 12, 12], importance: 0.9, facing: 'left' },
            { box_2d: 'nope' },
            ...Array.from({ length: 20 }, () => ({ label: 'extra', box_2d: [0, 0, 500, 500], importance: 0.4, facing: 'none' })),
        ],
        must_keep: [{ label: 'face', box_2d: [100, 100, 300, 300] }, { label: 'bad', box_2d: [1, 2] }],
        eye_line: 4000,
        horizon: -1,
        emphasis: 'clouds',
        symmetric: 'true',
        symmetry_axis: 500,
        clutter_edges: ['left', 'left', 'diagonal'],
        suggested_aspect: '7:3',
        intent: 'y'.repeat(500),
    })
    check('unknown scene falls back to other', hostile.scene === 'other')
    check('reversed boxes are normalised', hostile.subjects[0].box.x0 < hostile.subjects[0].box.x1 && hostile.subjects[0].box.y0 < hostile.subjects[0].box.y1)
    check('importance is clamped to 0..1', hostile.subjects.every((s) => s.importance >= 0 && s.importance <= 1))
    check('unknown facing falls back to none', hostile.subjects[0].facing === 'none')
    check('subjects are capped at 6', hostile.subjects.length <= 6)
    check('subjects are sorted by importance', hostile.subjects[0].importance >= hostile.subjects[hostile.subjects.length - 1].importance)
    check('malformed boxes are dropped', hostile.mustKeep.length === 1)
    check('out-of-range eye line becomes absent', hostile.eyeLine === null)
    check('-1 horizon becomes absent', hostile.horizon === null)
    check('unknown emphasis falls back to none', hostile.emphasis === 'none')
    check('non-boolean symmetric is false', hostile.symmetric === false)
    check('clutter edges are deduped and filtered', JSON.stringify(hostile.clutterEdges) === '["left"]')
    check('unknown aspect choice falls back to original', hostile.suggestedAspect === 'original')
    check('intent is truncated', hostile.intent.length <= 160)
    check('empty input is survivable', validateCropAnalysis(null).subjects.length === 0)
    check('degenerate boxes are rejected', normalizeBox2d([500, 500, 501, 501]) === null)
    check('aspect choice parses', near(aspectFromChoice('4:5', 100, 100), 0.8, 1e-9) && near(aspectFromChoice('original', 200, 100), 2, 1e-9))
}

// ── the geometric strategies still hold ───────────────────────────────────
{
    const w = 200, h = 200
    const rgba = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i += 1) { rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255 }
    for (let y = 50; y < 150; y += 1) {
        for (let x = 40; x < 160; x += 1) {
            const i = (y * w + x) * 4
            rgba[i] = 20; rgba[i + 1] = 30; rgba[i + 2] = 40
        }
    }
    const content = computeContentFillCrop(rgba, w, h, {})
    check('content-fill trims a white mat', content && near(content.box[0], 40, 3) && near(content.box[2], 120, 4), JSON.stringify(content?.box))

    // Gradient depth (white = near at the bottom); a two-value map has a degenerate quantile.
    const depth = new Uint8Array(w * h)
    for (let y = 0; y < h; y += 1) depth.fill(Math.round((y / (h - 1)) * 255), y * w, y * w + w)
    const dc = computeDepthCrop(depth, w, h, {})
    check('depth crop follows the near band', dc && dc.box[1] > 60 && dc.box[1] + dc.box[3] >= h - 1, JSON.stringify(dc?.box))
    check('recommend picks the highest score', recommendCrop({ subject: { score: 0.9 }, content: { score: 0.4 } }) === 'subject')
    check('recommend ignores missing strategies', recommendCrop({ subject: null, content: { score: 0.4 } }) === 'content')
}

if (failures > 0) {
    console.error(`\n[verify-crop-compose] ✗ ${failures} check(s) failed`)
    process.exit(1)
}
console.log('\n[verify-crop-compose] ✓ all checks passed')
