// /api/ai/inpaint
// ===============
// ⚠️  WORK IN PROGRESS — NO FRONTEND CALLER
// =========================================
// This route is fully implemented (Hugging Face Stable Diffusion
// inpainting, sharp pipeline, mask-bounds detection, edge-aware
// composite) but no editor tool invokes it yet. The route builds
// and deploys; calling it directly will incur a Hugging Face API
// bill without producing any visible UI result.
//
// Audit (2025-06): no `fetch('/api/ai/inpaint')` in `src/` or
// `hooks/`. The companion `/api/ai/outpaint` route does not exist;
// "outpaint" is just a keyword in the ImageKit Agent's intent
// parser (mapped to `/api/ai/extend`).
//
// Status: keep the route around as scaffolding for a future
// inpaint tool. The build / lint / verify suites still pass.
// See README.md "Scripts" → verify-inpaint (TODO) for the planned
// end-to-end test.

import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import sharp from 'sharp'
import { enforceRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export const maxDuration = 120
export const runtime = 'nodejs'

const MAX_INPUT_BYTES = 24 * 1024 * 1024
const MAX_MODEL_SIDE = 1024
const DEFAULT_MODEL = 'stable-diffusion-v1-5/stable-diffusion-inpainting'

const fileToBuffer = async (file, label) => {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error(`${label} is required`)
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(`${label} is too large`)
  }
  const contentType = file.type || 'image/png'
  if (!contentType.startsWith('image/')) {
    throw new Error(`${label} must be an image`)
  }
  return Buffer.from(await file.arrayBuffer())
}

const dataUrl = (buffer, contentType = 'image/png') =>
  `data:${contentType};base64,${buffer.toString('base64')}`

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const getMaskBounds = async (maskBuffer) => {
  const { data, info } = await sharp(maskBuffer, { failOn: 'none' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height } = info
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      if (data[row + x] <= 16) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  if (maxX < minX || maxY < minY) return null

  const boxW = maxX - minX + 1
  const boxH = maxY - minY + 1
  const pad = clamp(Math.round(Math.max(boxW, boxH) * 0.35), 32, 220)
  const left = clamp(minX - pad, 0, width - 1)
  const top = clamp(minY - pad, 0, height - 1)
  const right = clamp(maxX + pad, 0, width - 1)
  const bottom = clamp(maxY + pad, 0, height - 1)

  return {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
    sourceWidth: width,
    sourceHeight: height,
  }
}

const normalizeForModel = async (imageBuffer, maskBuffer, bounds) => {
  const maxSide = Math.max(bounds.width, bounds.height)
  const scale = Math.min(1, MAX_MODEL_SIDE / maxSide)
  const modelWidth = Math.max(64, Math.round(bounds.width * scale))
  const modelHeight = Math.max(64, Math.round(bounds.height * scale))

  const imageCrop = sharp(imageBuffer, { failOn: 'none' })
    .rotate()
    .extract({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })
    .resize(modelWidth, modelHeight, { fit: 'fill' })
    .png()

  const maskCrop = sharp(maskBuffer, { failOn: 'none' })
    .rotate()
    .extract({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })
    .resize(modelWidth, modelHeight, { fit: 'fill', kernel: 'nearest' })
    .greyscale()
    .threshold(16)
    .png()

  const [image, mask] = await Promise.all([imageCrop.toBuffer(), maskCrop.toBuffer()])
  return { image, mask, modelWidth, modelHeight }
}

const extractImageBuffer = async (response) => {
  const contentType = response.headers.get('content-type') || ''
  if (response.ok && contentType.startsWith('image/')) {
    return Buffer.from(await response.arrayBuffer())
  }

  const raw = await response.text().catch(() => '')
  let parsed = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    parsed = null
  }

  const possible =
    parsed?.image ||
    parsed?.generated_image ||
    parsed?.output?.[0] ||
    parsed?.images?.[0] ||
    (Array.isArray(parsed) ? parsed[0]?.image || parsed[0]?.generated_image : null)

  if (typeof possible === 'string') {
    const base64 = possible.includes(',') ? possible.split(',').pop() : possible
    return Buffer.from(base64, 'base64')
  }

  const message = parsed?.error || parsed?.message || raw.slice(0, 240) || `HTTP ${response.status}`
  throw new Error(message)
}

