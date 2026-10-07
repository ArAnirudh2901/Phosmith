export let messageId = 0;

export const newMessage = (role, content, extra = {}) => ({
  id: `${role}-${Date.now()}-${messageId++}`,
  role,
  content,
  at: Date.now(),
  ...extra,
});

// ── Chat history persistence ────────────────────────────────────────────────
// Multi-thread session model. Each project has its own bag of threads (think
// Cursor/Windsurf "past chats"). Active thread id is persisted too so the user
// returns to whichever conversation they were in.
//
// Storage shape (v2):
//   {
//     activeThreadId: string,
//     threads: [
//       { id, title, createdAt, updatedAt, messages: Message[] },
//       ...
//     ]
//   }
//
// Plan/preview blobs can be large, so per-thread we cap message count and
// strip heavy fields from older messages.
export const CHAT_STORAGE_VERSION = 2;

export const CHAT_STORAGE_PREFIX = `phosmith-agent-chat-v${CHAT_STORAGE_VERSION}`;

export const CHAT_LEGACY_V1_PREFIX = "phosmith-agent-chat-v1";

export const CHAT_MAX_PERSISTED_MESSAGES = 60;

export const CHAT_KEEP_PLANS_ON_RECENT = 6;

export const CHAT_MAX_THREADS = 24;

export const chatStorageKey = (projectId) =>
  projectId ? `${CHAT_STORAGE_PREFIX}:${projectId}` : null;

export const chatLegacyKey = (projectId) =>
  projectId ? `${CHAT_LEGACY_V1_PREFIX}:${projectId}` : null;

export const newThreadId = () =>
  `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const INITIAL_WELCOME_MESSAGE = {
  id: "assistant-initial",
  role: "assistant",
  content:
    "Select an image, describe the edit, and I will build a preview with the changes visible below.",
};

export const makeEmptyThread = () => {
  const now = Date.now();
  return {
    id: newThreadId(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    messages: [INITIAL_WELCOME_MESSAGE],
  };
};

// Auto-title a thread from its first user message (the way Cursor / Claude do
// it). Falls back to "New chat" until the user actually sends something.
export const inferThreadTitle = (messages) => {
  const firstUser = messages?.find?.((m) => m?.role === "user" && m?.content?.trim?.());
  if (!firstUser) return "New chat";
  const raw = firstUser.content.trim().replace(/\s+/g, " ");
  return raw.length > 48 ? `${raw.slice(0, 46)}…` : raw;
};

export const trimMessagesForStorage = (messages) => {
  if (!Array.isArray(messages)) return [];
  const capped = messages.slice(-CHAT_MAX_PERSISTED_MESSAGES);
  const keepFrom = Math.max(0, capped.length - CHAT_KEEP_PLANS_ON_RECENT);
  return capped.map((message, index) => {
    if (index >= keepFrom) return message;
    if (!message || (!message.plan && !message.multiLayerPlans && !message.upscaleComparison)) {
      return message;
    }
    const { plan: _plan, multiLayerPlans: _mlp, upscaleComparison: _uc, ...lite } = message;
    return lite;
  });
};

export const trimThreadsForStorage = (threads) => {
  if (!Array.isArray(threads)) return [];
  return threads
    .slice(-CHAT_MAX_THREADS)
    .map((thread) => ({
      ...thread,
      messages: trimMessagesForStorage(thread.messages),
    }));
};

export const migrateLegacyV1 = (projectId) => {
  if (typeof window === "undefined") return null;
  const legacyKey = chatLegacyKey(projectId);
  if (!legacyKey) return null;
  try {
    const raw = window.localStorage.getItem(legacyKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const now = Date.now();
    const thread = {
      id: newThreadId(),
      title: inferThreadTitle(parsed),
      createdAt: now - 1,
      updatedAt: now,
      messages: parsed,
    };
    // Best-effort cleanup; if it fails the next save will overwrite the v2 key
    // anyway and the legacy entry just sits unused.
    try { window.localStorage.removeItem(legacyKey); } catch { /* ignore */ }
    return { activeThreadId: thread.id, threads: [thread] };
  } catch (error) {
    console.warn("[agent] failed to migrate legacy chat:", error?.message || error);
    return null;
  }
};

export const loadStoredState = (projectId) => {
  if (typeof window === "undefined") return null;
  const key = chatStorageKey(projectId);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.threads) && parsed.threads.length) {
        // Repair: make sure activeThreadId points at something real.
        const hasActive = parsed.threads.some((t) => t.id === parsed.activeThreadId);
        return {
          activeThreadId: hasActive ? parsed.activeThreadId : parsed.threads[parsed.threads.length - 1].id,
          threads: parsed.threads,
        };
      }
    }
  } catch (error) {
    console.warn("[agent] failed to read chat history:", error?.message || error);
  }
  // No v2 entry — try migrating a v1 flat array.
  return migrateLegacyV1(projectId);
};

export const saveStoredState = (projectId, state) => {
  if (typeof window === "undefined") return;
  const key = chatStorageKey(projectId);
  if (!key) return;
  try {
    const trimmed = {
      activeThreadId: state.activeThreadId,
      threads: trimThreadsForStorage(state.threads),
    };
    window.localStorage.setItem(key, JSON.stringify(trimmed));
  } catch (error) {
    console.warn("[agent] failed to write chat history:", error?.message || error);
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  }
};

export const clearAllThreads = (projectId) => {
  if (typeof window === "undefined") return;
  const key = chatStorageKey(projectId);
  if (!key) return;
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
};

// Initial messages array (used as a default for new threads or when no stored
// state exists yet). Lives below the storage block so INITIAL_WELCOME_MESSAGE
// is already initialized.
export const INITIAL_MESSAGES = [INITIAL_WELCOME_MESSAGE];

// Format a unix ms timestamp as a relative label ("now", "5m", "2h", "3d",
// "Jan 12"). Matches the compact style of the rest of the editor's UI.
export const formatRelativeTime = (ms) => {
  if (!ms || !Number.isFinite(ms)) return "";
  const delta = Math.max(0, Date.now() - ms);
  const sec = Math.floor(delta / 1000);
  if (sec < 45) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
