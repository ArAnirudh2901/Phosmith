import { ProRulerSlider } from '@/components/editor/ProRulerSlider'
import { EASE } from './constants'

// Refine: twist, fade and the finer ribbon controls.

export default function RefineSliders({
    accent,
    commit,
    flowMode,
    livePatch,
    onAccent,
    params,
    pct,
    setActivePresetId,
    sliderCommit,
    sliderVisual,
    tapClass,
    warpMode,
}) {
  // Uncompiled, like the panel it was cut from: it reads live objects and refs in render.
  'use no memo'
  return (
    <div className="space-y-3">
      {!warpMode && !flowMode && (
        <ProRulerSlider
          variant="instrument" label="Twist (S-curve)" suffix="%"
          value={pct(params.twist)} min={-100} max={100} step={1}
          onPreview={(v) => livePatch({ twist: v / 100 })}
          onCommit={(v) => sliderCommit('twist', v)}
          visual={sliderVisual}
        />
      )}
      <ProRulerSlider
        variant="instrument" label="Fade (tips)" suffix="%"
        value={pct(params.fade)} min={0} max={100} step={1}
        onPreview={(v) => livePatch({ fade: v / 100 })}
        onCommit={(v) => sliderCommit('fade', v)}
        visual={sliderVisual}
      />
      <ProRulerSlider
        variant="instrument" label="Fade in (root)" suffix="%"
        value={pct(params.fadeIn)} min={0} max={100} step={1}
        onPreview={(v) => livePatch({ fadeIn: v / 100 })}
        onCommit={(v) => sliderCommit('fadeIn', v)}
        visual={sliderVisual}
      />
      <ProRulerSlider
        variant="instrument" label="Strength" suffix="%"
        value={pct(params.opacity)} min={0} max={100} step={1}
        onPreview={(v) => livePatch({ opacity: v / 100 })}
        onCommit={(v) => sliderCommit('opacity', v)}
        visual={sliderVisual}
      />
      {!flowMode && (
      <button
        type="button"
        onClick={() => { setActivePresetId(null); commit({ mirror: !params.mirror }) }}
        className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-[11px] font-medium editor-interactive ${tapClass}`}
        style={{ background: params.mirror ? accent : 'var(--bg-elevated)', color: params.mirror ? onAccent : 'var(--text-secondary)', border: params.mirror ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
      >
        Mirror (symmetric arc)
        <span>{params.mirror ? 'On' : 'Off'}</span>
      </button>
      )}
    </div>
  )
}
