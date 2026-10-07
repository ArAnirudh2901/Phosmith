import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/* ═══════════════════════════════════════════════════════════════════════════
 * /api/ai/health — masking-service health/capability probe
 *
 * Thin server-side proxy for the masking service's GET /health so the editor's
 * Mask tool can show a live service badge without hitting the Python service
 * directly (no CORS, no exposed service URL). Reads MASKING_SERVICE_URL (the
 * depth service), falling back to the legacy combined MASK_SERVICE_URL when
 * only that is configured.
 *
 * Response: { available, depth, model } plus the raw service payload. Always
 * 200 so the client can branch on `available`.
 * ═══════════════════════════════════════════════════════════════════════════ */

const MASKING_SERVICE_URL =
  (process.env.MASKING_SERVICE_URL || process.env.MASK_SERVICE_URL)?.trim().replace(/\/+$/, '') || ''

export async function GET() {
  if (!MASKING_SERVICE_URL) {
    return NextResponse.json(
      { available: false, reason: 'MASKING_SERVICE_URL not configured' },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }
  try {
    const resp = await fetch(`${MASKING_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(4000),
    })
    if (!resp.ok) {
      return NextResponse.json(
        { available: false, reason: `HTTP ${resp.status}` },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }
    const j = await resp.json().catch(() => ({}))
    return NextResponse.json(
      {
        available: true,
        depth: !!j.depth_available,
        model: j.depth_model || '',
        service: j,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    return NextResponse.json(
      { available: false, reason: e?.message || 'unreachable' },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
