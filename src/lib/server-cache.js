// In-memory server-side cache with TTL + size bounds.
//
// This is the backing store for two things:
//   1) Per-user rate limits on the AI endpoints (small counters)
//   2) Canvas write-behind snapshots (larger JSON blobs)
//
// Why in-memory, not Redis: keeps the project zero-deps and works in any
// deployment that runs Node (no external service to provision). The trade-off
// is the cache is scoped to a single process — if you scale horizontally to N
// instances, each one has its own cache, so behaviors that need *cross-instance
// consistency* (like global rate limiting) become per-instance. For solo dev
// and small deployments that's fine. For multi-node, swap in a Redis backing
// store later without changing any caller — they only use the exports below.
//
// Persistence: lost on process restart. For canvas state that's safe because we
// flush to Neon on every critical event (Save button, beforeunload). The
// cache is a write-behind buffer, not the source of truth.

const MAX_ENTRIES = 5000              // LRU eviction kicks in past this
const DEFAULT_TTL_SECONDS = 24 * 60 * 60 // 24h
const SWEEP_INTERVAL_MS = 60_000

const store = new Map()    // key → { value, expiresAt, accessedAt }

const sweep = () => {
    const now = Date.now()
    for (const [key, entry] of store) {
        if (entry.expiresAt && entry.expiresAt <= now) {
            store.delete(key)
        }
    }
    // Bound size — evict least-recently-accessed if we exceed the cap.
    if (store.size > MAX_ENTRIES) {
        const sorted = [...store.entries()].sort((a, b) => a[1].accessedAt - b[1].accessedAt)
        const toEvict = sorted.slice(0, store.size - MAX_ENTRIES)
        for (const [key] of toEvict) store.delete(key)
    }
}

if (typeof globalThis !== "undefined" && !globalThis.__pixxelCacheSweep) {
    const handle = setInterval(sweep, SWEEP_INTERVAL_MS)
    if (typeof handle.unref === "function") handle.unref()
    globalThis.__pixxelCacheSweep = handle
}

export const cacheGet = (key) => {
    const entry = store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
        store.delete(key)
        return undefined
    }
    entry.accessedAt = Date.now()
    return entry.value
}

export const cacheSet = (key, value, ttlSeconds = DEFAULT_TTL_SECONDS) => {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null
    store.set(key, { value, expiresAt, accessedAt: Date.now() })
}

export const cacheDelete = (key) => {
    store.delete(key)
}

export const cacheIncr = (key, ttlSeconds) => {
    const current = Number(cacheGet(key)) || 0
    const next = current + 1
    cacheSet(key, next, ttlSeconds)
    return next
}

export const cacheStats = () => ({ size: store.size, maxEntries: MAX_ENTRIES })
