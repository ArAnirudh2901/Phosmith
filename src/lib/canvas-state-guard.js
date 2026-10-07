// The one rule for what a saved canvas may replace, shared by the editor (which
// copy to load) and the Neon functions (which writes to accept).
//
// An empty canvas is assumed to be a bug — a save that ran before the project
// loaded, a stale cache — and never replaces one that has objects, unless the
// state says the user emptied it. That is how two projects were wiped.

export const INTENTIONALLY_EMPTY = 'intentionallyEmpty'

// The editor nests the Fabric document under `canvas`; older states are the document.
export const canvasObjectCount = (state) => {
    const objects = state?.canvas?.objects ?? state?.objects
    return Array.isArray(objects) ? objects.length : 0
}

export const isUnmarkedEmpty = (state) =>
    canvasObjectCount(state) === 0 && state?.[INTENTIONALLY_EMPTY] !== true

export const isAccidentalEmpty = (next, storedCount) => storedCount > 0 && isUnmarkedEmpty(next)

// Dropping at least half the objects is worth a restorable copy first.
export const isLargeShrink = (next, storedCount) =>
    storedCount > 0 && canvasObjectCount(next) * 2 <= storedCount
