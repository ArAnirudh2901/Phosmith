/**
 * Agent commands for Pixel Stretch.
 *
 * The panel and these commands share one engine (`src/lib/pixel-stretch.js`) and
 * one commit path (`src/lib/pixel-stretch-apply.js`), so an agent stretch is the
 * same object a hand stretch is: an independent layer above the photo, carrying
 * its params, re-editable by selecting it.
 *
 * Two families are exposed, because the reference workflow has two:
 *   ribbon   — marquee a slice, stretch it, bend it (the trend look). The warp
 *              mesh and the flow path are the two ways to bend it.
 *   scanline — threshold the frame and propagate the last surviving pixel along
 *              each row or column (the datamosh smear). No selection needed.
 */

import {
    DEFAULT_STRETCH,
    DEFAULT_SCANLINE,
    PIXEL_STRETCH_PRESETS,
    WARP_PRESETS,
    FLOW_PRESETS,
    clampStretchParams,
    applyWarpPreset,
    applyFlowPreset,
    analyzeStretchPlan,
    createFlowPathFromPoints,
    makeSampleCanvas,
    bestSeedInBand,
} from '@/lib/pixel-stretch'
import { applyStretchToCanvas, getSourceElement, isSourceReady, isStretchBlend, STRETCH_BLEND_MODES } from '@/lib/pixel-stretch-apply'

const clamp = (v, lo, hi, fallback) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return fallback
    return Math.max(lo, Math.min(hi, n))
}

const PRESET_IDS = PIXEL_STRETCH_PRESETS.map((p) => p.id)
const WARP_IDS = WARP_PRESETS.map((p) => p.id)
const FLOW_IDS = FLOW_PRESETS.map((p) => p.id)

/**
 * Where the seed slice sits. A word is easier for an agent to get right than four
 * numbers, and every word resolves to a band that actually contains pixels.
 */
const BANDS = {
    top: { x: 0.08, y: 0.06, w: 0.84, h: 0.18, axis: 'vertical', direction: 1 },
    bottom: { x: 0.08, y: 0.76, w: 0.84, h: 0.18, axis: 'vertical', direction: -1 },
    middle: { x: 0.08, y: 0.40, w: 0.84, h: 0.20, axis: 'vertical', direction: -1 },
    left: { x: 0.06, y: 0.08, w: 0.18, h: 0.84, axis: 'horizontal', direction: 1 },
    right: { x: 0.76, y: 0.08, w: 0.18, h: 0.84, axis: 'horizontal', direction: -1 },
    centre: { x: 0.40, y: 0.08, w: 0.20, h: 0.84, axis: 'horizontal', direction: 1 },
}
BANDS.center = BANDS.centre

const validBand = (b) => b
    && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(Number(b[k])))
    && Number(b.w) > 0.01 && Number(b.h) > 0.01

/**
 * Natural language → one stretch command, with no model call.
 *
 * Returns null when the sentence is not about pixel stretch, so the agent chat
 * can fall through to the edit planner exactly as it does for focus.
 */
