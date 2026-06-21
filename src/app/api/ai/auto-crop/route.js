import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import sharp from 'sharp'
import { enforceRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export const maxDuration = 180
export const runtime = 'nodejs'

/* ═══════════════════════════════════════════════════════════════════════════
 * AUTO-CROP — /api/ai/auto-crop
 *
 * Thin proxy in front of the local mask service's `/crop/auto` endpoint
 * (services/segment/main.py). Returns crop boxes in the ORIGINAL image's
 * pixel coordinates for four strategies:
 *
 *   - subject  — BiRefNet matte + YOLO instance union, padded + rule-of-thirds
 *   - aspect   — max-area fit at the requested ratio (cheap, deterministic)
 *   - content  — trim near-solid borders (white mats, letterboxing)
 *   - depth    — Depth Anything V2 foreground percentile (lazy-loaded model)
 *
 * Returns 501 when MASK_SERVICE_URL is unset — exactly like sam2/depth/
 * segment-instances. No HuggingFace fallback (these strategies depend on
 * the local stack).
 *
 * Request format (multipart/form-data):
 *   - image:   JPEG/PNG/WebP, max 24 MB
 *   - aspect:  optional "W:H" or float (e.g. "16:9", "1.7777")
 *   - mode:    one of subject|aspect|content|depth|all (default "all")
 *   - padding: optional 0..1 padding fraction override
 *
 * Response: see Python /crop/auto.
 * ═══════════════════════════════════════════════════════════════════════════ */

const MASK_SERVICE_URL = process.env.MASK_SERVICE_URL?.trim().replace(/\/+$/, '') || ''
const MAX_INPUT_BYTES = 24 * 1024 * 1024
// The Python service caps at 2048 too — re-encoding above that wastes work
// without improving the crop boxes (which are returned at original-image
// resolution by scaling the inputs back up here).
const MAX_MODEL_SIDE = 2048

const ALLOWED_MODES = new Set(['subject', 'aspect', 'content', 'depth', 'all'])

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
  const origW = meta.width || 0
  const origH = meta.height || 0
  if (!origW || !origH) throw new Error('image has no usable dimensions')

  const scale = Math.min(1, MAX_MODEL_SIDE / Math.max(origW, origH))
  const w = Math.max(1, Math.round(origW * scale))
  const h = Math.max(1, Math.round(origH * scale))

  const buffer = await sharp(inputBuffer, { failOn: 'none' })
    .resize(w, h, { fit: 'fill' })
    .removeAlpha()
    .jpeg({ quality: 88 })
    .toBuffer()

  return { buffer, width: w, height: h, origWidth: origW, origHeight: origH }
}

/** Scale a [x,y,w,h] box from model-resolution back to original-resolution. */
const scaleBox = (box, sx, sy) => {
  if (!Array.isArray(box) || box.length !== 4) return box
  const [x, y, w, h] = box
  return [
    Math.max(0, Math.round(x * sx)),
    Math.max(0, Math.round(y * sy)),
    Math.max(1, Math.round(w * sx)),
    Math.max(1, Math.round(h * sy)),
  ]
}

const scaleCrop = (crop, sx, sy) => {
  if (!crop || !crop.box) return crop
  return {
    ...crop,
    box: scaleBox(crop.box, sx, sy),
    centroid: Array.isArray(crop.centroid)
      ? [Math.round(crop.centroid[0] * sx), Math.round(crop.centroid[1] * sy)]
      : crop.centroid,
  }
}

