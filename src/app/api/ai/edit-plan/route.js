// /api/ai/edit-plan
//
// AI Edit Agent v2 — single orchestration endpoint.
//
// Flow:
//   1. Auth (Clerk)
//   2. Look up cache (Neon editPlanCache) keyed by (projectId + imageHash + promptKey + plannerVersion).
//      imageHash is computed by the client from the LIVE rendered canvas, so it
//      changes whenever the visible pixels change (including manual edits) and the
//      cache self-invalidates — same rendered image + same prompt = same plan.
//   3. Cache hit → return immediately.
//   4. Cache miss → ask the configured Gemini vision model (temperature=0) what style the
//      image is now and what the user wants, analysing the client's flattened canvas
//      render when provided, then run the deterministic planner.
//   5. Persist the plan into the cache and return it.
//
// If GEMINI_API_KEY is not configured (or the call fails), we fall back to a pure
// rule-based planner that uses prompt keywords + the client's computed feature vector.

import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { getNeonAuthContext } from "@/lib/neon/auth"
import { runNeonMutation, runNeonQuery } from "@/lib/neon/functions"
import { buildEditPlan, PLANNER_VERSION } from "@/lib/edit-planner"
import { getStyleFit } from "@/lib/image-features"
import {
    KEYWORD_STYLE_ROUTES,
    STYLE_DESCRIPTORS,
    STYLE_KEYS,
} from "@/lib/style-profiles"
import { enforceRateLimit, rateLimitResponse } from "@/lib/rate-limit"

