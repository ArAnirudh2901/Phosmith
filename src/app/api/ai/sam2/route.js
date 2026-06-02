import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import sharp from 'sharp'
import { enforceRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export const maxDuration = 120
export const runtime = 'nodejs'

/* ═══════════════════════════════════════════════════════════════════════════
 * SAM 2 click-to-select semantic masking
 *
 * The Next.js route here is a thin proxy in front of the local Python
 * service (`services/segment/`), which runs SAM 2 Hiera-Small via
 * Hugging Face `transformers`. The Python service returns a greyscale
 * PNG mask (white = include, black = exclude) at *prepared* resolution.
 *
 * Why a separate route instead of a direct call from the editor?
 *   - The editor and the Python service run in different processes; the
 *     service can be scaled independently (GPU host, free-tier CPU, etc.).
 *   - Server-side keeps the HF model out of the browser bundle.
 *   - Server-side can attach auth + rate limiting + a per-user quota.
 *
 * Request format (multipart/form-data):
 *   - image:  JPEG/PNG/WebP, max 24 MB
 *   - clicks: JSON string `[[x, y, label], ...]` where label is 1
 *             (positive / include) or 0 (negative / exclude). Clicks
 *             are in the *original* (un-resized) image's pixel coordinates.
 *
 * Response:
 *   - image/png  (greyscale mask at *original* image resolution,
 *                 white = include, black = exclude)
 *   - X-Score    (IoU of the chosen mask candidate, 0..1)
 *   - X-Model    (HF checkpoint id)
 *   - X-Elapsed-Ms
 * ═══════════════════════════════════════════════════════════════════════════ */

const MASK_SERVICE_URL = process.env.MASK_SERVICE_URL?.trim().replace(/\/+$/, '') || ''
const MAX_INPUT_BYTES = 24 * 1024 * 1024
const MAX_CLICKS = 50
const MAX_MODEL_SIDE = 1024

const fileToBuffer = async (file, label) => {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error(`${label} is required`)
  }
  if (typeof file.size !== 'number' || file.size > MAX_INPUT_BYTES) {
    throw new Error(`${label} is too large (max ${MAX_INPUT_BYTES / 1024 / 1024}MB)`)
  }
  return Buffer.from(await file.arrayBuffer())
}

const readImageMeta = async (inputBuffer) => {
  const meta = await sharp(inputBuffer, { failOn: 'none' }).metadata()
  const origW = meta.width || 0
  const origH = meta.height || 0
  if (!origW || !origH) {
    throw new Error('image has no usable dimensions')
  }
  return { origWidth: origW, origHeight: origH }
}

const parseClicks = (raw) => {
  if (raw == null) throw new Error('clicks is required')
  if (typeof raw !== 'string') throw new Error('clicks must be a JSON string')
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    throw new Error(`invalid clicks JSON: ${e.message}`)
  }
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('clicks must be a non-empty array')
  }
  if (data.length > MAX_CLICKS) {
    throw new Error(`too many clicks: ${data.length} > ${MAX_CLICKS}`)
  }
  return data.map((c, i) => {
    if (!Array.isArray(c) || c.length !== 3) {
      throw new Error(`click #${i} must be [x, y, label]; got ${JSON.stringify(c)}`)
    }
    const [x, y, label] = c
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) {
      throw new Error(`click #${i} x must be a non-negative finite number; got ${x}`)
    }
    if (typeof y !== 'number' || !Number.isFinite(y) || y < 0) {
      throw new Error(`click #${i} y must be a non-negative finite number; got ${y}`)
    }
    if (label !== 0 && label !== 1) {
      throw new Error(`click #${i} label must be 0 or 1; got ${label}`)
    }
    return [x, y, label]
  })
}

const validateClicksInBounds = (clicks, origWidth, origHeight) => {
  for (let i = 0; i < clicks.length; i++) {
    const [x, y] = clicks[i]
    if (x >= origWidth || y >= origHeight) {
      throw new Error(
        `click #${i} (${x}, ${y}) is outside image (${origWidth}x${origHeight})`,
      )
    }
  }
}

