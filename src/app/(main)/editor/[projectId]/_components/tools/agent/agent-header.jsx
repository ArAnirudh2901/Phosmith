import { motion } from "framer-motion";
import { History, Plus, WandSparkles, Zap } from "lucide-react";

// Agent header: status, Live/Manual preview toggle, new chat, history.

export default function AgentHeader({
    activeChangeSummary,
    autoPreview,
    canChat,
    canCollage,
    canSend,
    collageImageCount,
    contrastingColor,
    dominantColor,
    isHistoryOpen,
    setAutoPreview,
    setIsHistoryOpen,
    startNewThread,
}) {
  // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
  "use no memo";
  return (
    <motion.div
      className="agent-command-header"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="agent-command-mark" style={{ "--agent-mark": dominantColor, color: contrastingColor }}>
        <WandSparkles className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1 agent-command-info">
        <h3>{canChat ? "Ready" : canCollage ? "Collage ready" : "Waiting for image"}</h3>
        <p className={`agent-command-sub ${canSend ? "is-ready" : ""}`}>
          <span className="agent-command-dot" aria-hidden="true" />
          {canChat
            ? activeChangeSummary
            : canCollage
              ? `${collageImageCount} photos — ask me to build a collage`
              : "Select an image to begin"}
        </p>
      </div>
      <div className="agent-header-actions">
        {/* Undo / redo buttons removed — the agent's per-step history
            here only tracked a single most-recent change, which was
            confusing next to the editor's global undo/redo (⌘Z / ⌘⇧Z).
            Users can use the global shortcuts instead. */}
        <motion.button
          type="button"
          onClick={() => setAutoPreview((value) => !value)}
          className={`agent-toggle ${autoPreview ? "agent-toggle--on" : ""}`}
          aria-pressed={autoPreview}
          whileTap={{ scale: 0.96 }}
          title="Toggle preview mode"
        >
          <Zap className="h-3.5 w-3.5" />
          {autoPreview ? "Live" : "Manual"}
        </motion.button>
        <motion.button
          type="button"
          onClick={startNewThread}
          className="agent-icon-button"
          whileTap={{ scale: 0.94 }}
          title="Start a new chat"
          aria-label="Start a new chat"
        >
          <Plus className="h-3.5 w-3.5" />
        </motion.button>
        <motion.button
          type="button"
          onClick={() => setIsHistoryOpen((value) => !value)}
          className={`agent-icon-button ${isHistoryOpen ? "agent-icon-button--active" : ""}`}
          whileTap={{ scale: 0.94 }}
          title="Browse chat history"
          aria-label="Browse chat history"
          aria-expanded={isHistoryOpen}
        >
          <History className="h-3.5 w-3.5" />
        </motion.button>
      </div>
    </motion.div>
  );
}
