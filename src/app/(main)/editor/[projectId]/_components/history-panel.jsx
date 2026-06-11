"use client"

import React, { useEffect, useState } from 'react'
import { Bot, ChevronDown, ChevronUp, History, Trash2, User } from 'lucide-react'
import { clearChanges, getChanges, subscribeChanges } from '@/lib/change-journal'

/**
 * History panel — pinned at the bottom of the editor sidebar.
 *
 * Lists every change recorded in the change journal (newest first). Entries
 * made by the AI agent carry a Bot badge so agent edits are visually
 * distinguishable from the user's own; entries persist per project for the
 * session (sessionStorage) and survive tool switches.
 */

const relativeTime = (at) => {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000))
    if (s < 5) return 'just now'
    if (s < 60) return `${s}s ago`
    const m = Math.round(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.round(m / 60)
    if (h < 24) return `${h}h ago`
    return new Date(at).toLocaleDateString()
}

const SourceBadge = ({ source }) => {
    if (source === 'agent') {
        return (
            <span
                className="flex items-center gap-1 rounded px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide shrink-0"
                style={{ background: 'rgba(6,184,212,0.16)', color: 'var(--accent-primary, #06B8D4)' }}
                title="Made by the AI agent"
            >
                <Bot className="h-2.5 w-2.5" />
                Agent
            </span>
        )
    }
    return (
        <span className="shrink-0" title="Made by you" style={{ color: 'var(--text-muted)' }}>
            <User className="h-2.5 w-2.5" />
        </span>
    )
}

export default function HistoryPanel() {
    const [entries, setEntries] = useState([])
    const [open, setOpen] = useState(false)
    // Re-render the relative timestamps once a minute while open.
    const [, setClock] = useState(0)

    useEffect(() => {
        setEntries(getChanges())
        return subscribeChanges(setEntries)
    }, [])

    useEffect(() => {
        if (!open) return undefined
        const t = setInterval(() => setClock((c) => c + 1), 60_000)
        return () => clearInterval(t)
    }, [open])

    const agentCount = entries.filter((e) => e.source === 'agent').length

    return (
        <div
            className="shrink-0 border-t"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface, transparent)' }}
        >
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex w-full items-center gap-2 px-4 py-2 text-left"
                style={{ color: 'var(--text-secondary)' }}
                aria-expanded={open}
            >
                <History className="h-3.5 w-3.5" />
                <span className="text-[11px] font-semibold flex-1">History</span>
                {entries.length > 0 && (
                    <span className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>
                        {entries.length}{agentCount > 0 ? ` · ${agentCount} agent` : ''}
                    </span>
                )}
                {open ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
            </button>

            {open && (
                <div className="px-3 pb-3">
                    <div className="max-h-48 overflow-y-auto panel-scroll space-y-1">
                        {entries.length === 0 && (
                            <p className="text-[10px] px-1 py-2" style={{ color: 'var(--text-muted)' }}>
                                No changes yet — edits you or the agent make will appear here.
                            </p>
                        )}
                        {entries.map((e) => (
                            <div
                                key={e.id}
                                className="flex items-center gap-2 rounded-md px-2 py-1.5"
                                style={{ background: 'var(--bg-elevated)' }}
                            >
                                <SourceBadge source={e.source} />
                                <div className="min-w-0 flex-1">
                                    <p
                                        className="truncate text-[10px] font-medium"
                                        style={{ color: 'var(--text-primary)' }}
                                        title={e.detail ? `${e.label} — ${e.detail}` : e.label}
                                    >
                                        {e.label}
                                    </p>
                                </div>
                                <span className="shrink-0 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                    {relativeTime(e.at)}
                                </span>
                            </div>
                        ))}
                    </div>
                    {entries.length > 0 && (
                        <button
                            type="button"
                            onClick={clearChanges}
                            className="mt-2 flex items-center gap-1.5 text-[10px]"
                            style={{ color: 'var(--text-muted)' }}
                        >
                            <Trash2 className="h-3 w-3" />
                            Clear history
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}
