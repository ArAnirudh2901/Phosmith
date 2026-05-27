"use client"

import { useEffect } from "react"
import Link from "next/link"
import { AlertTriangle, RotateCcw, ArrowLeft } from "lucide-react"
import { logger } from "@/lib/logger"

export default function EditorError({ error, reset }) {
  useEffect(() => {
    logger.error("[editor] route boundary caught:", error)
  }, [error])

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ background: "var(--bg-void-darkest)" }}
    >
      <div className="max-w-md w-full text-center">
        <div
          className="w-14 h-14 mx-auto mb-5 rounded-2xl flex items-center justify-center"
          style={{ background: "rgba(244,63,94,0.1)", border: "1px solid rgba(244,63,94,0.25)" }}
        >
          <AlertTriangle className="h-6 w-6" style={{ color: "var(--accent-destructive, #f43f5e)" }} />
        </div>
        <h1
          className="text-xl font-bold mb-2"
          style={{ color: "var(--text-primary)" }}
        >
          The editor crashed
        </h1>
        <p
          className="text-sm mb-5"
          style={{ color: "var(--text-muted)" }}
        >
          Something went wrong while loading or rendering this project. Your last saved state is safe.
        </p>
        {process.env.NODE_ENV !== "production" && error?.message && (
          <pre
            className="text-[11px] text-left mb-5 p-3 rounded-lg overflow-auto"
            style={{
              background: "rgba(0,0,0,0.4)",
              border: "1px solid rgba(255,255,255,0.08)",
              color: "var(--text-secondary)",
              maxHeight: 160,
            }}
          >
            {error.message}
            {error.digest ? `\nDigest: ${error.digest}` : ""}
          </pre>
        )}
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold"
            style={{
              background: "var(--accent-primary, #00E5FF)",
              color: "#03050A",
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Try again
          </button>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold"
            style={{
              background: "transparent",
              border: "1px solid var(--border-default)",
              color: "var(--text-primary)",
            }}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to projects
          </Link>
        </div>
      </div>
    </div>
  )
}