export async function POST(request) {
  try {
    const { userId } = await auth()
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!MASK_SERVICE_URL) {
      return NextResponse.json(
        {
          error:
            'MASK_SERVICE_URL is not configured — auto-crop requires the local mask service (bun run mask:dev)',
        },
        { status: 501 },
      )
    }

    const limited = rateLimitResponse(await enforceRateLimit('ai-auto-crop', userId))
    if (limited) return limited

    const contentLength = request.headers.get('content-length')
    if (contentLength) {
      const cl = Number.parseInt(contentLength, 10)
      if (Number.isFinite(cl) && cl > MAX_INPUT_BYTES) {
        return NextResponse.json(
          {
            error: `request body too large (${(cl / 1024 / 1024).toFixed(1)}MB > ${MAX_INPUT_BYTES / 1024 / 1024}MB)`,
          },
          { status: 413 },
        )
      }
    }

    const formData = await request.formData()
    const imageBuffer = await fileToBuffer(formData.get('image'), 'image')

    const rawAspect = formData.get('aspect')
    const aspect = typeof rawAspect === 'string' && rawAspect.trim() ? rawAspect.trim() : null

    const rawMode = formData.get('mode')
    const mode = typeof rawMode === 'string' && rawMode.trim() ? rawMode.trim().toLowerCase() : 'all'
    if (!ALLOWED_MODES.has(mode)) {
      return NextResponse.json({ error: `invalid mode: ${mode}` }, { status: 400 })
    }

    const rawPadding = formData.get('padding')
    const padding =
      typeof rawPadding === 'string' && rawPadding.trim() !== '' ? rawPadding.trim() : null

    const prepared = await prepareImage(imageBuffer)
    console.info('[ai-auto-crop] image:', prepared.width, 'x', prepared.height,
      '→ orig:', prepared.origWidth, 'x', prepared.origHeight,
      `mode=${mode}`, aspect ? `aspect=${aspect}` : '(no aspect)')

    const serviceForm = new FormData()
    serviceForm.append(
      'image',
      new Blob([prepared.buffer], { type: 'image/jpeg' }),
      'image.jpg',
    )
    serviceForm.append('mode', mode)
    if (aspect) serviceForm.append('aspect', aspect)
    if (padding) serviceForm.append('padding', padding)

    const response = await fetch(`${MASK_SERVICE_URL}/crop/auto`, {
      method: 'POST',
      body: serviceForm,
      signal: AbortSignal.timeout(180_000),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.warn('[ai-auto-crop] service HTTP', response.status, text.slice(0, 200))
      return NextResponse.json(
        { error: `mask service error (HTTP ${response.status})`, detail: text.slice(0, 200) },
        { status: response.status >= 500 ? 502 : response.status },
      )
    }

    const payload = await response.json()

    // Scale every box + centroid back to original image resolution.
    const sx = prepared.origWidth / (payload.width || prepared.width)
    const sy = prepared.origHeight / (payload.height || prepared.height)

    const crops = {}
    for (const key of Object.keys(payload.crops || {})) {
      crops[key] = scaleCrop(payload.crops[key], sx, sy)
    }

    const subjects = (payload.subjects || []).map((s) => ({
      ...s,
      bbox: Array.isArray(s.bbox) ? scaleBox(s.bbox, sx, sy) : s.bbox,
      centroid: Array.isArray(s.centroid)
        ? [Math.round(s.centroid[0] * sx), Math.round(s.centroid[1] * sy)]
        : s.centroid,
    }))

    console.info('[ai-auto-crop] ✓ ran:', payload.ran, 'rec:', payload.recommended,
      `(${payload.elapsed_ms}ms)`)

    return NextResponse.json(
      {
        width: prepared.origWidth,
        height: prepared.origHeight,
        aspect: payload.aspect ?? null,
        mode: payload.mode,
        ran: payload.ran || [],
        crops,
        subjects,
        recommended: payload.recommended || null,
        elapsedMs: payload.elapsed_ms,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    console.error('[ai-auto-crop] ✗', error?.message)
    const msg = error?.message || ''
    const timeout = /abort|timeout/i.test(msg)
    const connRefused = /ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET/i.test(msg)
    return NextResponse.json(
      {
        error: connRefused
          ? 'Mask service is not running — start it with `bun run mask:dev` and try again'
          : msg || 'Auto-crop failed',
      },
      { status: timeout ? 504 : 500 },
    )
  }
}
