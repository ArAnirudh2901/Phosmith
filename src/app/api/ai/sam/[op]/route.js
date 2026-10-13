import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { enforceRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { isServiceOffline, serviceOfflineResponse } from '@/lib/service-availability'

export const maxDuration = 120
export const runtime = 'nodejs'

/* ═══════════════════════════════════════════════════════════════════════════
 * /api/ai/sam/embed, /api/ai/sam/decode — SlimSAM on the masking service
 *
 * Server-side selection for devices too weak to run SlimSAM in the browser
 * (the "Selection engine" card, `src/lib/selection-engine.js`). Thin proxy:
 *   - embed  (multipart `image`): the browser's own model input, long side
 *            ≤ 1024 → `{ key, width, height }`. The slow encode runs once per
 *            image; the service caches it by pixel hash.
 *   - decode (JSON `{ key, prompts, output }`): masks for clicks / boxes /
 *            the Detect All Subjects grid. A 404 means the key was evicted —
 *            the client embeds again.
 * Status codes pass through so the client can tell them apart.
 * ═══════════════════════════════════════════════════════════════════════════ */

const SERVICE_URL = (process.env.MASKING_SERVICE_URL || process.env.MASK_SERVICE_URL)?.trim().replace(/\/+$/, '') || ''
const LIMITS = {
  // A 1024 px PNG is ~1.5 MB at worst; JPEG is what the client sends.
  embed: { bucket: 'ai-sam-embed', maxBytes: 4 * 1024 * 1024, timeout: 110_000 },
  // 64 prompts of 16 points is ~40 KB of JSON.
  decode: { bucket: 'ai-sam-decode', maxBytes: 128 * 1024, timeout: 60_000 },
}

const json = (body, status) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

export async function POST(request, { params }) {
  const { op } = await params
  const limit = LIMITS[op]
  if (!limit) return json({ error: 'Not found' }, 404)

  const { userId } = await auth()
  if (!userId) return json({ error: 'Unauthorized' }, 401)
  const limited = rateLimitResponse(await enforceRateLimit(limit.bucket, userId))
  if (limited) return limited

  if (!SERVICE_URL) {
    return json({
      error: 'Server selection is not set up: MASKING_SERVICE_URL is not configured. Choose "This device" in the Selection engine card.',
      unavailable: true,
    }, 501)
  }

  const length = Number.parseInt(request.headers.get('content-length') || '', 10)
  if (Number.isFinite(length) && length > limit.maxBytes) {
    return json({ error: `Request too large (${(length / 1024 / 1024).toFixed(1)} MB)` }, 413)
  }

  try {
    let body
    let headers
    if (op === 'embed') {
      const image = (await request.formData()).get('image')
      if (!image || typeof image.arrayBuffer !== 'function') return json({ error: 'image is required' }, 400)
      if (image.size > limit.maxBytes) return json({ error: 'image is too large' }, 413)
      body = new FormData()
      body.append('image', image, 'sam-input')
    } else {
      const text = await request.text()
      if (text.length > limit.maxBytes) return json({ error: 'Request too large' }, 413)
      body = text
      headers = { 'content-type': 'application/json' }
    }
    const res = await fetch(`${SERVICE_URL}/sam/${op}`, {
      method: 'POST',
      body,
      headers,
      signal: AbortSignal.timeout(limit.timeout),
    })
    const payload = await res.json().catch(() => null)
    if (!payload) return json({ error: `Selection service answered HTTP ${res.status} without JSON` }, 502)
    if (!res.ok) {
      // FastAPI puts its message in `detail` (a list for validation errors).
      const detail = typeof payload.detail === 'string' ? payload.detail : 'Invalid selection request'
      return json({ error: detail }, res.status)
    }
    return json(payload, 200)
  } catch (error) {
    if (isServiceOffline(error)) return serviceOfflineResponse('Selection service', 'MASKING_SERVICE_URL')
    const timedOut = /timeout|abort/i.test(error?.message || '')
    console.warn(`[ai-sam] ${op} failed:`, error?.message)
    return json({
      error: timedOut
        ? 'The selection server is waking up or busy. Try again in a moment.'
        : error?.message || 'Selection failed',
    }, timedOut ? 504 : 502)
  }
}
