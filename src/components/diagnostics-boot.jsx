"use client"

import { useEffect } from "react"
import { installDiagnostics } from "@/lib/client-diagnostics"

/**
 * Installs the client failure listeners once for the whole app.
 *
 * Renders nothing. It exists as its own component so the root layout can stay a
 * server component — only this leaf needs to be a client one.
 */
export default function DiagnosticsBoot() {
    useEffect(() => installDiagnostics(), [])
    return null
}
