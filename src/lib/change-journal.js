/**
 * change-journal
 * ---------------
 * Editor-wide log of changes, with attribution: every entry records whether
 * it was made by the USER or by the AGENT, so the History panel can badge
 * agent-made edits. Three chokepoints feed it:
 *
 *   - command-registry.runCommand wraps every agent command in
 *     beginAgentAction()/endAgentAction() and records the command itself;
 *   - canvas.jsx's pushHistoryState records canvas-level edits (crop, text,
 *     AI extend, …) — attributing them to the agent when one is acting;
 *   - useMaskLayers / mask-grow record mask-stack edits from the panel UI.
 *
 * Attribution works via a REFCOUNTED "agent acting" flag rather than a
 * boolean, because agent commands nest (mask.fromDescription internally adds
 * layers, which push history states — all of it is one agent action).
 *
 * COALESCING: bursts of the same action ("Moved image" five times while the
 * user fiddles with placement, per-pause "Edited text" while typing) merge
 * into ONE entry with a bumped count/timestamp instead of flooding the panel.
 * Two entries merge when their coalesce key (explicit `coalesceKey`, or
 * source+domain+label) matches the newest entry's and it was last touched
 * within COALESCE_WINDOW_MS.
 *
 * PERSISTENCE: localStorage, keyed per project, so the log survives browser
 * restarts (it previously used sessionStorage and silently vanished with the
 * session — "where did my history go?"). Legacy sessionStorage entries are
 * migrated on first load. A small LRU index caps how many projects keep a
 * persisted journal so localStorage can't grow unbounded.
 *
 * Headless-safe: with no `window` the journal still works in memory (the
 * verify script exercises it under bun); persistence and the change event are
 * browser-only extras.
 */

const MAX_ENTRIES = 200
const COALESCE_WINDOW_MS = 10_000
// How many projects keep a persisted journal before the least-recently-used
// ones are pruned from localStorage.
const MAX_PERSISTED_PROJECTS = 20
const EVENT_NAME = 'pixxel:journal-changed'
const INDEX_KEY = 'pixxel:journal-index'
const storageKey = (projectId) => `pixxel:journal:${projectId || 'default'}`

const hasWindow = () => typeof window !== 'undefined'

let entries = []
let currentProjectId = null
let agentDepth = 0
let seq = 0

const readStore = (store, key) => {
    try {
        return store.getItem(key)
    } catch {
        return null
    }
}

const persist = () => {
    if (!hasWindow()) return
    try {
        window.localStorage.setItem(
            storageKey(currentProjectId),
            JSON.stringify(entries.slice(-MAX_ENTRIES)),
        )
    } catch { /* storage full/blocked — in-memory log still works */ }
}

// LRU index of which projects hold a persisted journal. Touched on every
// project bind; projects beyond MAX_PERSISTED_PROJECTS lose their stored log
// (oldest first) so per-project journals can't accumulate forever.
const touchJournalIndex = (projectId) => {
    if (!hasWindow() || !projectId) return
    try {
        const raw = readStore(window.localStorage, INDEX_KEY)
        let index
        try {
            index = JSON.parse(raw || '{}')
        } catch {
            index = {}
        }
        if (!index || typeof index !== 'object' || Array.isArray(index)) index = {}
        index[projectId] = Date.now()
        const ids = Object.keys(index).sort((a, b) => index[b] - index[a])
        for (const stale of ids.slice(MAX_PERSISTED_PROJECTS)) {
            delete index[stale]
            try { window.localStorage.removeItem(storageKey(stale)) } catch { /* ignore */ }
        }
        window.localStorage.setItem(INDEX_KEY, JSON.stringify(index))
    } catch { /* best-effort housekeeping */ }
}

const emit = () => {
    if (!hasWindow()) return
    try {
        window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { entries } }))
    } catch { /* SSR */ }
}

/** Begin an agent-attributed scope. ALWAYS pair with endAgentAction(). */
export const beginAgentAction = () => { agentDepth += 1 }

export const endAgentAction = () => { agentDepth = Math.max(0, agentDepth - 1) }

/** True while any agent command is executing (used for attribution). */
export const isAgentActing = () => agentDepth > 0

/**
 * Record a change. `source` defaults to whoever is acting right now.
 * Repeats of the same action within COALESCE_WINDOW_MS merge into the newest
 * entry (count bumped) instead of appending — see the header comment.
 *
 * @param {{ label: string, detail?: string, source?: 'user'|'agent', domain?: string, coalesceKey?: string }} change
 * @returns {object|null} the recorded (or updated) entry
 */
export const recordChange = ({ label, detail, source, domain, coalesceKey } = {}) => {
    const text = String(label || '').trim()
    if (!text) return null
    const resolvedSource = source === 'agent' || source === 'user' ? source : (isAgentActing() ? 'agent' : 'user')
    const resolvedDomain = domain ? String(domain).slice(0, 24) : undefined
    const key = `${resolvedSource}:${resolvedDomain || ''}:${coalesceKey ? String(coalesceKey).slice(0, 48) : text}`
    const now = Date.now()

    const newest = entries[entries.length - 1]
    if (newest && newest.key === key && now - newest.at < COALESCE_WINDOW_MS) {
        newest.at = now
        newest.count = (newest.count || 1) + 1
        // The freshest label/detail wins — a stale detail from an earlier
        // repeat must not outlive it, so an absent detail clears it.
        newest.label = text.slice(0, 120)
        newest.detail = detail ? String(detail).slice(0, 200) : undefined
        persist()
        emit()
        return newest
    }

    seq += 1
    const entry = {
        id: `chg-${now.toString(36)}-${seq.toString(36)}`,
        at: now,
        label: text.slice(0, 120),
        detail: detail ? String(detail).slice(0, 200) : undefined,
        source: resolvedSource,
        domain: resolvedDomain,
        key,
        count: 1,
    }
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
    persist()
    emit()
    return entry
}

/** Newest-first copy of the journal. */
export const getChanges = () => [...entries].reverse()

export const clearChanges = () => {
    entries = []
    persist()
    emit()
}

/**
 * Bind the journal to a project (loads that project's persisted entries).
 * Call from the editor when the project mounts.
 */
export const setJournalProject = (projectId) => {
    if (projectId === currentProjectId) return
    currentProjectId = projectId || null
    entries = []
    if (hasWindow()) {
        try {
            // localStorage is the durable home; fall back to (and migrate from)
            // the legacy sessionStorage location so pre-existing sessions don't
            // lose their log on upgrade.
            const key = storageKey(currentProjectId)
            let raw = readStore(window.localStorage, key)
            if (!raw) {
                raw = readStore(window.sessionStorage, key)
                if (raw) {
                    try { window.localStorage.setItem(key, raw) } catch { /* ignore */ }
                    try { window.sessionStorage.removeItem(key) } catch { /* ignore */ }
                }
            }
            const parsed = JSON.parse(raw || '[]')
            if (Array.isArray(parsed)) entries = parsed.slice(-MAX_ENTRIES)
        } catch { /* corrupt storage — start fresh */ }
        touchJournalIndex(currentProjectId)
    }
    emit()
}

/**
 * Subscribe to journal changes. Returns an unsubscribe function.
 * (No-op unsubscribe headlessly — there's no event source without window.)
 */
export const subscribeChanges = (cb) => {
    if (!hasWindow() || typeof cb !== 'function') return () => {}
    const handler = () => cb(getChanges())
    window.addEventListener(EVENT_NAME, handler)
    return () => window.removeEventListener(EVENT_NAME, handler)
}
