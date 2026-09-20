import { auth } from '@clerk/nextjs/server'
import { isServiceOffline, serviceOfflineResponse } from '@/lib/service-availability'
import { NextResponse } from 'next/server'
import sharp from 'sharp'
import { enforceRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export const maxDuration = 120
export const runtime = 'nodejs'

const MAX_INPUT_BYTES = 24 * 1024 * 1024
// BiRefNet runs at a fixed 1024² internally, so a larger side does NOT add
// matte detail — but it (a) feeds the local service's YOLO a higher-resolution
// image so small/distant people in group photos are detected, and (b) gives a
// crisper Lanczos upscale of the mask back to the true source resolution.
// 2048 matches the depth service's cap; JPEG keeps the upload well under 24MB.
const MAX_MODEL_SIDE = 2048

/* ═══════════════════════════════════════════════════════════════════════════
 * STRATEGY ORDER
 *
 * 1. Local Python service (`services/segment/`) — runs `rembg` (BiRefNet-
 *    lite, MIT-licensed, SOTA quality). Free, no per-call cost.
 *
 * 2. HuggingFace semantic segmentation (segformer / detr). Last-resort
 *    because the "largest non-background" heuristic misclassifies
 *    leaves and other fine-grained subjects.
 *
 * Note: the previous HuggingFace RMBG-2.0 / RMBG-1.4 fallback was
 * removed because neither model is deployed on the new
 * `router.huggingface.co` inference API (returns HTTP 400 "Model not
 * supported by provider hf-inference"), and the old
 * `api-inference.huggingface.co` endpoint is deprecated. The retry loop
 * cost 30-60s per request before failing, polluting the logs. If HF
 * later adds RMBG support, the loop can be reintroduced here.
 * ═══════════════════════════════════════════════════════════════════════════ */

const MASKING_SERVICE_URL = (process.env.MASKING_SERVICE_URL || process.env.MASK_SERVICE_URL)?.trim().replace(/\/+$/, '') || ''
const fileToBuffer = async (file, label) => {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error(`${label} is required`)
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(`${label} is too large (max ${MAX_INPUT_BYTES / 1024 / 1024}MB)`)
  }
  return Buffer.from(await file.arrayBuffer())
}

