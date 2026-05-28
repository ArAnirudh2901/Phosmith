// Redis-shaped cache client.
//
// Production:
//   - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN: Upstash REST Redis
//   - REDIS_URL: native Redis over TCP via the existing `redis` package
//
// Local/dev fallback:
//   - In-memory Map with TTLs from server-cache.js. This is not durable and is
//     per-process only, but it keeps local development zero-config.

import { cacheDelete, cacheGet, cacheIncr, cacheSet } from "./server-cache"

const upstashUrl =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    ""
const upstashToken =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    ""
const redisUrl = process.env.REDIS_URL || ""

const hasUpstash = Boolean(upstashUrl && upstashToken)
const hasNativeRedis = Boolean(redisUrl)
let nativeClientPromise = null

const runUpstash = async (...command) => {
    const response = await fetch(upstashUrl, {
        method: "POST",
        headers: {
            authorization: `Bearer ${upstashToken}`,
            "content-type": "application/json",
        },
        body: JSON.stringify(command),
        cache: "no-store",
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body?.error) {
        throw new Error(body?.error || `Upstash command failed (${response.status})`)
    }
    return body.result
}

const upstashClient = {
    async get(key) {
        return await runUpstash("GET", key)
    },
    async set(key, value, options = {}) {
        const ttl = Number(options.ex)
        if (ttl) return await runUpstash("SET", key, value, "EX", ttl)
        return await runUpstash("SET", key, value)
    },
    async del(key) {
        return await runUpstash("DEL", key)
    },
    async incr(key, ttlSeconds = 60) {
        const next = await runUpstash("INCR", key)
        if (ttlSeconds) await runUpstash("EXPIRE", key, ttlSeconds)
        return Number(next)
    },
}

const getNativeClient = async () => {
    if (!nativeClientPromise) {
        nativeClientPromise = import("redis").then(async ({ createClient }) => {
            const client = createClient({ url: redisUrl })
            client.on("error", (error) => {
                console.error("[redis] client error:", error?.message || error)
            })
            await client.connect()
            return client
        })
    }
    return nativeClientPromise
}

const nativeRedisClient = {
    async get(key) {
        return await (await getNativeClient()).get(key)
    },
    async set(key, value, options = {}) {
        const ttl = Number(options.ex)
        if (ttl) return await (await getNativeClient()).set(key, value, { EX: ttl })
        return await (await getNativeClient()).set(key, value)
    },
    async del(key) {
        return await (await getNativeClient()).del(key)
    },
    async incr(key, ttlSeconds = 60) {
        const client = await getNativeClient()
        const next = await client.incr(key)
        if (ttlSeconds) await client.expire(key, ttlSeconds)
        return Number(next)
    },
}

const inMemoryClient = {
    async get(key) {
        const value = cacheGet(key)
        if (value === undefined) return null
        return value
    },
    async set(key, value, options = {}) {
        const ttl = Number(options.ex) || undefined
        cacheSet(key, value, ttl)
        return "OK"
    },
    async del(key) {
        cacheDelete(key)
        return 1
    },
    async incr(key, ttlSeconds = 60) {
        return cacheIncr(key, ttlSeconds)
    },
}

export const getRedis = () => {
    if (hasUpstash) return upstashClient
    if (hasNativeRedis) return nativeRedisClient
    return inMemoryClient
}

// Always true because the in-memory fallback ships with the app. Use real
// Redis env vars in production if the cache must survive restarts or scale
// across instances.
export const isRedisConfigured = () => true

export const getRedisMode = () => {
    if (hasUpstash) return "upstash"
    if (hasNativeRedis) return "redis-url"
    return "memory"
}