export const parseStretchPrompt = (text) => {
    const t = String(text || '').toLowerCase().trim()
    if (!t) return null
    const has = (re) => re.test(t)
    const num = (re, fallback) => {
        const m = t.match(re)
        return m ? Number(m[1]) : fallback
    }

    const mentionsStretch = has(/\b(pixel\s*stretch|stretch|smear|streak(s|ed|ing)?|ribbon|glitch|datamosh|pixel\s*sort)\b/)
    if (!mentionsStretch) return null

    if (has(/\b(remove|clear|undo|delete|get rid of|take off)\b[^.]*\b(stretch|smear|streaks?|ribbon|glitch)\b/)) {
        return { command: 'clear', params: {} }
    }

    // The scanline family is named by its own words — the whole-frame glitch, not
    // a ribbon pulled off a slice.
    if (has(/\b(datamosh|pixel\s*sort|glitch|scan\s*line|scanline|threshold)\b/)) {
        return {
            command: 'scanline',
            params: {
                axis: has(/\b(vertical|down|up|column)\b/) ? 'vertical' : 'horizontal',
                direction: has(/\b(left|up|back(ward)?)\b/) ? -1 : 1,
                mode: has(/\b(bright|light|highlight)s?\b/) ? 'light' : 'dark',
                threshold: num(/threshold\s*(?:of|at)?\s*(\d+(?:\.\d+)?)/, null),
                fade: has(/\bfade\b/) ? 60 : 0,
            },
        }
    }

    if (has(/\b(auto|for me|figure it out|best|suggest)\b/)) return { command: 'auto', params: {} }

    const strong = has(/\b(strong|heavy|extreme|dramatic|hard|big)\b/)
    const subtle = has(/\b(subtle|slight|gentle|soft|light touch|barely)\b/)
    const gain = strong ? 1.35 : subtle ? 0.55 : 1

    const from = ['top', 'bottom', 'left', 'right', 'middle', 'centre', 'center']
        .find((w) => new RegExp(`\\b(from|off|at|along)\\s+(the\\s+)?${w}\\b`).test(t))
        || (has(/\bsubject|person|him|her|them|it\b/) && has(/\bfrom\b/) ? 'subject' : null)

    const warp = WARP_IDS.find((id) => new RegExp(`\\b${id}\\b`).test(t))
    // "ribbon" is both a flow preset and the everyday word for the effect itself
    // ("pull a ribbon off the subject"), so it only names the flow mode when the
    // sentence also asks for a path.
    const saysFlow = has(/\b(flow|path|route|weave|serpentine|wind(ing)?)\b/)
    const flow = FLOW_IDS.find((id) => (id !== 'ribbon' || saysFlow) && new RegExp(`\\b${id}\\b`).test(t))
    if (flow || saysFlow) {
        return { command: 'flow', params: { preset: flow || 'ribbon', from } }
    }
    if (warp || has(/\b(warp|arch|bend over|curl|loop)\b/)) {
        return { command: 'warp', params: { preset: warp || (has(/\bcurl\b/) ? 'swoosh' : 'arch'), amount: Math.round(100 * gain), from } }
    }

    return {
        command: 'ribbon',
        params: {
            from,
            preset: PRESET_IDS.find((id) => new RegExp(`\\b${id}\\b`).test(t)) || null,
            axis: has(/\b(horizontal|sideways|across|left|right)\b/) ? 'horizontal'
                : has(/\b(vertical|up|down)\b/) ? 'vertical' : null,
            bend: has(/\b(straight|flat)\b/) ? 0 : num(/bend\s*(-?\d+)/, Math.round(55 * gain)),
            length: num(/(?:length|long)\s*(\d+(?:\.\d+)?)/, null),
            mirror: has(/\b(mirror|symmetric|both sides)\b/),
            behind: has(/\bbehind\b/) ? 100 : (has(/\b(around|past)\s+(the\s+)?(subject|person|him|her|them)\b/) ? 70 : 0),
        },
    }
}

