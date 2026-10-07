import { AnimatePresence } from 'framer-motion'
import { Contrast, Eye, EyeOff, Layers, Redo2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { expandLayerBoundary } from '@/lib/mask-grow'
import { toUserMessage } from '@/lib/user-error'
import LayerGradeEditor from '../_layer-grade-editor'
import { MaskChainCard } from '../_pixel-tool-ui'
import { Section } from './ui'

// Mask Layers: the megashader chain, pinned to the top of the panel.

export default function LayersSection({
    applyCurve,
    baseHasVisibleGrade,
    canRedo,
    canUndo,
    cleanPreview,
    clearAll,
    dominantColor,
    globalInvert,
    handleStartRefine,
    handleStopRefine,
    histogram,
    imageSize,
    maskView,
    moveLayer,
    redoChain,
    refineTarget,
    removeLayer,
    selectLayer,
    selectedLayerId,
    setBase,
    setCleanPreview,
    setFillMode,
    setGlobalInvert,
    setLayerOp,
    setMaskView,
    setRefineTarget,
    setShowMaskOverlay,
    showMaskOverlay,
    stack,
    tool,
    undoChain,
    updateLayer,
}) {
    return (
        <Section
            title="Mask Layers"
            icon={Layers}
            defaultOpen={true}
            badge={stack.chain.length > 0 ? `${stack.chain.length}` : null}
        >
            <div className="space-y-1.5">
                {stack.chain.length > 0 && (
                    <div className="seg-row seg-row--3 flex items-center gap-1.5 pb-1">
                        <button
                            type="button"
                            onClick={() => setShowMaskOverlay(!showMaskOverlay)}
                            aria-pressed={showMaskOverlay}
                            title="Show the selected area as a red overlay"
                            className={`mask-btn seg-btn flex-1 text-[10px] py-1.5 ${showMaskOverlay ? 'mask-btn--danger' : ''}`}
                        >
                            <Eye className="h-3 w-3" />
                            Show mask
                        </button>
                        <button
                            type="button"
                            onClick={() => setGlobalInvert(!globalInvert)}
                            aria-pressed={globalInvert}
                            title="Invert the whole mask"
                            className={`mask-btn seg-btn flex-1 text-[10px] py-1.5 ${globalInvert ? 'mask-btn--primary' : ''}`}
                        >
                            <Contrast className="h-3 w-3" />
                            Invert
                        </button>
                        <button
                            type="button"
                            onClick={() => setCleanPreview(!cleanPreview)}
                            aria-pressed={cleanPreview}
                            title="Clean view: hide handles and outlines to see the graded result"
                            aria-label="Clean view"
                            className={`mask-btn seg-btn flex-1 text-[10px] py-1.5 ${cleanPreview ? 'mask-btn--primary' : ''}`}
                        >
                            <EyeOff className="h-3 w-3" />
                            Clean
                        </button>
                    </div>
                )}
                {stack.chain.length > 0 && showMaskOverlay && (
                    <div className="seg-row seg-row--2 grid grid-cols-2 gap-1.5 pb-1" role="group" aria-label="Mask view">
                        {[
                            { id: 'tint', label: 'Overlay', title: 'Tint the selection over the photo (\\ cycles views)' },
                            { id: 'bw', label: 'Black & white', title: 'Show the mask itself: white = selected (\\ cycles views)' },
                        ].map((v) => (
                            <button
                                key={v.id}
                                type="button"
                                onClick={() => setMaskView(v.id)}
                                aria-pressed={maskView === v.id}
                                title={v.title}
                                className={`mask-btn seg-btn text-[10px] py-1.5 ${maskView === v.id ? 'mask-btn--primary' : ''}`}
                            >
                                {v.label}
                            </button>
                        ))}
                    </div>
                )}
                {stack.chain.length > 0 && (
                    <div className="flex items-center justify-end gap-1.5 pb-1">
                        <button
                            type="button"
                            onClick={undoChain}
                            disabled={!canUndo}
                            title="Undo layer change"
                            className="mask-icon-btn"
                        >
                            <Undo2 className="h-3 w-3" />
                        </button>
                        <button
                            type="button"
                            onClick={redoChain}
                            disabled={!canRedo}
                            title="Redo layer change"
                            className="mask-icon-btn"
                        >
                            <Redo2 className="h-3 w-3" />
                        </button>
                    </div>
                )}
                {/* Pinned Base grade — pre-grades the whole image (pass 1)
                    so per-layer grades stack on top of it. */}
                <div
                    className="rounded-lg p-2"
                    style={{
                        background: 'var(--bg-elevated)',
                        border: `1px solid ${baseHasVisibleGrade ? 'rgba(155,249,91,0.35)' : 'var(--border-subtle)'}`,
                    }}
                >
                    <div className="pb-1">
                        <span className="text-[10px] font-semibold" style={{ color: baseHasVisibleGrade ? '#9bf95b' : 'var(--text-secondary)' }}>
                            Base — whole image
                        </span>
                    </div>
                    <LayerGradeEditor
                        layer={{
                            id: 'base',
                            gamma: 1,
                            wheelShadows: [0, 0, 0],
                            wheelMidtones: [0, 0, 0],
                            wheelHighlights: [0, 0, 0],
                            ...(stack.base || {}),
                        }}
                        onUpdate={(patch) => setBase(patch)}
                        onApplyCurve={applyCurve}
                        histogram={histogram}
                        dominantColor={dominantColor}
                    />
                </div>
                <AnimatePresence>
                    {stack.chain.map((entry, i) => (
                        <MaskChainCard
                            key={entry.layer.id}
                            entry={entry}
                            index={i}
                            total={stack.chain.length}
                            isFirst={i === 0}
                            imageSize={imageSize}
                            selected={selectedLayerId === entry.layer.id}
                            onSelect={selectLayer}
                            onUpdate={(patch) => updateLayer(entry.layer.id, patch)}
                            onRemove={removeLayer}
                            onMove={moveLayer}
                            onSetOp={setLayerOp}
                            onSetFillMode={setFillMode}
                            onApplyCurve={applyCurve}
                            histogram={histogram}
                            dominantColor={dominantColor}
                            onExpandBoundary={(layerId, px, edge) => {
                                // Regenerates the layer's texture from its
                                // pristine base and re-syncs the panel via
                                // the chain-replaced event — so the edge of
                                // an AI-detected subject stays extendable.
                                try {
                                    expandLayerBoundary(tool.mainImage, layerId, px, edge)
                                } catch (err) {
                                    toast.error(toUserMessage(err, 'Could not adjust the mask boundary'))
                                }
                            }}
                            onRefineRegion={handleStartRefine}
                        />
                    ))}
                </AnimatePresence>

                {/* Brush-refine bar (studio-style): strokes land on release;
                    the toggle picks add vs erase, Alt flips per stroke. */}
                {refineTarget && (
                    <div
                        className="space-y-1.5 rounded-md p-2"
                        style={{ border: '1px dashed rgba(124,58,237,0.45)', background: 'rgba(124,58,237,0.06)' }}
                    >
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            Refining the mask — drag to paint, each stroke applies on
                            release. <strong>Alt-drag</strong> flips add/erase. Brush size
                            &amp; hardness are under “Selection Brush”.
                        </p>
                        <div className="grid grid-cols-3 gap-1.5">
                            <button
                                type="button"
                                onClick={() => setRefineTarget((t) => (t ? { ...t, mode: 'add' } : t))}
                                className={`mask-fill-mode-btn ${refineTarget.mode === 'add' ? 'mask-fill-mode-btn--active' : ''}`}
                            >
                                Add
                            </button>
                            <button
                                type="button"
                                onClick={() => setRefineTarget((t) => (t ? { ...t, mode: 'erase' } : t))}
                                className={`mask-fill-mode-btn ${refineTarget.mode === 'erase' ? 'mask-fill-mode-btn--active' : ''}`}
                            >
                                Erase
                            </button>
                            <button
                                type="button"
                                onClick={handleStopRefine}
                                className="mask-btn mask-btn--primary text-[10px] py-1.5"
                            >
                                Done
                            </button>
                        </div>
                    </div>
                )}

                {stack.chain.length === 0 && (
                    <p
                        className="text-[10px] text-center py-3 rounded-md"
                        style={{ color: 'var(--text-muted)', border: '1px dashed var(--border-subtle)' }}
                    >
                        No layers yet — use any selection tool below to add one.
                    </p>
                )}

                {stack.chain.length > 0 && (
                    <button
                        type="button"
                        onClick={clearAll}
                        className="mask-btn mask-btn--danger w-full text-[10px] py-1.5 mt-1"
                    >
                        Clear all layers
                    </button>
                )}
            </div>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Each selection you create becomes a non-destructive mask layer.
                Layers are composited by the megashader filter.
            </p>
        </Section>
    )
}
