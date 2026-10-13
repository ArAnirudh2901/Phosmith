'use client'

import { useEffect, useState } from 'react'
import { Check, Cloud, FlaskConical, Laptop, Loader2, ScanSearch, Sparkles, X } from 'lucide-react'
import {
    checkSelectionServer,
    getSelectionEngine,
    setSelectionMode,
    subscribeSelectionEngine,
    warmSelectionServer,
} from '@/lib/selection-engine'
import { isSelectionModelCached, releaseClientModels, runClientAISelfTest, subscribeClientAI } from '@/lib/client-ai'

// Where SlimSAM runs: this device, or the server. One card, used by every tool
// that selects (Mask, Erase); the choice is shared through ai-routing.

const ACCENT = '#06d6d6'

const SERVER_LABEL = {
    unknown: { text: 'Checking…', tone: 'muted' },
    checking: { text: 'Checking…', tone: 'muted' },
    ready: { text: 'Ready', tone: 'good' },
    cold: { text: 'Loads on first use', tone: 'muted' },
    asleep: { text: 'Asleep — wakes on first use', tone: 'warn' },
    unconfigured: { text: 'Not set up', tone: 'bad' },
    unsupported: { text: 'No SlimSAM on it', tone: 'bad' },
}

const TONE = { good: '#4ade80', muted: 'var(--text-muted)', warn: 'rgba(251,191,36,0.9)', bad: '#f87171' }

// Before mount: no localStorage or navigator reads, so SSR and the first client render agree.
const NEUTRAL = { mode: 'auto', side: 'client', device: { low: false, reasons: [] }, server: { state: 'unknown' } }

function Tile({ active, auto, disabled, icon: Icon, title, lines, status, onClick, hint }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-pressed={active}
            title={hint}
            className="relative flex min-w-0 flex-col gap-1 rounded-xl p-2.5 text-left transition-all disabled:cursor-not-allowed disabled:opacity-45"
            style={{
                border: `1.5px solid ${active ? 'rgba(6,184,212,0.55)' : 'rgba(244,244,245,0.10)'}`,
                background: active ? 'rgba(6,184,212,0.10)' : 'rgba(244,244,245,0.025)',
                boxShadow: active ? '0 4px 14px rgba(6,184,212,0.12)' : 'none',
            }}
        >
            <span className="flex items-center gap-1.5">
                <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: active ? ACCENT : 'var(--text-secondary)' }} />
                <span className="truncate text-[11px] font-semibold" style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                    {title}
                </span>
                {active && (
                    <span
                        className="ml-auto shrink-0 rounded px-1 text-[8px] font-bold uppercase tracking-wide"
                        style={{ color: ACCENT, background: 'rgba(6,184,212,0.14)' }}
                    >
                        {auto ? 'Auto' : 'On'}
                    </span>
                )}
            </span>
            {lines.map((line) => (
                <span key={line} className="text-[9.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>{line}</span>
            ))}
            {status && (
                <span className="mt-0.5 flex items-start gap-1 text-[9.5px] font-medium leading-snug" style={{ color: TONE[status.tone] }}>
                    <span className="mt-[4px] inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TONE[status.tone] }} />
                    {status.text}
                </span>
            )}
        </button>
    )
}

/**
 * @param {{ compact?: boolean }} props  compact: no explanation or test (the Erase panel)
 */
