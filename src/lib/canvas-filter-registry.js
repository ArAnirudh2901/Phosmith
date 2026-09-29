// Filter classes needed only to rehydrate saved canvas state. Registering them at
// module load put the megashader (82 KB) on every editor's critical path.

let pending = null

/** Register PhosmithCurves + Megashader with Fabric's classRegistry, once. */
export function ensureCanvasFilters() {
    if (!pending) {
        pending = Promise.all([
            import('@/lib/curves-filter'),
            import('@/lib/megashader/fabric-megashader-filter'),
        ]).catch((error) => {
            pending = null
            throw error
        })
    }
    return pending
}

// setClass registers the lowercase form too, so match either casing.
const FILTER_TYPES = /"(?:PhosmithCurves|Megashader)"/i

/** Does saved state name a lazily-registered filter? Text scan: a miss drops a grade. */
export function stateNeedsCanvasFilters(state) {
    if (!state) return false
    try {
        return FILTER_TYPES.test(typeof state === 'string' ? state : JSON.stringify(state))
    } catch {
        return true // unserializable: assume it needs them rather than lose a filter
    }
}