const prepareImage = async (inputBuffer, origWidth, origHeight) => {
  const scale = Math.min(1, MAX_MODEL_SIDE / Math.max(origWidth, origHeight))
  const w = Math.max(1, Math.round(origWidth * scale))
  const h = Math.max(1, Math.round(origHeight * scale))

  const buffer = await sharp(inputBuffer, { failOn: 'none' })
    .resize(w, h, { fit: 'fill' })
    .removeAlpha()
    .jpeg({ quality: 85 })
    .toBuffer()

  return { buffer, width: w, height: h, scale }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * EDGE REFINEMENT PIPELINE (mirrors /api/ai/segment/route.js)
 *
 * The Python service returns a raw SAM 2 mask at *prepared* resolution.
 * We upscale to the original image resolution with the same median →
 * lanczos3 → blur → threshold chain the segment route uses, so the two
 * endpoints produce visually-consistent masks.
 * ═══════════════════════════════════════════════════════════════════════════ */
const refineMaskEdges = async (pngBuffer, modelW, modelH, origW, origH) => {
  const grey = await sharp(pngBuffer, { failOn: 'none' })
    .resize(modelW, modelH, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer()

  return sharp(grey, { raw: { width: modelW, height: modelH, channels: 1 } })
    .median(3)
    .resize(origW, origH, { fit: 'fill', kernel: 'lanczos3' })
    .blur(1.2)
    .threshold(128)
    .png()
    .toBuffer()
}

const callSam2Service = async (imageBuffer, clicks) => {
  if (!MASK_SERVICE_URL) {
    return { ok: false, reason: 'MASK_SERVICE_URL not configured' }
  }
  const endpoint = `${MASK_SERVICE_URL}/sam2/click`
  try {
    const formData = new FormData()
    formData.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'image.jpg')
    formData.append('clicks', JSON.stringify(clicks))

    const response = await fetch(endpoint, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, reason: `HTTP ${response.status}: ${text.slice(0, 200)}` }
    }
    const ct = response.headers.get('content-type') || ''
    if (!ct.includes('image')) {
      return { ok: false, reason: `non-image response: ${ct}` }
    }
    const buf = Buffer.from(await response.arrayBuffer())
    return {
      ok: true,
      buffer: buf,
      model: response.headers.get('x-model') || 'sam2',
      score: response.headers.get('x-score') || '',
      elapsedMs: response.headers.get('x-elapsed-ms') || '',
    }
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) }
  }
}

export async function POST(request) {
  try {
    const { userId } = await auth()
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Shares the ai-segment bucket — both are SOTA model calls with
    // comparable cost (encoder cold-start + decoder inference).
    const limited = rateLimitResponse(await enforceRateLimit('ai-segment', userId))
    if (limited) return limited

    if (!MASK_SERVICE_URL) {
      return NextResponse.json(
        { error: 'MASK_SERVICE_URL is not configured. Start services/segment/main.py and set MASK_SERVICE_URL in .env.local.' },
        { status: 501 },
      )
    }

    // Pre-check the Content-Length header BEFORE parsing the multipart
    // body. Next.js's request.formData() is streaming but it still
    // allocates a Buffer for the whole body in some cases; a 1GB upload
    // from a malicious client would otherwise be parsed before our
    // per-file `fileToBuffer` size check runs. Mirrors the same check
    // in /api/ai/depth.
    const contentLength = request.headers.get('content-length')
    if (contentLength) {
      const cl = Number.parseInt(contentLength, 10)
      if (Number.isFinite(cl) && cl > MAX_INPUT_BYTES) {
        return NextResponse.json(
          { error: `request body too large (${(cl / 1024 / 1024).toFixed(1)}MB > ${MAX_INPUT_BYTES / 1024 / 1024}MB)` },
          { status: 413 },
        )
      }
    }

    const formData = await request.formData()
    const imageBuffer = await fileToBuffer(formData.get('image'), 'image')

    // Read original dimensions *before* preparing the model-space image,
    // so the frontend can keep sending clicks in original (natural) pixel
    // coordinates and we scale them here, hiding the resize constant.
    const meta = await readImageMeta(imageBuffer)

    const clicksOriginal = parseClicks(formData.get('clicks'))
    validateClicksInBounds(clicksOriginal, meta.origWidth, meta.origHeight)

    const prepared = await prepareImage(imageBuffer, meta.origWidth, meta.origHeight)
    const clicksScaled = clicksOriginal.map(([x, y, label]) => [
      x * prepared.scale,
      y * prepared.scale,
      label,
    ])

    console.info(
      '[ai-sam2] image:', prepared.width, 'x', prepared.height,
      '→ orig:', meta.origWidth, 'x', meta.origHeight,
      '· scale:', prepared.scale.toFixed(4),
      '· clicks:', clicksOriginal.length,
    )

    const result = await callSam2Service(prepared.buffer, clicksScaled)
    if (!result.ok) {
      console.warn('[ai-sam2] service failed:', result.reason)
      const status = /not configured|not available/i.test(result.reason) ? 501 : 502
      return NextResponse.json({ error: result.reason }, { status })
    }

    // Upscale the prepared-space mask to the original image resolution
    // so the frontend can drop it straight into the canvas at 1:1.
    let finalMask
    try {
      finalMask = await refineMaskEdges(
        result.buffer,
        prepared.width,
        prepared.height,
        meta.origWidth,
        meta.origHeight,
      )
    } catch (err) {
      console.warn('[ai-sam2] edge refinement failed, returning raw mask:', err?.message)
      finalMask = result.buffer
    }

    console.info(
      '[ai-sam2] ✓ mask:', finalMask.length, 'bytes',
      `(model: ${result.model}, score: ${result.score}, elapsed: ${result.elapsedMs}ms)`,
    )

    return new NextResponse(finalMask, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'X-Model': result.model,
        'X-Score': result.score,
        'X-Elapsed-Ms': result.elapsedMs,
      },
    })
  } catch (error) {
    console.error('[ai-sam2] ✗', error?.message)
    const msg = error?.message || 'SAM 2 click failed'
    const status = /not configured/i.test(msg) ? 501 : 400
    return NextResponse.json({ error: msg }, { status })
  }
}
