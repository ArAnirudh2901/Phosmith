// Prisma errors carry absolute server paths, generated-bundle offsets and engine
// internals. Those must never reach a toast — they leak the filesystem layout and
// mean nothing to the person reading them. Validation errors we raise ourselves
// are already user-facing, so they pass through unchanged.
const INTERNAL_PATTERNS = [
  /invalid `[^`]*` invocation/i,
  /\.js:\d+:\d+/,
  /transaction api error/i,
  /prisma/i,
  /\/(Users|home|var|app)\//,
]

const FRIENDLY = [
  [/timeout for this transaction|transaction api error|expired transaction/i,
    "Saving took too long and was rolled back. Nothing was lost — try again."],
  [/unique constraint/i, "That name is already taken."],
  [/foreign key constraint/i, "That item no longer exists."],
  [/can't reach database|connection refused|ECONNREFUSED/i,
    "Can't reach the database right now. Check your connection and try again."],
]

export const toSafeErrorMessage = (error, fallback = "Something went wrong. Please try again.") => {
  const raw = String(error?.message || "")
  if (!raw) return fallback
  for (const [pattern, message] of FRIENDLY) {
    if (pattern.test(raw)) return message
  }
  if (INTERNAL_PATTERNS.some((p) => p.test(raw))) return fallback
  return raw
}
