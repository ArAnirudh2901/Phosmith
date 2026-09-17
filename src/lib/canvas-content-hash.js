// Content identity for a persisted canvas state. Postgres JSONB reorders keys
// and JSON drops undefined fields, and undo history is trimmed differently per
// storage tier, so a raw string compare never matches a round-tripped state.

const stable = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
    return '{' + Object.keys(v)
        .filter((k) => v[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stable(v[k]))
        .join(',') + '}'
}

export const canvasContentHash = (state) => {
    if (!state) return null
    let s = state
    if (typeof s === 'string') {
        try { s = JSON.parse(s) } catch { return null }
    }
    if (typeof s !== 'object') return null
    const { history, historyIndex, ...content } = s
    return hashString(stable(content))
}

const hashString = (str) => {
    let h = 0x811c9dc5
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
    }
    return `${(h >>> 0).toString(16)}:${str.length}`
}

// Per-project ledger of content this browser saved, so a reload can tell a late
// write from its own previous page (older, same lineage) from another device's edit.
const LEDGER_MAX = 40
const ledgerKey = (projectId) => `phosmith:content-ledger:${projectId}`

const readLedger = (projectId) => {
    try {
        const v = JSON.parse(localStorage.getItem(ledgerKey(projectId)) || '[]')
        return Array.isArray(v) ? v : []
    } catch { return [] }
}

export const recordSavedContent = (projectId, hash) => {
    if (!projectId || !hash) return
    const list = readLedger(projectId)
    if (list[list.length - 1]?.h === hash) return
    const t = Math.max(Date.now(), (list[list.length - 1]?.t || 0) + 1)
    const next = list.filter((e) => e.h !== hash).concat({ h: hash, t }).slice(-LEDGER_MAX)
    try { localStorage.setItem(ledgerKey(projectId), JSON.stringify(next)) } catch { /* quota/private mode */ }
}

export const savedContentTime = (projectId, hash) =>
    (hash && readLedger(projectId).find((e) => e.h === hash)?.t) || null

// Highest revision this TAB's flushes produced (sessionStorage survives reload and
// HMR, not other tabs). A server still at that revision holds our own lineage.
const revKey = (projectId) => `phosmith:written-revision:${projectId}`
export const recordWrittenRevision = (projectId, rev) => {
    const n = Number(rev)
    if (!projectId || !Number.isFinite(n)) return
    try {
        if (n > (Number(sessionStorage.getItem(revKey(projectId))) || 0)) sessionStorage.setItem(revKey(projectId), String(n))
    } catch { /* storage unavailable */ }
}
export const writtenRevision = (projectId) => {
    try { return Number(sessionStorage.getItem(revKey(projectId))) || null } catch { return null }
}
