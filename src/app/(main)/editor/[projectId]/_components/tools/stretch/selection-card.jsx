import { AudioLines, BrainCircuit, Check, Lasso, Loader2, Pencil, RotateCcw, ScanSearch, Square, Zap } from 'lucide-react'
import { EASE } from './constants'

// Region selection: pick a tool, draw, confirm, or skip to a whole-photo smear.

export default function SelectionCard({
    accent,
    accentText,
    aiLoading,
    applying,
    autoDetectSubject,
    autoStretch,
    cardStyle,
    changeMode,
    confirmRegion,
    lassoPtsRef,
    onAccent,
    phase,
    regionReady,
    reselect,
    samLoading,
    scheduleFrame,
    selectionMode,
    setPhase,
    setRegionReady,
    setStretchMode,
    tapClass,
}) {
  // Uncompiled, like the panel it was cut from: it reads live objects and refs in render.
  'use no memo'
  return (
    <div className="panel-card" style={{ ...cardStyle, borderColor: `${accent}30` }}>
      <label className="panel-label">Selection Tool</label>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {[
          { id: 'lasso', label: 'Lasso', Icon: Lasso },
          { id: 'rect', label: 'Rectangle', Icon: Square },
        ].map(({ id, label, Icon }) => {
          const on = selectionMode === id
          return (
            <button
              key={id}
              type="button"
              disabled={phase === 'stretch'}
              onClick={() => changeMode(id)}
              className={`flex h-9 items-center justify-center gap-2 rounded-lg text-xs font-medium editor-interactive disabled:opacity-40 ${tapClass}`}
              style={{ background: on ? accent : 'var(--bg-elevated)', color: on ? onAccent : 'var(--text-secondary)', border: on ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          )
        })}
      </div>

      {phase === 'select' ? (
        <>
          <p className="mt-2.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {selectionMode === 'lasso' ? (
              <><span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Draw a freeform shape</span> around the area you want to smear, then confirm to stretch it.</>
            ) : (
              <><span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Drag a rectangle</span> over the area you want to smear, then confirm to stretch it.</>
            )}
          </p>
          <div className="mt-2.5 flex gap-2">
            {selectionMode === 'lasso' && (
              <button
                type="button"
                onClick={() => { lassoPtsRef.current = []; setRegionReady(false); scheduleFrame() }}
                className={`flex h-10 flex-1 items-center justify-center gap-2 rounded-xl text-xs font-semibold editor-interactive ${tapClass}`}
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={confirmRegion}
              disabled={!regionReady}
              className={`flex h-10 flex-[2] items-center justify-center whitespace-nowrap gap-2 rounded-xl text-xs font-semibold editor-interactive disabled:opacity-40 ${tapClass}`}
              style={{ background: accent, color: onAccent, border: 'none', boxShadow: `0 0 28px ${accent}45`, transition: `all 0.25s ${EASE}` }}
            >
              <Check className="h-3.5 w-3.5" />
              Confirm Region
            </button>
          </div>

          {/* The scanline smear reads the whole frame, so it must not be locked
              behind a selection the user does not need to make. */}
          <button
            type="button"
            onClick={() => { setPhase('stretch'); setStretchMode('scan') }}
            className={`mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-xl text-[11px] font-medium editor-interactive ${tapClass}`}
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
          >
            <AudioLines className="h-3.5 w-3.5" />
            Skip — smear the whole photo (Scanline)
          </button>

          {/* ── Use the subject's shape as the SOURCE region (on-device SAM) ── */}
          <div style={{
            marginTop: 12, padding: '10px 12px', borderRadius: 12,
            background: 'linear-gradient(135deg, rgba(16,185,129,0.12), rgba(6,182,212,0.12))',
            border: '1px solid rgba(16,185,129,0.25)',
          }}>
            <div className="flex items-center gap-2 mb-2">
              <ScanSearch className="h-3.5 w-3.5" style={{ color: '#34d399' }} />
              <span className="text-[11px] font-semibold" style={{ color: '#34d399' }}>Stretch the subject’s shape</span>
            </div>
            <p className="text-[10.5px] leading-relaxed mb-2.5" style={{ color: 'var(--text-muted)' }}>
              Detects the main subject on-device (no API calls) and uses its outline as the region to smear. To put streaks <em>behind</em> a subject instead, set that in <strong style={{ color: 'var(--text-secondary)' }}>Placement</strong> after confirming.
            </p>
            <button
              type="button"
              onClick={autoDetectSubject}
              disabled={samLoading || applying}
              className={`flex h-10 w-full items-center justify-center gap-2 rounded-xl text-xs font-semibold editor-interactive disabled:opacity-50 ${tapClass}`}
              style={{
                background: samLoading ? 'rgba(16,185,129,0.2)' : 'linear-gradient(135deg, #10b981, #06b6d4)',
                color: '#fff', border: 'none',
                boxShadow: samLoading ? 'none' : '0 0 24px rgba(16,185,129,0.35), 0 2px 8px rgba(0,0,0,0.3)',
                transition: `all 0.3s ${EASE}`,
              }}
            >
              {samLoading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Detecting…
                </>
              ) : (
                <>
                  <ScanSearch className="h-3.5 w-3.5" />
                  Detect Subject
                </>
              )}
            </button>
          </div>

          {/* ── AI Auto Stretch ─────────────────────────────────────────── */}
          <div style={{
            marginTop: 12, padding: '10px 12px', borderRadius: 12,
            background: 'linear-gradient(135deg, rgba(139,92,246,0.12), rgba(59,130,246,0.12))',
            border: '1px solid rgba(139,92,246,0.25)',
          }}>
            <div className="flex items-center gap-2 mb-2">
              <BrainCircuit className="h-3.5 w-3.5" style={{ color: '#a78bfa' }} />
              <span className="text-[11px] font-semibold" style={{ color: '#a78bfa' }}>AI Auto Stretch</span>
            </div>
            <p className="text-[10.5px] leading-relaxed mb-2.5" style={{ color: 'var(--text-muted)' }}>
              Finds the subject, runs stripes from its most colourful line into the open side of the frame with a look that suits it, and keeps the subject in front — the whole Photoshop sequence in one tap.
            </p>
            <button
              type="button"
              onClick={autoStretch}
              disabled={aiLoading || applying}
              className={`flex h-10 w-full items-center justify-center gap-2 rounded-xl text-xs font-semibold editor-interactive disabled:opacity-50 ${tapClass}`}
              style={{
                background: aiLoading ? 'rgba(139,92,246,0.2)' : 'linear-gradient(135deg, #7c3aed, #3b82f6)',
                color: '#fff', border: 'none',
                boxShadow: aiLoading ? 'none' : '0 0 24px rgba(124,58,237,0.35), 0 2px 8px rgba(0,0,0,0.3)',
                transition: `all 0.3s ${EASE}`,
              }}
            >
              {aiLoading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Analyzing…
                </>
              ) : (
                <>
                  <Zap className="h-3.5 w-3.5" />
                  Auto Stretch with AI
                </>
              )}
            </button>
          </div>
        </>
      ) : (
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: accentText }}>
            <Check className="h-3.5 w-3.5" /> Region confirmed
          </span>
          <button
            type="button"
            onClick={reselect}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium editor-interactive ${tapClass}`}
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
          >
            <Pencil className="h-3 w-3" /> Edit region
          </button>
        </div>
      )}
    </div>
  )
}
