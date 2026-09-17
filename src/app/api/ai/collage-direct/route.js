// ─── /api/ai/collage-direct ──────────────────────────────────────────────────
// Composer art director. The model sees the photo thumbnails plus the on-device
// analysis (subject boxes, calm space, lines, palette) and writes composition
// SPECS — structure family, hero, story order, spacing, finish — that the
// client's layout solvers realise. No catalogue templates: geometry is solved
// per photo set. Every spec is clamped by validateDirection; with no key or a
// model failure the route returns source "none"/"error" and the client uses the
// on-device prompt parser instead.

import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { enforceRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import {
    buildDirectorSchema,
    buildDirectorSystemPrompt,
    buildDirectorUserText,
    validateDirection,
} from '@/lib/collage/director'

export const maxDuration = 60
export const runtime = 'nodejs'

const GEMINI_MODEL = process.env.GEMINI_COLLAGE_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash'
const GEMINI_ENDPOINT = (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
const GEMINI_TIMEOUT_MS = 24_000
const MAX_IMAGE_BASE64_CHARS = 700 * 1024
const MAX_PHOTOS = 8

const num = (v, lo, hi, d = 0) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d)
const HEX = /^#[0-9a-f]{6}$/i

// Only well-formed numbers/hex reach the prompt.
const sanitizeAnalysis = (a) => ({
    aspect: num(a?.aspect, 0.1, 10, 1),
    box: { x0: num(a?.box?.x0, 0, 1), y0: num(a?.box?.y0, 0, 1), x1: num(a?.box?.x1, 0, 1, 1), y1: num(a?.box?.y1, 0, 1, 1) },
    calm: { area: num(a?.calm?.area, 0, 1) },
    openSide: a?.openSide === 'left' ? 'left' : 'right',
    lineAngle: num(a?.lineAngle, -90, 90),
    lineStrength: num(a?.lineStrength, 0, 1),
    luminance: num(a?.luminance, 0, 1, 0.5),
    quality: num(a?.quality, 0, 1, 0.5),
    palette: (Array.isArray(a?.palette) ? a.palette : []).filter((c) => HEX.test(c?.hex || '')).slice(0, 3).map((c) => ({ hex: c.hex })),
})

// Keep every complete direction from a truncated/malformed response.
const salvageDirections = (text) => {
    try { return JSON.parse(text) } catch { /* salvage below */ }
    const start = text.indexOf('"directions"')
    const arr = start >= 0 ? text.indexOf('[', start) : -1
    const directions = []
    if (arr >= 0) {
        let depth = 0, inStr = false, esc = false, objStart = -1
        for (let i = arr + 1; i < text.length; i += 1) {
            const ch = text[i]
            if (inStr) {
                if (esc) esc = false
                else if (ch === '\\') esc = true
                else if (ch === '"') inStr = false
                continue
            }
            if (ch === '"') inStr = true
            else if (ch === '{') { if (depth === 0) objStart = i; depth += 1 }
            else if (ch === '}') {
                depth -= 1
                if (depth === 0 && objStart >= 0) {
                    try { directions.push(JSON.parse(text.slice(objStart, i + 1))) } catch { /* skip broken one */ }
                    objStart = -1
                }
            } else if (ch === ']' && depth === 0) break
        }
    }
    const story = text.match(/"story"\s*:\s*"((?:[^"\\]|\\.){0,400})"/)?.[1] || ''
    if (!directions.length) throw new Error('unrecoverable JSON')
    return { story, directions }
}

const callGemini = async ({ apiKey, userText, photos, safe }) => {
    const parts = [{ text: userText }]
    photos.forEach((p, i) => {
        parts.push({ text: `Photo ${i + 1} (index ${i}):` })
        parts.push({ inlineData: { mimeType: p.mimeType, data: p.base64 } })
    })
    const generationConfig = {
        temperature: safe ? 0.4 : 0.9,
        responseMimeType: 'application/json',
        responseSchema: buildDirectorSchema(),
        maxOutputTokens: 8192,
        ...(!safe && /^gemini-3/i.test(GEMINI_MODEL) ? { thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING_LEVEL || 'low' } } : {}),
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
    try {
        const res = await fetch(`${GEMINI_ENDPOINT(GEMINI_MODEL)}?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: buildDirectorSystemPrompt() + (safe ? '\nReturn ONLY valid JSON matching the schema.' : '') }] },
                contents: [{ role: 'user', parts }],
                generationConfig,
            }),
            signal: controller.signal,
        })
        if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
        const json = await res.json()
        const text = json?.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === 'string')?.text
        if (!text) throw new Error('Gemini returned no text')
        return salvageDirections(text)
    } finally {
        clearTimeout(timeout)
    }
}

export async function POST(request) {
    try {
        const { userId } = await auth()
        if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        const limited = rateLimitResponse(await enforceRateLimit('ai-collage-direct', userId))
        if (limited) return limited

        const body = await request.json().catch(() => ({}))
        const photos = (Array.isArray(body.photos) ? body.photos : [])
            .slice(0, MAX_PHOTOS)
            .filter((p) => typeof p?.base64 === 'string' && p.base64.length <= MAX_IMAGE_BASE64_CHARS)
            .map((p) => ({ base64: p.base64, mimeType: p.mimeType === 'image/png' ? 'image/png' : 'image/jpeg' }))
        const photoCount = Math.max(2, Math.min(16, Number(body.photoCount) || photos.length))
        const analyses = (Array.isArray(body.analyses) ? body.analyses : []).slice(0, 16).map(sanitizeAnalysis)
        const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, 400) : ''
        const count = Math.max(1, Math.min(4, Number(body.count) || 3))
        // Template-first: no photos yet, but a brief to design from.
        if (photos.length < 2 && !(prompt.trim() && photoCount >= 2)) return NextResponse.json({ source: 'none', directions: [], reason: 'need photos or a brief' })

        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY
        if (!apiKey) return NextResponse.json({ source: 'none', directions: [], reason: 'no model configured' })

        const userText = buildDirectorUserText({ prompt, photoCount, canvasAspect: Number(body.canvasAspect) || 1, analyses, count })
        let raw
        try {
            raw = await callGemini({ apiKey, userText, photos, safe: false })
        } catch (first) {
            // A timeout will not get faster on retry; the client already shows on-device designs.
            if (first?.name === 'AbortError') return NextResponse.json({ source: 'error', directions: [], error: 'vision model timed out' })
            console.warn('[collage-direct] first attempt failed, retrying safe:', first?.message)
            try {
                raw = await callGemini({ apiKey, userText, photos, safe: true })
            } catch (error) {
                console.warn('[collage-direct] Gemini failed:', error?.message)
                return NextResponse.json({ source: 'error', directions: [], error: 'vision model unavailable' })
            }
        }
        const directions = (Array.isArray(raw?.directions) ? raw.directions : [])
            .slice(0, count)
            .map((d) => validateDirection(d, { photoCount }))
        return NextResponse.json({
            source: 'gemini',
            model: GEMINI_MODEL,
            story: typeof raw?.story === 'string' ? raw.story.slice(0, 400) : '',
            directions,
        })
    } catch (error) {
        console.error('[collage-direct] ✗', error?.message)
        return NextResponse.json({ error: 'Art direction failed' }, { status: 500 })
    }
}
