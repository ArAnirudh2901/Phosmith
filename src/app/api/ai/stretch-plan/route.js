// /api/ai/stretch-plan
//
// Gemini's decisions for Auto Stretch. The reference edits are one Photoshop
// sequence (sample a line across the subject, stretch it into stripes off the
// canvas, warp them, keep the subject in front). The client measures first —
// the subject (SlimSAM) and the room to each frame edge, sent as `facts` — and
// the model decides with the photo and those numbers: subject box, edge, look,
// bend, amount, where the colours are sampled, placement. The client then
// carries the decision out exactly (src/lib/stretch-auto.js).
//
// Returns { success, hint } where `hint` is null without a key or on failure;
// the client's shape rules then decide alone.

import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { enforceRateLimit, rateLimitResponse } from "@/lib/rate-limit"
import { AUTO_HINT_PROMPT, AUTO_HINT_SCHEMA, describeAutoFacts, sanitizeAutoHint } from "@/lib/stretch-auto-hint"

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"
const GEMINI_ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
const GEMINI_TIMEOUT_MS = 15_000

export async function POST(request) {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Rate limit — share the edit-plan bucket
  const rl = await enforceRateLimit("ai-stretch-plan", userId)
  const blocked = rateLimitResponse(rl)
  if (blocked) return blocked

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { imageBase64, mimeType, width, height, facts } = body || {}

  if (!imageBase64 || typeof imageBase64 !== "string") {
    return NextResponse.json({ error: "imageBase64 is required" }, { status: 400 })
  }

  if (!GEMINI_API_KEY) return NextResponse.json({ success: true, hint: null, source: "none", reason: "no-key" })

  const callArgs = {
    apiKey: GEMINI_API_KEY,
    model: GEMINI_MODEL,
    imageBase64,
    mimeType: mimeType || "image/jpeg",
    width: width || 0,
    height: height || 0,
    facts: facts && typeof facts === "object" ? facts : null,
  }
  let raw = null
  let reason = null
  try {
    raw = await callGeminiForStretchHint(callArgs)
  } catch (error) {
    // The free tier allows 20 requests a day on 2.5 Flash; say so rather than
    // falling back silently, or Auto just looks worse for no visible reason.
    if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(error?.message || "")) reason = "quota"
    else reason = "error"
    // Retry once after 2s for transient 503 (model overloaded) errors.
    if (/503|UNAVAILABLE/i.test(error?.message || "")) {
      try {
        await new Promise((r) => setTimeout(r, 2000))
        raw = await callGeminiForStretchHint(callArgs)
      } catch (retryErr) {
        console.warn("[stretch-plan] Gemini retry failed; the client plans alone:", retryErr?.message)
      }
    } else {
      console.warn("[stretch-plan] Gemini call failed; the client plans alone:", error?.message)
    }
  }
  const hint = sanitizeAutoHint(raw)
  return NextResponse.json({ success: true, hint, source: hint ? "vision" : "none", reason: hint ? null : reason || "error" })
}

/**
 * Robust JSON parser — handles common Gemini output quirks:
 * 1. Markdown code fences (```json ... ```)
 * 2. Unquoted property keys ({ region: ... } → { "region": ... })
 * 3. Trailing commas before closing braces/brackets
 * 4. Single-quoted strings
 */
function robustParseJSON(raw) {
  let text = raw.trim()

  // Strip markdown code fences
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')

  // Try strict parse first
  try { return JSON.parse(text) } catch { /* continue to repair */ }

  // Fix unquoted keys:  { region: → { "region":
  let repaired = text.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":')

  // Fix single-quoted strings:  'vertical' → "vertical"
  repaired = repaired.replace(/:\s*'([^']*?)'/g, ': "$1"')

  // Fix trailing commas:  ,} → }  and  ,] → ]
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1')

  try { return JSON.parse(repaired) } catch { /* fall through */ }

  // Last resort: try to extract a JSON object from mixed output
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    let obj = match[0]
      .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*?)'/g, ': "$1"')
      .replace(/,(\s*[}\]])/g, '$1')
    return JSON.parse(obj)
  }

  throw new Error(`Could not parse Gemini response as JSON`)
}

// ─── Per-image response cache ────────────────────────────────────────────────
// Keyed by a hash of the image base64 prefix (first 200 chars) + dimensions.
// TTL: 5 minutes. Prevents wasted API calls when clicking "Auto Stretch"
// multiple times on the same image.
const _planCache = new Map()
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX = 20

function getCacheKey(imageBase64, width, height, facts) {
  // Use first 200 chars of base64 + dimensions as a fingerprint
  return `${(imageBase64 || '').slice(0, 200)}:${(imageBase64 || '').length}:${width}x${height}:${JSON.stringify(facts || null)}`
}

function getCachedPlan(key) {
  const entry = _planCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _planCache.delete(key)
    return null
  }
  return entry.plan
}

function setCachedPlan(key, plan) {
  // Evict oldest entries if cache is full
  if (_planCache.size >= CACHE_MAX) {
    const oldest = _planCache.keys().next().value
    _planCache.delete(oldest)
  }
  _planCache.set(key, { plan, ts: Date.now() })
}

async function callGeminiForStretchHint({ apiKey, model, imageBase64, mimeType, width, height, facts }) {
  // Check cache first
  const cacheKey = getCacheKey(imageBase64, width, height, facts)
  const cached = getCachedPlan(cacheKey)
  if (cached) return cached

  const userText = describeAutoFacts(facts, width, height)

  const requestBody = {
    systemInstruction: { parts: [{ text: AUTO_HINT_PROMPT }] },
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: imageBase64 } },
          { text: userText },
        ],
      },
    ],
    generationConfig: {
      // The same photo should get the same edit when Auto is pressed twice.
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: AUTO_HINT_SCHEMA,
      // 2.5-series thinking spends from this budget; at 512 the JSON came back
      // cut off mid-object and every call fell through to the fallback.
      maxOutputTokens: 4096,
      // The decisions are the model's, so it gets to think (~9 s on 2.5 Flash
      // against ~5 s without): with thinking off it ignored the measured room
      // and sent a motorbike's stripes into the floor.
      ...(/^gemini-3/i.test(GEMINI_MODEL)
        ? { thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING_LEVEL || "low" } }
        : /^gemini-2\.5/i.test(GEMINI_MODEL) ? { thinkingConfig: { thinkingBudget: 1024 } } : {}),
    },
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)

  try {
    const response = await fetch(`${GEMINI_ENDPOINT(model)}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`Gemini ${response.status}: ${text.slice(0, 200)}`)
    }

    const json = await response.json()
    const textOut = json?.candidates?.[0]?.content?.parts?.find(p => p.text)?.text
    if (!textOut) throw new Error("Gemini returned no text")

    const plan = robustParseJSON(textOut)

    // Cache the successful result
    setCachedPlan(cacheKey, plan)

    return plan
  } finally {
    clearTimeout(timeout)
  }
}
