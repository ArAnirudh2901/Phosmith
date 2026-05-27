// /api/canvas/flush
//
// Reads the latest canvas snapshot from the server cache and persists it to
// Convex. Called by the client on:
//   - Debounced timer (every ~8s of idle)
//   - Manual Save button
//   - beforeunload (via fetch keepalive or navigator.sendBeacon)
//
// Idempotent: if the cache is empty or the meta blob's `dirty` flag is false
// (already flushed since the last write), this is a no-op. After a successful
// Convex write we clear the dirty flag so the next flush won't re-write the
// same state.

import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { fetchMutation } from "convex/nextjs"
import { api } from "../../../../../convex/_generated/api"
import { getRedis, isRedisConfigured } from "@/lib/redis"

const stateKey = (projectId) => `canvas:state:${projectId}`
const metaKey = (projectId) => `canvas:meta:${projectId}`

export async function POST(request) {
    try {
        const { userId, getToken, sessionClaims } = await auth()
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }
        if (!isRedisConfigured()) {
            return NextResponse.json({ flushed: false, reason: "no-cache" })
        }

        const token =
            sessionClaims?.aud === "convex"
                ? await getToken()
                : await getToken({ template: "convex" })
        if (!token) {
            return NextResponse.json({ error: "Missing Convex auth token" }, { status: 500 })
        }

        const body = await request.json().catch(() => ({}))
        const projectId = body.projectId
        if (!projectId) {
            return NextResponse.json({ error: "projectId required" }, { status: 400 })
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

        // Owner check: the snapshot is tagged with the user that wrote it. If
        // a different user somehow gets here with the same projectId, they
        // can't accidentally flush a stranger's snapshot.
        if (parsedState.userId && parsedState.userId !== userId) {
            return NextResponse.json({ flushed: false, reason: "owner-mismatch" })
        }

        // Skip the Convex write when no edits have happened since the last
        // flush — this is the common case if the debounced flush fires while
        // the user is idle.
        if (parsedMeta && parsedMeta.dirty === false) {
            return NextResponse.json({ flushed: false, reason: "clean" })
        }

        await fetchMutation(
            api.projects.updateProject,
            {
                projectId,
                canvasState: parsedState.canvasState,
                ...(parsedState.currentImageUrl ? { currentImageUrl: parsedState.currentImageUrl } : {}),
            },
            { token },
        )

        // Mark clean so subsequent idle flushes don't repeat the write.
        if (parsedMeta) {
            await redis.set(
                metaKey(projectId),
                JSON.stringify({ ...parsedMeta, dirty: false }),
                { ex: 24 * 60 * 60 },
            )
        }

        return NextResponse.json({ flushed: true, updatedAt: parsedState.updatedAt })
    } catch (error) {
        console.error("[canvas-flush] failed:", error)
        return NextResponse.json(
            { error: "flush failed", details: error?.message || String(error) },
            { status: 500 },
        )
    }
}
