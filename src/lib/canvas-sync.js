// Canvas sync orchestrator — optimises the write-behind path and makes it
// resilient to the user dropping offline mid-edit.
//
// It sits between the editor's saveCanvasState() and the existing
// snapshot/flush cache helpers, adding four things the raw cache lacked:
//
//   1. Dedup — skips the network snapshot when the serialized state is
//      byte-identical to the last one already sent (cheap rolling hash).
//   2. Single-flight + coalescing — only one snapshot is ever in flight; rapid
//      edits collapse into "send the latest once the current one finishes",
//      so writes can't race or arrive out of order.
//   3. Durable offline mirror (IndexedDB) — every save is written locally FIRST,
//      so a disconnect / reload / tab-close never loses work. On reconnect the
//      latest local state is replayed to Redis → Neon automatically.
//   4. Unload beacon — on tab close it ships the very latest state via
//      navigator.sendBeacon (which survives unload) so the final, sub-debounce
//      edits are captured for the next load instead of being dropped.
//
// UI-decoupled on purpose: the editor wires it; the in-app agent (or any other
// driver) can reuse the same manager.

const DB_NAME = "pixxel-canvas-sync"
const STORE = "states"
const DB_VERSION = 1

// ── IndexedDB: the durable local mirror ─────────────────────────────────────
let dbPromise = null
const openDB = () => {
    if (typeof indexedDB === "undefined") return Promise.resolve(null)
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve) => {
        let req
        try {
            req = indexedDB.open(DB_NAME, DB_VERSION)
        } catch {
            resolve(null)
            return
        }
        req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: "projectId" })
            }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
    })
    return dbPromise
}

const withStore = async (mode, run) => {
    const db = await openDB()
    if (!db) return null
    return new Promise((resolve) => {
        let tx
        try {
            tx = db.transaction(STORE, mode)
        } catch {
            resolve(null)
            return
        }
        let req
        try {
            req = run(tx.objectStore(STORE))
        } catch {
            resolve(null)
            return
        }
        tx.oncomplete = () => resolve(req ? req.result : null)
        tx.onerror = () => resolve(null)
        tx.onabort = () => resolve(null)
    })
}

// Store/overwrite the single "latest" record for a project. `dirty` = not yet
// confirmed flushed to Neon.
export const saveLocalState = (projectId, record) =>
    withStore("readwrite", (store) => store.put({ projectId, ...record }))

export const loadLocalState = (projectId) =>
    projectId ? withStore("readonly", (store) => store.get(projectId)) : Promise.resolve(null)

export const clearLocalState = (projectId) =>
    withStore("readwrite", (store) => store.delete(projectId))

// ── Online status ───────────────────────────────────────────────────────────
export const getOnlineStatus = () =>
    typeof navigator === "undefined" || typeof navigator.onLine !== "boolean" ? true : navigator.onLine

export const subscribeOnlineStatus = (cb) => {
    if (typeof window === "undefined") return () => {}
    const onOnline = () => cb(true)
    const onOffline = () => cb(false)
    window.addEventListener("online", onOnline)
    window.addEventListener("offline", onOffline)
    return () => {
        window.removeEventListener("online", onOnline)
        window.removeEventListener("offline", onOffline)
    }
}

// FNV-1a over the serialized state. Same bytes → same hash, so we can skip the
// network round-trip when nothing actually changed between two save() calls.
export const cheapHash = (str) => {
    let h = 0x811c9dc5
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i)
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) | 0
    }
    return (h >>> 0).toString(16)
}

const SNAPSHOT_ENDPOINT = "/api/canvas/snapshot"

