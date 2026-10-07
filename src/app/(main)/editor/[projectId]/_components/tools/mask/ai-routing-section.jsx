import { Cpu, FlaskConical, Loader2 } from 'lucide-react'
import { AI_CAPABILITIES, resetRoutingPolicy, setRoutingMode } from '@/lib/ai-routing'
import { Section } from './ui'

// AI Processing: where each AI capability runs (device / server / auto).

export default function AiRoutingSection({
    CLIENT_READY,
    clientAI,
    handleSelfTest,
    routingBadge,
    routingPolicy,
    selfTest,
}) {
    return (
        <Section title="AI Processing" icon={Cpu} defaultOpen={false} badge={routingBadge}>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Choose where each AI function runs. <strong>Device</strong> keeps
                everything in this browser (models download once);{' '}
                <strong>Server</strong> uses the local AI service / Gemini;{' '}
                <strong>Auto</strong> prefers the server and falls back to the device.
            </p>
            {Object.entries(AI_CAPABILITIES).map(([cap, def]) => (
                <div key={cap} className="space-y-1">
                    {/* flex-wrap: in a narrow sidebar the three-mode pill
                        row drops below the label instead of overlapping it */}
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span
                            className="text-[10px] font-semibold"
                            style={{ color: 'var(--text-secondary)' }}
                            title={def.hint}
                        >
                            {def.label}
                        </span>
                        <div className="mask-fill-modes" style={{ marginTop: 0 }}>
                            {['auto', ...(def.client ? ['client'] : []), ...(def.server ? ['server'] : [])].map((mode) => (
                                <button
                                    key={mode}
                                    type="button"
                                    onClick={() => setRoutingMode(cap, mode)}
                                    className={`mask-fill-mode-btn ${routingPolicy[cap] === mode ? 'mask-fill-mode-btn--active' : ''}`}
                                    title={mode === 'client' ? (def.clientImpl || 'In this browser')
                                        : mode === 'server' ? (def.serverImpl || 'On the server')
                                            : 'Server first, device fallback'}
                                >
                                    {mode === 'auto' ? 'Auto' : mode === 'client' ? 'Device' : 'Server'}
                                </button>
                            ))}
                        </div>
                    </div>
                    {/* Device-model readiness: this capability is set to run
                        on-device and has a downloadable browser model. The
                        background prefetch downloads it; show its progress. */}
                    {routingPolicy[cap] === 'client' && cap in CLIENT_READY && (
                        <span
                            className="text-[9px]"
                            style={{ color: CLIENT_READY[cap] ? '#4ade80' : 'var(--text-muted)' }}
                        >
                            {CLIENT_READY[cap]
                                ? '✓ Model ready on device'
                                : clientAI.loading
                                    ? `Downloading ${clientAI.loading}…`
                                    : 'Model downloads in the background'}
                        </span>
                    )}
                </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
                <button
                    type="button"
                    onClick={resetRoutingPolicy}
                    className="whitespace-nowrap text-[10px]"
                    style={{ color: 'var(--text-muted)' }}
                >
                    Reset to Auto
                </button>
                <button
                    type="button"
                    onClick={handleSelfTest}
                    disabled={selfTest.running}
                    className="mask-btn whitespace-nowrap px-2 py-1 text-[10px] font-semibold"
                    title="Runs the in-browser models on a test image with a known answer. First run downloads the models (one-time)."
                >
                    {selfTest.running ? (
                        <>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Testing…
                        </>
                    ) : (
                        <>
                            <FlaskConical className="h-3 w-3" />
                            Test device AI
                        </>
                    )}
                </button>
            </div>
            {selfTest.running && selfTest.progress && (
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{selfTest.progress}</p>
            )}
            {selfTest.report && (
                <div className="space-y-1">
                    {selfTest.report.checks.map((c) => (
                        <div key={c.label} className="flex items-center gap-1.5 text-[10px]">
                            <span style={{ color: c.ok ? '#4ade80' : '#ef4444' }}>{c.ok ? '✓' : '✗'}</span>
                            <span style={{ color: 'var(--text-secondary)' }}>{c.label}</span>
                            <span className="ml-auto font-mono" style={{ color: 'var(--text-muted)' }}>{c.detail}</span>
                        </div>
                    ))}
                    <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                        {selfTest.report.device?.toUpperCase()} · {(selfTest.report.totalMs / 1000).toFixed(1)}s
                    </p>
                </div>
            )}
        </Section>
    )
}
