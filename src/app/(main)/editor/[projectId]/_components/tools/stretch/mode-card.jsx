import { AudioLines, Columns3, FlipHorizontal2, Grid3X3, Minus, RotateCcw, Route, Rows3, Spline, Wand2, Waypoints } from 'lucide-react'
import { ProRulerSlider } from '@/components/editor/ProRulerSlider'
import { DEFAULT_SCANLINE, FLOW_MIN_ANCHORS, FLOW_PRESETS, WARP_MAX_DIM, WARP_PRESETS, applyWarpPreset } from '@/lib/pixel-stretch'
import { EASE } from './constants'

// Mode (ribbon, warp, flow, scanline) and the controls that belong to each.

export default function ModeCard({
    accent,
    applyFlowPresetUI,
    applyWarp,
    cardStyle,
    flowAnchorCount,
    flowMode,
    flowPresetId,
    livePatch,
    onAccent,
    params,
    paramsRef,
    patchScan,
    removeFlowPointAt,
    resetFlow,
    resetWarpGrid,
    scanMode,
    setFlowWidthCommit,
    setFlowWidthLive,
    setStretchMode,
    sliderVisual,
    smoothFlow,
    splitWarp,
    tapClass,
    warpMode,
    warpPresetId,
    warpStrength,
}) {
  // Uncompiled, like the panel it was cut from: it reads live objects and refs in render.
  'use no memo'
  return (
    <div className="panel-card" style={cardStyle}>
      <label className="panel-label">Mode</label>
      <div className="mt-2 grid grid-cols-4 gap-2">
        {[
          { id: 'mesh', label: 'Warp', Icon: Grid3X3 },
          { id: 'flow', label: 'Flow Path', Icon: Waypoints },
          { id: 'simple', label: 'Simple', Icon: Wand2 },
          { id: 'scan', label: 'Scanline', Icon: AudioLines },
        ].map(({ id, label, Icon }) => {
          const curMode = scanMode ? 'scan' : warpMode ? 'mesh' : flowMode ? 'flow' : 'simple'
          const on = curMode === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => setStretchMode(id)}
              className={`flex h-12 flex-col items-center justify-center gap-1 rounded-lg text-[10px] font-medium editor-interactive ${tapClass}`}
              style={{ background: on ? accent : 'var(--bg-elevated)', color: on ? onAccent : 'var(--text-secondary)', border: on ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          )
        })}
      </div>
      {scanMode && (
        <div className="mt-3 space-y-3">
          <p className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            No selection: every row (or column) keeps the pixels that pass the threshold and drags the last one across the rest. Raise <strong>Threshold</strong> until only the shapes you want to smear survive.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'horizontal', label: 'Rows', Icon: Rows3 },
              { id: 'vertical', label: 'Columns', Icon: Columns3 },
            ].map(({ id, label, Icon }) => {
              const on = (params.scan?.axis || 'horizontal') === id
              return (
                <button
                  key={id} type="button"
                  onClick={() => patchScan({ axis: id })}
                  className={`flex h-10 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive ${tapClass}`}
                  style={{ background: on ? `${accent}22` : 'var(--bg-elevated)', border: on ? `1.5px solid ${accent}` : '1px solid var(--border-subtle)', color: on ? accent : 'var(--text-secondary)', transition: `all 0.2s ${EASE}` }}
                >
                  <Icon className="h-3.5 w-3.5" />{label}
                </button>
              )
            })}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'dark', label: 'Smear over dark' },
              { id: 'light', label: 'Smear over light' },
            ].map(({ id, label }) => {
              const on = (params.scan?.mode || 'dark') === id
              return (
                <button
                  key={id} type="button"
                  onClick={() => patchScan({ mode: id })}
                  className={`flex h-9 items-center justify-center rounded-lg text-[10px] font-medium editor-interactive ${tapClass}`}
                  style={{ background: on ? `${accent}22` : 'var(--bg-elevated)', border: on ? `1.5px solid ${accent}` : '1px solid var(--border-subtle)', color: on ? accent : 'var(--text-secondary)', transition: `all 0.2s ${EASE}` }}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => patchScan({ direction: (params.scan?.direction ?? 1) > 0 ? -1 : 1 })}
            className={`flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-[10px] font-medium editor-interactive ${tapClass}`}
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.2s ${EASE}` }}
          >
            <FlipHorizontal2 className="h-3.5 w-3.5" />
            {(params.scan?.direction ?? 1) > 0
              ? ((params.scan?.axis || 'horizontal') === 'vertical' ? 'Smearing downward' : 'Smearing right')
              : ((params.scan?.axis || 'horizontal') === 'vertical' ? 'Smearing upward' : 'Smearing left')}
          </button>
          <ProRulerSlider
            variant="instrument" label="Threshold" suffix="%"
            value={Math.round((params.scan?.threshold ?? DEFAULT_SCANLINE.threshold) * 100)} min={0} max={100} step={1}
            onPreview={(v) => patchScan({ threshold: v / 100 }, true)}
            onCommit={(v) => patchScan({ threshold: v / 100 })}
            visual={sliderVisual}
          />
          <ProRulerSlider
            variant="instrument" label="Smear length" suffix="%"
            value={Math.round((params.scan?.length ?? DEFAULT_SCANLINE.length) * 100)} min={1} max={100} step={1}
            onPreview={(v) => patchScan({ length: v / 100 }, true)}
            onCommit={(v) => patchScan({ length: v / 100 })}
            visual={sliderVisual}
          />
          <ProRulerSlider
            variant="instrument" label="Fade to black" suffix="%"
            value={Math.round((params.scan?.fade ?? 0) * 100)} min={0} max={100} step={1}
            onPreview={(v) => patchScan({ fade: v / 100 }, true)}
            onCommit={(v) => patchScan({ fade: v / 100 })}
            visual={sliderVisual}
          />
          <ProRulerSlider
            variant="instrument" label="Strength" suffix="%"
            value={Math.round((params.scan?.opacity ?? 1) * 100)} min={0} max={100} step={1}
            onPreview={(v) => patchScan({ opacity: v / 100 }, true)}
            onCommit={(v) => patchScan({ opacity: v / 100 })}
            visual={sliderVisual}
          />
        </div>
      )}
      {warpMode && params.warpGrid && (
        <div className="mt-3 space-y-3">
          <p className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Drag a <strong style={{ color: 'rgba(90, 170, 255, 1)' }}>■ anchor</strong> to move the sheet, a <strong style={{ color: 'rgba(120, 190, 255, 1)' }}>● handle</strong> to bend the curve through it (the tangent line shows the direction), or an interior dot to push the patch. Split to sculpt more curves — exactly like the Photoshop Warp transform.
          </p>

          {/* Warp shape presets */}
          <div>
            <span className="panel-label inline-flex items-center gap-1.5"><Spline className="h-3 w-3" /> Warp Shape</span>
            <div className="mt-1.5 grid grid-cols-4 gap-1.5">
              {WARP_PRESETS.map((wp) => {
                const on = warpPresetId === wp.id
                return (
                  <button
                    key={wp.id} type="button" title={wp.hint}
                    onClick={() => applyWarp(wp.id, wp.id === 'flat' ? 1 : warpStrength)}
                    className={`flex h-9 items-center justify-center rounded-lg text-[10px] font-medium editor-interactive ${tapClass}`}
                    style={{ background: on ? `${accent}22` : 'var(--bg-elevated)', border: on ? `1.5px solid ${accent}` : '1px solid var(--border-subtle)', color: on ? accent : 'var(--text-secondary)', transition: `all 0.2s ${EASE}` }}
                  >
                    {wp.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Preset strength — re-applies the active shape live */}
          {warpPresetId && warpPresetId !== 'flat' && (
            <ProRulerSlider
              variant="instrument" label="Warp Strength" suffix="%"
              value={Math.round(warpStrength * 100)} min={0} max={150} step={5}
              onPreview={(v) => { const r = applyWarpPreset(paramsRef.current, warpPresetId, v / 100); livePatch({ warpGrid: r.grid, warpRest: r.rest }) }}
              onCommit={(v) => applyWarp(warpPresetId, v / 100)}
              visual={sliderVisual}
            />
          )}

          {/* Grid density / split-warp */}
          <div>
            <div className="flex items-center justify-between">
              <span className="panel-label">Mesh Density</span>
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                {(params.warpGrid.length - 1) / 3}×{(params.warpGrid[0].length - 1) / 3} patches
              </span>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <button
                type="button" onClick={() => splitWarp('row')} disabled={params.warpGrid.length >= WARP_MAX_DIM}
                title="Split every patch horizontally (adds control points)"
                className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive disabled:opacity-40 ${tapClass}`}
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
              >
                <Rows3 className="h-3.5 w-3.5" /> Split Rows
              </button>
              <button
                type="button" onClick={() => splitWarp('col')} disabled={params.warpGrid[0].length >= WARP_MAX_DIM}
                title="Split every patch vertically (adds control points)"
                className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive disabled:opacity-40 ${tapClass}`}
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
              >
                <Columns3 className="h-3.5 w-3.5" /> Split Cols
              </button>
            </div>
          </div>

          <button
            type="button" onClick={resetWarpGrid}
            className={`flex w-full items-center justify-center gap-2 rounded-lg py-2 text-[11px] font-medium editor-interactive ${tapClass}`}
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
          >
            <RotateCcw className="h-3 w-3" />
            Reset Grid
          </button>
        </div>
      )}

      {flowMode && params.flowPath && (
        <div className="mt-3 space-y-3">
          <p className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Drag the <strong style={{ color: 'rgba(40, 130, 255, 1)' }}>■ anchors</strong> to route the smear and the <strong style={{ color: 'rgba(120, 190, 255, 1)' }}>● handles</strong> to bend each segment. <strong style={{ color: 'var(--text-secondary)' }}>Click the line</strong> to add a point · <strong style={{ color: 'var(--text-secondary)' }}>double-click</strong> a point to remove it.
          </p>

          {/* Flow shape presets */}
          <div>
            <span className="panel-label inline-flex items-center gap-1.5"><Route className="h-3 w-3" /> Flow Shape</span>
            <div className="mt-1.5 grid grid-cols-4 gap-1.5">
              {FLOW_PRESETS.map((fpz) => {
                const on = flowPresetId === fpz.id
                return (
                  <button
                    key={fpz.id} type="button" title={fpz.hint}
                    onClick={() => applyFlowPresetUI(fpz.id)}
                    className={`flex h-9 items-center justify-center rounded-lg text-[10px] font-medium editor-interactive ${tapClass}`}
                    style={{ background: on ? `${accent}22` : 'var(--bg-elevated)', border: on ? `1.5px solid ${accent}` : '1px solid var(--border-subtle)', color: on ? accent : 'var(--text-secondary)', transition: `all 0.2s ${EASE}` }}
                  >
                    {fpz.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Ribbon width along the path */}
          <ProRulerSlider
            variant="instrument" label="Ribbon Width" suffix="%"
            value={Math.round((params.flowPath.width || 0.18) * 100)} min={2} max={80} step={1}
            onPreview={(v) => setFlowWidthLive(v / 100)}
            onCommit={(v) => setFlowWidthCommit(v / 100)}
            visual={sliderVisual}
          />

          {/* Anchor count + edit actions */}
          <div className="flex items-center justify-between">
            <span className="panel-label">Anchors</span>
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
              {flowAnchorCount} points
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button" onClick={smoothFlow}
              title="Re-smooth every anchor (Catmull-Rom tangents)"
              className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive ${tapClass}`}
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
            >
              <Spline className="h-3.5 w-3.5" /> Smooth
            </button>
            <button
              type="button" onClick={() => removeFlowPointAt(params.flowPath.anchors.length - 1)}
              disabled={params.flowPath.anchors.length <= FLOW_MIN_ANCHORS}
              title="Remove the last anchor"
              className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive disabled:opacity-40 ${tapClass}`}
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
            >
              <Minus className="h-3.5 w-3.5" /> Remove Point
            </button>
          </div>

          <button
            type="button" onClick={resetFlow}
            className={`flex w-full items-center justify-center gap-2 rounded-lg py-2 text-[11px] font-medium editor-interactive ${tapClass}`}
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
          >
            <RotateCcw className="h-3 w-3" />
            Reset Path
          </button>
        </div>
      )}
    </div>
  )
}
