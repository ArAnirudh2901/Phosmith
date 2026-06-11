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
 * Headless-safe: with no `window` the journal still works in memory (the
 * verify script exercises it under bun); persistence (sessionStorage, keyed
 * per project) and the change event are browser-only extras.
 */

const MAX_ENTRIES = 200
const EVENT_NAME = 'pixxel:journal-changed'
const storageKey = (projectId) => `pixxel:journal:${projectId || 'default'}`

const hasWindow = () => typeof window !== 'undefined'

let entries = []
let currentProjectId = null
let agentDepth = 0
let seq = 0

const persist = () => {
    if (!hasWindow()) return
    try {
        window.sessionStorage.setItem(
            storageKey(currentProjectId),
            JSON.stringify(entries.slice(-MAX_ENTRIES)),
        )
    } catch { /* storage full/blocked — in-memory log still works */ }
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
 *
 * @param {{ label: string, detail?: string, source?: 'user'|'agent', domain?: string }} change
 * @returns {object|null} the recorded entry
 */
export const recordChange = ({ label, detail, source, domain } = {}) => {
    const text = String(label || '').trim()
    if (!text) return null
    seq += 1
    const entry = {
        id: `chg-${Date.now().toString(36)}-${seq.toString(36)}`,
        at: Date.now(),
        label: text.slice(0, 120),
        detail: detail ? String(detail).slice(0, 200) : undefined,
        source: source === 'agent' || source === 'user' ? source : (isAgentActing() ? 'agent' : 'user'),
        domain: domain ? String(domain).slice(0, 24) : undefined,
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
            const raw = window.sessionStorage.getItem(storageKey(currentProjectId))
            const parsed = JSON.parse(raw || '[]')
            if (Array.isArray(parsed)) entries = parsed.slice(-MAX_ENTRIES)
        } catch { /* corrupt storage — start fresh */ }
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
