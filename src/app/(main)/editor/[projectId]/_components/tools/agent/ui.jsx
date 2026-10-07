import React from "react";
import { motion } from "framer-motion";
import { Bot, Copy, RotateCcw, SlidersHorizontal, Sparkles, User } from "lucide-react";
import { toast } from "sonner";
import { ProRulerSlider } from "@/components/editor/ProRulerSlider";
import { formatMessageTime, truncate } from "./format";
import { createEnabledMap, formatAdjustmentValue, getChangeItems } from "./plan";

// New: slider-equipped row for "adjustment" entries; toggle-only row for ImageKit AI tokens.
export const AgentEffectControls = ({
  plan,
  enabledMap = {},
  valueMap = {},
  onToggle,
  onValueChange,
  interactive = true,
  dominantColor = "#5eb8ff",
}) => {
  const changes = getChangeItems(plan);
  if (!changes.length) {
    return (
      <div className="agent-change-empty">
        <SlidersHorizontal className="h-3.5 w-3.5" />
        No adjustable changes in this prompt.
      </div>
    );
  }

  return (
    <div className="agent-change-list">
      {changes.map((change) => {
        const enabled = enabledMap?.[change.id] !== false;
        if (change.type === "imagekit") {
          return (
            <button
              key={change.id}
              type="button"
              className={`agent-change-row ${enabled ? "agent-change-row--enabled" : "agent-change-row--muted"}`}
              onClick={() => interactive && onToggle?.(change.id)}
              disabled={!interactive}
              aria-pressed={enabled}
              title={change.detail}
            >
              <span className="agent-change-switch" aria-hidden="true">
                <span />
              </span>
              <span className="agent-change-copy">
                <span className="agent-change-name">{change.label}</span>
                <span className="agent-change-detail">{change.detail}</span>
              </span>
              <span className="agent-change-value">{change.valueLabel}</span>
            </button>
          );
        }
        // Adjustment row: toggle + slider + value chip
        const liveValue = Number(valueMap?.[change.key] ?? change.defaultValue ?? change.neutral ?? 0);
        return (
          <div
            key={change.id}
            className={`agent-effect-row ${enabled ? "is-on" : "is-off"}`}
            style={{ "--agent-effect-accent": dominantColor }}
          >
            <button
              type="button"
              className="agent-effect-toggle"
              onClick={() => interactive && onToggle?.(change.id)}
              disabled={!interactive}
              aria-pressed={enabled}
              title={enabled ? "Disable" : "Enable"}
            >
              <span className="agent-change-switch" aria-hidden="true">
                <span />
              </span>
            </button>
            <div className="agent-effect-body">
              <div className="agent-effect-header">
                <span className="agent-effect-name">{change.label}</span>
                <span className="agent-effect-value">{formatAdjustmentValue(change.key, liveValue)}</span>
              </div>
              <div className={`agent-effect-slider ${enabled ? "" : "agent-effect-slider--muted"}`}>
                <ProRulerSlider
                  variant="instrument"
                  value={liveValue}
                  min={change.min}
                  max={change.max}
                  step={1}
                  label={change.label}
                  onPreview={(v) => interactive && enabled && onValueChange?.(change.key, v, { commit: false })}
                  onCommit={(v) => interactive && enabled && onValueChange?.(change.key, v, { commit: true })}
                  visual={{
                    fill: "rgba(94, 184, 255, 0.35)",
                    accent: dominantColor,
                    trackBg: "rgba(14, 18, 26, 0.96)",
                  }}
                />
              </div>
              {change.detail && (
                <p className="agent-effect-detail">{change.detail}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export const AgentChangeList = React.memo(({ plan, enabledMap = {}, onToggle, compact = false, interactive = true }) => {
  const changes = getChangeItems(plan);

  if (!changes.length) {
    return (
      <motion.div
        layout
        className="agent-change-empty"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        No changes needed for this prompt.
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      className={`agent-change-list ${compact ? "agent-change-list--compact" : ""}`}
      initial={{ opacity: 0, y: 10, filter: "blur(8px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, y: -8, filter: "blur(8px)" }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
    >
      {changes.map((change, index) => {
        const enabled = enabledMap?.[change.id] !== false;
        return (
          <motion.button
            key={change.id}
            type="button"
            className={`agent-change-row ${enabled ? "agent-change-row--enabled" : "agent-change-row--muted"}`}
            onClick={() => interactive && onToggle?.(change.id)}
            disabled={!interactive}
            aria-pressed={enabled}
            title={interactive ? "Toggle this change" : change.detail}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: compact ? 0 : index * 0.035, duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            whileHover={interactive ? { x: 3 } : {}}
            whileTap={interactive ? { scale: 0.985 } : {}}
          >
            <span className="agent-change-switch" aria-hidden="true">
              <span />
            </span>
            <span className="agent-change-copy">
              <span className="agent-change-name">{change.label}</span>
              {!compact && <span className="agent-change-detail">{change.detail}</span>}
            </span>
            <span className="agent-change-value">{change.valueLabel}</span>
          </motion.button>
        );
      })}
    </motion.div>
  );
});

AgentChangeList.displayName = "AgentChangeList";

export const AgentThinkingRow = ({ prompt, autoPreview = true }) => (
  <motion.div
    layout
    className="agent-thinking-row"
    initial={{ opacity: 0, y: 10, filter: "blur(8px)" }}
    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
    exit={{ opacity: 0, y: -8, filter: "blur(8px)" }}
    transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
  >
    <div>
      <Sparkles className="h-3.5 w-3.5" />
      Reading prompt
    </div>
    <strong>{truncate(prompt || "Latest edit", 56)}</strong>
    <span>{autoPreview ? "Preview will update automatically" : "Manual preview ready after planning"}</span>
  </motion.div>
);

export const MessageBubble = ({ message, canUndoPreview = false, onUndoPreview, isApplying = false }) => {
  const isUser = message.role === "user";
  const hasUndoablePreview = !isUser && Boolean(message.previewToken);

  const copyContent = () => {
    try {
      navigator.clipboard?.writeText(message.content || "");
      toast.success("Copied");
    } catch {
      toast.error("Couldn't copy");
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className={`agent-message-line ${isUser ? "agent-message-line--user" : ""}`}
    >
      <div className="agent-message-meta">
        <span
          className={`agent-message-avatar ${isUser ? "agent-message-avatar--user" : ""}`}
          title={isUser ? "You" : "Agent"}
        >
          {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
        </span>
        {message.at && (
          <span className="agent-message-time">{formatMessageTime(message.at)}</span>
        )}
      </div>
      <div className={`agent-message-card ${isUser ? "agent-message-card--user" : ""}`}>
        <p>{message.content}</p>
        {message.plan && (
          <AgentChangeList
            plan={message.plan}
            enabledMap={message.enabledChanges || createEnabledMap(message.plan)}
            compact
            interactive={false}
          />
        )}
        {!isUser && (message.content || "").length > 0 && (
          <button
            type="button"
            className="agent-message-copy"
            onClick={copyContent}
            title="Copy message"
            aria-label="Copy message"
          >
            <Copy className="h-3 w-3" />
          </button>
        )}
        {hasUndoablePreview && (
          <div className="agent-message-actions">
            <button
              type="button"
              className="agent-message-action"
              onClick={() => onUndoPreview?.(message)}
              disabled={!canUndoPreview || isApplying}
              title={canUndoPreview ? "Undo this whole preview" : "This preview is no longer active"}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {canUndoPreview ? "Undo preview" : "Preview settled"}
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
};
