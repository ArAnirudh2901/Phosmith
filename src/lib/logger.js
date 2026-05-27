// Centralized logger. Use this instead of console.* in app code.
// - In production, `debug` and `info` are no-ops (Next compiler also strips raw console.log calls).
// - `warn` and `error` always fire so ops monitoring and the browser console keep working.
// - All calls funnel through a single entrypoint so we can later send to a remote sink
//   (Sentry, Datadog, OpenTelemetry) without touching every callsite.

const isProd = process.env.NODE_ENV === "production"

const formatScope = (scope) => (scope ? `[${scope}]` : "")

const emit = (level, scope, args) => {
  if (level === "debug" || level === "info") {
    if (isProd) return
  }
  const head = formatScope(scope)
  const fn = console[level] || console.log
  if (head) fn(head, ...args)
  else fn(...args)
  // Future: forward to remote sink for 'warn' and 'error' levels.
}

export const createLogger = (scope) => ({
  debug: (...args) => emit("debug", scope, args),
  info: (...args) => emit("info", scope, args),
  warn: (...args) => emit("warn", scope, args),
  error: (...args) => emit("error", scope, args),
})

export const logger = createLogger("")
