import { auth } from "@clerk/nextjs/server"
import ImageKit from "imagekit"
import { NextResponse } from "next/server"

export const maxDuration = 120

// ─── Constants ───
const HF_TIMEOUT = 90_000              // 90s — outpainting is heavier than text-to-image
const IMAGEKIT_TIMEOUT = 20_000        // 20s for upload
const MAX_RETRIES = 3                  // auto-retry on 503 (model loading)
const RETRY_BASE_DELAY = 5_000         // 5s base delay between retries
const MAX_PAYLOAD_SIZE = 20_000_000    // 20 MB max incoming base64 payload
const MAX_PROMPT_LENGTH = 500
const MIN_PROMPT_LENGTH = 2

// Hugging Face inpainting model
// Using Stable Diffusion XL Inpainting for highest-quality outpainting.
// Falls back to runwayml/stable-diffusion-inpainting if not available.
const HF_INPAINTING_MODEL =
    process.env.HUGGINGFACE_INPAINTING_MODEL ||
    "diffusers/stable-diffusion-xl-1.0-inpainting-0.1"

const HF_FALLBACK_MODEL = "runwayml/stable-diffusion-inpainting"

const HF_API_BASE_URL = (
    process.env.HUGGINGFACE_API_BASE_URL || "https://router.huggingface.co/hf-inference/models"
).replace(/\/+$/, "")

// ─── Validation ───
const validatePrompt = (prompt) => {
    if (!prompt || typeof prompt !== "string") {
        return { valid: false, error: "Prompt must be a non-empty string" }
    }
    const trimmed = prompt.trim()
    if (trimmed.length < MIN_PROMPT_LENGTH)
        return { valid: false, error: `Prompt must be at least ${MIN_PROMPT_LENGTH} characters` }
    if (trimmed.length > MAX_PROMPT_LENGTH)
        return { valid: false, error: `Prompt must not exceed ${MAX_PROMPT_LENGTH} characters` }
    return { valid: true, prompt: trimmed }
}

const validateBase64Image = (data, label) => {
    if (!data || typeof data !== "string") {
        return { valid: false, error: `${label} is required` }
    }
    // Accept both raw base64 and data-URL prefixed
    const raw = data.replace(/^data:image\/\w+;base64,/, "")
    if (raw.length > MAX_PAYLOAD_SIZE) {
        return { valid: false, error: `${label} is too large (max ${MAX_PAYLOAD_SIZE / 1e6} MB)` }
    }
    return { valid: true, data: raw }
}

// ─── Fetch helper with timeout ───
const fetchWithTimeout = (url, options = {}, timeoutMs = 30_000) =>
    Promise.race([
        fetch(url, options),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Request timeout")), timeoutMs)
        ),
    ])

// ─── Sleep helper ───
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ─── ImageKit upload ───
const getImageKitClient = () => {
    const endpoint = process.env.NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT?.trim()?.replace(/\/+$/, "")
    const publicKey = process.env.NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY
    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY

    if (!privateKey || !publicKey || !endpoint) return null

    return new ImageKit({ publicKey, privateKey, urlEndpoint: endpoint })
}

const uploadBufferToImageKit = async (buffer) => {
    const client = getImageKitClient()
    if (!client) return null

    const uploadResponse = await Promise.race([
        client.upload({
            file: buffer,
            fileName: `outpaint-${Date.now()}.png`,
            folder: "/yt-projects/ai-outpainting",
            useUniqueFileName: true,
            isBase64: true,
        }),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error("ImageKit upload timeout")), IMAGEKIT_TIMEOUT)
        ),
    ])

    return uploadResponse.url
}

