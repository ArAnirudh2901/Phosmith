import { auth } from "@clerk/nextjs/server"
import ImageKit from "imagekit"
import { NextResponse } from "next/server"

export const maxDuration = 60

// Constants
const HF_TIMEOUT = 60000 // 60 seconds (Hugging Face can be slower on free tier)
const IMAGEKIT_TIMEOUT = 15000 // 15 seconds
const MAX_PROMPT_LENGTH = 500
const MIN_PROMPT_LENGTH = 3
const ALLOWED_IMAGE_SIZES = ['1024x1024', '1280x720', '720x1280']
const DEFAULT_IMAGE_SIZE = '1024x1024'
const HF_MODEL = process.env.HUGGINGFACE_MODEL || 'black-forest-labs/FLUX.1-schnell'
const HF_API_BASE_URL = process.env.HUGGINGFACE_API_BASE_URL || 'https://router.huggingface.co/hf-inference/models'

// Validation utilities
const validatePrompt = (prompt) => {
    if (!prompt || typeof prompt !== 'string') {
        return { valid: false, error: 'Prompt must be a non-empty string' }
    }

    const trimmed = prompt.trim()
    
    if (trimmed.length < MIN_PROMPT_LENGTH) {
        return { valid: false, error: `Prompt must be at least ${MIN_PROMPT_LENGTH} characters` }
    }

    if (trimmed.length > MAX_PROMPT_LENGTH) {
        return { valid: false, error: `Prompt must not exceed ${MAX_PROMPT_LENGTH} characters` }
    }

    return { valid: true, prompt: trimmed }
}

// Utility to add timeout to fetch
const fetchWithTimeout = (url, options = {}, timeoutMs = 30000) => {
    return Promise.race([
        fetch(url, options),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
        )
    ])
}

const getImageKitEndpoint = () => {
    const endpoint = process.env.NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT?.trim()
    if (!endpoint) return null
    return endpoint.replace(/\/+$/, "")
}

const getHuggingFaceEndpoint = () => {
    const baseUrl = HF_API_BASE_URL.trim().replace(/\/+$/, "")
    return `${baseUrl}/${HF_MODEL}`
}

async function generateImageWithHuggingFace(prompt, { raw = false } = {}) {
    const apiToken = process.env.HUGGINGFACE_API_TOKEN

    if (!apiToken) {
        throw new Error('Hugging Face API token is not configured')
    }

    if (apiToken === 'your-huggingface-api-token-here') {
        throw new Error('Hugging Face API token is not set. Please configure HUGGINGFACE_API_TOKEN in .env.local')
    }

    // `raw` callers (e.g. the collage "fit the photos" decorative themes) own the
    // full style description — appending "photorealistic" would fight an
    // illustration/watercolor/chalk look, so only the photo-style generator gets
    // the photoreal quality suffix.
    const enhancedPrompt = raw
        ? `${prompt} High quality, clean composition.`
        : `${prompt}. High quality, professional background, clean, no text, no logos, no watermark, photorealistic.`

    try {
        const response = await fetchWithTimeout(
            getHuggingFaceEndpoint(),
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json',
                    'Accept': 'image/png',
                },
                body: JSON.stringify({
                    inputs: enhancedPrompt,
                    parameters: {
                        negative_prompt: 'text, logo, watermark, blurry, low quality, distorted',
                        num_inference_steps: 4,
                    },
                }),
            },
            HF_TIMEOUT
        )

        if (!response.ok) {
            const contentType = response.headers.get('content-type')
            let errorData = {}
            
            try {
                if (contentType?.includes('application/json')) {
                    errorData = await response.json()
                } else {
                    const text = await response.text()
                    console.error('[AI Background] HF Error Response:', { status: response.status, text })
                }
            } catch (e) {
                // Ignore JSON parsing errors
            }

            const errorMessage = errorData?.error || `HTTP ${response.status}`
            console.error('[AI Background] Hugging Face API Error:', { status: response.status, errorMessage, errorData, model: HF_MODEL })

            if (response.status === 404) {
                throw new Error(
                    `Hugging Face model "${HF_MODEL}" was not found or is not available for text-to-image inference.`
                )
            }
            
            // Detect rate limiting / quota errors
            if (response.status === 429) {
                const retryAfter = response.headers.get('retry-after') || '60'
                const quotaError = new Error(
                    `Hugging Face API rate limited. Please try again in ${retryAfter} seconds. (Free tier has usage limits)`
                )
                quotaError.isRateLimited = true
                quotaError.retryAfter = retryAfter
                throw quotaError
            }

            if (response.status === 503) {
                const error = new Error(
                    'Hugging Face model is currently loading. Please try again in 10 seconds.'
                )
                error.isModelLoading = true
                throw error
            }

            throw new Error(`Hugging Face API error: ${errorMessage}`)
        }

        const contentType = response.headers.get('content-type') || ''
        if (!contentType.startsWith('image/')) {
            let errorMessage = 'Hugging Face did not return an image'
            try {
                const data = await response.json()
                errorMessage = data?.error || data?.message || errorMessage
            } catch {
                // Response was neither image data nor useful JSON.
            }
            throw new Error(errorMessage)
        }

        // Hugging Face returns the image directly as binary.
        const buffer = Buffer.from(await response.arrayBuffer())
        
        // Validate buffer size (max 10MB)
        if (buffer.length > 10 * 1024 * 1024) {
            throw new Error('Generated image is too large')
        }

        return buffer
    } catch (error) {
        if (error.message?.includes('timeout')) {
            throw new Error('Hugging Face image generation timed out. The model may be slow on free tier. Please try again.')
        }
        throw error
    }
}

