import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { enforceRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { parseMaskDescription, validateMaskPlan } from '@/lib/agent/nl-mask-parser'

export const maxDuration = 30
export const runtime = 'nodejs'

/* ═══════════════════════════════════════════════════════════════════════════
 * NL MASK PLANNING — /api/ai/mask-plan
 *
 * Turns "the dog on the left, but not its leash" into a validated MaskPlan
 * (see src/lib/agent/nl-mask-parser.js) that the client-side executor
 * (mask.fromDescription in src/lib/agent/nl-mask.js) resolves into actual
 * mask layers via instance detection / text grounding / depth / geometry.
 *
 * Text-only Gemini call (no image upload — grounding happens client-side
 * against the live canvas), with the deterministic heuristic parser as the
 * keyless/offline fallback. Every plan, whatever its source, passes through
 * validateMaskPlan before leaving this route.
 * ═══════════════════════════════════════════════════════════════════════════ */

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash'
const GEMINI_ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
const GEMINI_TIMEOUT_MS = 12_000

const SYSTEM_PROMPT = `You convert a user's natural-language description of an image region into a JSON MaskPlan for a photo editor's masking engine.

Output STRICT JSON only (no markdown) with this shape:
{
  "fillMode": "fill" | "adjust" | "erase",
  "feather": number 0..0.5 or null,
  "grow": integer -200..200 or null,
  "invert": boolean,
  "steps": [ { "op": "add" | "subtract" | "intersect", "target": <Target> } ]
}

Target variants (pick the BEST tool for each referenced region):
- {"type":"subjects","labels":["person"|"dog"|"cat"|"bird"|"horse"|"sheep"|"cow"|"elephant"|"bear"|"zebra"|"giraffe"|"car"|"truck"|"bus"|"bicycle"|"motorcycle"|"boat", ...],"qualifiers":{"position":"left|right|top|bottom|center","ordinal":1-50,"ordinalFrom":"right","size":"largest|smallest","color":"red|blue|..."},"phrase":"<original noun phrase>"}
  → instance detection. Use for people, animals, vehicles. qualifiers/phrase optional.
- {"type":"concept","phrase":"<short noun phrase>"} → open-vocabulary segmentation (CLIPSeg). Use for everything else visible: sky, clothing, objects, materials, body parts.
- {"type":"depth","region":"foreground|background|midground"} → depth plane.
- {"type":"luminance","region":"shadows|midtones|highlights"} → tonal range.
- {"type":"colorRange","name":"red|...","hex":"#rrggbb","tolerance":0..1} → pixels of a colour ("all the red areas").
- {"type":"region","area":"top|bottom|left|right|center|edges","fraction":0.05..0.95} → geometric area ("top half", "the edges").

Rules:
- "everything except X" → invert=true with steps for X.
- "X but not Y" / "X except Y" → add X, then {"op":"subtract"} Y.
- "X inside Y" / "the part of X within Y" → add X, then {"op":"intersect"} Y.
- "erase/remove/cut out X" → fillMode "erase".
- "extend/expand the selection by N px" or "with N px padding" → grow=N; "shrink/tighten by N" → grow=-N; "slightly" ≈ 8, "a lot" ≈ 24.
- "soft edges/feathered" → feather 0.12; "hard edges" → feather 0.
- Subjects whose noun is NOT in the labels list above → use "concept" with the noun phrase.
- Keep concept phrases short and visual (drop verbs and mask-words).
- Max 6 steps. First step op is always "add".`

const callGemini = async ({ apiKey, description }) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
  try {
    const response = await fetch(`${GEMINI_ENDPOINT(GEMINI_MODEL)}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: `Description: ${description}` }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Gemini ${response.status}: ${text.slice(0, 160)}`)
    }
    const data = await response.json()
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

export async function POST(request) {
  try {
    const { userId } = await auth()
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limited = rateLimitResponse(await enforceRateLimit('ai-mask-plan', userId))
    if (limited) return limited

    let body
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const description = String(body?.description || '').trim().slice(0, 500)
    if (!description) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 })
    }

    const apiKey = process.env.GEMINI_API_KEY
    if (apiKey) {
      try {
        const raw = await callGemini({ apiKey, description })
        const { valid, errors, plan } = validateMaskPlan({ ...raw, source: 'gemini' })
        if (valid) {
          return NextResponse.json({ plan }, { headers: { 'Cache-Control': 'no-store' } })
        }
        console.warn('[ai-mask-plan] Gemini plan invalid, falling back:', errors)
      } catch (err) {
        console.warn('[ai-mask-plan] Gemini failed, falling back to heuristic:', err?.message)
      }
    }

    const plan = parseMaskDescription(description)
    return NextResponse.json({ plan }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[ai-mask-plan] ✗', error?.message)
    return NextResponse.json(
      { error: error?.message || 'Mask planning failed' },
      { status: 500 },
    )
  }
}
