// Required env vars. Fail fast at boot if a critical one is missing instead of
// shipping a half-working app that explodes at the first user interaction.
//
// `client` vars are NEXT_PUBLIC_ prefixed and exposed to the browser bundle.
// `server` vars are only available on the server (API routes, server components).

import { logger } from "./logger"

const REQUIRED_CLIENT = [
  "NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT",
  "NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY",
]

const REQUIRED_SERVER = [
  "IMAGEKIT_PRIVATE_KEY",
]

// Optional but useful: warn (don't fail) when these are missing.
const OPTIONAL_HINTS = [
  "NEXT_PUBLIC_UNSPLASH_ACCESS_KEY",
  "HUGGINGFACE_API_TOKEN",
  "CLERK_JWT_ISSUER_DOMAIN",
  "DATABASE_URL",
  "DIRECT_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  // AI Agent v2 vision model. Free tier at https://aistudio.google.com.
  // Without it, the agent falls back to a deterministic keyword planner — still
  // works, just can't make image-aware judgments ("is this already cinematic?").
  "GEMINI_API_KEY",
  // Optional model override. Defaults to "gemini-2.5-flash". Set this when
  // pinning to a specific snapshot (e.g. "gemini-2.5-flash-002") to guard
  // against silent upstream model updates in production.
  "GEMINI_MODEL",
]

const collect = (names) => {
  const missing = []
  for (const name of names) {
    const value = process.env[name]
    if (!value || String(value).trim() === "") missing.push(name)
  }
  return missing
}

// Next.js dev mode evaluates this module in multiple runtimes (server bootstrap
// + route handlers + middleware.js), each with its own module instance. A plain
// module-level `let validated = false` would log the warning once per instance.
// Hoist the dedupe flag to `globalThis` so all instances share it.
const VALIDATED_KEY = Symbol.for("phosmith.env.validated")
const markValidated = () => {
  globalThis[VALIDATED_KEY] = true
}
const isValidated = () => Boolean(globalThis[VALIDATED_KEY])

export const validateEnv = ({ throwOnMissing = false } = {}) => {
  if (isValidated()) return { ok: true, missing: [] }
  markValidated()

  const isServer = typeof window === "undefined"
  const required = isServer ? [...REQUIRED_CLIENT, ...REQUIRED_SERVER] : REQUIRED_CLIENT
  const missing = collect(required)
  const missingOptional = collect(OPTIONAL_HINTS)

  if (missing.length) {
    const msg = `[env] missing required env vars: ${missing.join(", ")}`
    if (throwOnMissing) throw new Error(msg)
    logger.error(msg)
  }
  if (missingOptional.length) {
    logger.warn(`[env] optional env vars not set: ${missingOptional.join(", ")} (some features may be disabled)`)
  }

  return { ok: missing.length === 0, missing, missingOptional }
}

// Auto-run on module import so issues surface immediately at boot.
// Server: throw and crash the build/server (forces a fix).
// Client: log loudly but don't crash the page (some users might still get a working subset).
try {
  validateEnv({ throwOnMissing: typeof window === "undefined" })
} catch (e) {
  // Re-throw on the server so build/start fails visibly.
  if (typeof window === "undefined") throw e
}