// ─── Hugging Face Inpainting ───
async function callInpaintingModel(modelId, imageBase64, maskBase64, prompt, attempt = 1) {
    const apiToken = process.env.HUGGINGFACE_API_TOKEN
    if (!apiToken || apiToken === "your-huggingface-api-token-here") {
        throw new Error("Hugging Face API token is not configured")
    }

    const enhancedPrompt = `${prompt}. Seamless outpainting, photorealistic, high quality, consistent lighting, natural edges, no artifacts, no seams.`

    const endpoint = `${HF_API_BASE_URL}/${modelId}`

    console.info("[AI Outpaint] Calling model", {
        model: modelId,
        attempt,
        promptLength: prompt.length,
    })

    const response = await fetchWithTimeout(
        endpoint,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiToken}`,
                "Content-Type": "application/json",
                Accept: "image/png",
            },
            body: JSON.stringify({
                inputs: enhancedPrompt,
                parameters: {
                    image: imageBase64,
                    mask_image: maskBase64,
                    negative_prompt:
                        "blurry, distorted, artifacts, seams, visible edges, text, watermark, low quality, deformed",
                    num_inference_steps: 30,
                    guidance_scale: 7.5,
                    strength: 0.99,
                },
            }),
        },
        HF_TIMEOUT
    )

    if (!response.ok) {
        const status = response.status

        // Try to parse error body
        let errorMessage = `HTTP ${status}`
        try {
            const ct = response.headers.get("content-type") || ""
            if (ct.includes("application/json")) {
                const data = await response.json()
                errorMessage = data?.error || data?.message || errorMessage
            }
        } catch {
            // ignore
        }

        // 503 — model loading, retry automatically
        if (status === 503 && attempt <= MAX_RETRIES) {
            const delay = RETRY_BASE_DELAY * attempt
            console.warn(`[AI Outpaint] Model loading (503), retry ${attempt}/${MAX_RETRIES} in ${delay}ms`)
            await sleep(delay)
            return callInpaintingModel(modelId, imageBase64, maskBase64, prompt, attempt + 1)
        }

        // 429 — rate limited
        if (status === 429) {
            const retryAfter = response.headers.get("retry-after") || "60"
            const err = new Error(`Rate limited. Please try again in ${retryAfter} seconds.`)
            err.statusCode = 429
            err.retryAfter = retryAfter
            throw err
        }

        // 404 — model not found, signal to try fallback
        if (status === 404) {
            const err = new Error(`Model "${modelId}" not found or unavailable.`)
            err.statusCode = 404
            throw err
        }

        const err = new Error(`Hugging Face API error: ${errorMessage}`)
        err.statusCode = status
        throw err
    }

    // Validate response is an image
    const contentType = response.headers.get("content-type") || ""
    if (!contentType.startsWith("image/")) {
        let errMsg = "Hugging Face did not return an image"
        try {
            const data = await response.json()
            errMsg = data?.error || data?.message || errMsg
        } catch {
            // ignore
        }
        throw new Error(errMsg)
    }

    const buffer = Buffer.from(await response.arrayBuffer())

    // Sanity check: buffer shouldn't be empty
    if (buffer.length < 100) {
        throw new Error("Received empty or corrupt image data")
    }

    return buffer
}

// ─── Main outpainting function with model fallback ───
async function generateOutpainting(imageBase64, maskBase64, prompt) {
    try {
        return await callInpaintingModel(HF_INPAINTING_MODEL, imageBase64, maskBase64, prompt)
    } catch (primaryError) {
        // If primary model not found (404), try fallback
        if (primaryError.statusCode === 404 && HF_INPAINTING_MODEL !== HF_FALLBACK_MODEL) {
            console.warn(
                `[AI Outpaint] Primary model failed (${primaryError.message}), trying fallback: ${HF_FALLBACK_MODEL}`
            )
            try {
                return await callInpaintingModel(HF_FALLBACK_MODEL, imageBase64, maskBase64, prompt)
            } catch (fallbackError) {
                console.error("[AI Outpaint] Fallback model also failed:", fallbackError.message)
                throw fallbackError
            }
        }
        throw primaryError
    }
}

// ─── POST handler ───
export async function POST(request) {
    // Auth
    const { userId } = await auth()
    if (!userId) {
        return NextResponse.json(
            { error: "Unauthorized. Please sign in." },
            { status: 401, headers: { "Cache-Control": "no-store" } }
        )
    }

    // Parse body
    let body
    try {
        body = await request.json()
    } catch {
        return NextResponse.json(
            { error: "Invalid request body. Expected JSON." },
            { status: 400, headers: { "Cache-Control": "no-store" } }
        )
    }

    const { prompt, mask, image, width, height } = body || {}

    // ── Validate prompt ──
    const promptValidation = validatePrompt(prompt)
    if (!promptValidation.valid) {
        return NextResponse.json(
            { error: promptValidation.error },
            { status: 400, headers: { "Cache-Control": "no-store" } }
        )
    }

    // ── Validate images ──
    const imageValidation = validateBase64Image(image, "Base image")
    if (!imageValidation.valid) {
        return NextResponse.json(
            { error: imageValidation.error },
            { status: 400, headers: { "Cache-Control": "no-store" } }
        )
    }

    const maskValidation = validateBase64Image(mask, "Mask image")
    if (!maskValidation.valid) {
        return NextResponse.json(
            { error: maskValidation.error },
            { status: 400, headers: { "Cache-Control": "no-store" } }
        )
    }

    // ── Validate dimensions ──
    const w = parseInt(width, 10)
    const h = parseInt(height, 10)
    if (!w || !h || w < 64 || h < 64 || w > 4096 || h > 4096) {
        return NextResponse.json(
            { error: "Invalid dimensions. Width and height must be between 64 and 4096 pixels." },
            { status: 400, headers: { "Cache-Control": "no-store" } }
        )
    }

    try {
        console.info("[AI Outpaint] Starting outpainting", {
            userId,
            promptLength: promptValidation.prompt.length,
            dimensions: `${w}x${h}`,
            timestamp: new Date().toISOString(),
        })

        const startTime = Date.now()

        // Call Hugging Face inpainting
        const buffer = await generateOutpainting(
            imageValidation.data,
            maskValidation.data,
            promptValidation.prompt
        )

        const generationTime = Date.now() - startTime
        console.info("[AI Outpaint] Image generated successfully", {
            userId,
            bufferSize: buffer.length,
            generationTimeMs: generationTime,
        })

        // Upload to ImageKit (best effort, fallback to base64)
        let imageUrl = null
        try {
            imageUrl = await uploadBufferToImageKit(buffer)
            if (imageUrl) {
                console.info("[AI Outpaint] Uploaded to ImageKit", { userId })
            }
        } catch (uploadError) {
            console.warn("[AI Outpaint] ImageKit upload failed, using base64 fallback", {
                userId,
                error: uploadError.message,
            })
        }

        if (!imageUrl) {
            imageUrl = `data:image/png;base64,${buffer.toString("base64")}`
        }

        return NextResponse.json(
            {
                success: true,
                imageUrl,
                width: w,
                height: h,
            },
            {
                status: 200,
                headers: {
                    "Cache-Control": "private, max-age=3600",
                    "Content-Type": "application/json",
                },
            }
        )
    } catch (error) {
        console.error("[AI Outpaint] Failed", {
            userId,
            error: error.message,
            statusCode: error.statusCode,
            timestamp: new Date().toISOString(),
        })

        let statusCode = error.statusCode || 500
        let errorMessage = error.message || "Failed to generate outpainted image"

        if (error.message?.includes("timeout")) {
            statusCode = 504
            errorMessage = "Image generation timed out. Please try again with a smaller region."
        } else if (error.message?.includes("API token")) {
            statusCode = 500
            errorMessage = "Server configuration error. Please contact support."
        }

        return NextResponse.json(
            { error: errorMessage },
            {
                status: statusCode,
                headers: {
                    "Cache-Control": "no-store",
                    ...(statusCode === 429 && { "Retry-After": error.retryAfter || "60" }),
                    ...(statusCode === 503 && { "Retry-After": "10" }),
                },
            }
        )
    }
}
