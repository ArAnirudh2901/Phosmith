// /api/canvas/presence
//
// Lightweight "who else is editing this project right now" heartbeat. The
// editor POSTs here every few seconds; the response tells it which OTHER
// devices currently have the same project open, so it can warn the user about
// concurrent editing and fork into a separate copy before the two sessions
// clobber each other.
//
// This is presence/awareness only — it is NOT the optimistic-concurrency guard
// (that lives in /api/canvas/flush). Presence is proactive (detects the second
// device the moment it joins); the flush conflict is the reactive backstop.
//
// Storage: a single JSON map per project in Redis —
//   canvas:presence:{projectId} = { [sessionId]: { clientId, deviceLabel, joinedAt, lastSeen } }
// Read-modify-write on each beat: prune entries we haven't heard from within
// PRESENCE_STALE_MS, upsert the caller's entry, write back with a TTL. Presence
// is soft state, so the small get→set race (two beats interleaving) is fine: a
// dropped beat is re-added on the next one.

import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { getNeonAuthContext } from "@/lib/neon/auth"
import { runNeonQuery } from "@/lib/neon/functions"
import { getRedis, isRedisConfigured } from "@/lib/redis"
import { enforceRateLimit, rateLimitResponse } from "@/lib/rate-limit"

// A session is "live" if we've heard from it within this window. Must be a few
// heartbeats long so a single dropped beat doesn't drop the device. With a ~10s
// client heartbeat, 35s tolerates two missed beats before a device is pruned.
const PRESENCE_STALE_MS = 35_000
// Whole-key TTL so the map self-cleans once everyone leaves (well above the
// stale window so an active project's key never expires under it).
const PRESENCE_TTL_SECONDS = 5 * 60

const presenceKey = (projectId) => `canvas:presence:${projectId}`
const ownerKey = (projectId) => `canvas:owner:${projectId}`
const OWNER_CACHE_TTL_SECONDS = 60 * 60

// Redis-cached ownership check (same scheme as the snapshot route): a cache hit
// for the same user skips the Neon read; a miss falls through to Neon and
// re-caches. Keeps the per-beat cost to a single Redis round-trip in steady state.
const ensureOwnershipCached = async (projectId, userId, neonAuth, redis) => {
    try {
        const cached = await redis.get(ownerKey(projectId))
        if (cached && String(cached) === userId) return
    } catch { /* cache unavailable — fall through to Neon */ }
    const project = await runNeonQuery("projects.getProject", { projectId }, { auth: neonAuth })
    if (!project) throw new Error("Project not found or access denied")
    try {
        await redis.set(ownerKey(projectId), userId, { ex: OWNER_CACHE_TTL_SECONDS })
    } catch { /* best-effort */ }
}

const parseMap = (raw) => {
    if (!raw) return {}
    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
        return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
        return {}
    }
}

export async function POST(request) {
    try {
        const { userId } = await auth()
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const limited = rateLimitResponse(await enforceRateLimit("canvas-presence", userId))
        if (limited) return limited

        if (!isRedisConfigured()) {
            // No shared store → can't observe other devices. Report "alone" so the
            // client simply runs without concurrent-edit detection.
            return NextResponse.json({ ok: true, self: null, others: [] })
        }

        const body = await request.json().catch(() => ({}))
        const projectId = body.projectId
        const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 64) : ""
        const clientId = typeof body.clientId === "string" ? body.clientId.slice(0, 64) : ""
        const deviceLabel = typeof body.deviceLabel === "string" ? body.deviceLabel.slice(0, 80) : "A device"
        const action = body.action === "leave" ? "leave" : "beat"
        if (!projectId || !sessionId || !clientId) {
            return NextResponse.json({ error: "projectId, sessionId and clientId required" }, { status: 400 })
        }

        const neonAuth = await getNeonAuthContext()
        const redis = getRedis()
        await ensureOwnershipCached(projectId, userId, neonAuth, redis)

        const key = presenceKey(projectId)
        const now = Date.now()
        const map = parseMap(await redis.get(key))

        // Prune sessions we haven't heard from inside the live window.
        for (const [sid, entry] of Object.entries(map)) {
            if (!entry || typeof entry.lastSeen !== "number" || now - entry.lastSeen > PRESENCE_STALE_MS) {
                delete map[sid]
            }
        }

        if (action === "leave") {
            delete map[sessionId]
        } else {
            const existing = map[sessionId]
            map[sessionId] = {
                clientId,
                deviceLabel,
                userId,
                // Preserve the original join time so "who arrived first" stays
                // stable across this session's heartbeats (drives newcomer logic).
                joinedAt: existing?.joinedAt || now,
                lastSeen: now,
            }
        }

        try {
            if (Object.keys(map).length === 0) {
                await redis.del(key)
            } else {
                await redis.set(key, JSON.stringify(map), { ex: PRESENCE_TTL_SECONDS })
            }
        } catch { /* best-effort — presence is soft state */ }

        const self = map[sessionId] || null
        // "Others" = live sessions on a DIFFERENT physical device/browser. We key
        // on clientId (a stable per-browser id), so a reload or a second tab on
        // the SAME device is never mistaken for a concurrent device — only a
        // genuinely different machine/browser counts.
        const others = Object.entries(map)
            .filter(([sid, e]) => sid !== sessionId && e && e.clientId && e.clientId !== clientId)
            .map(([, e]) => ({ deviceLabel: e.deviceLabel || "A device", joinedAt: e.joinedAt || 0, clientId: e.clientId }))

        return NextResponse.json({
            ok: true,
            self: self ? { joinedAt: self.joinedAt } : null,
            others,
        })
    } catch (error) {
        console.error("[canvas-presence] failed:", error)
        return NextResponse.json(
            { error: "presence failed", details: error?.message || String(error) },
            { status: 500 },
        )
    }
}
