// /api/ai/inpaint
// ================
// Backend-selectable AI inpainting route. Supports two backends:
//   - "lama"  → proxy to the local Python mask service (LaMa, fast, free)
//   - "hf"    → Hugging Face Stable Diffusion inpainting (slower, creative)
//   - "auto"  → try LaMa first, fall back to HF SD on failure (default)
//
// The client sends an image + mask (white = inpaint region) as multipart.
// Returns the composited result as PNG.

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

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

// ─── Mask bounds detection ──────────────────────────────────────────────────

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

// ─── Normalize for HF SD model ──────────────────────────────────────────────

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

// ─── Composite the inpainted patch back ─────────────────────────────────────

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

// ─── Backend: LaMa via mask service ─────────────────────────────────────────

const callLamaInpaint = async (imageBuffer, maskBuffer, bounds) => {
  const maskServiceUrl = process.env.MASK_SERVICE_URL?.trim()
  if (!maskServiceUrl) {
    throw new Error('MASK_SERVICE_URL is not configured')
  }

  // Quick health check — does the service support /inpaint?
  try {
    const healthResp = await fetch(`${maskServiceUrl}/health`, { signal: AbortSignal.timeout(3000) })
    if (healthResp.ok) {
      const health = await healthResp.json()
      if (!health.lama_available) {
        throw new Error('LaMa not available on the mask service')
      }
    }
  } catch (err) {
    if (err?.message?.includes('LaMa not available')) throw err
    // Health check failed (timeout/network) — try anyway, the service might
    // support /inpaint even if /health is unreachable.
  }

  // Inpaint only the padded region AROUND the mask, not the whole photo —
  // LaMa runs at native resolution, so a 12MP full-frame pass on CPU takes
  // minutes (and would blow this route's timeout) while contributing nothing
  // outside the mask. The crop keeps native sharpness; the patch is
  // composited back over the original afterwards.
  const region = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }
  const [imageCrop, maskCrop] = await Promise.all([
    sharp(imageBuffer, { failOn: 'none' }).rotate().extract(region).png().toBuffer(),
    sharp(maskBuffer, { failOn: 'none' }).rotate().extract(region).greyscale().png().toBuffer(),
  ])

  const form = new FormData()
  form.append('image', new Blob([imageCrop], { type: 'image/png' }), 'image.png')
  form.append('mask', new Blob([maskCrop], { type: 'image/png' }), 'mask.png')

  console.info('[ai-inpaint] trying LaMa via mask service:', maskServiceUrl,
    `(region ${region.width}x${region.height} of ${bounds.sourceWidth}x${bounds.sourceHeight})`)
  let response
  try {
    response = await fetch(`${maskServiceUrl}/inpaint`, {
      method: 'POST',
      body: form,
      // First call lazy-loads the model; large regions are slow on CPU.
      signal: AbortSignal.timeout(110_000),
    })
  } catch (fetchErr) {
    const isTimeout = /timeout|abort/i.test(fetchErr?.message || '')
    throw new Error(
      isTimeout
        ? 'AI inpaint model is loading for the first time (downloading weights). This takes 30–90 seconds — please try again in a moment.'
        : `LaMa service unreachable: ${fetchErr?.message}`
    )
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`LaMa inpaint failed (${response.status}): ${text.slice(0, 200)}`)
  }

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.startsWith('image/')) {
    throw new Error('LaMa returned non-image response')
  }

  // Log cold-load for observability
  if (response.headers.get('x-cold-load') === 'true') {
    console.info('[ai-inpaint] LaMa cold load — first request after model download')
  }

  // Composite the inpainted patch back into the full image (mask-feathered,
  // same path the HF backend uses — the patch is already bounds-sized).
  const patch = Buffer.from(await response.arrayBuffer())
  return compositePatch(imageBuffer, maskBuffer, patch, bounds)
}

// ─── Backend: Hugging Face SD Inpainting ────────────────────────────────────

const HF_ENDPOINTS = [
  'https://router.huggingface.co/hf-inference/models',
  'https://api-inference.huggingface.co/models',
]

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
      console.info('[ai-inpaint] trying HF endpoint:', endpoint)
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
      console.warn('[ai-inpaint] HF endpoint failed:', endpoint, error?.message)
      lastError = error
      if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(error?.message || '')) continue
      throw error
    }
  }

  throw lastError || new Error('Hugging Face inpainting failed')
}

// ─── Route handler ──────────────────────────────────────────────────────────

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
    const requestedBackend = String(formData.get('backend') || 'auto').toLowerCase()

    const bounds = await getMaskBounds(maskBuffer)
    if (!bounds) {
      return NextResponse.json({ error: 'No selected pixels found' }, { status: 400 })
    }

    let finalBuffer = null
    let usedBackend = null

    // ── LaMa path (local mask service) ──
    const tryLama = requestedBackend === 'lama' || requestedBackend === 'auto'
    if (tryLama) {
      try {
        const lamaResult = await callLamaInpaint(imageBuffer, maskBuffer, bounds)
        finalBuffer = lamaResult
        usedBackend = 'lama'
      } catch (lamaErr) {
        console.warn('[ai-inpaint] LaMa failed:', lamaErr?.message)
        if (requestedBackend === 'lama') {
          // Explicit LaMa request — don't fall back
          return NextResponse.json(
            { error: `LaMa inpaint failed: ${lamaErr?.message}` },
            { status: 502 }
          )
        }
        // Auto mode — fall through to HF
      }
    }

    // ── HF SD path (Hugging Face Stable Diffusion) ──
    if (!finalBuffer) {
      try {
        const normalized = await normalizeForModel(imageBuffer, maskBuffer, bounds)
        const generated = await callHuggingFaceInpaint({
          image: normalized.image,
          mask: normalized.mask,
          prompt,
          width: normalized.modelWidth,
          height: normalized.modelHeight,
        })
        finalBuffer = await compositePatch(imageBuffer, maskBuffer, generated, bounds)
        usedBackend = 'hf'
      } catch (hfErr) {
        console.error('[ai-inpaint] HF SD failed:', hfErr?.message)
        return NextResponse.json(
          { error: hfErr?.message || 'Inpainting failed' },
          { status: /not configured/i.test(hfErr?.message || '') ? 501 : 500 }
        )
      }
    }

    return new NextResponse(finalBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'X-Inpaint-Backend': usedBackend,
      },
    })
  } catch (error) {
    console.error('[ai-inpaint] failed:', error)
    return NextResponse.json(
      { error: error?.message || 'Inpainting failed' },
      { status: 500 }
    )
  }
}
