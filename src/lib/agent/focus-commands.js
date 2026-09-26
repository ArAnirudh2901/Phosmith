/**
 * Agent commands for Focus & Light — tilt-shift, depth of field, motion blur,
 * selective colour and the two shadow kinds.
 *
 * Every command builds megashader layers through the same modules the panel uses
 * (`src/lib/effects/*`), so what the agent produces is what a user would get by
 * hand: the same coverage maps, the same fallbacks, the same limits. The depth
 * resolution order is reported back in the result so the agent can tell the user
 * whether the service, the subject matte or the photo's own defocus answered.
 */

import { Shadow } from 'fabric'
import { applyMegashaderFilter } from '@/lib/megashader/apply-megashader'
import { gradientLayer, setMaskTexture } from '@/lib/megashader/mask-types'
import { buildDepthOfField, motionBlurLayer, tiltShiftLayer } from '@/lib/effects/focus'
import { buildColorPop } from '@/lib/effects/color-pop'
import { castShadowAlpha, frameShadowParams, GLOBAL_LIGHT_ANGLE } from '@/lib/effects/shadow'
import { canvasToPlane, imageToLumaPlane, matchPlane, planeToCoverageCanvas } from '@/lib/cv/plane-image'
import { refineMatte } from '@/lib/cv/guided-filter'
import { resolveOrder } from '@/lib/ai-routing'

const elementOf = (image) => image?._originalElement || image?._element || image?.getElement?.() || null

const clamp = (v, lo, hi, fallback) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return fallback
    return Math.max(lo, Math.min(hi, n))
}

