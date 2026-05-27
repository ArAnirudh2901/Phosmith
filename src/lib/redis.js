// "Redis-shaped" client backed by the in-memory cache in server-cache.js.
//
// Kept the name and surface (getRedis + isRedisConfigured + Redis-style
// async get/set/del/incr methods) so the API routes that already use it
// don't have to change if/when we swap in a real Redis later. Right now this
// is just an in-memory Map with TTLs — see server-cache.js for the trade-offs.

import { cacheDelete, cacheGet, cacheIncr, cacheSet } from "./server-cache"

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

// Always returns a non-null client now (in-memory). Calls that previously
// checked for null can keep doing so without changing — they just won't see
// null from this layer anymore.
export const getRedis = () => inMemoryClient

// Always "configured" — the backing store ships with the app.
export const isRedisConfigured = () => true
