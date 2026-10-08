import { Check, Lasso, Layers, Loader2, ScanSearch, Square, X } from 'lucide-react'
import { ProRulerSlider } from '@/components/editor/ProRulerSlider'
import { EASE } from './constants'

// Placement: the stretch is its own layer, above, partly behind or behind the subject.

export default function PlacementCard({
    accent,
    accentText,
    beginSubjectPick,
    cancelSubjectPick,
    cardStyle,
    coverage,
    coverageRef,
    ensureMatteRef,
    featherRef,
    forceAutoDetect,
    isEditingLayer,
    matteIsManualRef,
    matteStatus,
    onAccent,
    scheduleFrame,
    scheduleFrameRef,
    setCoverageMode,
    setPlacementMode,
    setSubjectMaskKind,
    setWrapCommit,
    setWrapLive,
    sliderVisual,
    subjectCutoutRef,
    subjectMaskKind,
    subjectMaskKindRef,
    subjectPicking,
    subjectRawMatteRef,
    tapClass,
    wrapAt,
    wrapRecross,
}) {
  // Uncompiled, like the panel it was cut from: it reads live objects and refs in render.
  'use no memo'
  return (
    <div className="panel-card" style={{ ...cardStyle, borderColor: `${accent}30` }}>
      <div className="flex items-center justify-between">
        <label className="panel-label inline-flex items-center gap-1.5"><Layers className="h-3 w-3" /> Placement</label>
        {isEditingLayer && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold" style={{ color: accentText }}>
            <Check className="h-3 w-3" /> Editing layer
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        The stretch is its own layer — crop, colour-grade or move it like any image, and it stays even if you <strong style={{ color: 'var(--text-secondary)' }}>delete the photo</strong>. Pick how it sits relative to the subject:
      </p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {[
          { id: 'above', label: 'Above', hint: 'Streaks on top of the subject' },
          { id: 'partial', label: 'Partial', hint: 'Out from behind the subject, then across it in front' },
          { id: 'below', label: 'Behind', hint: 'Subject in front of the streaks' },
        ].map(({ id, label, hint }) => {
          const cur = wrapAt != null && coverage > 0 ? 'partial' : coverage <= 0.05 ? 'above' : 'below'
          const on = cur === id
          return (
            <button
              key={id} type="button" title={hint} onClick={() => setPlacementMode(id === 'below' ? 'behind' : id)}
              className={`flex h-11 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium editor-interactive ${tapClass}`}
              style={{ background: on ? accent : 'var(--bg-elevated)', color: on ? onAccent : 'var(--text-secondary)', border: on ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
            >
              {label}
            </button>
          )
        })}
      </div>
      {coverage > 0 && (
        <div className="mt-3 space-y-3">
          {/* What stays in front — the selection by default, or a detected /
              traced subject when the user asks for one */}
          <div>
            <span className="panel-label">What stays in front?</span>
            <button
              type="button"
              onClick={() => {
                subjectMaskKindRef.current = 'selection'
                setSubjectMaskKind('selection')
                matteIsManualRef.current = false
                subjectRawMatteRef.current = null
                subjectCutoutRef.current = null
                ensureMatteRef.current?.()
                scheduleFrameRef.current?.()
              }}
              className={`mt-1.5 flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive ${tapClass}`}
              style={{ background: subjectMaskKind === 'selection' ? accent : 'var(--bg-elevated)', color: subjectMaskKind === 'selection' ? onAccent : 'var(--text-secondary)', border: subjectMaskKind === 'selection' ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
            >
              <Square className="h-3.5 w-3.5" />
              My selection
            </button>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={forceAutoDetect}
                disabled={matteStatus === 'loading'}
                className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive disabled:opacity-50 ${tapClass}`}
                style={{ background: subjectMaskKind === 'auto' ? accent : 'var(--bg-elevated)', color: subjectMaskKind === 'auto' ? onAccent : 'var(--text-secondary)', border: subjectMaskKind === 'auto' ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
              >
                {matteStatus === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
                Auto-detect
              </button>
              <button
                type="button"
                onClick={() => (subjectPicking ? cancelSubjectPick() : beginSubjectPick())}
                className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive ${tapClass}`}
                style={{ background: subjectPicking ? '#f59e0b' : subjectMaskKind === 'manual' ? accent : 'var(--bg-elevated)', color: subjectPicking || subjectMaskKind === 'manual' ? '#0b0e14' : 'var(--text-secondary)', border: subjectPicking || subjectMaskKind === 'manual' ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
              >
                {subjectPicking ? <X className="h-3.5 w-3.5" /> : <Lasso className="h-3.5 w-3.5" />}
                {subjectPicking ? 'Cancel' : subjectMaskKind === 'manual' ? 'Re-draw subject' : 'Draw subject'}
              </button>
            </div>
            <div className="mt-2 text-[10px] leading-relaxed">
              {subjectPicking && <span style={{ color: '#f59e0b' }}>✏️ Trace around the subject on the photo, then release to set it.</span>}
              {!subjectPicking && matteStatus === 'loading' && <span className="inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}><Loader2 className="h-3 w-3 animate-spin" /> Detecting subject on-device…</span>}
              {!subjectPicking && subjectMaskKind === 'selection' && <span style={{ color: '#34d399' }}>✓ Streaks sit behind the area you selected — no AI, no extra memory.</span>}
              {!subjectPicking && subjectMaskKind === 'auto' && <span style={{ color: '#34d399' }}>✓ Subject auto-detected — streaks sit behind it.</span>}
              {!subjectPicking && subjectMaskKind === 'manual' && <span style={{ color: '#34d399' }}>✓ Using your traced region as the subject.</span>}
              {!subjectPicking && matteStatus === 'none' && subjectMaskKind === 'none' && <span style={{ color: '#f59e0b' }}>No subject auto-detected — tap “Draw subject” to mark it by hand.</span>}
            </div>
          </div>

          {wrapAt != null && (
            <div className="space-y-1.5">
              <ProRulerSlider
                variant="instrument" label="In front from" suffix="%"
                value={Math.round(wrapAt * 100)} min={0} max={100} step={1}
                onPreview={(v) => setWrapLive(v / 100)}
                onCommit={(v) => setWrapCommit(v / 100)}
                visual={sliderVisual}
              />
              <p className="text-[10px] leading-relaxed" style={{ color: wrapRecross ? 'var(--text-muted)' : '#f59e0b' }}>
                {wrapRecross
                  ? 'Behind the subject up to this point along the ribbon, in front after it — set where it comes back over the subject.'
                  : 'The ribbon rises out of the subject and covers it from this point along — slide to choose how much of the subject it overlaps.'}
              </p>
            </div>
          )}

          <ProRulerSlider
            variant="instrument" label="Subject Coverage" suffix="%"
            value={Math.round(coverage * 100)} min={0} max={100} step={1}
            onPreview={(v) => { coverageRef.current = v / 100; scheduleFrame() }}
            onCommit={(v) => setCoverageMode(v / 100)}
            visual={sliderVisual}
          />
          <ProRulerSlider
            variant="instrument" label="Edge Feather" suffix=""
            value={Math.round((featherRef.current || 0.006) * 1000)} min={0} max={30} step={1}
            onPreview={(v) => { featherRef.current = v / 1000; subjectCutoutRef.current = null; scheduleFrame() }}
            onCommit={(v) => { featherRef.current = v / 1000; subjectCutoutRef.current = null; scheduleFrame() }}
            visual={sliderVisual}
          />
        </div>
      )}
    </div>
  )
}