// Model is configurable via env so we can pin a snapshot or trade quality for
// free-tier headroom. Default: "gemini-3.5-flash" — Google's current-generation
// vision Flash model: generous free tier, native multimodal, JSON mode, and
// Gemini-3 "thinking" + per-request media-resolution control (both applied below
// for sharper colour-grading judgment). Switch to a Pro tier (e.g. "gemini-3-pro")
// for the highest ceiling at a tighter free quota.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash"
const GEMINI_ENDPOINT = (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
const GEMINI_TIMEOUT_MS = 12_000
const MAX_IMAGE_BYTES_FOR_VISION = 4 * 1024 * 1024 // 4 MB — fetch a downsized image if larger

// ── Gemini 3.x request tuning ──────────────────────────────────────────────
// Gemini 3 models replace 2.5's integer `thinkingBudget` with a `thinkingLevel`
// enum and add `mediaResolution` (the max vision tokens spent per image). For
// interactive colour grading we want a little reasoning — but must stay inside
// GEMINI_TIMEOUT_MS — and HIGH media resolution so the model perceives fine
// colour/tonal detail. Both are env-overridable and only attached for gemini-3*
// models (older models 400 on thinkingLevel). The callGemini retry strips them
// defensively if a given snapshot rejects a field.
const isGemini3Model = (model) => /^gemini-3/i.test(model || "")
const GEMINI3_THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || "low"
const GEMINI3_MEDIA_RESOLUTION = process.env.GEMINI_MEDIA_RESOLUTION || "MEDIA_RESOLUTION_HIGH"

const tuneGenerationConfig = (model, baseConfig, { safe = false } = {}) => {
    if (safe) {
        // Defensive retry: keep only universally-supported fields so a model or
        // snapshot that rejects a newer field still returns a plan.
        const safeConfig = { ...baseConfig }
        delete safeConfig.seed
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

// Cap the flattened-render payload a client may send per image. A 1024px JPEG is
// ~150-400 KB of base64; this leaves generous headroom while rejecting abuse.
const MAX_RENDERED_BASE64_CHARS = 3 * 1024 * 1024

// DoS guards for the multi-layer path. A client could otherwise send an
// arbitrarily long layers[] and drive N concurrent image fetches + N Gemini
// calls. Cap the layer count, bound the fan-out concurrency, and reject any
// thumbnail whose base64 payload is unreasonably large.
const MAX_LAYERS = 12
const PLAN_FANOUT_CONCURRENCY = 4
const MAX_THUMB_BASE64_CHARS = 2 * 1024 * 1024 // ~1.5 MB decoded — generous for a thumbnail

// When the source is an ImageKit URL, append this canonical transform so
// different users uploading the same scene at different sizes/qualities all
// end up sending the SAME bytes to Gemini. That eliminates a major source of
// cross-user output drift that's invisible at the cache-key layer.
const IMAGEKIT_CANONICAL_TRANSFORM = "w-1024,h-1024,c-at_max,q-85,f-jpg"

const isImageKitUrl = (url) =>
    typeof url === "string" && /https?:\/\/[^/]*imagekit\.io\//i.test(url)

const buildStandardizedVisionUrl = (sourceUrl) => {
    if (!sourceUrl || !isImageKitUrl(sourceUrl)) return sourceUrl
    try {
        const u = new URL(sourceUrl)
        const existing = u.searchParams.get("tr")
        const tr = existing
            ? `${existing}:${IMAGEKIT_CANONICAL_TRANSFORM}`
            : IMAGEKIT_CANONICAL_TRANSFORM
        u.searchParams.set("tr", tr)
        return u.toString()
    } catch {
        return sourceUrl
    }
}

// Keyword → target-style routing table. Sourced from style-profiles.js so that
// adding a new film/camera preset updates BOTH the system prompt and this
// deterministic fallback from one place. Order is significant — the FIRST
// regex that matches wins, and specific film/camera names come before generic
// fallbacks (e.g. "Portra" must beat the catch-all "vintage" entry).
const KEYWORD_STYLE_HINTS = KEYWORD_STYLE_ROUTES

const KEYWORD_AI = [
    [/remove\s+background|cut\s*out|no\s+background/i, "bgRemove"],
    [/upscale|hi(gh)?[- ]?res|enhance\s+resolution/i, "upscale"],
    [/retouch|skin\s+smooth|cleanup/i, "retouch"],
    [/sharpen|crisp/i, "sharpen"],
]

const inferKeywordIntent = (prompt) => {
    const intent = { targetStyle: "neutral", imagekitAi: {} }
    if (!prompt) return intent
    for (const [pattern, style] of KEYWORD_STYLE_HINTS) {
        if (pattern.test(prompt)) {
            intent.targetStyle = style
            break
        }
    }
    for (const [pattern, key] of KEYWORD_AI) {
        if (pattern.test(prompt)) intent.imagekitAi[key] = true
    }
    return intent
}

// Deterministic direct-adjustment parser. Extracts explicit tonal/technical
// moves from the prompt ("warmer", "30% brighter", "add grain", "less saturated",
// "sharper", "rotate the hue") into concrete adjustment values, so the agent
// handles arbitrary corrections even with NO named style and even when the
// vision model is unavailable. Values are in the same units as STYLE_PROFILES.
// Each adjustment is a {key, sign, base, re} tuple so the magnitude pairing
// below can map "30% brighter" / "warmer by 20" to the SPECIFIC adjustment whose
// keyword is adjacent to the number, instead of slamming one global number onto
// every detected key. `order` is significant only for the brightness/contrast/
// saturation/temperature pairs where the positive variant is checked first
// (matching the original if/else-if precedence).
const DIRECT_ADJUSTMENT_RULES = [
    { key: "brightness", sign: 1, base: 18, re: /\b(bright(?:er|en)?|lighter|too\s*dark|more\s*exposure|expose\s*up)\b/, group: "brightness" },
    { key: "brightness", sign: -1, base: 18, re: /\b(darker|darken|too\s*bright|less\s*exposure|underexpos\w*)\b/, group: "brightness" },
    { key: "contrast", sign: 1, base: 16, re: /\b(more\s*contrast|contrast(?:y|ier)?|punch(?:y|ier)?|add\s*contrast)\b/, group: "contrast" },
    { key: "contrast", sign: -1, base: 16, re: /\b(less\s*contrast|flat(?:ter)?|low\s*contrast|reduce\s*contrast)\b/, group: "contrast" },
    { key: "saturation", sign: 1, base: 18, re: /\b(more\s*satur\w*|more\s*colou?rs?|vivid\w*|pop\s*(?:the\s*)?colou?rs?|colou?r\s*pop)\b/, group: "saturation" },
    { key: "saturation", sign: -1, base: 18, re: /\b(desatur\w*|less\s*satur\w*|less\s*colou?rs?|muted?|drain\s*colou?r|wash\s*out\s*colou?r)\b/, group: "saturation" },
    { key: "vibrance", sign: 1, base: 16, re: /\bvibran\w*\b/, group: "vibrance" },
    { key: "temperature", sign: 1, base: 18, re: /\bwarm(?:er|th)?\b|warm\s*it|golden\s*warm|cozy\s*warm/, group: "temperature" },
    { key: "temperature", sign: -1, base: 18, re: /\bcool(?:er)?\b|cold(?:er)?\b|bluer|more\s*blue|icy\s*tone/, group: "temperature" },
    { key: "sharpness", sign: 1, base: 18, re: /\bsharp(?:er|en)?\b|crisp(?:er)?\b|clearer|more\s*detail\b/, group: "sharpness" },
    { key: "blur", sign: 1, base: 14, re: /\bblur(?:ry|red)?\b|soften|softer\b|out\s*of\s*focus|bokeh|gaussian\s*blur/, group: "blur" },
    { key: "noise", sign: 1, base: 14, re: /\bgrain(?:y)?\b|film\s*grain|noise|noisy\b/, group: "noise" },
    { key: "hue", sign: 1, base: 30, re: /\b(rotate|shift|swap)\s*(?:the\s*)?(hue|colou?rs?|color\s*wheel)|hue\s*(shift|rotation|rotate)/, group: "hue" },
]

// Words that, when paired with an explicit number, count as an "adjustment word"
// (grain/detail/faded/sharper/etc.) so callers can decide NOT to force a creative
// restyle / gain floor when the prompt is really a direct numeric adjustment.
const ADJUSTMENT_INTENSITY_WORDS =
    /\b(grain(?:y)?|noise|noisy|detail|faded?|fade|sharp(?:er|en)?|crisp(?:er)?|bright(?:er|en)?|dark(?:er)?|contrast(?:y|ier)?|satur\w*|vibran\w*|warm(?:er|th)?|cool(?:er)?|blur(?:ry|red)?|soft(?:er|en)?)\b/i

const parseDirectAdjustments = (prompt) => {
    const p = String(prompt || "").toLowerCase()
    if (!p) return {}
    const adj = {}

    // Intensity multiplier from modifier words. Choose a SINGLE multiplier
    // deterministically rather than letting the last matching tier overwrite a
    // contradictory earlier one: prefer the tier whose keyword appears earliest
    // in the prompt, breaking ties toward the smaller magnitude.
    const MULT_TIERS = [
        { value: 0.55, re: /\b(slight\w*|subtle|barely|gently|softly|a\s*(little|bit|touch|hair)|just\s*a\s*bit)\b/ },
        { value: 1.6, re: /\b(very|really|much|way|a\s*lot|lots|quite|noticeabl\w*)\b/ },
        { value: 2.3, re: /\b(super|extremely|insanely|drastically|heavil\w*|heavy|extreme|max(?:imum)?|crank\w*|blast|tons?\s*of)\b/ },
    ]
    let mult = 1
    let bestPos = Infinity
    for (const tier of MULT_TIERS) {
        const m = p.match(tier.re)
        if (!m) continue
        const pos = m.index
        if (pos < bestPos || (pos === bestPos && tier.value < mult)) {
            bestPos = pos
            mult = tier.value
        }
    }

    // Optional explicit magnitude. Only a "30%" or "by 30" form counts — a bare
    // number is IGNORED so film/camera/year tokens ("Portra 400", "800T", "16mm",
    // "1990s photo") don't get mistaken for an adjustment amount and slammed to max.
    // Capture the number's POSITION so we apply it to ONLY ONE adjustment — the
    // single keyword nearest the number in the SAME clause — instead of one global
    // value smeared across every detected key (distinct prompts must not collide).
    const numMatch = p.match(/by\s+([+-]?\d{1,3})\b|([+-]?\d{1,3})\s*%/)
    const explicit = numMatch
        ? Math.min(100, Math.abs(parseInt(numMatch[1] ?? numMatch[2], 10)))
        : null
    const numStart = numMatch ? numMatch.index : -1
    const numEnd = numMatch ? numMatch.index + numMatch[0].length : -1

    // First pass: collect every matched adjustment (one per group, positive variant
    // first to preserve the original if/else-if precedence) with its keyword index.
    const usedGroups = new Set()
    const matched = []
    for (const rule of DIRECT_ADJUSTMENT_RULES) {
        if (usedGroups.has(rule.group)) continue
        const m = p.match(rule.re)
        if (!m) continue
        usedGroups.add(rule.group)
        matched.push({ rule, start: m.index, end: m.index + m[0].length })
    }

    // Decide which single matched adjustment (if any) the explicit number scopes:
    // the closest keyword by character distance, but only if no clause separator
    // (comma/semicolon/"and"/"but") sits between the number and that keyword.
    let explicitTargetKey = null
    if (explicit != null && matched.length > 0) {
        let best = null
        for (const item of matched) {
            const gapStart = item.end <= numStart ? item.end : numEnd
            const gapEnd = item.end <= numStart ? numStart : item.start
            if (gapEnd < gapStart) continue
            const gap = p.slice(gapStart, gapEnd)
            if (/[,;]|\band\b|\bbut\b/.test(gap)) continue // different clause — skip
            const dist = gapEnd - gapStart
            if (best == null || dist < best.dist) best = { key: item.rule.key, dist }
        }
        if (best) explicitTargetKey = best.key
    }

    for (const { rule } of matched) {
        // Apply the explicit number to ONLY the single nearest in-clause adjustment;
        // every other detected adjustment falls back to its per-phrase base*mult.
        const useExplicit = explicitTargetKey != null && rule.key === explicitTargetKey
        const magnitude = Math.round(useExplicit ? explicit : rule.base * mult)
        adj[rule.key] = rule.sign * magnitude
    }

    return adj
}

const FORCE_RESTYLE_PATTERN =
    /\b(again|amplify|boost|dramatic|exaggerat\w*|extra|heavy|intense|max|more|push|strong(?:er|ly)?)\b/i

const wantsForcedRestyle = (prompt) => FORCE_RESTYLE_PATTERN.test(String(prompt || ""))

// Canonical prompt key. NFC-normalize so composed and decomposed Unicode
// (e.g. precomposed "é" vs "e + ◌́") collide to the same cache row.
const normalizePromptKey = (prompt) =>
    String(prompt || "")
        .normalize("NFC")
        .toLowerCase()
        // Preserve the load-bearing magnitude tokens BEFORE stripping punctuation:
        // a "%" and a +/- sign that directly precedes a digit both change the parsed
        // adjustment plan, so they must survive into the key as distinct word tokens.
        .replace(/\+(?=\d)/g, " plustok ")
        .replace(/-(?=\d)/g, " minustok ")
        .replace(/%/g, " pcttok ")
        // Fold away everything else that isn't a letter/number/space.
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()

// Canvas fingerprint for the multi-image targeting cache. Sorted so two equivalent
// canvases (same layers + names + image hashes, possibly different order in the
// array) collapse to the same signature.
const buildCanvasSignature = (layers) => {
    if (!Array.isArray(layers) || layers.length === 0) return ""
    const parts = layers
        .map((layer) => {
            const name = String(layer?.name || `Layer ${layer?.index ?? "?"}`).normalize("NFC").toLowerCase().trim()
            const hash = String(layer?.imageHash || "").trim()
            return `${name}::${hash}`
        })
        .sort()
    return parts.join("|")
}

// SSRF guard for server-side image fetches. The sourceUrl is client-controlled,
// so before fetching we require https:, reject hosts that resolve to private /
// loopback / link-local IP literals, and allowlist only the image hosts this app
// actually serves from (ImageKit + Unsplash). Returns true only for safe URLs.
const ALLOWED_IMAGE_HOST_SUFFIXES = ["imagekit.io", "images.unsplash.com"]

const isPrivateOrLocalHost = (host) => {
    const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "")
    if (!h || h === "localhost" || h === "0.0.0.0" || h.endsWith(".localhost")) return true
    // IPv6 loopback / unique-local (fc00::/7 → fc.. or fd..) / link-local (fe80::)
    if (h === "::1" || /^fc/.test(h) || /^fd/.test(h) || /^fe80:/.test(h)) return true
    // IPv4 literal ranges: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])]
        if (a === 127 || a === 10 || a === 0) return true
        if (a === 172 && b >= 16 && b <= 31) return true
        if (a === 192 && b === 168) return true
        if (a === 169 && b === 254) return true
    }
    return false
}

const validateOutboundImageUrl = (url) => {
    if (typeof url !== "string" || !url) return false
    let u
    try {
        u = new URL(url)
    } catch {
        return false
    }
    if (u.protocol !== "https:") return false
    const host = u.hostname.toLowerCase()
    if (isPrivateOrLocalHost(host)) return false
    return ALLOWED_IMAGE_HOST_SUFFIXES.some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
}

const fetchImageAsBase64 = async (url) => {
    if (!url) return null
    if (!validateOutboundImageUrl(url)) {
        console.warn("[edit-plan] blocked outbound image fetch for disallowed url")
        return null
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
    try {
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new Error(`Image fetch ${response.status}`)
        const contentType = response.headers.get("content-type") || "image/jpeg"
        if (!contentType.toLowerCase().startsWith("image/")) {
            throw new Error(`Image fetch returned non-image content-type: ${contentType}`)
        }
        const buffer = await response.arrayBuffer()
        if (buffer.byteLength > MAX_IMAGE_BYTES_FOR_VISION) {
            // Gemini accepts up to 20 MB inline; we keep it tight to keep latency low.
            // The client is welcome to resize first; here we just send what we got.
        }
        const base64 = Buffer.from(buffer).toString("base64")
        return { base64, mimeType: contentType }
    } catch (error) {
        console.warn("[edit-plan] image fetch failed:", error?.message || error)
        return null
    } finally {
        clearTimeout(timeout)
    }
}

const GEMINI_TARGETING_PROMPT = `You match a user's edit instruction to one or more images on a canvas.

You will be given:
- A user instruction string.
- A list of canvas layers, each with: { "index": number, "name": string, plus a thumbnail image attached in order }.

The thumbnails appear in the same order as the layers array. Match images by:
  • exact or fuzzy layer NAME match ("the sunset", "Image 2", "portrait")
  • visual DESCRIPTION ("the dog photo", "the dark one", "the landscape with mountains")
  • visual PROPERTY ("the bright one", "the warm photo", "the b&w one")

Return STRICT JSON only, no prose:

{
  "targetIndexes": [<list of layer indexes the user is referring to>],
  "needsConfirmation": true|false,
  "reason": "<one short sentence on how you matched>"
}

Rules:
- If the user's instruction is GENERIC (no naming, no description, no visual property, e.g. "make it cinematic" or "polish this"), AND there are multiple layers, set needsConfirmation=true and return ALL layer indexes as candidates.
- If the user names or describes a SPECIFIC layer clearly, return only those matching indexes and needsConfirmation=false.
- If the user says "all" / "everything" / "every image", return all indexes and needsConfirmation=false.
- If you can't tell at all, set needsConfirmation=true and return all indexes as candidates.
- Output JSON only.`

const callGeminiForTargeting = async ({ apiKey, model, prompt, layers }) => {
    if (!Array.isArray(layers) || layers.length < 2) {
        return null
    }

    const parts = []
    parts.push({
        text: `User instruction: ${prompt}\n\nCanvas layers (in order):\n${layers
            .map((layer, idx) => `[${idx}] name="${layer?.name || `Image ${idx + 1}`}"`)
            .join("\n")}`,
    })
    for (const layer of layers) {
        if (layer?.thumbBase64 && layer?.thumbMime) {
            parts.push({ inlineData: { mimeType: layer.thumbMime, data: layer.thumbBase64 } })
        }
    }

    const body = {
        systemInstruction: { parts: [{ text: GEMINI_TARGETING_PROMPT }] },
        contents: [{ role: "user", parts }],
        generationConfig: tuneGenerationConfig(model, {
            temperature: 0,
            topP: 0,
            topK: 1,
            seed: 42,
            responseMimeType: "application/json",
            maxOutputTokens: 256,
        }),
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
    try {
        const response = await fetch(`${GEMINI_ENDPOINT(model)}?key=${encodeURIComponent(apiKey)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        })
        if (!response.ok) {
            const text = await response.text().catch(() => "")
            throw new Error(`Gemini ${response.status}: ${text.slice(0, 200)}`)
        }
        const json = await response.json()
        const textOut = json?.candidates?.[0]?.content?.parts?.[0]?.text
        if (!textOut) throw new Error("Gemini returned no text")
        return JSON.parse(textOut)
    } finally {
        clearTimeout(timeout)
    }
}

const sanitizeTargeting = (raw, layerCount) => {
    const allIndexes = Array.from({ length: layerCount }, (_, i) => i)
    if (!raw || typeof raw !== "object") {
        return { targetIndexes: allIndexes, needsConfirmation: true, reason: "Could not parse targeting response — confirm which layers to edit." }
    }
    const rawIdx = Array.isArray(raw.targetIndexes) ? raw.targetIndexes : []
    const targetIndexes = [...new Set(rawIdx
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < layerCount))]
    if (targetIndexes.length === 0) {
        return { targetIndexes: allIndexes, needsConfirmation: true, reason: "No matching layer identified — confirm which layers to edit." }
    }
    return {
        targetIndexes,
        needsConfirmation: !!raw.needsConfirmation,
        reason: String(raw.reason || "").slice(0, 200),
    }
}

// Build the per-style reference table from STYLE_DESCRIPTORS so adding a new
// film/camera preset in style-profiles.js automatically updates the prompt.
const STYLE_REFERENCE_TABLE = STYLE_KEYS
    .map((key) => {
        const d = STYLE_DESCRIPTORS[key] || {}
        return `- ${key}\n    look: ${d.characteristics || "—"}\n    pick when: ${d.whenToPick || "—"}`
    })
    .join("\n")

const GEMINI_SYSTEM_PROMPT = `You are a senior photo retoucher analyzing an image and a user instruction.
Return STRICT JSON only, no prose, matching this schema exactly:

{
  "currentStyle": "<one of: ${STYLE_KEYS.join(", ")}>",
  "targetStyle":  "<one of the same enum>",
  "alreadyMatchesTarget": true|false,
  "gain": 0.0,
  "imagekitAi": { "retouch": false, "bgRemove": false, "upscale": false, "sharpen": false, "contrast": false },
  "adjustments": { },
  "notes": "<one or two short sentences explaining what you saw and what you'd do>"
}

## Style reference — pick the MOST SPECIFIC matching key

${STYLE_REFERENCE_TABLE}

## Vague-prompt routing rules (CRITICAL — read carefully)

The user will often describe a look in vague language. Translate it to the most
specific enum key that fits. Generic keys ("vintage", "cinematic") are LAST
RESORTS — only use them when no specific film stock, camera, or mood key fits.

Concrete routing:
- "Shot on RED" / "RED camera" / "RED Dragon/Helium/Monstro/Komodo" / "IPP2" → red-cinema
  (NOT cinematic. RED is a specific digital cinema look.)
- "ARRI" / "Alexa" / "Log-C" → arri-alexa (NOT cinematic.)
- "Portra" / "Kodak Portra" / "wedding film" → kodak-portra (NOT vintage or warm-portrait.)
- "Fuji Pro 400H" / "Pro 400H" / "soft green pastel film" → fuji-pro400h
- "CineStill" / "800T" / "halation" / "neon film" / "tungsten film" → cinestill-800t
- "Kodachrome" / "National Geographic film" / "rich slide film" → kodachrome
- "Polaroid" / "SX-70" / "Instax" / "instant film" → polaroid (NOT vintage.)
- "Tri-X" / "pushed B&W" / "gritty grainy black and white" / "street B&W" → bw-tri-x
- "Super 8" / "16mm" / "8mm film" / "old home movie" → super8
- "VHS" / "camcorder" / "analog video" / "tracking lines" → vhs-tape
- "Golden hour" / "magic hour" / "sunset glow" / "sun-soaked" → golden-hour
- "Pastel" / "washed out" / "milky" / "IG aesthetic" → faded-pastel

Vague era-only prompts (no specific film named):
- "Make it look like a vintage photo from an old camera" → super8 (for snapshot
  / candid subjects) OR kodachrome (for landscapes / saturated scenes). Use the
  image to decide which fits better.
- "Old camera" / "old photo" / "old-fashioned" alone → super8 by default.
- "70s photo" → kodachrome (slides) or super8 (home movies) — pick based on image.
- Generic "vintage" with NOTHING specific → vintage (the catch-all).

## Two types of edits — handle them DIFFERENTLY

### Type A: CORRECTIONS ("brighter", "fix exposure", "more contrast")
Technical fixes. Use targetStyle="neutral". Only set gain>0 if the image
actually needs the correction. If well-exposed and user says "brighten",
gain=0 is correct.

### Type B: CREATIVE STYLE CHANGE
The user wants the image to LOOK DIFFERENT.
- A well-exposed photo asked to look "vintage" / "cinematic" / "shot on RED" /
  "like a Polaroid" etc. should get gain 0.5–0.8.
- ONLY set alreadyMatchesTarget=true if the image ALREADY has the SPECIFIC
  visual characteristics of the target style — e.g. an image with lifted
  blacks, faded colors and warm tones when asked for "vintage". A normal
  well-exposed photo is NOT "already cinematic" or "already RED".
- Do NOT refuse a creative restyle just because the image is technically good.

## Critical Rules

- DO NOT DOUBLE-PROCESS: alreadyMatchesTarget=true ONLY when the image already
  exhibits the SPECIFIC characteristics listed above for the target key.
- HONOR USER INTENT: if the user names a film stock or camera, route to its
  specific key. Generic "cinematic" or "vintage" are last-resort fallbacks.
- BE PROPORTIONAL: use moderate gain (0.4–0.7) for typical style shifts on
  well-edited images; higher (0.7–1.0) for dramatic shifts; lower (0.1–0.3)
  only when the image is genuinely close to the target style.

## Gain guidance

- 0.0 = image already exhibits the target style (currentStyle === targetStyle)
- 0.1–0.3 = subtle refinement (image is close to target)
- 0.4–0.6 = moderate style shift (typical for most creative requests)
- 0.7–0.9 = strong change (image is far from target)
- 1.0 = dramatic shift (e.g. color → B&W)

## imagekitAi

Set these booleans ONLY when the user EXPLICITLY asks for that AI transform
("remove background" → bgRemove=true). Never speculative.

## adjustments (direct tonal/technical moves — the catch-all for ANY edit)

Use "adjustments" for explicit, concrete requests that a named style does not
capture — this is how you handle arbitrary, "tough", or compound edits. Leave it
{} when the user only asked for a named look.

Keys + units (omit any you don't need; values are DELTAS from neutral except
gamma which is absolute, neutral 100):
- brightness/contrast/saturation/vibrance/temperature: -100..100
- sharpness/blur/noise: 0..100
- gamma: 20..220 (100 = neutral)
- hue: -180..180

Examples:
- "make it 30% brighter and a bit warmer" → { "brightness": 30, "temperature": 12 }
- "add heavy film grain and soften it" → { "noise": 28, "blur": 12 }
- "less saturated, more contrast" → { "saturation": -22, "contrast": 18 }
- "lift the shadows / fix crushed blacks" → { "gamma": 116 }
- "shift the colors / rotate hue toward teal" → { "hue": -28 }

You MAY combine adjustments WITH a named style (e.g. targetStyle="cinematic" plus
adjustments {"noise": 20}). Be proportional — match the magnitude to the request.

## Colour grading — the attached image is the CURRENT canvas

The image attached to this request is the LIVE, fully-rendered canvas: the user's
original photo WITH every manual edit already baked in (their brightness / contrast /
white-balance moves, masks, local edits, layers). Grade what you SEE, not an
imagined original:
- Judge exposure, white balance and saturation from the attached pixels. If a manual
  edit already achieved the look (e.g. it already reads warm and faded when asked for
  "vintage"), prefer alreadyMatchesTarget=true / a small gain over stacking another
  pass on top.
- For colour work reach for: temperature (warm/cool white balance), hue (global tint /
  teal–orange split), vibrance vs saturation (vibrance protects skin tones and
  already-saturated areas; saturation is global), and contrast + gamma (tonal curve /
  shadow lift). Prefer vibrance over saturation when people are present.
- Keep skin tones natural and neutrals neutral unless the user explicitly wants a
  stylised cast. A colour grade is a deliberate, measured move — precise and
  proportional, never maximal for its own sake.

Output JSON only.`

const STRICTER_RETRY_SUFFIX =
    "\n\nPrevious response was not valid JSON. YOU MUST RETURN VALID JSON. NO COMMENTS. NO MARKDOWN FENCES. NO PROSE. Only the object."

const callGeminiOnce = async ({ apiKey, model, prompt, imageBase64, mimeType, features, systemPrompt, safeConfig = false }) => {
    const userPart = {
        text: `User instruction: ${prompt || "(no specific instruction — apply a sensible default look)"}\n\nClient-computed image features:\n${JSON.stringify(features || {})}`,
    }
    const baseGenerationConfig = {
        // Deterministic settings — same image + same prompt = same JSON.
        temperature: 0,
        topP: 0,
        topK: 1,
        seed: 42,
        responseMimeType: "application/json",
        responseSchema: {
            type: "OBJECT",
            properties: {
                currentStyle: { type: "STRING", enum: STYLE_KEYS },
                targetStyle: { type: "STRING", enum: STYLE_KEYS },
                alreadyMatchesTarget: { type: "BOOLEAN" },
                gain: { type: "NUMBER" },
                imagekitAi: {
                    type: "OBJECT",
                    properties: {
                        retouch: { type: "BOOLEAN" },
                        bgRemove: { type: "BOOLEAN" },
                        upscale: { type: "BOOLEAN" },
                        sharpen: { type: "BOOLEAN" },
                        contrast: { type: "BOOLEAN" },
                    },
                },
                adjustments: {
                    type: "OBJECT",
                    properties: {
                        brightness: { type: "NUMBER" },
                        contrast: { type: "NUMBER" },
                        saturation: { type: "NUMBER" },
                        vibrance: { type: "NUMBER" },
                        temperature: { type: "NUMBER" },
                        gamma: { type: "NUMBER" },
                        sharpness: { type: "NUMBER" },
                        blur: { type: "NUMBER" },
                        noise: { type: "NUMBER" },
                        hue: { type: "NUMBER" },
                    },
                },
                notes: { type: "STRING" },
            },
            required: ["currentStyle", "targetStyle", "alreadyMatchesTarget", "gain", "notes"],
        },
        maxOutputTokens: 512,
    }

    const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [
            {
                role: "user",
                parts: [
                    imageBase64
                        ? { inlineData: { mimeType, data: imageBase64 } }
                        : { text: "(no image attached)" },
                    userPart,
                ],
            },
        ],
        // Gemini-3 thinking + media-resolution tuning is merged in here; the
        // retry path passes safe:true to strip any field a snapshot rejects.
        generationConfig: tuneGenerationConfig(model, baseGenerationConfig, { safe: safeConfig }),
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
    try {
        const response = await fetch(`${GEMINI_ENDPOINT(model)}?key=${encodeURIComponent(apiKey)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        })
        if (!response.ok) {
            const text = await response.text().catch(() => "")
            throw new Error(`Gemini ${response.status}: ${text.slice(0, 200)}`)
        }
        const json = await response.json()
        const textOut = json?.candidates?.[0]?.content?.parts?.[0]?.text
        if (!textOut) throw new Error("Gemini returned no text")
        return JSON.parse(textOut)
    } finally {
        clearTimeout(timeout)
    }
}

// Wrap callGeminiOnce with a single retry on schema mismatch. Production
// determinism is best-effort on Google's side; this catches the rare case
// where the model wraps JSON in markdown fences or returns extra prose.
const callGemini = async (params) => {
    try {
        return await callGeminiOnce({ ...params, systemPrompt: GEMINI_SYSTEM_PROMPT })
    } catch (firstError) {
        // Retry once with a stricter "JSON ONLY" suffix AND a safe generationConfig
        // (drops Gemini-3 thinking/mediaResolution + seed/topP/topK) so the retry
        // also recovers from a model/snapshot that rejects one of those fields.
        console.warn("[edit-plan] Gemini first attempt failed, retrying with strict prompt + safe config:", firstError?.message)
        return await callGeminiOnce({
            ...params,
            systemPrompt: GEMINI_SYSTEM_PROMPT + STRICTER_RETRY_SUFFIX,
            safeConfig: true,
        })
    }
}

const sanitizeGeminiVerdict = (raw, fallbackIntent, features = null, prompt = "") => {
    const safeStyle = (s) => (STYLE_KEYS.includes(s) ? s : null)
    const keywordStyle = safeStyle(fallbackIntent?.targetStyle)
    // The MODEL verdict wins when present — it actually looked at the image and the
    // full prompt. The keyword router is only a fallback for when the model returns
    // nothing (or an out-of-enum value), and the bare keyword catch-alls were
    // overriding correct, more-specific Gemini verdicts.
    const targetStyle =
        safeStyle(raw?.targetStyle) ||
        (keywordStyle && keywordStyle !== "neutral" ? keywordStyle : null) ||
        "neutral"
    const fit = features ? getStyleFit(features, targetStyle) : null
    const currentStyle = safeStyle(raw?.currentStyle) || fit?.currentStyle || "neutral"
    const forceRestyle = wantsForcedRestyle(prompt)
    // When the prompt is really a DIRECT numeric/tonal adjustment (e.g. "add more
    // grain", "+15% detail", "make it more faded", "sharper") we must NOT treat it
    // as a creative restyle and slam a gain floor on top — that double-applies the
    // edit. We detect this when parseDirectAdjustments produced something AND the
    // prompt contains an adjustment-intensity word (grain/detail/faded/sharper/etc.).
    const directAdj = parseDirectAdjustments(prompt)
    const isDirectAdjustmentPrompt =
        Object.keys(directAdj).length > 0 && ADJUSTMENT_INTENSITY_WORDS.test(prompt)
    // Determine if this is a creative style change (vintage, cinematic, etc.)
    // vs a generic correction. Creative changes should not be suppressed.
    const isCreativeRestyle =
        targetStyle !== "neutral" && targetStyle !== currentStyle && !isDirectAdjustmentPrompt
    let alreadyMatchesTarget =
        !forceRestyle && (!!raw?.alreadyMatchesTarget || currentStyle === targetStyle)
    let gainRaw = Number(raw?.gain)
    let gain = Number.isFinite(gainRaw) ? Math.max(0, Math.min(1, gainRaw)) : 0.6

    // Only use deterministic fit to block when the current style EXACTLY matches
    // the target AND this is not a forced restyle. Don't rely on loose numeric
    // thresholds — they were falsely marking normal photos as "already vintage", etc.
    if (fit?.alreadyMatches && fit.currentStyle === targetStyle && !forceRestyle) {
        alreadyMatchesTarget = true
        gain = 0
    }

    // ── CREATIVE RESTYLE OVERRIDE ──
    // When the user asks for a style that differs from the current style,
    // ALWAYS apply the change regardless of what the model says. A normal
    // photo asked to look "vintage" or "cinematic" must get edited — the
    // model's "alreadyMatchesTarget" verdict is unreliable for these.
    if (isCreativeRestyle && !forceRestyle) {
        // Don't let the model or deterministic fit block a creative restyle
        if (currentStyle !== targetStyle) {
            alreadyMatchesTarget = false
        }
        // Enforce a visible gain floor so the user sees a real style shift
        if (gain < 0.35) {
            gain = 0.45
        }
    }

    // For non-creative prompts: if gain is near zero, mark as already matching
    if (!isCreativeRestyle && gain < 0.05) {
        alreadyMatchesTarget = true
        gain = 0
    }

    // Only apply the "well-exposed" gain bias for neutral/correction prompts.
    // Creative style changes (vintage, cinematic, etc.) should not be penalized
    // for having good exposure — that's exactly why the user wants a restyle.
    if (features && !alreadyMatchesTarget && !isCreativeRestyle) {
        const lum = features?.luminance?.mean
        const con = typeof features?.contrast === "number" ? features.contrast : null
        const isWellExposed = lum != null && lum >= 0.36 && lum <= 0.64
        const hasGoodContrast = con != null && con >= 0.45
        if (isWellExposed && hasGoodContrast) {
            gain = Math.min(gain, gain * 0.7)
            if (gain < 0.05) {
                alreadyMatchesTarget = true
                gain = 0
            }
        }
    }

    const imagekitAi = {
        retouch: !!(raw?.imagekitAi?.retouch ?? fallbackIntent.imagekitAi.retouch),
        bgRemove: !!(raw?.imagekitAi?.bgRemove ?? fallbackIntent.imagekitAi.bgRemove),
        upscale: !!(raw?.imagekitAi?.upscale ?? fallbackIntent.imagekitAi.upscale),
        sharpen: !!(raw?.imagekitAi?.sharpen ?? fallbackIntent.imagekitAi.sharpen),
        contrast: !!(raw?.imagekitAi?.contrast ?? false),
    }
    // Pass through any explicit adjustment deltas the model emitted. The planner
    // re-clamps/filters these, so we only need to coerce to finite numbers here.
    const adjustments = {}
    if (raw?.adjustments && typeof raw.adjustments === "object") {
        for (const [k, v] of Object.entries(raw.adjustments)) {
            const n = Number(v)
            if (Number.isFinite(n)) adjustments[k] = n
        }
    }
    const notes = alreadyMatchesTarget && gain === 0 && Object.keys(adjustments).length === 0
        ? `Image already matches the ${targetStyle} look, so no automatic changes were applied.`
        : String(raw?.notes || "").slice(0, 240)
    return { currentStyle, targetStyle, alreadyMatchesTarget, gain, imagekitAi, adjustments, notes }
}

const pHashBuckets = (pHash) => {
    if (!pHash || pHash.length !== 16) return { pHashHead: undefined, pHashTail: undefined }
    return { pHashHead: pHash.slice(0, 4), pHashTail: pHash.slice(12, 16) }
}

// Builds (or returns from cache) the edit plan for ONE image. Used by both the
// single-image legacy path and the multi-layer path (called per target layer).
const computePlanForImage = async ({
    sourceUrl,
    imageHash,
    pHash,
    features,
    prompt,
    promptKey,
    projectId,
    neonAuth,
    apiKey,
    // Flattened render of the LIVE canvas/layer (reflects manual edits). When
    // present it is what the vision model actually analyses — so the agent grades
    // what the user sees, not the original upload. sourceUrl is only the fallback.
    renderedImageBase64 = null,
    renderedImageMime = null,
}) => {
    // 1) Exact cache lookup — content-addressable, fast O(1).
    try {
        const cached = await runNeonQuery(
            "editPlanCache.getPlan",
            { imageHash, promptKey, plannerVersion: PLANNER_VERSION },
            { auth: neonAuth },
        )
        if (cached?.plan) {
            return { plan: cached.plan, features: cached.features, source: "cache", model: cached.model }
        }
    } catch (cacheError) {
        console.warn("[edit-plan] cache lookup failed:", cacheError?.message || cacheError)
    }

    // 2) Fuzzy lookup via perceptual hash. Catches the "user uploaded a slightly
    // different version of the same image" edge case — re-encoded JPEG, light
    // crop, resize, brightness shift. Same scene → same dHash buckets → same
    // plan, even though the exact pixel hash differs.
    const { pHashHead, pHashTail } = pHashBuckets(pHash)
    if (pHash && pHashHead && pHashTail) {
        try {
            const fuzzy = await runNeonQuery(
                "editPlanCache.getPlanFuzzy",
                {
                    pHash,
                    pHashHead,
                    pHashTail,
                    promptKey,
                    plannerVersion: PLANNER_VERSION,
                    threshold: 8,
                },
                { auth: neonAuth },
            )
            if (fuzzy?.plan) {
                return {
                    plan: fuzzy.plan,
                    features: fuzzy.features,
                    source: "fuzzy",
                    model: fuzzy.model,
                    matchedHash: fuzzy.matchedHash,
                    distance: fuzzy.distance,
                }
            }
        } catch (fuzzyError) {
            console.warn("[edit-plan] fuzzy lookup failed:", fuzzyError?.message || fuzzyError)
        }
    }

    const keywordIntent = inferKeywordIntent(prompt)
    let geminiVerdict = null
    let rawGeminiResponse = null
    let source = "fallback"

    if (apiKey) {
        try {
            // Prefer the client's live-canvas render (reflects manual edits). Only
            // fetch the source URL (original / last-applied image) as a fallback
            // when no render was supplied (e.g. a tainted canvas client-side).
            let fetched
            if (renderedImageBase64) {
                fetched = { base64: renderedImageBase64, mimeType: renderedImageMime || "image/jpeg" }
            } else {
                const standardizedUrl = buildStandardizedVisionUrl(sourceUrl)
                fetched = standardizedUrl ? await fetchImageAsBase64(standardizedUrl) : null
            }
            rawGeminiResponse = await callGemini({
                apiKey,
                model: GEMINI_MODEL,
                prompt,
                imageBase64: fetched?.base64,
                mimeType: fetched?.mimeType || "image/jpeg",
                features,
            })
            geminiVerdict = sanitizeGeminiVerdict(rawGeminiResponse, keywordIntent, features, prompt)
            source = "gemini"
        } catch (error) {
            console.warn("[edit-plan] Gemini failed for one image, falling back:", error?.message || error)
        }
    }

    const verdict =
        geminiVerdict ||
        sanitizeGeminiVerdict(
            {
                currentStyle: "neutral",
                targetStyle: keywordIntent.targetStyle,
                alreadyMatchesTarget: false,
                gain: 0.6,
                imagekitAi: keywordIntent.imagekitAi,
                notes:
                    keywordIntent.targetStyle === "neutral"
                        ? "Applied a balanced default look based on the image features."
                        : `Applied the "${keywordIntent.targetStyle}" preset inferred from your prompt.`,
            },
            keywordIntent,
            features,
            prompt,
        )

    // Explicit user tonal moves win over the model's suggested deltas per key.
    const directAdjustments = { ...(verdict.adjustments || {}), ...parseDirectAdjustments(prompt) }

    const plan = buildEditPlan({
        features,
        targetStyle: verdict.targetStyle,
        currentStyle: verdict.currentStyle,
        gain: verdict.gain,
        alreadyMatchesTarget: verdict.alreadyMatchesTarget,
        notes: verdict.notes,
        imagekitAi: verdict.imagekitAi,
        directAdjustments,
    })

    try {
        await runNeonMutation(
            "editPlanCache.savePlan",
            {
                imageHash,
                promptKey,
                plannerVersion: PLANNER_VERSION,
                plan,
                features,
                source,
                pHash,
                pHashHead,
                pHashTail,
                projectId,
                model: source === "gemini" ? GEMINI_MODEL : undefined,
                rawResponse: source === "gemini" ? rawGeminiResponse : undefined,
            },
            { auth: neonAuth },
        )
    } catch (saveError) {
        console.warn("[edit-plan] cache save failed:", saveError?.message || saveError)
    }

    return { plan, features, source, model: source === "gemini" ? GEMINI_MODEL : undefined }
}

// Multi-image targeting: ask Gemini "which of these labeled images is the user
// referring to?" The selection is cached by (canvasSignature, promptKey) so two
// users with the same canvas + same prompt always pick the same target images.
const resolveTargetLayers = async ({ layers, prompt, promptKey, neonAuth, apiKey }) => {
    const canvasSignature = buildCanvasSignature(layers)

    // Cache lookup
    try {
        const cached = await runNeonQuery(
            "canvasTargetCache.getTargets",
            { canvasSignature, promptKey, plannerVersion: PLANNER_VERSION },
            { auth: neonAuth },
        )
        if (cached?.targets) {
            return {
                targetIndexes: cached.targets,
                needsConfirmation: cached.needsConfirmation,
                reason: cached.reason,
                source: "cache",
                model: cached.model,
            }
        }
    } catch (cacheError) {
        console.warn("[edit-plan] target cache lookup failed:", cacheError?.message || cacheError)
    }

    // Try Gemini if configured, otherwise default to "ask the user".
    let raw = null
    if (apiKey) {
        try {
            raw = await callGeminiForTargeting({ apiKey, model: GEMINI_MODEL, prompt, layers })
        } catch (error) {
            console.warn("[edit-plan] Gemini targeting failed:", error?.message || error)
        }
    }

    const result = raw
        ? sanitizeTargeting(raw, layers.length)
        : { targetIndexes: layers.map((_, i) => i), needsConfirmation: true, reason: "No vision model configured — confirm which layers to edit." }

    // Save selection so subsequent identical canvases get the same answer.
    try {
        await runNeonMutation(
            "canvasTargetCache.saveTargets",
            {
                canvasSignature,
                promptKey,
                plannerVersion: PLANNER_VERSION,
                targets: result.targetIndexes,
                needsConfirmation: result.needsConfirmation,
                reason: result.reason,
                model: raw ? GEMINI_MODEL : undefined,
                rawResponse: raw || undefined,
            },
            { auth: neonAuth },
        )
    } catch (saveError) {
        console.warn("[edit-plan] target cache save failed:", saveError?.message || saveError)
    }

    return { ...result, source: raw ? "gemini" : "fallback", model: raw ? GEMINI_MODEL : undefined }
}

export async function POST(request) {
    try {
        const { userId } = await auth()
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        // Per-user rate limit. Protects the shared Gemini free quota from a
        // single runaway client. Generous limit (30/min) — well above any
        // human-interactive flow. No-op when Redis isn't configured.
        const limitResult = await enforceRateLimit("edit-plan", userId)
        const limited = rateLimitResponse(limitResult)
        if (limited) return limited

        const neonAuth = await getNeonAuthContext()

        const body = await request.json().catch(() => ({}))
        const projectId = body.projectId
        const prompt = String(body.prompt || "").slice(0, 1000)
        // Cap the layer count BEFORE anything fans out over it. An unbounded
        // layers[] would otherwise drive N concurrent fetches + N Gemini calls.
        // Also strip any thumbnail whose base64 is unreasonably large so it never
        // reaches the vision model.
        const layers = Array.isArray(body.layers)
            ? body.layers.slice(0, MAX_LAYERS).map((layer) => {
                  if (!layer || typeof layer !== "object") return layer
                  // Strip oversized payloads so they never reach the vision model;
                  // keep the rest of the layer (name/hash/sourceUrl) intact.
                  const sanitized = { ...layer }
                  if (
                      typeof sanitized.thumbBase64 === "string" &&
                      sanitized.thumbBase64.length > MAX_THUMB_BASE64_CHARS
                  ) {
                      delete sanitized.thumbBase64
                      delete sanitized.thumbMime
                  }
                  if (
                      typeof sanitized.renderedBase64 === "string" &&
                      sanitized.renderedBase64.length > MAX_RENDERED_BASE64_CHARS
                  ) {
                      delete sanitized.renderedBase64
                      delete sanitized.renderedMime
                  }
                  return sanitized
              })
            : null
        // Optional override from the client when the user has explicitly confirmed
        // (or de-selected) which layers to edit — bypasses the auto-targeting step.
        // Bounded to the same capped layer set below (i < layers.length).
        const overrideIndexes = Array.isArray(body.confirmedTargetIndexes)
            ? body.confirmedTargetIndexes
                  .map((n) => Number(n))
                  .filter((n) => Number.isInteger(n) && n >= 0)
                  .slice(0, MAX_LAYERS)
            : null

        if (!projectId) {
            return NextResponse.json({ error: "projectId required" }, { status: 400 })
        }

        const promptKey = normalizePromptKey(prompt)
        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY

        // ── Multi-layer path ──────────────────────────────────────────────
        // Activated when the client sends a `layers` array with 2+ entries.
        // Step 1: target which layers. Step 2: compute one plan per target,
        // each cached independently by content hash.
        if (layers && layers.length >= 2) {
            let targetIndexes
            let needsConfirmation = false
            let targetingReason = ""
            let targetingSource = "fallback"

            if (overrideIndexes && overrideIndexes.length > 0) {
                // User explicitly confirmed which layers — skip the targeting step.
                targetIndexes = overrideIndexes.filter((i) => i < layers.length)
                needsConfirmation = false
                targetingSource = "user-confirmed"
            } else {
                const targeting = await resolveTargetLayers({ layers, prompt, promptKey, neonAuth, apiKey })
                targetIndexes = targeting.targetIndexes
                needsConfirmation = targeting.needsConfirmation
                targetingReason = targeting.reason
                targetingSource = targeting.source
            }

            // If the targeting step needs the user to confirm, return candidates
            // WITHOUT computing per-layer plans (saves quota + latency).
            if (needsConfirmation) {
                return NextResponse.json({
                    success: true,
                    needsConfirmation: true,
                    candidates: targetIndexes,
                    reason: targetingReason,
                    targetingSource,
                })
            }

            // Defensive: never compute more than MAX_LAYERS plans even if a cached
            // targeting row somehow carried a longer list.
            const boundedTargetIndexes = targetIndexes.slice(0, MAX_LAYERS)

            // Compute one plan per targeted layer. Each call uses the per-image
            // cache (with perceptual-hash fallback) so common-image plans are O(1)
            // and "slightly-different version of the same scene" plans hit the fuzzy
            // cache. Fan-out is bounded to PLAN_FANOUT_CONCURRENCY so a large canvas
            // can't open N concurrent image fetches + N Gemini calls at once.
            const planFor = async (layerIndex) => {
                const layer = layers[layerIndex]
                if (!layer?.imageHash || !layer?.sourceUrl) {
                    return { layerIndex, error: "missing layer data" }
                }
                const result = await computePlanForImage({
                    sourceUrl: layer.sourceUrl,
                    imageHash: layer.imageHash,
                    pHash: layer.pHash || null,
                    features: layer.features || null,
                    prompt,
                    promptKey,
                    projectId,
                    neonAuth,
                    apiKey,
                    renderedImageBase64: layer.renderedBase64 || null,
                    renderedImageMime: layer.renderedMime || null,
                })
                return { layerIndex, ...result }
            }

            const plans = []
            for (let i = 0; i < boundedTargetIndexes.length; i += PLAN_FANOUT_CONCURRENCY) {
                const batch = boundedTargetIndexes.slice(i, i + PLAN_FANOUT_CONCURRENCY)
                const batchResults = await Promise.all(batch.map(planFor))
                plans.push(...batchResults)
            }

            return NextResponse.json({
                success: true,
                plans,
                targetingSource,
                targetingReason,
            })
        }

        // ── Single-layer legacy path ───────────────────────────────────────
        const sourceUrl = String(body.sourceUrl || "")
        const imageHash = String(body.imageHash || "").slice(0, 128)
        const pHash = body.pHash ? String(body.pHash).slice(0, 32) : null
        const features = body.features || null
        // Flattened live-canvas render — bounded so a client can't send an
        // unreasonably large payload to the vision model.
        const renderedImageBase64 =
            typeof body.renderedImageBase64 === "string" &&
            body.renderedImageBase64.length > 0 &&
            body.renderedImageBase64.length <= MAX_RENDERED_BASE64_CHARS
                ? body.renderedImageBase64
                : null
        const renderedImageMime =
            renderedImageBase64 && typeof body.renderedImageMime === "string"
                ? body.renderedImageMime
                : null

        if (!imageHash) {
            return NextResponse.json({ error: "imageHash or layers[] required" }, { status: 400 })
        }

        const result = await computePlanForImage({
            sourceUrl,
            imageHash,
            pHash,
            features,
                prompt,
                promptKey,
                projectId,
                neonAuth,
                apiKey,
                renderedImageBase64,
                renderedImageMime,
            })

        return NextResponse.json({
            success: true,
            plan: result.plan,
            features: result.features,
            source: result.source,
            model: result.model,
        })
    } catch (error) {
        // Keep the full error server-side for ops, but never leak the raw internal
        // message to the client. Only include details outside production.
        console.error("[edit-plan] failed:", error)
        const payload = { error: "Failed to build edit plan" }
        if (process.env.NODE_ENV !== "production") {
            payload.details = error?.message || String(error)
        }
        return NextResponse.json(payload, { status: 500 })
    }
}
