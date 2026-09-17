// Vision pass for subject-aware crop: Gemini reads the photo (scene, subjects,
// facing, eye line, horizon, must-keep details) and the client composes the crop.
// No segmentation service or SAM: subject edges come from the on-device matte.
// Without a key or on model failure the route returns source "none"/"error" and
// the client falls back to on-device saliency analysis.

import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { enforceRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import {
    buildCropAnalysisSchema,
    buildCropAnalysisSystemPrompt,
    buildCropAnalysisUserText,
    validateCropAnalysis,
} from '@/lib/crop-analysis'

export const maxDuration = 30
export const runtime = 'nodejs'

const GEMINI_MODEL = process.env.GEMINI_CROP_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash'
const GEMINI_ENDPOINT = (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
const GEMINI_TIMEOUT_MS = 20_000
const MAX_IMAGE_BASE64_CHARS = 700 * 1024

const callGemini = async ({ apiKey, image, userText, signal }) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
        const res = await fetch(`${GEMINI_ENDPOINT(GEMINI_MODEL)}?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: buildCropAnalysisSystemPrompt() }] },
                contents: [{ role: 'user', parts: [{ text: userText }, { inlineData: { mimeType: image.mimeType, data: image.base64 } }] }],
                generationConfig: {
                    // Boxes must be repeatable, not creative.
                    temperature: 0,
                    responseMimeType: 'application/json',
                    responseSchema: buildCropAnalysisSchema(),
                    maxOutputTokens: 2048,
                    ...(/^gemini-3/i.test(GEMINI_MODEL) ? { thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING_LEVEL || 'low' } } : {}),
                },
            }),
            signal: controller.signal,
        })
        if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
        const json = await res.json()
        const text = json?.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === 'string' && !p.thought)?.text
        if (!text) throw new Error('Gemini returned no text')
        return JSON.parse(text)
    } finally {
        clearTimeout(timeout)
        signal?.removeEventListener?.('abort', onAbort)
    }
}

export async function POST(request) {
    try {
        const { userId } = await auth()
        if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        const limited = rateLimitResponse(await enforceRateLimit('ai-crop-analyze', userId))
        if (limited) return limited

        const body = await request.json().catch(() => ({}))
        const base64 = typeof body.image?.base64 === 'string' ? body.image.base64 : ''
        if (!base64 || base64.length > MAX_IMAGE_BASE64_CHARS) {
            return NextResponse.json({ error: 'image (base64 JPEG/PNG, ≤700 KB) is required' }, { status: 400 })
        }
        const width = Number(body.width) || 0
        const height = Number(body.height) || 0
        if (width < 16 || height < 16) return NextResponse.json({ error: 'width and height are required' }, { status: 400 })

        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY
        if (!apiKey) return NextResponse.json({ source: 'none', reason: 'no model configured' })

        const image = { base64, mimeType: body.image.mimeType === 'image/png' ? 'image/png' : 'image/jpeg' }
        const aspect = Number(body.aspect) > 0 ? Number(body.aspect) : null
        const userText = buildCropAnalysisUserText({ width, height, aspect })
        let raw
        try {
            raw = await callGemini({ apiKey, image, userText, signal: request.signal })
        } catch (first) {
            // Timeouts and quota/auth errors won't clear on an immediate retry.
            if (first?.name === 'AbortError') return NextResponse.json({ source: 'error', error: 'vision model timed out' })
            if (/Gemini (401|403|429)/.test(first?.message || '')) return NextResponse.json({ source: 'error', error: 'vision model unavailable', detail: String(first?.message || '').slice(0, 160) })
            console.warn('[crop-analyze] first attempt failed, retrying:', first?.message)
            try {
                raw = await callGemini({ apiKey, image, userText, signal: request.signal })
            } catch (error) {
                console.warn('[crop-analyze] Gemini failed:', error?.message)
                return NextResponse.json({ source: 'error', error: 'vision model unavailable', detail: String(error?.message || '').slice(0, 160) })
            }
        }
        return NextResponse.json({ source: 'gemini', model: GEMINI_MODEL, analysis: validateCropAnalysis(raw) })
    } catch (error) {
        console.error('[crop-analyze] ✗', error?.message)
        return NextResponse.json({ error: 'Crop analysis failed' }, { status: 500 })
    }
}
