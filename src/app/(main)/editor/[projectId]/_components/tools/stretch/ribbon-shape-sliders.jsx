import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { ProRulerSlider } from '@/components/editor/ProRulerSlider'
import { bestSeedInBand } from '@/lib/pixel-stretch'
import { EASE } from './constants'

// Length, tip width and bend: the sliders that give a ribbon its shape.

export default function RibbonShapeSliders({
    bandExtent,
    commit,
    getSample,
    livePatch,
    params,
    paramsRef,
    pct,
    setActivePresetId,
    sliderCommit,
    sliderVisual,
    tapClass,
}) {
  // Uncompiled, like the panel it was cut from: it reads live objects and refs in render.
  'use no memo'
  return (
    <div className="space-y-3">
      {/* Shown as travel across the FRAME, not as a multiple of the slice: a
          multiple is meaningless to the eye when the slice is 2% tall, and it
          is exactly the control the reference workflow needs (drag the streaks
          past the top of the picture). Stored as the multiple. */}
      <ProRulerSlider
        variant="instrument" label="Length" suffix="% of frame"
        value={Math.round(params.length * bandExtent * 100)}
        min={Math.max(1, Math.round(bandExtent * 100))} max={250} step={1}
        onPreview={(v) => livePatch({ length: Math.max(1, v / 100 / bandExtent) })}
        onCommit={(v) => sliderCommit('length', Math.max(100, (v / bandExtent)))}
        visual={sliderVisual}
      />
      <ProRulerSlider
        variant="instrument" label="Bend" suffix="%"
        value={pct(params.bend)} min={-100} max={100} step={1}
        onPreview={(v) => livePatch({ bend: v / 100 })}
        onCommit={(v) => sliderCommit('bend', v)}
        visual={sliderVisual}
      />
      {/* Next to Bend rather than buried under Refine: with Length this is what
          turns a slice into the reference fan. 0% narrows to a point, 100% is
          parallel, and past that it splays — the old control stopped at 200%,
          which could not open a fan at all. */}
      <ProRulerSlider
        variant="instrument" label="Tip width" suffix="%"
        value={Math.round((1 - params.taper) * 100)} min={0} max={1300} step={5}
        onPreview={(v) => livePatch({ taper: 1 - v / 100 })}
        onCommit={(v) => { setActivePresetId(null); commit({ taper: 1 - v / 100 }) }}
        visual={sliderVisual}
      />

      {/* The physical twist: the ribbon pinches and, past half depth, turns
          over so its two sides swap — the flip seen in the reference clips. */}
      <ProRulerSlider
        variant="instrument" label="Ribbon twist" suffix=" half-turns"
        value={Math.round(params.twistTurns * 10) / 10} min={0} max={3} step={0.1}
        onPreview={(v) => livePatch({ twistTurns: v })}
        onCommit={(v) => { setActivePresetId(null); commit({ twistTurns: v }) }}
        visual={sliderVisual}
      />
      {params.twistTurns > 0 && (
        <ProRulerSlider
          variant="instrument" label="Twist depth" suffix="%"
          value={Math.round((params.twistDepth ?? 1) * 100)} min={0} max={100} step={1}
          onPreview={(v) => livePatch({ twistDepth: v / 100 })}
          onCommit={(v) => { setActivePresetId(null); commit({ twistDepth: v / 100 }) }}
          visual={sliderVisual}
        />
      )}
      <ProRulerSlider
        variant="instrument" label="Seed Line" suffix="%"
        value={pct(params.seed)} min={0} max={100} step={1}
        onPreview={(v) => livePatch({ seed: v / 100 })}
        onCommit={(v) => sliderCommit('seed', v)}
        visual={sliderVisual}
      />
      <button
        type="button"
        onClick={() => {
          const smp = getSample()
          const best = smp?.canvas ? bestSeedInBand(smp.canvas, paramsRef.current.band, paramsRef.current.axis) : null
          if (!best) { toast.error('Could not read this region'); return }
          setActivePresetId(null)
          commit({ seed: best.seed })
          toast.success('Seeded on the most colourful line in the region')
        }}
        className={`mt-1 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-[10.5px] font-medium editor-interactive ${tapClass}`}
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
      >
        <Sparkles className="h-3 w-3" />
        Find the most colourful line
      </button>
    </div>
  )
}