export default function SelectionEngineCard({ compact = false }) {
    const [engine, setEngine] = useState(NEUTRAL)
    const [cached, setCached] = useState(null)
    const [test, setTest] = useState({ running: false, progress: '', report: null })

    useEffect(() => {
        setEngine(getSelectionEngine())
        checkSelectionServer()
        const refreshCached = () => { isSelectionModelCached().then(setCached) }
        refreshCached()
        const unEngine = subscribeSelectionEngine(setEngine)
        const unClient = subscribeClientAI(refreshCached)
        return () => { unEngine(); unClient() }
    }, [])

    const { mode, side, device, server } = engine
    const auto = mode === 'auto'
    const serverUsable = !['unconfigured', 'unsupported'].includes(server.state)

    const choose = (next) => {
        setTest({ running: false, progress: '', report: null })
        setSelectionMode(next)
        const nextSide = next === 'auto' ? getSelectionEngine().side : next
        if (nextSide === 'server') {
            warmSelectionServer()
            // A weak device wants the memory back now, not after the idle sweep.
            releaseClientModels(['sam'])
        }
    }

    const runTest = async () => {
        setTest({ running: true, progress: 'Starting…', report: null })
        try {
            const report = await runClientAISelfTest({
                side,
                onProgress: (msg) => setTest((t) => ({ ...t, progress: msg })),
            })
            // CLIPSeg is not part of the selection engine; leave it to "Test device AI".
            const checks = report.checks.filter((c) => !/grounding|mask covers/i.test(c.label))
            setTest({ running: false, progress: '', report: { ...report, checks, ok: checks.every((c) => c.ok) } })
        } catch (err) {
            setTest({ running: false, progress: '', report: { ok: false, totalMs: 0, checks: [{ label: 'Test crashed', ok: false, detail: String(err?.message || err) }] } })
        }
    }

    const deviceStatus = cached == null
        ? null
        : cached ? { text: 'Downloaded', tone: 'good' } : { text: 'Downloads 40 MB once', tone: 'muted' }

    const why = auto
        ? device.low
            ? `Auto chose the server: this device has ${device.reasons.join(' and ')}.`
            : 'Auto chose this device: it can run SlimSAM comfortably.'
        : side === 'server'
            ? 'Every selection runs on the server.'
            : 'Every selection runs in this browser.'

    return (
        <div
            className="space-y-2.5 rounded-xl p-3"
            style={{ border: '1px solid var(--border-subtle)', background: 'linear-gradient(180deg, rgba(6,184,212,0.04), rgba(255,255,255,0.01))' }}
        >
            <div className="flex items-center gap-2">
                <ScanSearch className="h-4 w-4 shrink-0" style={{ color: ACCENT }} />
                <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
                    Selection engine
                </span>
                <span className="ml-auto text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>SlimSAM</span>
            </div>
            {!compact && (
                <p className="text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    Runs click and box select, Select Subject, Detect All Subjects and the object remover&apos;s click.
                    Same model, same masks — only where it runs changes.
                </p>
            )}

            <div className="grid grid-cols-2 gap-2">
                <Tile
                    icon={Laptop}
                    title="This device"
                    active={side === 'client'}
                    auto={auto}
                    lines={compact ? ['Private, offline'] : ['Private · works offline', 'Needs a few GB of memory']}
                    status={deviceStatus}
                    onClick={() => choose('client')}
                    hint="Run SlimSAM in this browser (WebGPU, else WASM)"
                />
                <Tile
                    icon={Cloud}
                    title="Server"
                    active={side === 'server'}
                    auto={auto}
                    disabled={!serverUsable}
                    lines={compact ? ['No download'] : ['No download · light on memory', 'Needs a connection']}
                    status={SERVER_LABEL[server.state] || SERVER_LABEL.unknown}
                    onClick={() => choose('server')}
                    hint={serverUsable ? 'Run SlimSAM on the Phosmith server' : server.detail}
                />
            </div>

            <button
                type="button"
                role="switch"
                aria-checked={auto}
                onClick={() => choose(auto ? side : 'auto')}
                className="flex w-full items-center gap-2 text-left"
            >
                <span
                    className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors"
                    style={{ background: auto ? 'rgba(6,184,212,0.55)' : 'rgba(244,244,245,0.14)' }}
                >
                    <span
                        className="absolute h-3 w-3 rounded-full bg-white transition-transform"
                        style={{ transform: `translateX(${auto ? 14 : 2}px)` }}
                    />
                </span>
                <Sparkles className="h-3 w-3 shrink-0" style={{ color: auto ? ACCENT : 'var(--text-muted)' }} />
                <span className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>Choose for me</span>
            </button>
            <p className="text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>{why}</p>

            {side === 'server' && !compact && (
                <p className="text-[9.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    Each photo goes to the server once, as a 1024 px copy. The server keeps only the model&apos;s encoding of it, in memory.
                </p>
            )}
            {side === 'server' && server.state === 'unconfigured' && (
                <p className="text-[10px]" style={{ color: TONE.bad }}>
                    No selection server is set up for this app — selections will fail until you pick This device.
                </p>
            )}

            {!compact && (
                <div className="space-y-1.5">
                    <button
                        type="button"
                        onClick={runTest}
                        disabled={test.running || (side === 'server' && !serverUsable)}
                        className="mask-btn w-full px-2 py-1.5 text-[10px] font-semibold"
                    >
                        {test.running
                            ? <><Loader2 className="h-3 w-3 animate-spin" />{test.progress || 'Testing…'}</>
                            : <><FlaskConical className="h-3 w-3" />Test {side === 'server' ? 'the server' : 'this device'}</>}
                    </button>
                    {test.report && (
                        <div className="space-y-1">
                            {test.report.checks.map((c) => (
                                <div key={c.label} className="flex items-center gap-1.5 text-[10px]">
                                    {c.ok
                                        ? <Check className="h-3 w-3 shrink-0" style={{ color: TONE.good }} />
                                        : <X className="h-3 w-3 shrink-0" style={{ color: TONE.bad }} />}
                                    <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{c.label}</span>
                                </div>
                            ))}
                            <p className="text-[9px]" style={{ color: test.report.ok ? TONE.good : TONE.bad }}>
                                {test.report.ok ? 'All good' : 'Something is wrong'} · {(test.report.totalMs / 1000).toFixed(1)} s
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
