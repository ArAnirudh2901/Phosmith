"use client"

import { useEffect } from "react"
import { logger } from "@/lib/logger"
import { report, flush } from "@/lib/client-diagnostics"

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    logger.error("[global] root boundary caught:", error)
    // A crash that reaches the root boundary is the one worth knowing about on
    // someone else's device; flush immediately rather than waiting for a batch
    // the user may never trigger.
    report("error", { name: error?.name, message: error?.message, stack: error?.stack, context: "root-boundary" })
    flush()
  }, [error])

  return (
    <html>
      <body style={{ margin: 0, background: "#03050A", color: "#F4F4F5", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Something went wrong</h1>
            <p style={{ fontSize: 14, color: "#A1A8B4", marginBottom: 20 }}>
              An unexpected error stopped the app. You can try reloading.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                background: "#00E5FF",
                color: "#03050A",
                border: "none",
                padding: "10px 16px",
                borderRadius: 8,
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