const HF_ENDPOINTS = [
  // Primary: the router endpoint (same one used by the working background generation route)
  'https://router.huggingface.co/hf-inference/models',
  // Fallback: the legacy endpoint
  'https://api-inference.huggingface.co/models',
]

const callHuggingFaceInpaint = async ({ image, mask, prompt, width, height }) => {
  const token = process.env.HUGGINGFACE_API_TOKEN?.trim()
  if (!token) {
    throw new Error('HUGGINGFACE_API_TOKEN is not configured')
  }

  const model = process.env.HUGGINGFACE_INPAINT_MODEL?.trim() || DEFAULT_MODEL
  const negativePrompt = [
    'random dots',
    'speckles',
    'artifacts',
    'new objects',
    'distorted texture',
    'low quality',
    'blurry',
  ].join(', ')

  const common = {
    prompt,
    negative_prompt: negativePrompt,
    num_inference_steps: 32,
    guidance_scale: 6.5,
    strength: 0.82,
    width,
    height,
  }

  const imageB64 = image.toString('base64')
  const maskB64 = mask.toString('base64')
  const payload = {
    inputs: {
      prompt,
      image: imageB64,
      mask_image: maskB64,
    },
    parameters: common,
    options: { wait_for_model: true, use_cache: false },
  }

  let lastError = null
  for (const baseUrl of HF_ENDPOINTS) {
    const endpoint = `${baseUrl}/${model}`
    try {
      console.info('[ai-inpaint] trying endpoint:', endpoint)
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'image/png,image/jpeg,application/json',
        },
        body: JSON.stringify(payload),
      })
      return await extractImageBuffer(response)
    } catch (error) {
      console.warn('[ai-inpaint] endpoint failed:', endpoint, error?.message)
      lastError = error
      // DNS / network errors → try the next endpoint
      if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(error?.message || '')) continue
      // Other errors (e.g. model errors) → don't retry with a different host
      throw error
    }
  }

  throw lastError || new Error('Hugging Face inpainting failed')
}

const compositePatch = async (imageBuffer, maskBuffer, generatedBuffer, bounds) => {
  const patchRgb = await sharp(generatedBuffer, { failOn: 'none' })
    .resize(bounds.width, bounds.height, { fit: 'fill' })
    .removeAlpha()
    .png()
    .toBuffer()

  const alpha = await sharp(maskBuffer, { failOn: 'none' })
    .rotate()
    .extract({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })
    .resize(bounds.width, bounds.height, { fit: 'fill', kernel: 'nearest' })
    .greyscale()
    .threshold(16)
    .blur(1.2)
    .png()
    .toBuffer()

  const patch = await sharp(patchRgb, { failOn: 'none' })
    .joinChannel(alpha)
    .png()
    .toBuffer()

  return sharp(imageBuffer, { failOn: 'none' })
    .rotate()
    .composite([{ input: patch, left: bounds.left, top: bounds.top }])
    .png()
    .toBuffer()
}

export async function POST(request) {
  try {
    const { userId } = await auth()
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limited = rateLimitResponse(await enforceRateLimit('ai-inpaint', userId))
    if (limited) return limited

    const formData = await request.formData()
    const imageBuffer = await fileToBuffer(formData.get('image'), 'image')
    const maskBuffer = await fileToBuffer(formData.get('mask'), 'mask')
    const prompt = String(
      formData.get('prompt') ||
        'remove the selected object and naturally continue the surrounding background texture, realistic photo cleanup'
    )

    const bounds = await getMaskBounds(maskBuffer)
    if (!bounds) {
      return NextResponse.json({ error: 'No selected pixels found' }, { status: 400 })
    }

    const normalized = await normalizeForModel(imageBuffer, maskBuffer, bounds)
    const generated = await callHuggingFaceInpaint({
      image: normalized.image,
      mask: normalized.mask,
      prompt,
      width: normalized.modelWidth,
      height: normalized.modelHeight,
    })

    const finalBuffer = await compositePatch(imageBuffer, maskBuffer, generated, bounds)
    return new NextResponse(finalBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    console.error('[ai-inpaint] failed:', error)
    return NextResponse.json(
      { error: error?.message || 'Inpainting failed' },
      { status: /not configured/i.test(error?.message || '') ? 501 : 500 }
    )
  }
}
