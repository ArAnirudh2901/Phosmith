"use client"

import { useEffect } from "react"

// Common keyboard shortcuts for the dashboard. Bound at the window level so
// they fire from anywhere on the page, but suppressed when the user is typing
// in an input / textarea / contentEditable element.
//
//   N        → new project
//   /        → focus search (if any)
//   S        → toggle multi-select mode
//   Esc      → exit select mode / close any open dialog
//   ?        → toggle shortcuts guide
//   Cmd/Ctrl+A → select all (only when in select mode)
//   Delete   → delete selected (only when in select mode)

const INTERACTIVE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"])

const isTypingContext = () => {
    if (typeof document === "undefined") return false
    const el = document.activeElement
    if (!el) return false
    if (INTERACTIVE_TAGS.has(el.tagName)) return true
    if (el.isContentEditable) return true
    return false
}

const useDashboardShortcuts = ({
    onNewProject,
    onToggleShortcuts,
    onFocusSearch,
    onToggleSelectMode,
    onSelectAll,
    onDeleteSelected,
    onEscape,
    isSelectionMode = false,
    selectedCount = 0,
} = {}) => {
    useEffect(() => {
        const handle = (event) => {
            const key = event.key
            const metaOrCtrl = event.metaKey || event.ctrlKey

            // ── Always-active (Esc never gets swallowed by inputs) ──
            if (key === "Escape") {
                onEscape?.()
                return
            }

            // ── Show shortcuts guide (works even while typing? we'll allow ?
            //    only outside inputs so it doesn't fight literal "?" being typed)
            if (isTypingContext()) return

            // "?" or shift+/
            if (key === "?" || (key === "/" && event.shiftKey)) {
                event.preventDefault()
                onToggleShortcuts?.()
                return
            }

            // "/" alone → focus search
            if (key === "/" && !metaOrCtrl) {
                event.preventDefault()
                onFocusSearch?.()
                return
            }

            // Cmd/Ctrl+A → select all (in select mode)
            if (metaOrCtrl && key.toLowerCase() === "a" && isSelectionMode) {
                event.preventDefault()
                onSelectAll?.()
                return
            }

            // Skip remaining single-key combos when a modifier is held —
            // browser shortcuts (Cmd+R, Cmd+T, etc.) should pass through.
            if (metaOrCtrl || event.altKey) return

            // N → new project
            if (key === "n" || key === "N") {
                event.preventDefault()
                onNewProject?.()
                return
            }

            // S → toggle select mode
            if (key === "s" || key === "S") {
                event.preventDefault()
                onToggleSelectMode?.()
                return
            }

            // Delete / Backspace → delete selected (only when select mode + non-empty)
            if ((key === "Delete" || key === "Backspace") && isSelectionMode && selectedCount > 0) {
                event.preventDefault()
                onDeleteSelected?.()
                return
            }
        }

        window.addEventListener("keydown", handle)
        return () => window.removeEventListener("keydown", handle)
    }, [
        onNewProject,
        onToggleShortcuts,
        onFocusSearch,
        onToggleSelectMode,
        onSelectAll,
        onDeleteSelected,
        onEscape,
        isSelectionMode,
        selectedCount,
    ])
}

export default useDashboardShortcuts
