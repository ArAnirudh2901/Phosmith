export const MAX_PERSISTED_HISTORY = 30

export const MIN_PERSISTED_HISTORY_ENTRIES = 3

export const MAX_NEON_STATE_CHARS = 900_000

// Tiered autosave: MAJOR changes (real edits) save on the fast debounce as
// before; MINOR ones (sub-threshold nudges — see canvas-change-describe) ride
// a slow trickle so fidgeting can't generate a stream of snapshot/flush API
// calls. Minor edits are still durable immediately via the IndexedDB mirror
// and the unload beacon, and any pending major save carries them for free.
export const MAJOR_SAVE_DEBOUNCE_MS = 2000

export const MINOR_SAVE_TRICKLE_MS = 30_000

// 'text:changed' fires per keystroke. Without a debounce every keystroke
// became its own undo state and evicted the whole 30-entry history while
// typing a sentence — push ONE history state per typing pause instead.
export const TEXT_HISTORY_DEBOUNCE_MS = 900

// How long the network snapshot (Redis write-behind) is allowed to lag the
// freshest state — see minSnapshotIntervalMs in canvas-sync.
export const MIN_SNAPSHOT_INTERVAL_MS = 4000

// Neon flush debounce. Was 8s; 15s halves database writes in active sessions
// with no durability cost (Redis snapshot + IndexedDB hold the latest state,
// and tab-hide/unload force a flush anyway).
export const FLUSH_DEBOUNCE_MS = 15_000

export const getPrimaryRemoteImageUrl = (canvas) => {
    const image = canvas
        ?.getObjects?.()
        ?.find((object) => object?.type?.toLowerCase() === 'image')
    const src =
        image?.getSrc?.() ||
        image?._originalElement?.src ||
        image?._element?.src ||
        image?.src ||
        ''

    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return null
    return src.startsWith('http') ? src : null
}
