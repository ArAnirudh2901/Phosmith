// /api/ai/stretch-plan
//
// AI Pixel Stretch Planner — uses Gemini vision to analyze an image and recommend
// the optimal region, direction, and parameters for a pixel stretch effect.
//
// Flow:
//   1. Auth (Clerk)
//   2. Rate limit
//   3. Accept image as base64 (client captures a small canvas snapshot)
//   4. Send to Gemini with a system prompt asking it to think like a pro editor
//   5. Return the plan: { region, axis, direction, params, reasoning }
//
// Fallback: if Gemini is unavailable, returns an aspect-ratio-based editorial
// default. The CLIENT additionally runs a real on-device pixel analyser
// (analyzeStretchPlan in lib/pixel-stretch.js) when this route is unreachable,
// so Auto Stretch keeps working — and "thinking" — with no API key at all.

import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { enforceRateLimit, rateLimitResponse } from "@/lib/rate-limit"

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"
const GEMINI_ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
const GEMINI_TIMEOUT_MS = 15_000

const STRETCH_SYSTEM_PROMPT = `You are an elite photo editor and digital artist specializing in pixel stretch / glitch art effects. You analyze images and decide WHERE and HOW to create the most visually stunning pixel stretch effect.

Your job: given an image, output a JSON plan for a pixel stretch effect that would look incredible as album art, editorial photography, or social media content.

## How Pixel Stretch Works
- A "band" region (rectangle) is selected on the image — this is the SOURCE of the pixel colors
- Pixels from a seed line within that band are stretched along an axis (vertical or horizontal)
- The stretch can be straight, arched, S-curved, ribbon-like, etc.

## Your Decision Process (think like a pro editor)

### 1. REGION SELECTION (most critical)
Pick a region that contains the most visually interesting / colorful strip of pixels:
- For PORTRAITS: stretch through the clothing, hair, or background colors (NOT through the face)
- For LANDSCAPES: stretch through the sky gradient, horizon line, or most colorful section
- For ARCHITECTURE: stretch through columns, windows, or facade patterns
- For ABSTRACT/PATTERNS: stretch through the most color-varied section
- For GROUP PHOTOS: stretch through the background or between subjects

The seed line (the row/column of pixels that gets smeared) should pass through the area with the BEST color variety and contrast.

### 2. DIRECTION & NEGATIVE SPACE (decide where the streaks GO)
- vertical: good for portraits, buildings, trees, tall subjects
- horizontal: good for landscapes, horizons, wide scenes
- Sweep the streaks INTO the emptiest, least-detailed region (open sky, a plain
  wall, soft/blurred background) so they read as deliberate motion and have room
  to breathe — never smear over the focal subject's face or key detail.
- Set "direction" (1 = forward along the axis, -1 = backward) so the stretch
  travels toward that open space.
- Prefer a seed line whose COLORS are vivid and varied — the streaks become the
  hero of the image, so saturated, harmonious colour beats flat or muddy tones.

### 3. PARAMETERS
- length (1.0-8.0): how far the pixels stretch. 1.0 = no extension. 2.0-3.5 = editorial. 4.0+ = dramatic
- bend (-1.0 to 1.0): curve of the stretch. 0 = straight. 0.3-0.7 = elegant arch. negative = opposite curve
- twist (-1.0 to 1.0): S-curve amount. 0 = uniform. 0.5-1.0 = serpentine
- fade (0-1.0): how much the stretch fades out. 0.05-0.25 = subtle taper
- taper (0-1.0): width tapering. 0.1-0.3 = natural look
- mirror (true/false): symmetric stretch both directions
- seed (0-1.0): position of the source line within the band (0 = start edge, 0.5 = center, 1 = end edge)
- opacity (0-1.0): strength of the effect. Usually 1.0

### 4. FLOW PATH (STRONGLY PREFERRED — the best-in-class control)
Instead of a single bent ribbon, route the smear through a FLOW PATH: an ordered
list of 3-6 points (normalized 0-1) that the streak travels along, following
every curve. This is far more expressive than length/bend/twist — it lets the
streak weave through the composition like a brushstroke.

Rules for a great flow path:
- The FIRST point sits on the most colourful / highest-contrast seed location
  (the streak's colours are sampled there).
- Subsequent points route INTO the emptiest negative space (open sky, plain wall,
  soft background), curving smoothly — never a straight line, never back over the
  focal subject's face or key detail.
- Keep turns gentle and organic (an S, an arc, a gentle spiral) — think of how a
  ribbon would fall through the scene.
- "flowWidth" (0.05-0.4) is the ribbon's thickness as a fraction of the image.

Also fill the scalar params (length/bend/twist/…) as a graceful fallback for
clients that don't support flow paths.

### 5. STYLE GUIDELINES
- For EDITORIAL/PREMIUM: moderate reach, gentle single arc, light fade
- For DRAMATIC/ART: long reach, strong curve, with an S-turn
- For SUBTLE/MINIMAL: short reach, near-straight
- For FLOWING/ORGANIC: serpentine multi-point flow with taper

Return STRICT JSON only, no prose:
{
  "region": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 },
  "axis": "vertical" | "horizontal",
  "direction": 1 | -1,
  "flowPath": [ { "x": 0.0, "y": 0.0 }, { "x": 0.0, "y": 0.0 }, { "x": 0.0, "y": 0.0 } ],
  "flowWidth": 0.18,
  "length": 0.0,
  "bend": 0.0,
  "twist": 0.0,
  "fade": 0.0,
  "taper": 0.0,
  "mirror": false,
  "seed": 0.0,
  "opacity": 1.0,
  "reasoning": "<1-2 sentence explanation of your creative choice>"
}

All coordinates are NORMALIZED (0-1 range relative to image dimensions).
Pick a flow path + parameters that create the BEST LOOKING result. Be bold and creative.`

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

  const { imageBase64, mimeType, width, height } = body || {}

  if (!imageBase64 || typeof imageBase64 !== "string") {
    return NextResponse.json({ error: "imageBase64 is required" }, { status: 400 })
  }

  // Try Gemini first, fall back to rule-based analysis
  let plan = null

  if (GEMINI_API_KEY) {
    const callArgs = {
      apiKey: GEMINI_API_KEY,
      model: GEMINI_MODEL,
      imageBase64,
      mimeType: mimeType || "image/jpeg",
      width: width || 0,
      height: height || 0,
    }
    try {
      plan = await callGeminiForStretchPlan(callArgs)
    } catch (error) {
      // Retry once after 2s for transient 503 (model overloaded) errors.
      const is503 = /503|UNAVAILABLE/i.test(error?.message || '')
      if (is503) {
        try {
          await new Promise((r) => setTimeout(r, 2000))
          plan = await callGeminiForStretchPlan(callArgs)
        } catch (retryErr) {
          console.warn("[stretch-plan] Gemini retry also failed, falling back to rule-based:", retryErr?.message)
        }
      } else {
        console.warn("[stretch-plan] Gemini call failed, falling back to rule-based:", error?.message)
      }
    }
  }

  if (!plan) {
    // Rule-based fallback
    plan = generateFallbackPlan(width || 0, height || 0)
  }

  // Sanitize the plan
  plan = sanitizePlan(plan)

  return NextResponse.json({ success: true, plan })
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