const hexToUnit = (hex) => {
    const h = String(hex || '#0b0d12').replace('#', '')
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    const n = parseInt(full.slice(0, 6), 16) || 0
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

/**
 * Natural language → one focus command, with no model call.
 *
 * The agent chat routes a focus request here first: a deterministic parser is
 * cheaper and more predictable than a planner round-trip for a request as
 * concrete as "blur the background". Returns `null` when nothing recognisable is
 * there, so the caller falls through to the edit planner instead of guessing.
 */
export const parseFocusPrompt = (raw) => {
    const text = String(raw || '').toLowerCase()
    if (!text.trim()) return null

    const has = (re) => re.test(text)
    const num = (re, fallback) => {
        const m = text.match(re)
        const n = m ? Number(m[1]) : NaN
        return Number.isFinite(n) ? n : fallback
    }
    const strength = has(/\b(subtle|slight|gentle|light|a little)\b/) ? 0.55
        : has(/\b(strong|heavy|extreme|max|maximum|lots?|very|really)\b/) ? 1.7
            : 1
    const px = num(/(\d{1,3})\s*(?:px|pixels?)\b/, null)
    const degrees = num(/(\d{1,3})\s*(?:°|deg\b|degrees\b)/, null)
    const aperture = has(/\bhex(agonal|agon)?\b/) ? 'hex'
        : has(/\b(ring|donut|catadioptric|mirror lens)\b/) ? 'ring'
            : 'disc'

    // "drop" is NOT a removal verb here — "drop shadow" is the effect's name.
    if (has(/\b(remove|clear|undo|delete|get rid of|take off)\b[^.]*\b(blur|shadow|effects?|focus|pop)\b/)
        || has(/\bno (blur|shadow|effects?)\b/)) {
        return { command: 'clear', params: {}, why: 'clear every focus effect' }
    }

    if (has(/\b(cast shadow|ground shadow|shadow on the (ground|floor)|shadow behind (the )?(subject|person|product))\b/)) {
        return {
            command: 'castShadow',
            params: {
                angle: degrees ?? GLOBAL_LIGHT_ANGLE,
                length: Math.round(55 * strength),
                softness: has(/\b(hard|sharp|crisp)\b/) ? 20 : has(/\b(soft|diffuse|diffused)\b/) ? 80 : 50,
                opacity: Math.round(45 * Math.min(1.6, strength)),
            },
            why: "cast the subject's own shadow onto the ground",
        }
    }

    if (has(/\bshadow\b/)) {
        return {
            command: 'frameShadow',
            params: {
                angle: degrees ?? GLOBAL_LIGHT_ANGLE,
                distance: px ?? Math.round(18 * strength),
                size: Math.round(28 * strength),
                opacity: Math.round(38 * Math.min(1.8, strength)),
            },
            why: 'drop a shadow behind the photo',
        }
    }

    const monoWithException = has(/\b(black and white|b&w|monochrome|greyscale|grayscale|desaturate)\b/)
        && has(/\b(except|but|apart from|other than|keep|leave)\b/)
    const hex = (text.match(/#[0-9a-f]{3,6}\b/) || [])[0] || null
    const named = {
        red: '#c0392b', blue: '#2563eb', green: '#16a34a', yellow: '#eab308',
        orange: '#ea580c', purple: '#7c3aed', pink: '#ec4899',
    }
    const wordColour = Object.keys(named).find((c) => new RegExp(`\\b${c}\\b`).test(text))
    // "keep the purple, lose the rest" names no mono word but means exactly this.
    const keepOnlyColour = Boolean(hex || wordColour)
        && has(/\b(keep|only|just|leave|retain)\b/)
        && has(/\b(rest|everything else|the others?|else)\b/)
    if (has(/\b(colou?r pop|colou?r splash|selective colou?r)\b/) || monoWithException || keepOnlyColour) {
        return {
            command: 'colorPop',
            params: {
                target: hex || (wordColour ? named[wordColour] : null),
                keep: has(/\b(pure|fully|completely|dead|totally)\b/) ? 0 : 15,
                tolerance: 24,
            },
            why: hex || wordColour ? 'keep that colour and drain the rest' : 'keep the subject in colour and drain the rest',
        }
    }

    if (has(/\b(spin|rotational|whirl|swirl|twirl)\b/) && has(/\bblur\b/)) {
        return {
            command: 'motionBlur',
            params: { spin: true, blur: px ?? Math.round(40 * strength), length: 70 },
            why: 'rotational blur about the centre',
        }
    }

    if ((has(/\b(motion|speed|panning|directional|movement)\b/) && has(/\bblur\b/))
        || has(/\b(streak|sense of speed|whoosh)\b/)) {
        const angle = has(/\b(vertical|vertically|up|down)\b/) ? 90 : (degrees ?? 0)
        return {
            command: 'motionBlur',
            params: { angle, length: Math.round(60 * strength), blur: px ?? Math.round(40 * strength) },
            why: 'directional motion blur',
        }
    }

    if (has(/\b(tilt[\s-]?shift|miniature|toy town|model village|diorama|toy)\b/)) {
        return {
            command: 'tiltShift',
            params: {
                mode: has(/\b(band|strip|linear|horizontal)\b/) ? 'linear' : 'radial',
                blur: px ?? Math.round(30 * strength),
                feather: 35,
                aperture,
                miniature: has(/\b(miniature|toy|model|diorama)\b/) ? 60 : 0,
            },
            why: 'tilt-shift focus band',
        }
    }

    if (has(/\b(bokeh|depth of field|dof|portrait mode)\b/)
        || (has(/\b(blur|soften|defocus)\b/) && has(/\b(background|backdrop|behind)\b/))) {
        return {
            command: 'depthOfField',
            params: {
                blur: px ?? Math.round(36 * strength),
                aperture,
                bloom: has(/\bbokeh\b/) ? 4 : 2,
                falloff: 25,
            },
            why: 'depth of field with the subject sharp',
        }
    }

    if (has(/\b(blur|soften|defocus)\b/)) {
        return {
            command: 'tiltShift',
            params: { mode: 'radial', blur: px ?? Math.round(30 * strength), feather: 40, aperture },
            why: 'soften everything outside the centre',
        }
    }

    return null
}

/** Does this request belong to the focus domain at all? */
export const isFocusPrompt = (raw) => parseFocusPrompt(raw) !== null

export const createFocusCommands = ({ getPrimaryImage, getCanvas }) => {
    const requireImage = () => {
        const image = getPrimaryImage?.()
        if (!image) throw new Error('[agent.focus] no image on the canvas')
        const el = elementOf(image)
        if (!el) throw new Error('[agent.focus] the image has no pixels yet')
        return { image, el }
    }

    /** Append layers to whatever the Mask tool and Adjust already own. */
    const push = (image, layers, label) => {
        const mega = image.filters?.find((f) => f && f.type === 'Megashader')
        const existing = Array.isArray(mega?.stack?.chain) ? mega.stack.chain : []
        const entries = layers.map((layer, i) => ({
            op: existing.length === 0 && i === 0 ? 'replace' : 'add',
            layer,
        }))
        applyMegashaderFilter(image, { chain: [...existing, ...entries], base: mega?.stack?.base }, { globalMaskAlpha: 1 })
        const canvas = getCanvas?.()
        canvas?.requestRenderAll?.()
        canvas?.__pushHistoryState?.({ label, domain: 'focus' })
        canvas?.__saveCanvasState?.()
        return entries.map((e) => e.layer.id)
    }

    /** Subject matte, on-device first, service second — the Mask tool's order. */
    const subjectMatte = async (el) => {
        const dims = { width: el.naturalWidth || el.width, height: el.naturalHeight || el.height }
        for (const side of resolveOrder('segment')) {
            try {
                if (side === 'client') {
                    const { clientSubjectMask } = await import('@/lib/client-ai')
                    const mask = await clientSubjectMask(el, dims)
                    if (mask) return { mask, side }
                } else {
                    const { serviceSubjectMask } = await import('@/lib/mask-service-client')
                    const mask = await serviceSubjectMask(el, dims)
                    if (mask) return { mask, side }
                }
            } catch (error) {
                console.warn('[agent.focus] subject mask failed on', side, error)
            }
        }
        return { mask: null, side: null }
    }

    const serviceDepth = async (el) => {
        try {
            const { checkMaskService, serviceDepthMap } = await import('@/lib/mask-service-client')
            const health = await checkMaskService()
            if (!health?.ok) return null
            return await serviceDepthMap(el)
        } catch {
            return null
        }
    }

    return {
        tiltShift: {
            description: 'Blur everything outside a focus band or ellipse — the tilt-shift / miniature look.',
            params: {
                mode: '"radial" (default) or "linear"',
                blur: 'blur radius in source px at full coverage (default 30)',
                feather: '0..100 — how gradually the blur comes in (default 35)',
                aperture: '"disc" (default), "hex" or "ring"',
                bloom: '0..8 — how much bright highlights bloom into the blur (default 2)',
                miniature: '0..100 — extra contrast/saturation for the toy-model read (default 0)',
            },
            run: ({ mode = 'radial', blur = 30, feather = 35, aperture = 'disc', bloom = 2, miniature = 0 } = {}) => {
                const { image, el } = requireImage()
                // Report what was USED, not what was asked for — a result that
                // echoes an unusable input back at the agent is a lie.
                const resolvedMode = mode === 'linear' ? 'linear' : 'radial'
                const layer = tiltShiftLayer({
                    mode: resolvedMode,
                    imageSize: { width: el.naturalWidth || el.width, height: el.naturalHeight || el.height },
                    radius: Math.max(0.05, 0.45 - clamp(feather, 2, 100, 35) / 400),
                    feather: Math.max(0.02, clamp(feather, 2, 100, 35) / 100),
                    blurPx: clamp(blur, 0, 200, 30),
                    shape: ['disc', 'hex', 'ring'].includes(aperture) ? aperture : 'disc',
                    highlightGain: clamp(bloom, 0, 8, 2),
                    miniature: clamp(miniature, 0, 100, 0),
                })
                const ids = push(image, [layer], 'Tilt-shift')
                return { applied: 'tiltShift', mode: resolvedMode, layerIds: ids }
            },
        },

        depthOfField: {
            description: 'Portrait-style depth of field: keep the subject sharp, blur the background by distance. Uses the depth service when it is running, else the on-device subject matte, else the photo\'s own defocus — no extra model is downloaded.',
            params: {
                blur: 'blur radius in source px at full coverage (default 36)',
                focus: '0..100 — which depth plane stays sharp (depth source only, default 50)',
                falloff: '0..100 — how far from the subject the blur reaches (default 25)',
                aperture: '"disc" (default), "hex" or "ring"',
                bloom: '0..8 — highlight bloom (default 2)',
            },
            run: async ({ blur = 36, focus = 50, falloff = 25, aperture = 'disc', bloom = 2 } = {}) => {
                const { image, el } = requireImage()
                const depthCanvas = await serviceDepth(el)
                const { mask: matteCanvas, side } = depthCanvas ? { mask: null, side: null } : await subjectMatte(el)
                const { layer, source, coverage } = buildDepthOfField(el, {
                    depthCanvas,
                    matteCanvas,
                    focus: clamp(focus, 0, 100, 50) / 100,
                    blurPx: clamp(blur, 0, 200, 36),
                    shape: ['disc', 'hex', 'ring'].includes(aperture) ? aperture : 'disc',
                    highlightGain: clamp(bloom, 0, 8, 2),
                    reach: Math.max(0.05, clamp(falloff, 2, 100, 25) / 100),
                })
                const ids = push(image, [layer], 'Depth of field')
                return { applied: 'depthOfField', source, matteSide: side, estimateCoverage: coverage, layerIds: ids }
            },
        },

        motionBlur: {
            description: 'Directional or rotational blur over the whole frame.',
            params: {
                angle: 'degrees, 0 = horizontal (default 0)',
                length: '0..100 — how far the streak runs (default 60)',
                blur: 'blur radius in source px (default 40)',
                spin: 'true for rotational blur about the centre (default false)',
            },
            run: ({ angle = 0, length = 60, blur = 40, spin = false } = {}) => {
                const { image } = requireImage()
                const layer = motionBlurLayer({
                    angle: (clamp(angle, -360, 360, 0) * Math.PI) / 180,
                    length: clamp(length, 1, 100, 60) / 100,
                    blurPx: clamp(blur, 0, 200, 40),
                    spin: spin === true,
                })
                const ids = push(image, [layer], spin ? 'Spin blur' : 'Motion blur')
                return { applied: 'motionBlur', spin: spin === true, layerIds: ids }
            },
        },

        colorPop: {
            description: 'Keep the subject (or one picked colour) in colour and drain the rest toward monochrome.',
            params: {
                target: 'hex colour to keep (omit to keep the detected subject instead)',
                tolerance: '0..100 — how close a colour must be to count (colour mode, default 12)',
                keep: '0..60 — saturation left in the surround; a dead grey reads worse (default 15)',
                softness: '0..60 — edge feather (default 15)',
            },
            run: async ({ target = null, tolerance = 12, keep = 15, softness = 15 } = {}) => {
                const { image, el } = requireImage()
                let matteCanvas = null
                let side = null
                if (!target) {
                    const found = await subjectMatte(el)
                    matteCanvas = found.mask
                    side = found.side
                    if (!matteCanvas) throw new Error('[agent.focus] no subject found — pass a target colour instead')
                }
                const { layer, mode, keptFraction } = buildColorPop({
                    imageEl: el,
                    matteCanvas,
                    target: target ? hexToUnit(target) : null,
                    tolerance: clamp(tolerance, 1, 100, 12) / 100,
                    keep: clamp(keep, 0, 60, 15),
                    feather: clamp(softness, 0, 60, 15) / 100,
                })
                const ids = push(image, [layer], 'Colour pop')
                return { applied: 'colorPop', mode, matteSide: side, keptFraction, layerIds: ids }
            },
        },

        frameShadow: {
            description: 'A drop shadow behind the whole photo, with Photoshop\'s parameters.',
            params: {
                angle: 'light direction in degrees (default 120 — the global light)',
                distance: 'px the shadow falls (default 18)',
                size: 'px of softness (default 28)',
                spread: '0..100 — how hard the shadow\'s core is (default 10)',
                opacity: '0..100 (default 38)',
                color: 'hex (default #0b0d12)',
            },
            run: ({ angle = GLOBAL_LIGHT_ANGLE, distance = 18, size = 28, spread = 10, opacity = 38, color = '#0b0d12' } = {}) => {
                const { image } = requireImage()
                const params = frameShadowParams({
                    angle: clamp(angle, 0, 360, GLOBAL_LIGHT_ANGLE),
                    distance: clamp(distance, 0, 200, 18),
                    size: clamp(size, 0, 200, 28),
                    spread: clamp(spread, 0, 100, 10) / 100,
                    opacity: clamp(opacity, 0, 100, 38) / 100,
                    color,
                })
                image.set({ shadow: new Shadow({ color: params.color, blur: params.blur, offsetX: params.offsetX, offsetY: params.offsetY }) })
                const canvas = getCanvas?.()
                canvas?.requestRenderAll?.()
                canvas?.__pushHistoryState?.({ label: 'Frame shadow', domain: 'focus' })
                canvas?.__saveCanvasState?.()
                return { applied: 'frameShadow', offsetX: params.offsetX, offsetY: params.offsetY, blur: params.blur }
            },
        },

        castShadow: {
            description: 'A shadow in the SUBJECT\'S shape, projected onto the ground plane and softening with distance. Needs room beside the subject; refuses on a crop that has none.',
            params: {
                angle: 'light direction in degrees (default 120)',
                length: '10..150 — how far the shadow stretches (default 55)',
                softness: '0..100 (default 50)',
                opacity: '0..100 (default 45)',
                color: 'hex (default #0b0d12)',
            },
            run: async ({ angle = GLOBAL_LIGHT_ANGLE, length = 55, softness = 50, opacity = 45, color = '#0b0d12' } = {}) => {
                const { image, el } = requireImage()
                const { mask: matteCanvas, side } = await subjectMatte(el)
                if (!matteCanvas) throw new Error('[agent.focus] a cast shadow needs a subject — none was found')
                const guide = imageToLumaPlane(el)
                const raw = matchPlane(canvasToPlane(matteCanvas, 'luma'), guide.width, guide.height)
                const matte = refineMatte(raw, guide, { radius: 6, eps: 1e-3, subsample: 2 })
                const { alpha } = castShadowAlpha(matte, {
                    angle: clamp(angle, 0, 360, GLOBAL_LIGHT_ANGLE),
                    length: clamp(length, 10, 150, 55) / 100,
                    softness: clamp(softness, 0, 100, 50) / 100,
                    opacity: clamp(opacity, 0, 100, 45) / 100,
                })
                let visible = 0
                let total = 0
                for (let i = 0; i < alpha.data.length; i += 1) {
                    if (alpha.data[i] <= 0.02) continue
                    total += 1
                    if (matte.data[i] < 0.5) visible += 1
                }
                if (total === 0 || visible / total < 0.15) {
                    throw new Error('[agent.focus] the shadow would fall entirely behind the subject — this crop has no ground beside it, use frameShadow')
                }
                const key = `cast-${Date.now().toString(36)}`
                setMaskTexture(key, planeToCoverageCanvas(alpha))
                const ids = push(image, [{
                    ...gradientLayer({ gradientMapKey: key, low: 0, high: 1 }),
                    label: 'Cast shadow',
                    fillMode: 'fill',
                    fillColor: hexToUnit(color),
                    fillStrength: 1,
                }], 'Cast shadow')
                return { applied: 'castShadow', matteSide: side, groundFraction: visible / Math.max(1, total), layerIds: ids }
            },
        },

        fromDescription: {
            description: 'Apply a focus / blur / colour-pop / shadow effect described in plain language ("blur the background", "tilt-shift miniature", "keep the red and make the rest black and white", "soft drop shadow at 45 degrees").',
            params: { prompt: 'the request, in the user\'s own words' },
            run: async ({ prompt } = {}) => {
                const parsed = parseFocusPrompt(prompt)
                if (!parsed) throw new Error('[agent.focus] nothing about focus, blur, colour pop or shadows in that request')
                const commands = createFocusCommands({ getPrimaryImage, getCanvas })
                const def = commands[parsed.command]
                if (!def) throw new Error(`[agent.focus] parsed an unknown command "${parsed.command}"`)
                const result = await def.run(parsed.params)
                return { ...result, parsed: { command: parsed.command, params: parsed.params, why: parsed.why } }
            },
        },

        clear: {
            description: 'Remove every Focus & Light effect from the image (layers and the frame shadow).',
            params: {},
            run: () => {
                const { image } = requireImage()
                applyMegashaderFilter(image, { chain: [] }, {})
                image.set({ shadow: null })
                const canvas = getCanvas?.()
                canvas?.getObjects?.().filter((o) => o.phosmithCastShadow).forEach((o) => canvas.remove(o))
                canvas?.requestRenderAll?.()
                canvas?.__pushHistoryState?.({ label: 'Cleared focus effects', domain: 'focus' })
                canvas?.__saveCanvasState?.()
                return { cleared: true }
            },
        },
    }
}
