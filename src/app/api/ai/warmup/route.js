import { NextResponse } from 'next/server'

export const maxDuration = 300 // warmup can take a while on cold starts
export const runtime = 'nodejs'

/* ═══════════════════════════════════════════════════════════════════════════
 * /api/ai/warmup — Proactively warm up all lazy-loaded AI models
 *
 * The Python services lazy-load heavy models (SAM 3.1, Depth, LaMa) on first
 * use, which can take 30–120s on a free-tier CPU host. This route warms both
 * the masking service (MASKING_SERVICE_URL — SAM 3.1 / depth / grounding) and
 * the segment service (MASK_SERVICE_URL — inpaint / auto-crop) so the first
 * real AI request doesn't surprise the user. Fire-and-forget.
 *
 * No auth required — warmup is idempotent and free (just loads models).
 * ═══════════════════════════════════════════════════════════════════════════ */

const clean = (v) => v?.trim().replace(/\/+$/, '') || ''
const MASKING_SERVICE_URL = clean(process.env.MASKING_SERVICE_URL)
const MASK_SERVICE_URL = clean(process.env.MASK_SERVICE_URL)

// Distinct service URLs to warm (the two may collapse to one combined service).
const SERVICES = [...new Set([MASKING_SERVICE_URL, MASK_SERVICE_URL].filter(Boolean))]

export async function POST() {
  if (SERVICES.length === 0) {
    return NextResponse.json(
      { status: 'skipped', reason: 'no mask service configured' },
      { status: 200 },
    )
  }

  const warmOne = async (url) => {
    try {
      const resp = await fetch(`${url}/warmup`, {
        method: 'POST',
        signal: AbortSignal.timeout(290_000), // just under maxDuration
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        return { url, status: 'error', reason: `HTTP ${resp.status}: ${text.slice(0, 160)}` }
      }
      return { url, status: 'warmed', ...(await resp.json().catch(() => ({}))) }
    } catch (e) {
      return { url, status: 'error', reason: e?.message || 'warmup failed' }
    }
  }

  const results = await Promise.all(SERVICES.map(warmOne))
  const ok = results.some((r) => r.status === 'warmed')
  console.info('[ai-warmup] results:', results)
  return NextResponse.json({ status: ok ? 'warmed' : 'error', services: results }, { status: ok ? 200 : 502 })
}
