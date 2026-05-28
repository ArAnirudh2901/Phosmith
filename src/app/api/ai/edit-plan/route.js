// /api/ai/edit-plan
//
// AI Edit Agent v2 — single orchestration endpoint.
//
// Flow:
//   1. Auth (Clerk)
//   2. Look up cache (Neon editPlanCache) keyed by (projectId + imageHash + promptKey + plannerVersion)
//   3. Cache hit → return immediately. Same image + same prompt = byte-exact plan, forever.
//   4. Cache miss → ask Gemini 2.0 Flash (vision, temperature=0) what style the image is now and what
//      the user wants, then run the deterministic planner.
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
import { STYLE_KEYS } from "@/lib/style-profiles"
import { enforceRateLimit, rateLimitResponse } from "@/lib/rate-limit"

// Model is configurable via env so we can pin to a specific snapshot (e.g.
// "gemini-2.5-flash-002") for production. Default: "gemini-2.5-flash" — the
// frontier-class free-tier vision model as of May 2026 (1500 RPD, 1M TPM,
// 15 RPM, native multimodal, JSON mode, no card required).
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"
const GEMINI_ENDPOINT = (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
const GEMINI_TIMEOUT_MS = 12_000
const MAX_IMAGE_BYTES_FOR_VISION = 4 * 1024 * 1024 // 4 MB — fetch a downsized image if larger

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

// Map of keywords → preferred target style for the keyword fallback.
const KEYWORD_STYLE_HINTS = [
    [/cinemat|movie|filmic/i, "cinematic"],
    [/editorial|magazine/i, "editorial"],
    [/vibrant|punchy|bold|pop/i, "vibrant"],
    [/vintag|retro|film|analog/i, "vintage"],
    [/studio|clean|product/i, "studio"],
    [/portrait|skin|face|warm/i, "warm-portrait"],
    [/black\s*and\s*white|monochrome|b&?w/i, "bw-classic"],
]

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

const FORCE_RESTYLE_PATTERN =
    /\b(again|amplify|boost|dramatic|exaggerat\w*|extra|heavy|intense|max|more|push|strong(?:er|ly)?)\b/i

const wantsForcedRestyle = (prompt) => FORCE_RESTYLE_PATTERN.test(String(prompt || ""))

// Canonical prompt key. NFC-normalize so composed and decomposed Unicode
// (e.g. precomposed "é" vs "e + ◌́") collide to the same cache row.
const normalizePromptKey = (prompt) =>
    String(prompt || "")
        .normalize("NFC")
        .toLowerCase()
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

const fetchImageAsBase64 = async (url) => {
    if (!url) return null
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
    try {
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new Error(`Image fetch ${response.status}`)
        const contentType = response.headers.get("content-type") || "image/jpeg"
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
        generationConfig: {
            temperature: 0,
            topP: 0,
            topK: 1,
            seed: 42,
            responseMimeType: "application/json",
            maxOutputTokens: 256,
        },
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

const GEMINI_SYSTEM_PROMPT = `You are a senior photo retoucher analyzing an image and a user instruction.
Return STRICT JSON only, no prose, matching this schema exactly:

{
  "currentStyle": "<one of: ${STYLE_KEYS.join(", ")}>",
  "targetStyle":  "<one of the same enum>",
  "alreadyMatchesTarget": true|false,
  "gain": 0.0,
  "imagekitAi": { "retouch": false, "bgRemove": false, "upscale": false, "sharpen": false, "contrast": false },
  "notes": "<one or two short sentences explaining what you saw and what you'd do>"
}

## Analysis Framework — follow these steps IN ORDER:

1. **Exposure check**: Is the image well-exposed? Look at overall brightness.
   - Mean luminance 0.36–0.64 = good exposure, NO brightness adjustment needed.
   - Only flag if clearly under/over-exposed.

2. **Contrast check**: Does the image have good tonal separation between shadows and highlights?
   - If shadows are deep and highlights are clean, contrast is fine. Do NOT boost.
   - Only boost contrast for flat, washed-out images.

3. **Color check**: Are the colors well-balanced and appropriate for the scene?
   - If colors are already saturated and harmonious, do NOT increase saturation.
   - If the image has intentional desaturation (e.g. moody, cinematic), respect it.

4. **Style match**: Does the image already exhibit the characteristics of the target style?
   - Cinematic = crushed blacks, slight desaturation, warm tones, subtle grain
   - Editorial = crisp detail, slight contrast boost, vibrant but not oversaturated
   - Vibrant = punchy colors, high saturation, bright
   - If the image ALREADY has these characteristics, it ALREADY matches.

## Critical Rules:

- **DO NOT DOUBLE-PROCESS**: If the image already looks professionally edited,
  set alreadyMatchesTarget=true and gain=0. A cinematic image asked to be "cinematic"
  should get gain=0. An already-bright image asked to be "brighter" should get gain=0.
- **If 3 or more of the 4 checks above pass**, the image is already good —
  set alreadyMatchesTarget=true and gain=0.
- **Repeatability**: If the same instruction is applied to an already-edited image,
  ALWAYS return gain=0. Do not re-apply adjustments on top of existing ones.
- **Be conservative**: Subtlety beats over-processing. When in doubt, use a LOWER gain.

## Gain guidance:
  - 0.0 = no change needed (image already looks right for the target style)
  - 0.1–0.3 = subtle tweak (image is close but could use minor polish)
  - 0.4–0.6 = moderate adjustment (image needs visible correction)
  - 0.7–0.9 = strong change (image significantly differs from target)
  - 1.0 = maximum (only for dramatic style shifts like color→B&W)

- Use the imagekitAi booleans ONLY when the user EXPLICITLY asks for that AI transform
  (e.g. "remove background" → bgRemove=true). Never set these speculatively.
- Output JSON only.`

const STRICTER_RETRY_SUFFIX =
    "\n\nPrevious response was not valid JSON. YOU MUST RETURN VALID JSON. NO COMMENTS. NO MARKDOWN FENCES. NO PROSE. Only the object."

const callGeminiOnce = async ({ apiKey, model, prompt, imageBase64, mimeType, features, systemPrompt }) => {
    const userPart = {
        text: `User instruction: ${prompt || "(no specific instruction — apply a sensible default look)"}\n\nClient-computed image features:\n${JSON.stringify(features || {})}`,
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
        generationConfig: {
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
                    notes: { type: "STRING" },
                },
                required: ["currentStyle", "targetStyle", "alreadyMatchesTarget", "gain", "notes"],
            },
            maxOutputTokens: 512,
        },
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
        // Retry once with a stricter "JSON ONLY" suffix appended to the system prompt.
        console.warn("[edit-plan] Gemini first attempt failed, retrying with strict prompt:", firstError?.message)
        return await callGeminiOnce({
            ...params,
            systemPrompt: GEMINI_SYSTEM_PROMPT + STRICTER_RETRY_SUFFIX,
        })
    }
}

const sanitizeGeminiVerdict = (raw, fallbackIntent, features = null, prompt = "") => {
    const safeStyle = (s) => (STYLE_KEYS.includes(s) ? s : null)
    const keywordStyle = safeStyle(fallbackIntent?.targetStyle)
    const targetStyle =
        (keywordStyle && keywordStyle !== "neutral" ? keywordStyle : null) ||
        safeStyle(raw?.targetStyle) ||
        keywordStyle ||
        "neutral"
    const fit = features ? getStyleFit(features, targetStyle) : null
    const currentStyle = safeStyle(raw?.currentStyle) || fit?.currentStyle || "neutral"
    const forceRestyle = wantsForcedRestyle(prompt)
    let alreadyMatchesTarget =
        !forceRestyle && (!!raw?.alreadyMatchesTarget || currentStyle === targetStyle)
    let gainRaw = Number(raw?.gain)
    let gain = Number.isFinite(gainRaw) ? Math.max(0, Math.min(1, gainRaw)) : 0.6

    if (fit?.alreadyMatches && !forceRestyle) {
        alreadyMatchesTarget = true
        gain = 0
    }

    // If gain is near zero, force alreadyMatchesTarget to true for consistency
    if (gain < 0.05) {
        alreadyMatchesTarget = true
        gain = 0
    }

    // If the deterministic calibration says the image is close to the requested
    // style, cap the gain. This catches cases where the LLM misjudges a
    // well-edited image without blocking explicit "make it stronger" prompts.
    if (fit && !alreadyMatchesTarget && !forceRestyle) {
        if (fit.score >= 0.8) {
            gain = Math.min(gain, 0.18)
        } else if (fit.score >= 0.65) {
            gain = Math.min(gain, 0.32)
        }
    }

    // If the client-provided features show the image is already well-exposed
    // and has decent contrast, bias the gain down to prevent over-processing.
    // This catches broad "make it premium" prompts on images that already read
    // as finished even if they don't fit a named preset exactly.
    if (features && !alreadyMatchesTarget) {
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
    const notes = alreadyMatchesTarget && gain === 0
        ? `Image already matches the ${targetStyle} look, so no automatic changes were applied.`
        : String(raw?.notes || "").slice(0, 240)
    return { currentStyle, targetStyle, alreadyMatchesTarget, gain, imagekitAi, notes }
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
            const standardizedUrl = buildStandardizedVisionUrl(sourceUrl)
            const fetched = standardizedUrl ? await fetchImageAsBase64(standardizedUrl) : null
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

    const plan = buildEditPlan({
        features,
        targetStyle: verdict.targetStyle,
        currentStyle: verdict.currentStyle,
        gain: verdict.gain,
        alreadyMatchesTarget: verdict.alreadyMatchesTarget,
        notes: verdict.notes,
        imagekitAi: verdict.imagekitAi,
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
        const layers = Array.isArray(body.layers) ? body.layers : null
        // Optional override from the client when the user has explicitly confirmed
        // (or de-selected) which layers to edit — bypasses the auto-targeting step.
        const overrideIndexes = Array.isArray(body.confirmedTargetIndexes)
            ? body.confirmedTargetIndexes
                  .map((n) => Number(n))
                  .filter((n) => Number.isInteger(n) && n >= 0)
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

            // Compute one plan per targeted layer in parallel. Each call uses
            // the per-image cache (with perceptual-hash fallback) so common-image
            // plans are O(1) and "slightly-different version of the same scene"
            // plans hit the fuzzy cache.
            const plans = await Promise.all(
                targetIndexes.map(async (layerIndex) => {
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
                    })
                    return { layerIndex, ...result }
                }),
            )

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
            })

        return NextResponse.json({
            success: true,
            plan: result.plan,
            features: result.features,
            source: result.source,
            model: result.model,
        })
    } catch (error) {
        console.error("[edit-plan] failed:", error)
        return NextResponse.json(
            { error: "Failed to build edit plan", details: error?.message || String(error) },
            { status: 500 },
        )
    }
}
