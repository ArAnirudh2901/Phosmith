import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { enforceRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/* ═══════════════════════════════════════════════════════════════════════════
 * /api/diagnostics — where the client reports its own failures
 *
 * Everything known about this app's reliability came from one browser on one
 * machine. This is how a failure on someone else's device becomes visible: the
 * page batches its uncaught errors, rejections and missing capabilities and
 * beacons them here, where they are logged as one structured line per event.
 *
 * Two things this route deliberately does NOT do:
 *   - trust the payload. Everything is re-clamped and re-shaped server side;
 *     the client already redacts, but a request can be forged, so nothing is
 *     echoed back and every field is length-capped here as well.
 *   - identify the person. The Clerk user id is hashed to a short, unsalted-
 *     but-truncated digest so repeat reports can be correlated without the
 *     log becoming a record of who was using the app when.
 *
 * Structured logging rather than a table: these land in the platform's logs,
 * which is where you would go looking. Persisting to Neon is a small follow-up
 * if queryable history is wanted.
 * ═══════════════════════════════════════════════════════════════════════════ */

const KINDS = new Set(['error', 'rejection', 'handled', 'capability'])
const MAX_EVENTS = 20
const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null)

const shortHash = async (value) => {
    if (!value) return 'anon'
    const data = new TextEncoder().encode(`phosmith:${value}`)
    const digest = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest).slice(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function POST(request) {
    let userId = null
    try { ({ userId } = await auth()) } catch { /* anonymous reports are still useful */ }

    // enforceRateLimit answers { ok }, and rateLimitResponse returns null when the
    // request is allowed — returning that null from a handler is a 500.
    const limit = await enforceRateLimit('diagnostics', userId || request.headers.get('x-forwarded-for') || 'anon')
    const limited = rateLimitResponse(limit)
    if (limited) return limited

    const body = await request.json().catch(() => null)
    const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS) : []
    if (!events.length) return NextResponse.json({ ok: true, recorded: 0 })

    const env = body?.env || {}
    const who = await shortHash(userId)
    const context = {
        who,
        route: cap(env.route, 80),
        ua: cap(env.ua, 180),
        viewport: cap(env.viewport, 24),
        // Number(null) is 0, which reads as "this machine has 0 GB" — Safari simply
        // does not expose deviceMemory, and "unknown" is the honest answer.
        memoryGb: env.deviceMemoryGb == null ? null : (Number.isFinite(Number(env.deviceMemoryGb)) ? Number(env.deviceMemoryGb) : null),
        cores: env.cores == null ? null : (Number.isFinite(Number(env.cores)) ? Number(env.cores) : null),
        online: env.online === false ? false : true,
    }

    let recorded = 0
    for (const e of events) {
        if (!KINDS.has(e?.kind)) continue
        recorded += 1
        console.warn('[client-diagnostic]', JSON.stringify({
            ...context,
            kind: e.kind,
            name: cap(e.name, 60),
            message: cap(e.message, 400),
            stack: cap(e.stack, 500),
            at: cap(e.context, 60),
        }))
    }

    // Report what was actually logged, not what was posted — a caller sending
    // twenty unknown kinds should not be told twenty were recorded.
    return NextResponse.json({ ok: true, recorded })
}
