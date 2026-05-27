// Client-side helpers for the canvas write-behind cache. The editor calls
// these instead of writing to Convex directly during active editing — every
// edit hits the in-memory server cache (fast) and a debounced flush runs the
// actual Convex mutation periodically and on critical events.
//
// Three exports:
//   - snapshotToCache(projectId, canvasState, currentImageUrl)
//       Persists the latest state to the server cache. Fire-and-forget; safe
//       to call on every keystroke / slider tick. Returns true on success.
//
//   - flushToConvex(projectId, { keepalive })
//       Asks the server to flush the cached state to Convex. Idempotent —
//       if nothing has changed, this is a no-op. `keepalive` lets the request
//       survive a page unload (use on beforeunload).
//
//   - fetchCachedSnapshot(projectId)
//       Read-through. Returns `{ canvasState, currentImageUrl, updatedAt }`
//       or null if no cached state exists.

const SNAPSHOT_ENDPOINT = "/api/canvas/snapshot"
const FLUSH_ENDPOINT = "/api/canvas/flush"

export const snapshotToCache = async (projectId, canvasState, currentImageUrl = null) => {
    if (!projectId || !canvasState) return false
    try {
        const response = await fetch(SNAPSHOT_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                projectId,
                canvasState,
                currentImageUrl,
                clientUpdatedAt: Date.now(),
            }),
        })
        if (!response.ok) {
            // 429 (rate-limited) or 5xx → caller can decide what to do; we
            // never throw so the editor's interactive loop isn't disrupted.
            return false
        }
        const data = await response.json().catch(() => ({}))
        return !data.redisUnavailable
    } catch (error) {
        // Network blip — don't crash the editor.
        console.warn("[canvas-cache] snapshot failed:", error?.message || error)
        return false
    }
}

export const flushToConvex = async (projectId, { keepalive = false } = {}) => {
    if (!projectId) return false
    try {
        const response = await fetch(FLUSH_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectId }),
            keepalive,
        })
        if (!response.ok) return false
        const data = await response.json().catch(() => ({}))
        return !!data.flushed
    } catch (error) {
        console.warn("[canvas-cache] flush failed:", error?.message || error)
        return false
    }
}

export const fetchCachedSnapshot = async (projectId) => {
    if (!projectId) return null
    try {
        const response = await fetch(
            `${SNAPSHOT_ENDPOINT}?projectId=${encodeURIComponent(projectId)}`,
            { method: "GET", cache: "no-store" },
        )
        if (!response.ok) return null
        const data = await response.json().catch(() => ({}))
        return data.snapshot || null
    } catch (error) {
        console.warn("[canvas-cache] fetch snapshot failed:", error?.message || error)
        return null
    }
}

// Builds a per-project debouncer. Stores its timer in a closure so each
// project gets its own debounce — useful when the editor switches projects
// without a full page reload.
export const createDebouncedFlusher = (projectId, debounceMs = 8000) => {
    let handle = null
    const flush = () => {
        handle = null
        flushToConvex(projectId)
    }
    return {
        schedule() {
            if (handle) clearTimeout(handle)
            handle = setTimeout(flush, debounceMs)
        },
        cancel() {
            if (handle) {
                clearTimeout(handle)
                handle = null
            }
        },
        async flushNow() {
            this.cancel()
            return flushToConvex(projectId)
        },
    }
}