function getCacheKey(imageBase64, width, height) {
  // Use first 200 chars of base64 + dimensions as a fingerprint
  return `${(imageBase64 || '').slice(0, 200)}:${width}x${height}`
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

async function callGeminiForStretchPlan({ apiKey, model, imageBase64, mimeType, width, height }) {
  // Check cache first
  const cacheKey = getCacheKey(imageBase64, width, height)
  const cached = getCachedPlan(cacheKey)
  if (cached) return cached

  const userText = `Analyze this image (${width}×${height}px) and create a pixel stretch plan that will look AMAZING.`

  const requestBody = {
    systemInstruction: { parts: [{ text: STRETCH_SYSTEM_PROMPT }] },
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
      temperature: 0.7,  // Some creativity for artistic decisions
      topP: 0.9,
      responseMimeType: "application/json",
      maxOutputTokens: 512,
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

/**
 * Rule-based fallback when Gemini is unavailable.
 * Uses aspect ratio heuristics to pick sensible defaults.
 */
function generateFallbackPlan(width, height) {
  const aspect = width && height ? width / height : 1
  const isLandscape = aspect > 1.2
  const isPortrait = aspect < 0.8

  // Pick axis based on image orientation
  const axis = isLandscape ? "horizontal" : "vertical"

  // Default region: a vertical strip through the center-right (interesting area)
  // or a horizontal strip through the upper third (sky/background)
  const region = axis === "vertical"
    ? { x: 0.3, y: 0.1, w: 0.35, h: 0.65 }
    : { x: 0.1, y: 0.15, w: 0.65, h: 0.35 }

  // Pick a moderate editorial preset
  return {
    region,
    axis,
    direction: 1,
    length: 2.4,
    bend: 0.45,
    twist: 0,
    fade: 0.15,
    taper: 0.12,
    mirror: false,
    seed: isPortrait ? 0.3 : 0.5,
    opacity: 1.0,
    reasoning: `Auto-selected a ${axis} stretch through the ${axis === "vertical" ? "center" : "upper"} region with an editorial arch look.`,
  }
}

function sanitizePlan(raw) {
  if (!raw || typeof raw !== "object") return generateFallbackPlan(0, 0)

  const clamp = (v, lo, hi) => Math.min(Math.max(Number(v) || 0, lo), hi)
  const clamp01 = (v) => clamp(v, 0, 1)

  const region = raw.region && typeof raw.region === "object"
    ? {
        x: clamp01(raw.region.x),
        y: clamp01(raw.region.y),
        w: clamp(raw.region.w, 0.05, 1),
        h: clamp(raw.region.h, 0.05, 1),
      }
    : { x: 0.3, y: 0.1, w: 0.35, h: 0.65 }

  // Ensure region doesn't overflow
  region.x = Math.min(region.x, 1 - region.w)
  region.y = Math.min(region.y, 1 - region.h)

  // Flow path — an ordered list of 2..12 normalized points, when the model
  // provided one. Drop anything malformed; a too-short list degrades to null
  // (the client then applies the scalar simple sweep).
  let flowPath = null
  if (Array.isArray(raw.flowPath)) {
    const pts = raw.flowPath
      .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
      .slice(0, 12)
      .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    if (pts.length >= 2) flowPath = pts
  }

  return {
    region,
    axis: raw.axis === "horizontal" ? "horizontal" : "vertical",
    direction: Number(raw.direction) < 0 ? -1 : 1,
    flowPath,
    flowWidth: raw.flowWidth != null ? clamp(raw.flowWidth, 0.05, 0.4) : 0.18,
    length: clamp(raw.length, 1, 8),
    bend: clamp(raw.bend, -1, 1),
    twist: clamp(raw.twist, -1, 1),
    fade: clamp01(raw.fade),
    taper: clamp01(raw.taper),
    mirror: Boolean(raw.mirror),
    seed: clamp01(raw.seed),
    opacity: clamp(raw.opacity, 0.1, 1),
    reasoning: String(raw.reasoning || "AI-selected stretch parameters").slice(0, 300),
  }
}
