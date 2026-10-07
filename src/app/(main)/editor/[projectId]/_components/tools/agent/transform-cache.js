// ── Client-side ImageKit transform URL cache ──────────────────────────────
// Caches resolved AI transform URLs (the ones waitForImageKitUrl polls for)
// so toggling a transform off and on again is instant — no 10–30s re-poll.
// Key: full transform URL (e.g. "https://ik.imagekit.io/.../img.jpg?tr=e-upscale")
// Value: { resolvedUrl: string, timestamp: number }
export const CLIENT_TRANSFORM_CACHE = new Map();

export const CLIENT_CACHE_TTL_MS = 30 * 60 * 1000;

// 30 minutes

export const getCachedTransformUrl = (url) => {
  const entry = CLIENT_TRANSFORM_CACHE.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CLIENT_CACHE_TTL_MS) {
    CLIENT_TRANSFORM_CACHE.delete(url);
    return null;
  }
  return entry.resolvedUrl;
};

export const setCachedTransformUrl = (url, resolvedUrl) => {
  CLIENT_TRANSFORM_CACHE.set(url, { resolvedUrl, timestamp: Date.now() });
  // Bound size — evict oldest if we exceed 100 entries
  if (CLIENT_TRANSFORM_CACHE.size > 100) {
    const oldest = CLIENT_TRANSFORM_CACHE.keys().next().value;
    CLIENT_TRANSFORM_CACHE.delete(oldest);
  }
};

// Check server-side cache (fire-and-forget safe — returns null on any error)
export const checkServerTransformCache = async (url) => {
  try {
    const response = await fetch(
      `/api/imagekit/transform-cache?url=${encodeURIComponent(url)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data?.cached ? data.resolvedUrl : null;
  } catch {
    return null;
  }
};

// Write to server-side cache (fire-and-forget — errors are silently ignored)
export const writeServerTransformCache = (url, resolvedUrl) => {
  fetch("/api/imagekit/transform-cache", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, resolvedUrl }),
  }).catch(() => { /* ignore */ });
};
