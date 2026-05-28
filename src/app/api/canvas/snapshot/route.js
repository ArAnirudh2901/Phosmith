// /api/canvas/snapshot
//
// Redis-backed write-behind cache for canvas state. The editor saves to Redis
// continuously (every edit) and only syncs to Neon periodically (debounced
// flush) or on critical events (manual Save, beforeunload). This drops Neon
// mutation volume by ~10-30× for active editing sessions while keeping data
// recoverable across reload — if the user closes the tab before a flush, the
// next page load reads from Redis instead of stale Neon state.
//
// POST → store the latest canvas snapshot. Fast (one Redis SET command).
// GET  → return the latest cached snapshot for a project (or null).
//
// Both routes auth via Clerk and verify the user owns the project via Neon
// before reading/writing — so a leaked projectId can't read someone else's
// in-flight state.

import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { getNeonAuthContext } from "@/lib/neon/auth"
import { runNeonQuery } from "@/lib/neon/functions"
import { getRedis, isRedisConfigured } from "@/lib/redis"
import { enforceRateLimit, rateLimitResponse } from "@/lib/rate-limit"

// 24h TTL: long enough that a user picking up an interrupted session next day
// still finds their work; short enough that Redis storage doesn't grow unbounded.
const SNAPSHOT_TTL_SECONDS = 24 * 60 * 60

const stateKey = (projectId) => `canvas:state:${projectId}`
const metaKey = (projectId) => `canvas:meta:${projectId}`

const ensureOwnership = async (projectId, neonAuth) => {
    const project = await runNeonQuery("projects.getProject", { projectId }, { auth: neonAuth })
    if (!project) throw new Error("Project not found or access denied")
    return project
}

export async function POST(request) {
    try {
        const { userId } = await auth()
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        // Per-user rate limit: 120/min covers the most aggressive editing flows
        // (one save per ~500ms during a slider drag is normal).
        const limited = rateLimitResponse(await enforceRateLimit("canvas-snapshot", userId))
        if (limited) return limited

        if (!isRedisConfigured()) {
            // No Redis → tell the client to skip the write-behind path and use
            // the direct-Neon save path instead. Client honors this flag.
            return NextResponse.json({ ok: false, redisUnavailable: true }, { status: 200 })
        }

        const neonAuth = await getNeonAuthContext()

        const body = await request.json().catch(() => ({}))
        const projectId = body.projectId
        const canvasState = body.canvasState
        const currentImageUrl = body.currentImageUrl || null
        const clientUpdatedAt = Number(body.clientUpdatedAt) || Date.now()
        if (!projectId || !canvasState) {
            return NextResponse.json({ error: "projectId and canvasState required" }, { status: 400 })
        }

        // Cheap ownership check — re-uses the existing project read auth so a
        // malicious client can't spam another user's project keys.
        await ensureOwnership(projectId, neonAuth)

        const redis = getRedis()
        const payload = JSON.stringify({ canvasState, currentImageUrl, updatedAt: clientUpdatedAt, userId })

        // SET with EX in one round-trip. Side meta blob lets us cheaply check
        // freshness without pulling the whole state.
        await Promise.all([
            redis.set(stateKey(projectId), payload, { ex: SNAPSHOT_TTL_SECONDS }),
            redis.set(
                metaKey(projectId),
                JSON.stringify({ updatedAt: clientUpdatedAt, userId, dirty: true }),
                { ex: SNAPSHOT_TTL_SECONDS },
            ),
        ])

        return NextResponse.json({ ok: true, updatedAt: clientUpdatedAt })
    } catch (error) {
        console.error("[canvas-snapshot POST] failed:", error)
        return NextResponse.json(
            { error: "snapshot failed", details: error?.message || String(error) },
            { status: 500 },
        )
    }
}

export async function GET(request) {
    try {
        const { userId } = await auth()
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }
        if (!isRedisConfigured()) {
            return NextResponse.json({ snapshot: null, redisUnavailable: true })
        }

        const { searchParams } = new URL(request.url)
        const projectId = searchParams.get("projectId")
        if (!projectId) {
            return NextResponse.json({ error: "projectId required" }, { status: 400 })
        }

        const neonAuth = await getNeonAuthContext()
        await ensureOwnership(projectId, neonAuth)

        const redis = getRedis()
        const raw = await redis.get(stateKey(projectId))
        if (!raw) return NextResponse.json({ snapshot: null })

        // Upstash SDK auto-parses JSON for stringified values. Handle both forms.
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
        return NextResponse.json({ snapshot: parsed })
    } catch (error) {
        console.error("[canvas-snapshot GET] failed:", error)
        return NextResponse.json({ snapshot: null, error: error?.message })
    }
}