const prepareImage = async (inputBuffer) => {
  const meta = await sharp(inputBuffer, { failOn: 'none' }).metadata()
  const origW = meta.width || 512
  const origH = meta.height || 512
  const scale = Math.min(1, MAX_MODEL_SIDE / Math.max(origW, origH))
  const w = Math.round(origW * scale)
  const h = Math.round(origH * scale)

  const buffer = await sharp(inputBuffer, { failOn: 'none' })
    .resize(w, h, { fit: 'fill' })
    .removeAlpha()
    .jpeg({ quality: 85 })
    .toBuffer()

  return { buffer, width: w, height: h, origWidth: origW, origHeight: origH }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * EDGE REFINEMENT PIPELINE
 *
 * Turns a raw model mask (at model resolution) into a clean, anti-aliased
 * mask at the original image resolution. Steps:
 *   1. Median(3)   — removes isolated noise pixels, preserves edges
 *   2. Lanczos3    — smooth upscale (replaces blocky nearest-neighbor)
 *   3. Blur(1.2)   — anti-aliases the transition zone
 *   4. Threshold   — re-binarises to a clean black/white mask (OPT-IN)
 *
 * `binarize` defaults to FALSE. The local BiRefNet service returns a SOFT
 * 0..255 saliency matte (translucent/backlit edges, hair, the shadowed lobes
 * of a leaf). A hard threshold(128) would drop every semi-opaque pixel below
 * 128 — exactly the regions we want to keep — so the local path keeps the soft
 * alpha (the downstream canvas maps mask luminance directly to clip alpha).
 * The HuggingFace semantic-seg fallback feeds genuinely-binary segment masks,
 * so it opts INTO binarize:true to stay crisp.
 * ═══════════════════════════════════════════════════════════════════════════ */
const refineMaskEdges = async (greyBuffer, modelW, modelH, origW, origH, { binarize = false } = {}) => {
  let pipeline

  if (greyBuffer.length === modelW * modelH) {
    pipeline = sharp(greyBuffer, { raw: { width: modelW, height: modelH, channels: 1 } })
  } else {
    pipeline = sharp(greyBuffer, { failOn: 'none' }).greyscale()
  }

  pipeline = pipeline
    .median(3)
    .resize(origW, origH, { fit: 'fill', kernel: 'lanczos3' })
    .blur(1.2)

  if (binarize) pipeline = pipeline.threshold(128)

  return pipeline.png().toBuffer()
}

/* ═══════════════════════════════════════════════════════════════════════════
 * STRATEGY 1: LOCAL PYTHON MASK SERVICE
 *
 * The FastAPI service at `services/segment/` runs `rembg` (BiRefNet default)
 * and returns a transparent-background PNG. The alpha channel IS the mask.
 * ═══════════════════════════════════════════════════════════════════════════ */

const callLocalMaskService = async (imageBuffer) => {
  if (!MASKING_SERVICE_URL) return null

  const endpoint = `${MASKING_SERVICE_URL}/segment`
  try {
    console.info('[ai-segment] trying local mask service:', endpoint)
    const formData = new FormData()
    formData.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'image.jpg')

    const response = await fetch(endpoint, {
      method: 'POST',
      body: formData,
      // The service now defaults to BiRefNet-general (Swin-Large) for the most
      // complete matte; it's ~3-5× slower than the lite model on CPU but runs
      // in a few seconds on Apple-Silicon CoreML / CUDA. 180 s leaves ample
      // headroom for a cold CPU run (and the one-time ~930 MB model download on
      // first use). A faster model (`birefnet-general-lite`, or `u2netp` ~3 s)
      // can be selected via `SEGMENT_MODEL` in services/segment/.env.
      signal: AbortSignal.timeout(180_000),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.warn('[ai-segment] local service HTTP', response.status, text.slice(0, 200))
      return null
    }

    const buf = Buffer.from(await response.arrayBuffer())
    const ct = response.headers.get('content-type') || ''
    if (!ct.includes('image')) {
      console.warn('[ai-segment] local service non-image response:', ct.slice(0, 80))
      return null
    }

    const model = response.headers.get('x-model') || 'local-rembg'
    console.info('[ai-segment] ✓ local service →', buf.length, 'bytes (model:', model + ')')
    return { buffer: buf, model }
  } catch (error) {
    console.warn('[ai-segment] local service failed:', error?.message)
    return null
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * STRATEGY 2: HUGGINGFACE SEMANTIC SEGMENTATION (Segformer / DETR)
 *
 * Last-resort fallback. Returns JSON with per-category masks. We
 * composite the largest single subject segment and run it through the
 * same edge refinement pipeline.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Extract the alpha channel from a background-removed PNG as a subject mask.
 * Alpha 255 = subject (keep → white), Alpha 0 = background (erase → black).
 */
const buildMaskFromAlpha = async (pngBuffer, modelW, modelH, origW, origH) => {
  const { data } = await sharp(pngBuffer, { failOn: 'none' })
    .resize(modelW, modelH, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const alphaBuffer = Buffer.alloc(modelW * modelH)
  for (let i = 0; i < modelW * modelH; i++) {
    alphaBuffer[i] = data[i * 4 + 3]
  }

  return refineMaskEdges(alphaBuffer, modelW, modelH, origW, origH)
}

export async function POST(request) {
  try {
    const { userId } = await auth()
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limited = rateLimitResponse(await enforceRateLimit('ai-segment', userId))
    if (limited) return limited

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

    const prepared = await prepareImage(imageBuffer)
    console.info('[ai-segment] image:', prepared.width, 'x', prepared.height,
      '→ orig:', prepared.origWidth, 'x', prepared.origHeight)

    let maskBuffer = null
    let usedModel = null

    // ── 1. Local Python service (BiRefNet / rembg) ──
    const localResult = await callLocalMaskService(prepared.buffer)
    if (localResult) {
      try {
        maskBuffer = await buildMaskFromAlpha(
          localResult.buffer,
          prepared.width,
          prepared.height,
          prepared.origWidth,
          prepared.origHeight,
        )
        usedModel = localResult.model
      } catch (err) {
        console.warn('[ai-segment] local alpha extraction failed, falling back:', err?.message)
      }
    }

    // No hosted fallback: when the service is down the route reports it and the
    // client runs RMBG-1.4 on-device (the `segment` routing capability).

    console.info('[ai-segment] ✓ mask:', maskBuffer.length, 'bytes (model:', usedModel + ')')

    return new NextResponse(maskBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'X-Model': usedModel || 'unknown',
      },
    })
  } catch (error) {
    console.error('[ai-segment] ✗', error?.message)
    if (isServiceOffline(error)) return serviceOfflineResponse('Masking service', 'MASKING_SERVICE_URL')
    return NextResponse.json(
      { error: error?.message || 'Segmentation failed' },
      { status: /not configured/i.test(error?.message || '') ? 501 : 500 }
    )
  }
}
