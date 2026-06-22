// ─── /api/ai/collage-plan ────────────────────────────────────────────────────
// Vision-driven collage TEMPLATE planner. The model SEES the photos that will go
// into the collage and proposes templates (layout + frame style + background)
// that MATCH the content — food gets warm/marble, nature gets airy botanical,
// product gets bold/minimal, and so on — instead of the old random curated set.
//
// Mirrors the production discipline of /api/ai/edit-judge:
//   1. Clerk auth + per-user rate limit.
//   2. Gemini VISION pass over the photo thumbnails with a strict response
//      schema (analysis + N template recipes), retried stricter+safe once.
//   3. validateCollagePlan clamps every field to the allowed catalog so a
//      hallucinated layout / colour can never reach the canvas.
//   4. No API key / model failure → 200 with source:"none"|"error" and empty
//      recipes, so the client falls back to its local heuristic gallery.
//
// The route is intentionally Fabric-free (it only imports the pure collage-ai
// contract) so it runs cleanly in the Node runtime.

import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { enforceRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import {
    buildCollagePlanSystemPrompt,
    buildCollagePlanUserText,
    buildCollagePlanSchema,
    validateCollagePlan,
} from '@/lib/collage-ai'

export const maxDuration = 60
export const runtime = 'nodejs'

const GEMINI_MODEL = process.env.GEMINI_COLLAGE_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash'
const GEMINI_ENDPOINT = (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
const GEMINI_TIMEOUT_MS = 22_000
const MAX_IMAGE_BASE64_CHARS = 1.2 * 1024 * 1024 // ~900KB binary per thumbnail
const MAX_PHOTOS = 6

const isGemini3Model = (model) => /^gemini-3/i.test(model || '')
const GEMINI3_THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'low'
const GEMINI3_MEDIA_RESOLUTION = process.env.GEMINI_MEDIA_RESOLUTION || 'MEDIA_RESOLUTION_HIGH'

const tuneGenerationConfig = (model, baseConfig, { safe = false } = {}) => {
    if (safe) {
        const safeConfig = { ...baseConfig }
        delete safeConfig.topP
        delete safeConfig.topK
        return safeConfig
    }
    if (!isGemini3Model(model)) return baseConfig
    return {
        ...baseConfig,
        mediaResolution: GEMINI3_MEDIA_RESOLUTION,
        thinkingConfig: { thinkingLevel: GEMINI3_THINKING_LEVEL },
    }
}

const STRICTER_RETRY_SUFFIX =
    '\n\nPrevious response was not valid JSON. YOU MUST RETURN VALID JSON matching the schema. NO COMMENTS. NO MARKDOWN FENCES. NO PROSE. Only the object.'

const callGeminiOnce = async ({ apiKey, model, systemPrompt, userText, photos, safeConfig = false }) => {
    const parts = [{ text: userText }]
    photos.forEach((p, i) => {
        parts.push({ text: `Photo ${i + 1}:` })
        parts.push({ inlineData: { mimeType: p.mimeType, data: p.base64 } })
    })

    const baseGenerationConfig = {
        // High temperature for genuinely varied, creative directions — the schema
        // + validator keep the structure safe regardless. The safe retry tones it
        // down only if the first creative pass returns malformed JSON.
        temperature: safeConfig ? 0.4 : 0.95,
        topP: 0.95,
        responseMimeType: 'application/json',
        responseSchema: buildCollagePlanSchema(),
        maxOutputTokens: 6144,
    }

    const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts }],
        generationConfig: tuneGenerationConfig(model, baseGenerationConfig, { safe: safeConfig }),
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
    try {
        const response = await fetch(`${GEMINI_ENDPOINT(model)}?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        })
        if (!response.ok) {
            const text = await response.text().catch(() => '')
            throw new Error(`Gemini ${response.status}: ${text.slice(0, 200)}`)
        }
        const json = await response.json()
        const textOut = json?.candidates?.[0]?.content?.parts?.[0]?.text
        if (!textOut) throw new Error('Gemini returned no text')
        return JSON.parse(textOut)
    } finally {
        clearTimeout(timeout)
    }
}

const callGemini = async (params) => {
    try {
        return await callGeminiOnce(params)
    } catch (firstError) {
        console.warn('[collage-plan] Gemini first attempt failed, retrying strict + safe:', firstError?.message)
        return await callGeminiOnce({
            ...params,
            systemPrompt: params.systemPrompt + STRICTER_RETRY_SUFFIX,
            safeConfig: true,
        })
    }
}

export async function POST(request) {
    try {
        const { userId } = await auth()
        if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const limited = rateLimitResponse(await enforceRateLimit('ai-collage-plan', userId))
        if (limited) return limited

        const body = await request.json().catch(() => ({}))
        const rawPhotos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : []
        const photos = rawPhotos
            .filter((p) => p && typeof p.base64 === 'string' && p.base64.length <= MAX_IMAGE_BASE64_CHARS)
            .map((p) => ({ base64: p.base64, mimeType: typeof p.mimeType === 'string' ? p.mimeType : 'image/jpeg' }))

        const photoCount = Math.max(2, Math.min(50, Number(body.photoCount) || photos.length || 2))
        const recipeCount = Math.max(2, Math.min(6, Number(body.recipeCount) || 6))
        const palette = Array.isArray(body.palette) ? body.palette.slice(0, 6) : []
        const aspects = Array.isArray(body.aspects) ? body.aspects.slice(0, MAX_PHOTOS) : []
        const canvasAspect = Number(body.canvasAspect) || null
        // Optional creative brief from the user or the in-app agent ("vintage
        // film", "editorial fashion", "cozy cafe menu") — steers every template.
        const directionHint = typeof body.directionHint === 'string' ? body.directionHint.slice(0, 160) : ''

        if (photos.length === 0) {
            return NextResponse.json({ source: 'none', recipes: [], analysis: null, reason: 'no usable photos' })
        }

        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY
        if (!apiKey) {
            return NextResponse.json({ source: 'none', recipes: [], analysis: null, reason: 'no model configured' })
        }

        let raw = null
        try {
            raw = await callGemini({
                apiKey,
                model: GEMINI_MODEL,
                systemPrompt: buildCollagePlanSystemPrompt(),
                userText: buildCollagePlanUserText({ photoCount, palette, canvasAspect, aspects, recipeCount, directionHint }),
                photos,
            })
        } catch (error) {
            console.warn('[collage-plan] Gemini failed:', error?.message || error)
            return NextResponse.json({ source: 'error', recipes: [], analysis: null, error: 'vision model unavailable' })
        }

        const { analysis, recipes } = validateCollagePlan(raw, { photoCount, maxRecipes: recipeCount })
        return NextResponse.json({ source: 'gemini', model: GEMINI_MODEL, analysis, recipes })
    } catch (error) {
        console.error('[collage-plan] ✗', error?.message)
        return NextResponse.json({ error: error?.message || 'Collage planning failed' }, { status: 500 })
    }
}
