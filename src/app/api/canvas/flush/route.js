// /api/canvas/flush
//
// Reads the latest canvas snapshot from the server cache and persists it to
// Neon. Called by the client on:
//   - Debounced timer (every ~8s of idle)
//   - Manual Save button
//   - beforeunload (via fetch keepalive or navigator.sendBeacon)
//
// Idempotent: if the cache is empty or the meta blob's `dirty` flag is false
// (already flushed since the last write), this is a no-op. After a successful
// Neon write we clear the dirty flag so the next flush won't re-write the
// same state.

import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { getNeonAuthContext } from "@/lib/neon/auth"
import { runNeonMutation } from "@/lib/neon/functions"
import { getRedis, isRedisConfigured } from "@/lib/redis"

const stateKey = (projectId) => `canvas:state:${projectId}`
const metaKey = (projectId) => `canvas:meta:${projectId}`

export async function POST(request) {
    try {
        const { userId } = await auth()
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const neonAuth = await getNeonAuthContext()

        const body = await request.json().catch(() => ({}))
        const projectId = body.projectId
        if (!projectId) {
            return NextResponse.json({ error: "projectId required" }, { status: 400 })
        }

        // Resolve the content + base revision to flush. The page-alive path sends
        // the canvas inline — authoritative for THIS client and immune to the
        // shared Redis key. The small unload/keepalive path omits it, so we fall
        // back to the shared Redis snapshot.
        let canvasState = body.canvasState
        let currentImageUrl = body.currentImageUrl ?? null
        let baseRevision = body.baseRevision
        const force = body.force === true
        let usedRedis = false

        if (canvasState === undefined) {
            if (!isRedisConfigured()) {
                return NextResponse.json({ flushed: false, reason: "no-cache" })
            }
            const redis = getRedis()
            const [stateRaw, metaRaw] = await Promise.all([
                redis.get(stateKey(projectId)),
                redis.get(metaKey(projectId)),
            ])
            if (!stateRaw) {
                return NextResponse.json({ flushed: false, reason: "empty" })
            }
            const parsedState = typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw
            const parsedMeta = metaRaw && typeof metaRaw === "string" ? JSON.parse(metaRaw) : metaRaw
            // Owner check: the snapshot is tagged with the user that wrote it.
            if (parsedState.userId && parsedState.userId !== userId) {
                return NextResponse.json({ flushed: false, reason: "owner-mismatch" })
            }
            // Idle no-op: nothing changed since the last flush.
            if (parsedMeta && parsedMeta.dirty === false) {
                return NextResponse.json({ flushed: false, reason: "clean" })
            }
            canvasState = parsedState.canvasState
            currentImageUrl = parsedState.currentImageUrl ?? null
            if (baseRevision === undefined) baseRevision = parsedState.baseRevision
            usedRedis = true
        }

        if (canvasState === undefined || canvasState === null) {
            return NextResponse.json({ flushed: false, reason: "empty" })
        }

        // Optimistic-concurrency write: bumps revision, or reports a conflict if
        // another session advanced it since `baseRevision`.
        const result = await runNeonMutation(
            "projects.flushCanvasState",
            {
                projectId,
                canvasState,
                ...(currentImageUrl ? { currentImageUrl } : {}),
                expectedRevision: baseRevision,
                force,
            },
            { auth: neonAuth },
        )

        if (result?.conflict) {
            // Leave Redis dirty so the client can reconcile without losing work.
            return NextResponse.json({ flushed: false, conflict: true, project: result.project })
        }
        if (result && result.ok === false) {
            // Could not establish a baseline to write against — refuse rather than
            // clobber. Leave Redis dirty; the next load reconciles.
            return NextResponse.json({ flushed: false, reason: result.reason || "not-persisted" })
        }

        // Mark the Redis meta clean so idle flushes don't repeat the write, and
        // record the new revision so the unload path flushes against it.
        if (usedRedis && isRedisConfigured()) {
            try {
                const redis = getRedis()
                const metaRaw = await redis.get(metaKey(projectId))
                const parsedMeta = metaRaw && typeof metaRaw === "string" ? JSON.parse(metaRaw) : metaRaw
                if (parsedMeta) {
                    await redis.set(
                        metaKey(projectId),
                        JSON.stringify({ ...parsedMeta, dirty: false, baseRevision: result?.revision }),
                        { ex: 24 * 60 * 60 },
                    )
                }
            } catch { /* best-effort */ }
        }

        return NextResponse.json({ flushed: true, revision: result?.revision })
    } catch (error) {
        console.error("[canvas-flush] failed:", error)
        return NextResponse.json(
            { error: "flush failed", details: error?.message || String(error) },
            { status: 500 },
        )
    }
}