export function createStretchCommands({ getPrimaryImage, getCanvas } = {}) {
    const requireImage = () => {
        const image = getPrimaryImage?.()
        if (!image) throw new Error('[agent.stretch] no image on the canvas')
        const el = getSourceElement(image)
        if (!isSourceReady(el)) throw new Error('[agent.stretch] the image has no pixels yet')
        return { image, el }
    }

    const editorOf = () => {
        const canvas = getCanvas?.()
        if (!canvas) throw new Error('[agent.stretch] no canvas')
        return canvas
    }

    // One matte per image per run: `from: "subject"` and `behind` both want it.
    let matteCache = null

    /** Subject matte + bounding box in normalised coords, or null. On-device SlimSAM, as in the Mask tool. */
    const subjectBox = async (el) => {
        if (matteCache !== null) return matteCache
        const dims = { width: el.naturalWidth || el.width, height: el.naturalHeight || el.height }
        try {
            const mask = await (await import('@/lib/client-ai')).clientSubjectMask(el, dims)
            const { bboxOfMaskCanvas } = await import('@/lib/mask-service-client')
            // [x0, y0, x1, y1] in the MASK's own pixels, which need not match
            // the source's — normalise against the mask, not the photo.
            const box = mask ? bboxOfMaskCanvas(mask) : null
            if (box) {
                const mw = mask.width || dims.width
                const mh = mask.height || dims.height
                matteCache = {
                    x: box[0] / mw, y: box[1] / mh,
                    w: (box[2] - box[0] + 1) / mw, h: (box[3] - box[1] + 1) / mh,
                    side: 'client',
                    mask,
                }
                return matteCache
            }
        } catch (error) {
            console.warn('[agent.stretch] subject box failed', error)
        }
        matteCache = null
        return null
    }

    /**
     * Resolve `from` into a band + axis + direction. A named edge is exact; the
     * subject is a thin slice across its widest part, which is what makes the
     * ribbon look like it is being pulled OUT of the subject.
     */
    const resolveBand = async (el, { from, band, axis, direction }) => {
        if (validBand(band)) {
            return {
                band: { x: clamp(band.x, 0, 0.98, 0), y: clamp(band.y, 0, 0.98, 0), w: clamp(band.w, 0.02, 1, 0.3), h: clamp(band.h, 0.02, 1, 0.3) },
                axis: axis === 'horizontal' ? 'horizontal' : 'vertical',
                direction: Number(direction) < 0 ? -1 : 1,
                from: 'band',
            }
        }
        if (from === 'subject') {
            const box = await subjectBox(el)
            if (box) {
                // The ribbon has to travel through OPEN SPACE — that is what the
                // reference edits all do, and the reason is mechanical: a ribbon
                // aimed at the nearest frame edge leaves the picture in a few
                // hundred pixels, and one aimed into the subject is then knocked
                // straight back out by the "behind" matte. So the side with the
                // most room wins, and the slice is taken across the subject at
                // the edge that faces it.
                const room = [
                    { dir: 'up', room: box.y, axis: 'vertical', direction: -1 },
                    { dir: 'down', room: 1 - (box.y + box.h), axis: 'vertical', direction: 1 },
                    { dir: 'left', room: box.x, axis: 'horizontal', direction: -1 },
                    { dir: 'right', room: 1 - (box.x + box.w), axis: 'horizontal', direction: 1 },
                ].sort((a, b) => b.room - a.room)[0]
                const wantAxis = axis || room.axis
                const wantDir = direction === undefined ? room.direction : (Number(direction) < 0 ? -1 : 1)
                // A slice ACROSS the subject, hugging the edge the ribbon leaves
                // from, so the streaks read as being pulled out of it.
                const thick = 0.22
                const slice = wantAxis === 'vertical'
                    ? {
                        x: box.x, w: box.w,
                        y: wantDir < 0 ? box.y : box.y + box.h * (1 - thick),
                        h: Math.max(0.03, box.h * thick),
                    }
                    : {
                        y: box.y, h: box.h,
                        x: wantDir < 0 ? box.x : box.x + box.w * (1 - thick),
                        w: Math.max(0.03, box.w * thick),
                    }
                return {
                    band: slice,
                    axis: wantAxis,
                    direction: wantDir,
                    from: `subject (${box.side}, ${room.dir})`,
                    room: room.room,
                }
            }
        }
        const preset = BANDS[from] || BANDS.middle
        return {
            band: { x: preset.x, y: preset.y, w: preset.w, h: preset.h },
            axis: axis || preset.axis,
            direction: Number(direction) < 0 ? -1 : (direction === undefined ? preset.direction : 1),
            from: BANDS[from] ? from : 'middle',
        }
    }

    const commit = async (image, params, label, placement = {}) => {
        const canvas = editorOf()
        const result = await applyStretchToCanvas({ editor: canvas, frameObj: image, params, ...placement })
        canvas.setActiveObject?.(result.layer)
        canvas.requestRenderAll?.()
        canvas.__pushHistoryState?.({ label, domain: 'stretch' })
        canvas.__saveCanvasState?.()
        return result
    }

    /**
     * `behind` knocks the subject back out of the ribbon layer, so the streaks
     * pass BEHIND the person instead of painting over them — the layering the
     * reference edits use on every portrait.
     */
    /** White-on-black mask of the slice itself — no model, no download. */
    const selectionMatte = (resolved) => {
        const size = 1024
        const c = typeof document === 'undefined' ? null : document.createElement('canvas')
        if (!c) return null
        c.width = size
        c.height = size
        const ctx = c.getContext('2d')
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, size, size)
        ctx.fillStyle = '#fff'
        const b = resolved.band
        ctx.fillRect(b.x * size, b.y * size, b.w * size, b.h * size)
        return c
    }

    const placementFor = async (el, behind, blend, resolved, useSubject) => {
        const out = isStretchBlend(blend) ? { blend } : {}
        const cov = clamp(behind, 0, 100, 0) / 100
        if (cov <= 0) return out
        // Default: the ribbon passes behind the SLICE the user chose. Subject
        // detection is opt-in because it downloads and runs SlimSAM, which is
        // expensive on a small machine and is not what "behind" usually means.
        if (!useSubject) {
            const matte = selectionMatte(resolved)
            return matte ? { ...out, matte, coverage: cov, feather: 0.004 } : out
        }
        const box = await subjectBox(el)
        if (!box?.mask) return out
        return { ...out, matte: box.mask, coverage: cov, feather: 0.004 }
    }

    /**
     * The seed line decides everything the ribbon looks like: a line through a
     * plain red jumper can only make a plain red slab. So unless the caller names
     * a seed, the band is scanned for the line that crosses the most colour.
     */
    const seedFor = (el, resolved, seed) => {
        if (Number.isFinite(Number(seed))) return clamp(seed, 0, 100, 50) / 100
        try {
            const long = Math.min(1400, Math.max(el.naturalWidth || el.width, el.naturalHeight || el.height))
            const scale = long / Math.max(el.naturalWidth || el.width, el.naturalHeight || el.height)
            const sample = makeSampleCanvas(el, Math.round((el.naturalWidth || el.width) * scale), Math.round((el.naturalHeight || el.height) * scale))
            const best = bestSeedInBand(sample, resolved.band, resolved.axis)
            if (best) return best.seed
        } catch (error) {
            console.warn('[agent.stretch] seed scan failed', error)
        }
        return 0.5
    }

    const baseParams = (resolved, extra = {}) => clampStretchParams({
        ...DEFAULT_STRETCH,
        axis: resolved.axis,
        direction: resolved.direction,
        band: resolved.band,
        seed: 0.5,
        ...extra,
    })

    return {
        ribbon: {
            description: 'Pull a ribbon of stretched pixels out of a slice of the photo — the pixel-stretch trend look. Bend it with `bend`, taper it, fade either end.',
            params: {
                from: '"subject" (detects it), "top", "bottom", "left", "right", "middle", "centre" — or pass `band`',
                band: 'exact source slice { x, y, w, h } in 0..1 image coords',
                axis: '"vertical" (streaks run up/down) or "horizontal"',
                seed: '0..100 — which line of the slice is smeared. Omitted, the most colourful line in the slice is chosen.',
                direction: '1 or -1 — which way the streaks travel from the slice',
                preset: `one of ${PRESET_IDS.join(', ')} — applied before the individual numbers`,
                length: '1..200 — how far the ribbon runs, as a multiple of the slice. Omitted, it is sized to cross the frame.',
                bend: '-100..100 — how far it bows sideways (default 55)',
                twist: '-100..100 — the PATH shape: 0 is an arch, 100 an S-curve, -100 a hook',
                twistTurns: '0..3 — half-turns of PHYSICAL twist; the ribbon pinches and turns over',
                twistDepth: '0..100 — how far a twist closes; under 50 it pinches to a waist without flipping (default 100)',
                tipWidth: '0..1300 — how wide the far end is against the slice: 0 narrows to a point, 100 parallel, 1300 a wide fan',
                taper: '-1200..100 — the same thing inverted, if you prefer it (positive narrows)',
                fade: '0..100 — fade at the streak tips',
                fadeIn: '0..100 — fade at the slice end, so it dissolves into the photo',
                mirror: 'true for a symmetric double ribbon',
                opacity: '0..100 (default 100)',
                behind: '0..100 — how much of the SELECTED SLICE the ribbon passes behind (default 0)',
                behindSubject: 'true to detect the subject and pass behind that instead — downloads and runs SlimSAM',
                blend: `layer blend mode: ${STRETCH_BLEND_MODES.map((b) => b.id).join(', ')}`,
            },
            run: async ({ from, band, axis, direction, preset, seed, length, bend, twist, taper, fade, fadeIn, mirror, opacity, behind, blend, behindSubject, twistTurns, twistDepth, tipWidth } = {}) => {
                const { image, el } = requireImage()
                const resolved = await resolveBand(el, { from, band, axis, direction })
                const fromPreset = preset && PIXEL_STRETCH_PRESETS.find((p) => p.id === preset)?.params
                const params = baseParams(resolved, {
                    ...(fromPreset || {}),
                    seed: seedFor(el, resolved, seed),
                    // Long enough to leave the frame, barely tapered: in the
                    // reference edits the ribbon keeps its width and exits the
                    // picture rather than ending in a wedge.
                    // Long enough to cross the room it found and leave the frame.
                    // Default: cross the room it found and leave the frame. A
                    // thin slice needs a big multiple to travel any distance, so
                    // the target is expressed in FRAME terms and divided by the
                    // slice's own extent.
                    length: clamp(length, 1, 200, fromPreset?.length
                        ?? Math.min(200, Math.max(1, ((resolved.room ?? 0.5) + 0.35) / Math.max(0.02, resolved.axis === 'vertical' ? resolved.band.h : resolved.band.w)))),
                    bend: clamp(bend, -100, 100, (fromPreset?.bend ?? 0.55) * 100) / 100,
                    twist: clamp(twist, -100, 100, (fromPreset?.twist ?? 0) * 100) / 100,
                    // `tipWidth` is the panel's vocabulary and the one that can
                    // actually reach a fan: 0 narrows to a point, 100 is parallel,
                    // 1300 splays. `taper` stays accepted for direct control and
                    // now spans the engine's full range rather than -1..1.
                    taper: Number.isFinite(Number(tipWidth))
                        ? 1 - clamp(tipWidth, 0, 1300, 100) / 100
                        : clamp(taper, -1200, 100, (fromPreset?.taper ?? 0.08) * 100) / 100,
                    fade: clamp(fade, 0, 100, (fromPreset?.fade ?? 0.18) * 100) / 100,
                    fadeIn: clamp(fadeIn, 0, 100, 22) / 100,
                    twistTurns: clamp(twistTurns, 0, 3, fromPreset?.twistTurns ?? 0),
                    twistDepth: clamp(twistDepth, 0, 100, (fromPreset?.twistDepth ?? 1) * 100) / 100,
                    mirror: mirror === undefined ? !!fromPreset?.mirror : !!mirror,
                    opacity: clamp(opacity, 0, 100, 100) / 100,
                })
                const placement = await placementFor(el, behind, blend, resolved, behindSubject)
                await commit(image, params, 'Pixel stretch', placement)
                return { applied: 'ribbon', from: resolved.from, axis: params.axis, direction: params.direction, band: params.band, seed: Math.round(params.seed * 100), tipWidth: Math.round((1 - params.taper) * 100), twistTurns: params.twistTurns, behind: Math.round((placement.coverage || 0) * 100), blend: placement.blend || 'source-over' }
            },
        },

        warp: {
            description: 'Photoshop\'s stretch-then-warp: the sampled line is stretched into stripes that run off the frame edge, then bent by a look with its root pinned to the subject (rise = straight, swoosh = curl, arch, fan, wave, fold, twist).',
            params: {
                preset: `one of ${WARP_IDS.join(', ')}`,
                amount: '-200..200 — how hard the look bends (default 100); negative bends it to the other side',
                from: 'same slice words as `ribbon`',
                band: 'exact source slice { x, y, w, h }',
                behind: '0..100 — how much of the selected slice the ribbon passes behind',
                behindSubject: 'true to use subject detection instead (see `ribbon`)',
                blend: 'layer blend mode (see `ribbon`)',
            },
            run: async ({ preset = 'arch', amount = 100, from, band, axis, direction, seed, length, behind, blend, behindSubject } = {}) => {
                const { image, el } = requireImage()
                const resolved = await resolveBand(el, { from, band, axis, direction })
                const id = WARP_IDS.includes(preset) ? preset : 'arch'
                const flat = baseParams(resolved, { seed: seedFor(el, resolved, seed), length: clamp(length, 1, 200, Math.min(200, Math.max(1, 0.85 / Math.max(0.02, resolved.axis === 'vertical' ? resolved.band.h : resolved.band.w)))), taper: 0.05 })
                // Built in pixels: the frame's real aspect keeps arcs round.
                const W = el.naturalWidth || el.width || 1, H = el.naturalHeight || el.height || 1
                const { grid, rest, look } = applyWarpPreset(flat, id, clamp(amount, -200, 200, 100) / 100, W, H)
                const placement = await placementFor(el, behind, blend, resolved, behindSubject)
                await commit(image, { ...flat, warpGrid: grid, warpRest: rest, warpLook: look, warpModel: 'stretch', anchor: 'seed' }, `Pixel stretch warp (${id})`, placement)
                return { applied: 'warp', preset: id, from: resolved.from, behind: Math.round((placement.coverage || 0) * 100), blend: placement.blend || 'source-over' }
            },
        },

        flow: {
            description: 'Route the ribbon along a multi-point flow path — the most expressive bend, for ribbons that weave through the composition.',
            params: {
                preset: `one of ${FLOW_IDS.join(', ')}`,
                points: 'optional [{x,y}, …] in 0..1 image coords — an explicit path (2..24 points)',
                width: '0.05..0.6 — ribbon thickness as a fraction of the short side',
                from: 'same slice words as `ribbon`',
                behind: '0..100 — how much of the selected slice the ribbon passes behind',
                behindSubject: 'true to use subject detection instead (see `ribbon`)',
                blend: 'layer blend mode (see `ribbon`)',
            },
            run: async ({ preset = 'ribbon', points, width, from, band, axis, direction, seed, behind, blend, behindSubject } = {}) => {
                const { image, el } = requireImage()
                const resolved = await resolveBand(el, { from, band, axis, direction })
                const flat = baseParams(resolved, { seed: seedFor(el, resolved, seed), length: Math.min(200, Math.max(1, 0.9 / Math.max(0.02, resolved.axis === 'vertical' ? resolved.band.h : resolved.band.w))), taper: 0.05 })
                const usable = Array.isArray(points) && points.length >= 2
                    && points.every((p) => Number.isFinite(Number(p?.x)) && Number.isFinite(Number(p?.y)))
                const flowPath = usable
                    ? createFlowPathFromPoints(points, width ? { width: clamp(width, 0.05, 0.6, 0.18) } : {})
                    : applyFlowPreset(flat, FLOW_IDS.includes(preset) ? preset : 'ribbon')
                const placement = await placementFor(el, behind, blend, resolved, behindSubject)
                await commit(image, { ...flat, flowPath }, 'Pixel stretch flow', placement)
                return { applied: 'flow', preset: usable ? 'custom' : preset, anchors: flowPath?.anchors?.length || 0, behind: Math.round((placement.coverage || 0) * 100), blend: placement.blend || 'source-over' }
            },
        },

        scanline: {
            description: 'Threshold the whole frame and propagate each scanline\'s last surviving pixel across the pixels it removed — the datamosh smear. Needs no selection.',
            params: {
                axis: '"horizontal" (smear along rows, default) or "vertical"',
                direction: '1 or -1',
                mode: '"dark" removes the dark pixels (default), "light" removes the bright ones',
                threshold: '0..100 luma cut (default 35)',
                length: '1..100 — longest run one colour may fill, as a percent of the scanline (default 35)',
                fade: '0..100 — fade to black along a run',
                opacity: '0..100 (default 100)',
                region: 'optional { x, y, w, h } in 0..1 to limit the pass',
            },
            run: async ({ axis, direction, mode, threshold, length, fade, opacity, region } = {}) => {
                const { image } = requireImage()
                const scan = {
                    axis: axis === 'vertical' ? 'vertical' : 'horizontal',
                    direction: Number(direction) < 0 ? -1 : 1,
                    mode: mode === 'light' ? 'light' : 'dark',
                    threshold: clamp(threshold, 0, 100, DEFAULT_SCANLINE.threshold * 100) / 100,
                    length: clamp(length, 1, 100, DEFAULT_SCANLINE.length * 100) / 100,
                    fade: clamp(fade, 0, 100, 0) / 100,
                    opacity: clamp(opacity, 0, 100, 100) / 100,
                    region: validBand(region) ? region : null,
                }
                await commit(image, { ...DEFAULT_STRETCH, scan }, 'Scanline stretch')
                return { applied: 'scanline', ...scan }
            },
        },

        auto: {
            description: 'Read the photo and place the stretch itself — picks the most colourful seed line and routes the ribbon through the calmest part of the frame. No API key, no model.',
            params: {},
            run: async () => {
                const { image, el } = requireImage()
                const dims = { width: el.naturalWidth || el.width, height: el.naturalHeight || el.height }
                const long = Math.min(1200, Math.max(dims.width, dims.height))
                const scale = long / Math.max(dims.width, dims.height)
                const sample = makeSampleCanvas(el, Math.round(dims.width * scale), Math.round(dims.height * scale))
                const plan = analyzeStretchPlan(sample)
                if (!plan) throw new Error('Could not read a stretch out of this photo — set a slice by hand')
                const { region, reasoning, flowPath, flowWidth, ...rest } = plan
                // The planner hands back raw points; the engine wants a flow path
                // with tangents, the same conversion the panel does.
                const fp = Array.isArray(flowPath) && flowPath.length >= 2
                    ? createFlowPathFromPoints(flowPath, flowWidth ? { width: flowWidth } : {})
                    : null
                const params = clampStretchParams({ ...DEFAULT_STRETCH, ...rest, band: region, flowPath: fp })
                await commit(image, params, 'Auto pixel stretch')
                return { applied: 'auto', reasoning, axis: params.axis, band: params.band, anchors: fp?.anchors?.length || 0 }
            },
        },

        clear: {
            description: 'Remove every pixel-stretch layer from the canvas.',
            params: {},
            run: () => {
                const canvas = editorOf()
                const layers = (canvas.getObjects?.() || []).filter((o) => o?.data?.pixelStretch)
                layers.forEach((o) => canvas.remove(o))
                canvas.discardActiveObject?.()
                canvas.requestRenderAll?.()
                canvas.__pushHistoryState?.({ label: 'Cleared pixel stretch', domain: 'stretch' })
                canvas.__saveCanvasState?.()
                return { cleared: layers.length }
            },
        },

        fromDescription: {
            description: 'Run a pixel-stretch request written in plain English ("pull a ribbon off the subject and arch it over", "datamosh the dark areas sideways").',
            params: { prompt: 'the sentence' },
            run: async ({ prompt } = {}) => {
                const parsed = parseStretchPrompt(prompt)
                if (!parsed) throw new Error('[agent.stretch] nothing about stretching, smearing or glitching in that request')
                const commands = createStretchCommands({ getPrimaryImage, getCanvas })
                const def = commands[parsed.command]
                if (!def) throw new Error(`[agent.stretch] parsed an unknown command "${parsed.command}"`)
                const result = await def.run(parsed.params)
                return { ...result, parsed: { command: parsed.command, params: parsed.params } }
            },
        },
    }
}
