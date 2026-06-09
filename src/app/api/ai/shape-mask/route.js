import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { enforceRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export const maxDuration = 15
export const runtime = 'nodejs'

const MASK_SERVICE_URL = process.env.MASK_SERVICE_URL?.trim().replace(/\/+$/, '') || ''
const MAX_SIDE = 2048
const MAX_POINTS = 10000

const parseDimension = (value, label) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  if (value > MAX_SIDE) {
    throw new Error(`${label} is too large (${value} > ${MAX_SIDE})`)
  }
  return value
}

const parsePoints = (raw, width, height) => {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new Error('points must be an array with at least 3 [x, y] pairs')
  }
  if (raw.length > MAX_POINTS) {
    throw new Error(`too many points: ${raw.length} > ${MAX_POINTS}`)
  }
  return raw.map((point, i) => {
    if (!Array.isArray(point) || point.length !== 2) {
      throw new Error(`point #${i} must be [x, y]`)
    }
    const [x, y] = point
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new Error(`point #${i} x must be a finite number`)
    }
    if (typeof y !== 'number' || !Number.isFinite(y)) {
      throw new Error(`point #${i} y must be a finite number`)
    }
    if (x < -1 || y < -1 || x > width + 1 || y > height + 1) {
      throw new Error(`point #${i} (${x}, ${y}) is outside mask bounds (${width}x${height})`)
    }
    return [x, y]
  })
}

const callShapeMaskService = async ({ width, height, points }) => {
  if (!MASK_SERVICE_URL) {
    return { ok: false, reason: 'MASK_SERVICE_URL not configured' }
  }

  try {
    const formData = new FormData()
    formData.append('width', String(width))
    formData.append('height', String(height))
    formData.append('points', JSON.stringify(points))

    const response = await fetch(`${MASK_SERVICE_URL}/shape/fill`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, reason: `HTTP ${response.status}: ${text.slice(0, 200)}` }
    }
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('image')) {
      return { ok: false, reason: `non-image response: ${contentType}` }
    }
    return {
      ok: true,
      buffer: Buffer.from(await response.arrayBuffer()),
      model: response.headers.get('x-model') || 'opencv-fillpoly',
      elapsedMs: response.headers.get('x-elapsed-ms') || '',
    }
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) }
  }
}

export async function POST(request) {
  try {
    const { userId } = await auth()
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limited = rateLimitResponse(await enforceRateLimit('shape-mask', userId))
    if (limited) return limited

    if (!MASK_SERVICE_URL) {
      return NextResponse.json(
        { error: 'MASK_SERVICE_URL is not configured. Start services/segment/main.py and set MASK_SERVICE_URL in .env.local.' },
        { status: 501 },
      )
    }

    const body = await request.json()
    const width = parseDimension(body?.width, 'width')
    const height = parseDimension(body?.height, 'height')
    const points = parsePoints(body?.points, width, height)

    const result = await callShapeMaskService({ width, height, points })
    if (!result.ok) {
      const status = /not configured/i.test(result.reason) ? 501 : 502
      return NextResponse.json({ error: result.reason }, { status })
    }

    return new NextResponse(result.buffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'X-Model': result.model,
        'X-Elapsed-Ms': result.elapsedMs,
      },
    })
  } catch (error) {
    const message = error?.message || 'Shape mask failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
