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

// The Erase tool probes with GET before deciding whether to warm, so a
// POST-only route made every client read the service as unavailable.
export async function GET() {
  if (SERVICES.length === 0) {
    return NextResponse.json({ configured: false, allWarm: false, services: [] })
  }

  const probeOne = async (url) => {
    try {
      const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) })
      if (!resp.ok) return { url, reachable: false, warm: false }
      const body = await resp.json().catch(() => ({}))
      // Services report per-model load state; treat "no models listed" as cold.
      const models = body.models || body.loaded || {}
      const flags = Object.values(models).filter((v) => typeof v === 'boolean')
      return { url, reachable: true, warm: flags.length > 0 && flags.every(Boolean), models }
    } catch {
      return { url, reachable: false, warm: false }
    }
  }

  const services = await Promise.all(SERVICES.map(probeOne))
  const reachable = services.filter((s) => s.reachable)
  return NextResponse.json({
    configured: reachable.length > 0,
    allWarm: reachable.length === services.length && services.every((s) => s.warm),
    services,
  })
}

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
