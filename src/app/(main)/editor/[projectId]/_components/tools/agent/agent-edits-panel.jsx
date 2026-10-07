import { AnimatePresence, motion } from "framer-motion";
import { BrainCircuit, Check, ChevronDown, ChevronUp, Copy, GripHorizontal, History, Loader2, RotateCcw, SlidersHorizontal, Sparkles, WandSparkles } from "lucide-react";
import { STYLE_LABELS } from "@/lib/style-profiles";
import { formatRevisionTime, truncate } from "./format";
import { getChangeItems } from "./plan";
import { AgentEffectControls } from "./ui";

// Resizable edits panel: the proposed plan, its per-change toggles and the version docks.

export default function AgentEditsPanel({
    activePlan,
    agentEditSets,
    applyStoredEditSet,
    commitLiveEdit,
    commitMultiLayerEdit,
    confirmedLayerIds,
    copyUrl,
    dominantColor,
    editsContainerRef,
    editsHeight,
    effectValues,
    enabledChanges,
    handleChangeToggle,
    handleEditsDragStart,
    handleEffectValueChange,
    isApplying,
    isEditsMinimized,
    isThinking,
    hasLiveSnapshot,
    multiLayerPlans,
    pendingConfirmation,
    previewPlanOnCanvas,
    removeStoredEditSet,
    requestPlan,
    restoreRevision,
    restoringRevisionId,
    revertLiveEdit,
    revisions,
    setConfirmedLayerIds,
    setEditsHeight,
    setIsEditsMinimized,
    setPendingConfirmation,
}) {
  // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
  "use no memo";
  return (
    <div
      ref={editsContainerRef}
      className="agent-edits-wrapper"
      style={{
        height: isEditsMinimized ? '32px' : (editsHeight ? `${editsHeight}px` : 'auto'),
        maxHeight: '65vh',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderTop: '1px solid var(--agent-line)',
        marginTop: 'auto',
        background: 'color-mix(in srgb, var(--agent-panel) 98%, transparent)',
        position: 'relative',
        zIndex: 10,
      }}
    >
      {/* Drag Handle */}
      <div
        className="agent-edits-handle"
        onMouseDown={handleEditsDragStart}
        style={{
          height: '32px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'ns-resize',
          position: 'relative',
          flexShrink: 0,
          userSelect: 'none',
        }}
      >
        <GripHorizontal className="h-4 w-4 opacity-40 hover:opacity-80 transition-opacity" />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsEditsMinimized(!isEditsMinimized);
            if (isEditsMinimized && editsHeight && editsHeight < 150) {
              setEditsHeight(400); // Expand to default if it was too small
            }
          }}
          className="agent-icon-action"
          style={{
            position: 'absolute',
            right: '8px',
            padding: '4px',
            background: 'transparent',
            border: 'none',
          }}
          title={isEditsMinimized ? "Maximize edits" : "Minimize edits"}
        >
          {isEditsMinimized ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {!isEditsMinimized && (
        <div
          className="agent-edits-content panel-scroll"
          style={{
            overflowY: 'auto',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            padding: '0.25rem 0 1rem 0',
          }}
        >
          {/* Multi-layer confirmation panel: shown when the agent isn't sure which
              layers the prompt was referring to. User picks → re-request. */}
          <AnimatePresence>
            {pendingConfirmation && (
              <motion.div
                className="agent-review-dock"
                initial={{ opacity: 0, y: 18, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.98 }}
                transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                key="confirm"
              >
                <div className="agent-review-head">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5" />
                      <h4>Confirm layers</h4>
                    </div>
                    <p>{pendingConfirmation.reason}</p>
                  </div>
                </div>
                <div className="agent-layer-confirm-list">
                  {pendingConfirmation.allLayers.map((layer) => {
                    const checked = confirmedLayerIds.includes(layer.index);
                    return (
                      <label key={layer.index} className="agent-layer-confirm-row">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            setConfirmedLayerIds((current) =>
                              e.target.checked
                                ? [...new Set([...current, layer.index])]
                                : current.filter((id) => id !== layer.index)
                            );
                          }}
                        />
                        <span>{layer.name}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="agent-action-row">
                  <motion.button
                    type="button"
                    onClick={() => {
                      const confirmed = [...confirmedLayerIds];
                      const promptToReuse = pendingConfirmation.prompt;
                      setPendingConfirmation(null);
                      requestPlan(promptToReuse, { confirmedTargetIndexes: confirmed });
                    }}
                    disabled={confirmedLayerIds.length === 0 || isThinking}
                    className="agent-action-button agent-action-button--primary"
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.97 }}
                  >
                    <Check className="h-3.5 w-3.5" />
                    Apply to {confirmedLayerIds.length} layer{confirmedLayerIds.length === 1 ? "" : "s"}
                  </motion.button>
                  <motion.button
                    type="button"
                    onClick={() => {
                      setPendingConfirmation(null);
                      setConfirmedLayerIds([]);
                    }}
                    className="agent-action-button"
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.97 }}
                  >
                    Cancel
                  </motion.button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Multi-layer applied status: shown after a multi-target edit lands. */}
          <AnimatePresence>
            {!pendingConfirmation && multiLayerPlans.length > 0 && !activePlan && (
              <motion.div
                className="agent-review-dock"
                initial={{ opacity: 0, y: 18, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.98 }}
                transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                key="multi"
              >
                <div className="agent-review-head">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5" />
                      <h4>Applied to {multiLayerPlans.length} layer{multiLayerPlans.length === 1 ? "" : "s"}</h4>
                    </div>
                    <p>{multiLayerPlans.map((p) => p.layerName).join(" · ")}</p>
                  </div>
                </div>
                <div className="agent-action-row">
                  <motion.button
                    type="button"
                    onClick={() => revertLiveEdit({ addMessage: true })}
                    disabled={!hasLiveSnapshot}
                    className="agent-action-button"
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.97 }}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Not now
                  </motion.button>
                  <motion.button
                    type="button"
                    onClick={commitMultiLayerEdit}
                    disabled={isApplying}
                    className="agent-action-button agent-action-button--primary"
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.97 }}
                  >
                    {isApplying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    Apply
                  </motion.button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {activePlan && (
              <motion.div
                className="agent-review-dock"
                initial={{ opacity: 0, y: 18, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.98 }}
                transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="agent-review-head">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5" />
                      <h4>{activePlan.title}</h4>
                    </div>
                    <p>{activePlan.summary}</p>
                  </div>
                  <button type="button" onClick={copyUrl} className="agent-icon-action" title="Copy URL">
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="agent-review-subhead">
                  <span>
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    Changes
                  </span>
                  <strong>{getChangeItems(activePlan).filter((item) => enabledChanges?.[item.id] !== false).length}/{getChangeItems(activePlan).length} on</strong>
                </div>

                {activePlan.alreadyMatchesTarget && (Number(activePlan.gain) || 0) < 0.1 ? (
                  <div className="agent-already-great">
                    <Check className="h-3.5 w-3.5" />
                    <div>
                      <strong>Already looks great</strong>
                      <p>
                        The image already matches the {STYLE_LABELS[activePlan.targetStyle] || activePlan.targetStyle || "requested"} look.
                        Drag a slider below if you want to push it further.
                      </p>
                    </div>
                  </div>
                ) : null}

                <AgentEffectControls
                  plan={activePlan}
                  enabledMap={enabledChanges}
                  valueMap={effectValues}
                  onToggle={handleChangeToggle}
                  onValueChange={handleEffectValueChange}
                  dominantColor={dominantColor}
                />

                <div className="agent-action-row">
                  <motion.button
                    type="button"
                    onClick={() => previewPlanOnCanvas(activePlan, enabledChanges)}
                    disabled={isThinking || isApplying}
                    className="agent-action-button"
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.97 }}
                  >
                    <BrainCircuit className="h-3.5 w-3.5" />
                    Preview
                  </motion.button>
                  <motion.button
                    type="button"
                    onClick={revertLiveEdit}
                    disabled={!hasLiveSnapshot || isApplying}
                    className="agent-action-button"
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.97 }}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Not now
                  </motion.button>
                  <motion.button
                    type="button"
                    onClick={commitLiveEdit}
                    disabled={isApplying}
                    className="agent-action-button agent-action-button--primary"
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.97 }}
                  >
                    {isApplying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    Apply
                  </motion.button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {agentEditSets.length > 0 && (
            <motion.div
              className="agent-version-dock agent-editset-dock"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="agent-version-head">
                <span>
                  <WandSparkles className="h-3.5 w-3.5" />
                  Agent edit sets
                </span>
                <small>{agentEditSets.length}</small>
              </div>
              <div className="agent-editset-list">
                {agentEditSets.slice(0, 8).map((editSet) => {
                  const isApplied = editSet.status === "applied";
                  const isRemoved = editSet.status === "removed";
                  const statusLabel = isApplied ? "Applied" : isRemoved ? "Removed" : "Saved";
                  const canApplyEditSet =
                    Boolean(editSet.afterCanvasState) ||
                    Boolean(editSet.plan && editSet.plan?.mode !== "multi-layer");
                  return (
                    <div key={editSet._id} className={`agent-editset-row is-${editSet.status}`}>
                      <div className="agent-editset-copy">
                        <strong>{truncate(editSet.title || "Agent edit set", 32)}</strong>
                        <span>{truncate(editSet.prompt || editSet.summary || "Stored change set", 54)}</span>
                        <small>{statusLabel} · {formatRevisionTime(editSet.updatedAt || editSet.createdAt)}</small>
                      </div>
                      <div className="agent-editset-actions">
                        {!isApplied && (
                          <button
                            type="button"
                            className="agent-editset-button agent-editset-button--apply"
                            onClick={() => applyStoredEditSet(editSet)}
                            disabled={isApplying || !canApplyEditSet}
                          >
                            <Check className="h-3.5 w-3.5" />
                            {isRemoved ? "Apply again" : "Apply"}
                          </button>
                        )}
                        {isApplied && (
                          <button
                            type="button"
                            className="agent-editset-button"
                            onClick={() => removeStoredEditSet(editSet)}
                            disabled={isApplying || !editSet.beforeCanvasState}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}

          {revisions.length > 0 && (
            <motion.div
              className="agent-version-dock"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="agent-version-head">
                <span>
                  <History className="h-3.5 w-3.5" />
                  Saved versions
                </span>
                <small>{revisions.length}</small>
              </div>
              <div className="agent-version-row">
                {revisions.slice(0, 6).map((revision) => (
                  <motion.button
                    key={revision._id}
                    type="button"
                    className="agent-version-chip"
                    onClick={() => restoreRevision(revision)}
                    disabled={Boolean(restoringRevisionId)}
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.97 }}
                    title={revision.summary || revision.title || "Restore version"}
                  >
                    <span>{truncate(revision.title || "Saved edit", 24)}</span>
                    <small>
                      {restoringRevisionId === revision._id ? "Restoring..." : formatRevisionTime(revision.createdAt)}
                    </small>
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}
        </div>
      )}
    </div>
  );
}
