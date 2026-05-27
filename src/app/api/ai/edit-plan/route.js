// /api/ai/edit-plan
//
// AI Edit Agent v2 — single orchestration endpoint.
//
// Flow:
//   1. Auth (Clerk)
//   2. Look up cache (Convex editPlanCache) keyed by (projectId + imageHash + promptKey + plannerVersion)
//   3. Cache hit → return immediately. Same image + same prompt = byte-exact plan, forever.
//   4. Cache miss → ask Gemini 2.0 Flash (vision, temperature=0) what style the image is now and what
//      the user wants, then run the deterministic planner.
//   5. Persist the plan into the cache and return it.
//
// If GEMINI_API_KEY is not configured (or the call fails), we fall back to a pure
// rule-based planner that uses prompt keywords + the client's computed feature vector.

import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { fetchMutation, fetchQuery } from "convex/nextjs"
import { api } from "../../../../../convex/_generated/api"
import { buildEditPlan, PLANNER_VERSION } from "@/lib/edit-planner"
import { STYLE_KEYS } from "@/lib/style-profiles"

const GEMINI_ENDPOINT =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
const GEMINI_TIMEOUT_MS = 12_000
const MAX_IMAGE_BYTES_FOR_VISION = 4 * 1024 * 1024 // 4 MB — fetch a downsized image if larger

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

const normalizePromptKey = (prompt) =>
    String(prompt || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()

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

Rules:
- Look at the image carefully. If the photo already matches what the user is asking for,
  set alreadyMatchesTarget=true and gain=0 — do not "double process" a finished look.
- gain is 0.0–1.0. 0.6 is a normal adjustment, 0.9 is strong, 1.0 is maximum.
- Be conservative. Subtlety beats over-processing.
- Use the imagekitAi booleans only when the user explicitly asks for that AI transform
  (e.g. "remove background" → bgRemove=true).
- Output JSON only.`

const callGemini = async ({ apiKey, prompt, imageBase64, mimeType, features }) => {
    const userPart = {
        text: `User instruction: ${prompt || "(no specific instruction — apply a sensible default look)"}\n\nClient-computed image features:\n${JSON.stringify(features || {})}`,
    }
    const body = {
        systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
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
            responseMimeType: "application/json",
            maxOutputTokens: 512,
        },
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
    try {
        const response = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
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

const sanitizeGeminiVerdict = (raw, fallbackIntent) => {
    const safeStyle = (s) => (STYLE_KEYS.includes(s) ? s : null)
    const targetStyle =
        safeStyle(raw?.targetStyle) || safeStyle(fallbackIntent.targetStyle) || "neutral"
    const currentStyle = safeStyle(raw?.currentStyle) || "neutral"
    const alreadyMatchesTarget = !!raw?.alreadyMatchesTarget || currentStyle === targetStyle
    const gainRaw = Number(raw?.gain)
    const gain = Number.isFinite(gainRaw) ? Math.max(0, Math.min(1, gainRaw)) : 0.6
    const imagekitAi = {
        retouch: !!(raw?.imagekitAi?.retouch ?? fallbackIntent.imagekitAi.retouch),
        bgRemove: !!(raw?.imagekitAi?.bgRemove ?? fallbackIntent.imagekitAi.bgRemove),
        upscale: !!(raw?.imagekitAi?.upscale ?? fallbackIntent.imagekitAi.upscale),
        sharpen: !!(raw?.imagekitAi?.sharpen ?? fallbackIntent.imagekitAi.sharpen),
        contrast: !!(raw?.imagekitAi?.contrast ?? false),
    }
    const notes = String(raw?.notes || "").slice(0, 240)
    return { currentStyle, targetStyle, alreadyMatchesTarget, gain, imagekitAi, notes }
}

export async function POST(request) {
    try {
        const { userId, getToken, sessionClaims } = await auth()
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }
        const token =
            sessionClaims?.aud === "convex"
                ? await getToken()
                : await getToken({ template: "convex" })
        if (!token) {
            return NextResponse.json({ error: "Missing Convex auth token" }, { status: 500 })
        }

        const body = await request.json().catch(() => ({}))
        const projectId = body.projectId
        const prompt = String(body.prompt || "").slice(0, 1000)
        const sourceUrl = String(body.sourceUrl || "")
        const imageHash = String(body.imageHash || "").slice(0, 128)
        const features = body.features || null

        if (!projectId) {
            return NextResponse.json({ error: "projectId required" }, { status: 400 })
        }
        if (!imageHash) {
            return NextResponse.json({ error: "imageHash required" }, { status: 400 })
        }

        const promptKey = normalizePromptKey(prompt)

        // 1) Cache lookup — same composite key → same plan, no recomputation.
        try {
            const cached = await fetchQuery(
                api.editPlanCache.getPlan,
                { projectId, imageHash, promptKey, plannerVersion: PLANNER_VERSION },
                { token },
            )
            if (cached?.plan) {
                return NextResponse.json({
                    success: true,
                    plan: cached.plan,
                    features: cached.features,
                    source: "cache",
                })
            }
        } catch (cacheError) {
            console.warn("[edit-plan] cache lookup failed:", cacheError?.message || cacheError)
        }

        const keywordIntent = inferKeywordIntent(prompt)

        // 2) Gemini call (only on cache miss, only if configured)
        let geminiVerdict = null
        let source = "fallback"
        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY
        if (apiKey) {
            try {
                const fetched = sourceUrl ? await fetchImageAsBase64(sourceUrl) : null
                const raw = await callGemini({
                    apiKey,
                    prompt,
                    imageBase64: fetched?.base64,
                    mimeType: fetched?.mimeType || "image/jpeg",
                    features,
                })
                geminiVerdict = sanitizeGeminiVerdict(raw, keywordIntent)
                source = "gemini"
            } catch (error) {
                console.warn("[edit-plan] Gemini failed, falling back to keyword planner:", error?.message || error)
            }
        }

        const verdict =
            geminiVerdict ||
            // Deterministic keyword fallback
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
            )

        // 3) Pure planner
        const plan = buildEditPlan({
            features,
            targetStyle: verdict.targetStyle,
            currentStyle: verdict.currentStyle,
            gain: verdict.gain,
            alreadyMatchesTarget: verdict.alreadyMatchesTarget,
            notes: verdict.notes,
            imagekitAi: verdict.imagekitAi,
        })

        // 4) Persist for next time
        try {
            await fetchMutation(
                api.editPlanCache.savePlan,
                {
                    projectId,
                    imageHash,
                    promptKey,
                    plannerVersion: PLANNER_VERSION,
                    plan,
                    features,
                    source,
                },
                { token },
            )
        } catch (saveError) {
            console.warn("[edit-plan] cache save failed:", saveError?.message || saveError)
        }

        return NextResponse.json({ success: true, plan, features, source })
    } catch (error) {
        console.error("[edit-plan] failed:", error)
        return NextResponse.json(
            { error: "Failed to build edit plan", details: error?.message || String(error) },
            { status: 500 },
        )
    }
}