async function uploadBufferToImageKit(buffer, fileName = null) {
    const endpoint = getImageKitEndpoint()
    const publicKey = process.env.NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY
    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY

    if (!privateKey || !publicKey || !endpoint) {
        throw new Error('ImageKit is not configured')
    }

    const client = new ImageKit({
        publicKey,
        privateKey,
        urlEndpoint: endpoint,
    })

    const timestamp = Date.now()
    const name = fileName || `ai-bg-${timestamp}.png`

    try {
        const uploadResponse = await Promise.race([
            client.upload({
                file: buffer.toString('base64'),
                fileName: name,
                folder: '/yt-projects/ai-backgrounds',
                useUniqueFileName: true,
                isBase64: true,
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('ImageKit upload timeout')), IMAGEKIT_TIMEOUT)
            )
        ])

        return uploadResponse.url
    } catch (error) {
        console.error('ImageKit upload failed:', error)
        throw error
    }
}

export async function POST(request) {
    // Authentication
    const { userId } = await auth()
    if (!userId) {
        return NextResponse.json(
            { error: "Unauthorized. Please sign in." },
            { status: 401, headers: { 'Cache-Control': 'no-store' } }
        )
    }

    // Request validation
    let body
    try {
        body = await request.json()
    } catch {
        return NextResponse.json(
            { error: "Invalid request body. Expected JSON." },
            { status: 400, headers: { 'Cache-Control': 'no-store' } }
        )
    }

    const { prompt, raw } = body || {}

    // Prompt validation
    const validation = validatePrompt(prompt)
    if (!validation.valid) {
        return NextResponse.json(
            { error: validation.error },
            { status: 400, headers: { 'Cache-Control': 'no-store' } }
        )
    }

    try {
        // Log request (sanitized)
        console.info('[AI Background] Generating image', {
            userId,
            promptLength: validation.prompt.length,
            timestamp: new Date().toISOString(),
        })

        // Generate image with Hugging Face
        const startTime = Date.now()
        const buffer = await generateImageWithHuggingFace(validation.prompt, { raw: raw === true })
        const generationTime = Date.now() - startTime

        console.info('[AI Background] Image generated successfully', {
            userId,
            bufferSize: buffer.length,
            generationTimeMs: generationTime,
        })

        // Upload to ImageKit (best effort)
        let imageUrl = null
        try {
            imageUrl = await uploadBufferToImageKit(buffer, `ai-bg-${Date.now()}.png`)
            console.info('[AI Background] Image uploaded to ImageKit', { userId })
        } catch (uploadError) {
            console.warn('[AI Background] ImageKit upload failed, using base64 fallback', {
                userId,
                error: uploadError.message,
            })

            // Fallback: return as data URL
            imageUrl = `data:image/png;base64,${buffer.toString('base64')}`
        }

        // Success response
        return NextResponse.json(
            {
                success: true,
                imageUrl,
                revisedPrompt: null,
            },
            {
                status: 200,
                headers: {
                    'Cache-Control': 'private, max-age=3600',
                    'Content-Type': 'application/json',
                }
            }
        )
    } catch (error) {
        // Error logging
        console.error('[AI Background] Image generation failed', {
            userId,
            error: error.message,
            isRateLimited: error.isRateLimited,
            isModelLoading: error.isModelLoading,
            timestamp: new Date().toISOString(),
        })

        // Determine appropriate status code and message
        let statusCode = 500
        let errorMessage = error.message || "Failed to generate image"

        if (error.isRateLimited) {
            statusCode = 429
            errorMessage = `API rate limited. Please try again in ${error.retryAfter || 60} seconds.`
        } else if (error.isModelLoading) {
            statusCode = 503
            errorMessage = "AI model is loading. Please try again in 10 seconds."
        } else if (error.message?.includes('timeout')) {
            statusCode = 504
            errorMessage = "Image generation timed out. Please try again."
        } else if (error.message?.includes('API token')) {
            statusCode = 500
            errorMessage = "Server configuration error. Please contact support."
        } else if (error.message?.includes('too large')) {
            statusCode = 413
            errorMessage = "Generated image is too large."
        }

        return NextResponse.json(
            { error: errorMessage },
            {
                status: statusCode,
                headers: {
                    'Cache-Control': 'no-store',
                    ...(statusCode === 429 && { 'Retry-After': error.retryAfter || '60' }),
                    ...(statusCode === 503 && { 'Retry-After': '10' })
                }
            }
        )
    }
}
