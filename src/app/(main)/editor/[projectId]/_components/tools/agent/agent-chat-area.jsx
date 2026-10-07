import { AnimatePresence, motion } from "framer-motion";
import { History, Loader2, MessageSquare, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { clearAllThreads, formatRelativeTime, makeEmptyThread } from "./chat-storage";
import { AgentThinkingRow, MessageBubble } from "./ui";

// Chat area: the thread-history drawer and the message log.

export default function AgentChatArea({
    autoPreview,
    chatEndRef,
    chatState,
    deleteThread,
    isApplying,
    isHistoryOpen,
    isThinking,
    livePreviewToken,
    messages,
    pendingPrompt,
    project,
    revertLiveEdit,
    setChatState,
    setIsHistoryOpen,
    startNewThread,
    switchToThread,
}) {
  // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
  "use no memo";
  return (
    <div className="agent-chat-area">
      <AnimatePresence>
        {isHistoryOpen && (
          <motion.div
            key="history-panel"
            className="agent-history-panel"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="agent-history-head">
              <div className="agent-history-title">
                <History className="h-3.5 w-3.5" />
                <span>Chat history</span>
                <em>{chatState.threads.length} thread{chatState.threads.length === 1 ? "" : "s"}</em>
              </div>
              <button
                type="button"
                className="agent-icon-button"
                onClick={() => setIsHistoryOpen(false)}
                title="Close history"
                aria-label="Close history"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              type="button"
              className="agent-history-new"
              onClick={startNewThread}
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Start a new chat</span>
            </button>
            <div className="agent-history-list panel-scroll">
              {[...chatState.threads]
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                .map((thread) => {
                  const isActive = thread.id === chatState.activeThreadId;
                  const userCount = thread.messages.filter((m) => m?.role === "user").length;
                  return (
                    <div
                      key={thread.id}
                      className={`agent-history-row ${isActive ? "is-active" : ""}`}
                    >
                      <button
                        type="button"
                        className="agent-history-row-main"
                        onClick={() => switchToThread(thread.id)}
                        title={thread.title}
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                        <span className="agent-history-row-title">{thread.title}</span>
                        <span className="agent-history-row-meta">
                          <em>{userCount} msg{userCount === 1 ? "" : "s"}</em>
                          <span className="agent-history-dot" aria-hidden="true">·</span>
                          <em>{formatRelativeTime(thread.updatedAt)}</em>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="agent-history-row-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteThread(thread.id);
                        }}
                        title="Delete this chat"
                        aria-label={`Delete ${thread.title}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              {chatState.threads.length > 1 && (
                <button
                  type="button"
                  className="agent-history-clear-all"
                  onClick={() => {
                    clearAllThreads(project?._id);
                    const fresh = makeEmptyThread();
                    setChatState({ activeThreadId: fresh.id, threads: [fresh] });
                    setIsHistoryOpen(false);
                    toast.success("Cleared all chat history for this project");
                  }}
                >
                  <RotateCcw className="h-3 w-3" />
                  Clear all threads
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="agent-chat-log panel-scroll">
      <div className="agent-chat-stack">
        <AnimatePresence initial={false}>
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              canUndoPreview={Boolean(message.previewToken && message.previewToken === livePreviewToken)}
              isApplying={isApplying}
              onUndoPreview={() => revertLiveEdit({ addMessage: true })}
            />
          ))}
          {isThinking && (
            <AgentThinkingRow
              key="thinking-row"
              prompt={pendingPrompt}
              autoPreview={autoPreview}
            />
          )}
        </AnimatePresence>
        {isThinking && (
          <div className="agent-thinking-pill">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Building a preview you can inspect.
          </div>
        )}
        <div ref={chatEndRef} />
      </div>
      </div>
    </div>
  );
}
