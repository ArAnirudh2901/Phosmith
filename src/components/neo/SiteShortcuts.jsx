"use client"

import React, { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import ShortcutsGuide from "./ShortcutsGuide"

const isTypingTarget = (el) => {
    if (!el) return false
    const tag = el.tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
    return Boolean(el.isContentEditable)
}

/**
 * Lightweight global keyboard shortcuts for the non-editor pages (landing + auth),
 * so the whole site is keyboard-navigable and the `?` reference is always reachable.
 *
 *   ?     → toggle the shortcuts reference (works everywhere)
 *   G     → open the studio (marketing variant)
 *   Esc   → close the guide, or (auth variant) go back home
 *
 * Single-letter navigation is intentionally limited to `G` — binding Enter at the
 * window level would hijack Enter on focused links/buttons and Clerk's auth form.
 */
export default function SiteShortcuts({ variant = "marketing", studioHref = "/dashboard" }) {
    const router = useRouter()
    const [showGuide, setShowGuide] = useState(false)

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return
            if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return

            const key = event.key
            if (key === "?" || (key === "/" && event.shiftKey)) {
                event.preventDefault()
                setShowGuide((prev) => !prev)
                return
            }

            // While the guide is open, let it own Escape/Enter to dismiss itself.
            if (showGuide) return

            if (variant === "marketing" && (key === "g" || key === "G")) {
                event.preventDefault()
                router.push(studioHref)
                return
            }
            if (variant === "auth" && key === "Escape") {
                event.preventDefault()
                router.push("/")
            }
        }
        window.addEventListener("keydown", onKeyDown)
        return () => window.removeEventListener("keydown", onKeyDown)
    }, [router, showGuide, variant, studioHref])

    return <ShortcutsGuide open={showGuide} onClose={() => setShowGuide(false)} variant={variant} />
}