// status values: 'idle' | 'saving' | 'saved' | 'offline' | 'error' | 'conflict'
export const createCanvasSync = ({
    projectId,
    snapshotFn,       // (projectId, fullState, currentImageUrl, baseRevision) => Promise<boolean>
    flushFn,          // (projectId, { keepalive, canvasState, currentImageUrl, baseRevision, force }) => Promise<object>
    onStatus,         // (status, detail) => void
    onConflict,       // (serverProject) => void   another session advanced the revision
    flushDebounceMs = 8000,
    initialRevision = 0,
}) => {
    let lastSentHash = null      // last state successfully written to Redis
    let inFlight = false
    let pending = null           // latest coalesced job waiting for the in-flight one
    let latest = null            // most recent { fullState, currentImageUrl, hash, updatedAt }
    let pendingSync = false      // latest hasn't been confirmed flushed to Neon
    let flushHandle = null
    let destroyed = false
    let online = getOnlineStatus()
    // Optimistic-concurrency token: the project revision this client is editing
    // on top of. Advances on every confirmed flush; a mismatch on flush means
    // another session wrote in between (conflict).
    let baseRevision = Number.isFinite(Number(initialRevision)) ? Number(initialRevision) : 0
    let conflicted = false       // holding flushes until the user resolves a conflict

    const setStatus = (status, detail) => {
        if (destroyed) return // don't poke React state after teardown
        try { onStatus?.(status, detail) } catch { /* never let a UI callback break sync */ }
    }

    const cancelFlush = () => {
        if (flushHandle) { clearTimeout(flushHandle); flushHandle = null }
    }
    const scheduleFlush = () => {
        if (flushHandle) clearTimeout(flushHandle)
        flushHandle = setTimeout(() => { flushHandle = null; doFlush() }, flushDebounceMs)
    }

    const markIdb = (dirty) => {
        if (!latest) return
        saveLocalState(projectId, {
            fullState: latest.fullState,
            currentImageUrl: latest.currentImageUrl,
            hash: latest.hash,
            updatedAt: latest.updatedAt,
            baseRevision,
            dirty,
        }).catch((err) => console.warn("[canvas-sync] local mirror write failed:", err?.message || err))
    }

    // Flush the LATEST state to Neon with an optimistic-concurrency check. The
    // content is carried inline so it's authoritative for this client (immune to
    // the shared Redis key). NOT gated on `destroyed` so the unmount flushNow()
    // can still complete.
    const doFlush = async ({ keepalive = false, force = false } = {}) => {
        if (!online || !latest) return { flushed: false }
        const flushHash = latest.hash
        let res
        try {
            res = await flushFn(projectId, {
                keepalive,
                canvasState: latest.fullState,
                currentImageUrl: latest.currentImageUrl,
                baseRevision,
                force,
            })
        } catch (err) {
            setStatus("error", err?.message || String(err))
            return { flushed: false }
        }
        if (res?.conflict) {
            // Another session advanced the revision. Hold further auto-flushes and
            // hand the server state to the UI to reconcile (non-destructively).
            // Deliberately DON'T advance baseRevision: our local content is still
            // based on the OLD revision, so the held base must stay old — otherwise
            // a later unload/keepalive flush would match the server and overwrite
            // the other session's work.
            conflicted = true
            cancelFlush() // stop any scheduled flush from re-firing the conflict
            setStatus("conflict")
            try { onConflict?.(res.project) } catch { /* UI cb must not break sync */ }
            return res
        }
        if (res?.flushed) {
            if (typeof res.revision === "number") baseRevision = res.revision
            conflicted = false
            // Only declare clean if nothing newer slipped in while we flushed.
            if (latest && latest.hash === flushHash) {
                pendingSync = false
                markIdb(false)
                setStatus("saved")
            } else {
                setStatus("saving")
            }
        }
        return res
    }

    const processPending = async () => {
        if (inFlight || !pending || destroyed) return
        const job = pending
        pending = null
        inFlight = true
        let toThrow = null
        try {
            if (!online) {
                // Offline: the durable IDB mirror already holds `latest`; the
                // reconnect handler will replay it. Nothing to send now.
                setStatus("offline")
                return
            }
            if (conflicted && !job.force) {
                // Hold until the user resolves the conflict (local stays in IDB).
                setStatus("conflict")
                return
            }

            const needsSnapshot = job.hash !== lastSentHash
            if (!needsSnapshot && !job.immediate && !job.force) {
                setStatus("saved")
                return
            }

            setStatus("saving")
            if (needsSnapshot) {
                // Best-effort cache write for cross-device read-through + the unload
                // path. The flush carries content, so we don't gate on this.
                snapshotFn(projectId, job.fullState, job.currentImageUrl, baseRevision).catch(() => {})
                lastSentHash = job.hash
            }

            if (job.immediate || job.force) {
                const res = await doFlush({ force: job.force })
                if (res?.conflict) {
                    /* handled in doFlush (held) */
                } else if (res?.flushed) {
                    cancelFlush()
                } else if (job.rethrow) {
                    toThrow = new Error("Canvas save did not persist")
                } else {
                    // Transient failure — retry on the debounce rather than leaving
                    // the status stuck on "saving".
                    scheduleFlush()
                }
            } else {
                scheduleFlush()
            }
        } finally {
            inFlight = false
            if (pending && !conflicted) processPending()
        }
        if (toThrow) throw toThrow
    }

    // Replay the latest local state after a reconnect (or on startup if a prior
    // offline session left dirty local state).
    const replayLocal = async () => {
        if (!online || destroyed || conflicted) return
        let source = latest
        let dirty = pendingSync
        if (!source) {
            // Startup path: nothing edited yet this session — pull the last record
            // a prior session left in IndexedDB and only replay it if it never made
            // it to Neon (dirty).
            const local = await loadLocalState(projectId)
            if (!local || !local.fullState) {
                setStatus("saved")
                return
            }
            source = {
                fullState: local.fullState,
                currentImageUrl: local.currentImageUrl,
                hash: local.hash,
                updatedAt: local.updatedAt,
            }
            dirty = local.dirty !== false // missing/true ⇒ assume it needs syncing

            // Restore the revision this offline work was BASED ON, so the replay
            // flush is checked against the right baseline. BUT only if the local
            // revision is >= what the manager was initialized with. If the local
            // revision is OLDER, the data was already flushed (e.g. via beacon on
            // tab close) and bumped the server revision — the IDB just wasn't
            // cleaned up. In that case, the "dirty" state is stale and should be
            // discarded to avoid a spurious conflict.
            const localRev = Number(local.baseRevision)
            if (Number.isFinite(localRev)) {
                if (localRev < baseRevision) {
                    // Stale local state — the server already has this or newer data.
                    // Clear the dirty flag so it doesn't re-trigger on next load.
                    saveLocalState(projectId, { ...local, dirty: false }).catch(() => {})
                    setStatus("saved")
                    return
                }
                baseRevision = localRev
            }
            latest = source
        }
        if (!dirty || (lastSentHash && source.hash === lastSentHash)) {
            setStatus("saved")
            return
        }
        pendingSync = true
        pending = {
            fullState: source.fullState,
            currentImageUrl: source.currentImageUrl,
            hash: source.hash,
            immediate: true,
            rethrow: false,
        }
        await processPending()
    }

    const handleOnlineChange = (isOnline) => {
        online = isOnline
        if (!isOnline) { setStatus("offline"); return }
        if (conflicted) { setStatus("conflict"); return }
        setStatus("saving", "reconnecting")
        replayLocal()
    }
    const unsubscribe = subscribeOnlineStatus(handleOnlineChange)

    // On startup, push any dirty state a prior offline session left in IndexedDB.
    if (online) replayLocal()

    return {
        // Persist a freshly serialized state. Always mirrors to IndexedDB first,
        // then syncs over the network (deduped, single-flight, online + conflict
        // aware).
        async save(fullState, currentImageUrl, { immediate = false, rethrow = false } = {}) {
            if (destroyed || !fullState) return
            const serialized = JSON.stringify(fullState)
            // Dedup key = 32-bit content hash + exact length. Pairing the hash with
            // the length makes an accidental collision (which would silently skip a
            // real, different state) astronomically unlikely.
            const hash = cheapHash(serialized) + ":" + serialized.length.toString(36)
            const updatedAt = Date.now()
            latest = { fullState, currentImageUrl, hash, updatedAt }

            // Durable mirror ALWAYS — even offline / mid-conflict, even before the
            // network call.
            const isNew = hash !== lastSentHash
            if (isNew) pendingSync = true
            markIdb(pendingSync)

            // Fast path: unchanged state on an autosave → nothing to send.
            if (!isNew && !immediate) {
                setStatus(conflicted ? "conflict" : online ? "saved" : "offline")
                return
            }

            pending = { fullState, currentImageUrl, hash, immediate, rethrow }
            await processPending()
        },

        async flushNow() {
            cancelFlush()
            return doFlush()
        },

        // Resolve a conflict by OVERWRITING the server with the local version.
        // Used by the "Keep mine" action after the losing remote state has been
        // preserved as a ProjectRevision by the caller. force=true bypasses the
        // revision check so it always lands.
        overwriteRemote() {
            conflicted = false
            if (!latest) return
            pendingSync = true
            lastSentHash = null
            pending = { fullState: latest.fullState, currentImageUrl: latest.currentImageUrl, hash: latest.hash, immediate: true, force: true }
            processPending()
        },

        // Best-effort persistence on tab close. sendBeacon survives unload and
        // lands the LATEST state in Redis (so the next load rehydrates from it,
        // capturing edits made within the autosave debounce window). The IDB
        // mirror is the backstop if the beacon is dropped (too large / offline).
        beaconUnload() {
            cancelFlush()
            try {
                if (latest && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
                    const body = JSON.stringify({
                        projectId,
                        canvasState: latest.fullState,
                        currentImageUrl: latest.currentImageUrl,
                        baseRevision,
                        clientUpdatedAt: latest.updatedAt,
                    })
                    // The browser caps sendBeacon (~64KB). Only attempt it under
                    // that ceiling; larger states fall back to the keepalive flush
                    // plus the IndexedDB mirror (recovered on the next load).
                    if (body.length <= 60_000) {
                        const queued = navigator.sendBeacon(SNAPSHOT_ENDPOINT, new Blob([body], { type: "application/json" }))
                        if (!queued) console.warn("[canvas-sync] unload beacon rejected by the browser")
                    } else {
                        console.warn("[canvas-sync] state too large for an unload beacon; relying on cache flush + local mirror")
                    }
                }
            } catch { /* ignore */ }
            // Also flush whatever's already in Redis to Neon (keepalive lets it
            // finish). Conflicts can't be resolved during unload, so this is
            // best-effort; the next load reconciles via the revision check.
            try { flushFn(projectId, { keepalive: true, baseRevision }) } catch { /* ignore */ }
        },

        // Align the manager's base to the revision the freshly-rehydrated canvas
        // content is based on (called by rehydration once the winning source —
        // Neon / Redis snapshot / IndexedDB — is known), so the next flush is
        // checked against the right baseline rather than always the current Neon
        // revision. No-op once any edit has set lastSentHash.
        setBaseRevision(rev) {
            if (lastSentHash) return
            if (Number.isFinite(Number(rev))) baseRevision = Number(rev)
        },

        isOnline: () => online,
        hasPendingSync: () => pendingSync,
        isConflicted: () => conflicted,
        getRevision: () => baseRevision,

        destroy() {
            destroyed = true
            cancelFlush()
            unsubscribe()
        },
    }
}
