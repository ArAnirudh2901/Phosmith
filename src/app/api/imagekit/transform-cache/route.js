// /api/imagekit/transform-cache
//
// Server-side cache for resolved ImageKit AI transform URLs.
//
// When the agent applies an AI transform (e-upscale, e-retouch, e-bgremove),
// ImageKit processes the image asynchronously (10–30s on first hit). The client
// polls with waitForImageKitUrl until the result is ready. Once resolved, the
// fully-processed URL is stored here so that toggling the same transform off
// and on again is instant — no re-polling needed.
//
// GET  ?url=<encodedTransformUrl>  → { cached: true, resolvedUrl } | { cached: false }
// POST { url, resolvedUrl }        → { ok: true }
//
// Key format: ik-transform:<sha256-hex-of-url>
// TTL: 2 hours (ImageKit caches for longer, but we stay conservative).

import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { getRedis, isRedisConfigured } from "@/lib/redis"
import { createHash } from "crypto"

const TRANSFORM_CACHE_TTL = 2 * 60 * 60 // 2 hours

const cacheKey = (url) => {
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 32)
    return `ik-transform:${hash}`
}

export async function GET(request) {
    try {
        const { userId } = await auth()
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        if (!isRedisConfigured()) {
            return NextResponse.json({ cached: false, reason: "no-cache" })
        }

        const { searchParams } = new URL(request.url)
        const url = searchParams.get("url")
        if (!url) {
            return NextResponse.json({ error: "url parameter required" }, { status: 400 })
        }

        const redis = getRedis()
        const raw = await redis.get(cacheKey(url))
        if (!raw) {
            return NextResponse.json({ cached: false })
        }

        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
        return NextResponse.json({
            cached: true,
            resolvedUrl: parsed.resolvedUrl,
            cachedAt: parsed.cachedAt,
        })
    } catch (error) {
        console.error("[transform-cache GET] failed:", error)
        return NextResponse.json({ cached: false, error: error?.message })
    }
}

export async function POST(request) {
    try {
        const { userId } = await auth()
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        if (!isRedisConfigured()) {
            return NextResponse.json({ ok: false, reason: "no-cache" })
        }

        const body = await request.json().catch(() => ({}))
        const { url, resolvedUrl } = body
        if (!url || !resolvedUrl) {
            return NextResponse.json(
                { error: "url and resolvedUrl required" },
                { status: 400 },
            )
        }

        const redis = getRedis()
        const payload = JSON.stringify({
            resolvedUrl,
            cachedAt: Date.now(),
            userId,
        })
        await redis.set(cacheKey(url), payload, { ex: TRANSFORM_CACHE_TTL })

        return NextResponse.json({ ok: true })
    } catch (error) {
        console.error("[transform-cache POST] failed:", error)
        return NextResponse.json(
            { error: "cache write failed", details: error?.message },
            { status: 500 },
        )
    }
}
