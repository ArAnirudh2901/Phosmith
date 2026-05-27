"use client"

import React, { useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { X } from "lucide-react"

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? "⌘" : "Ctrl"

const EDITOR_SECTIONS = [
    {
        title: "View",
        items: [
            { keys: ["Space", "drag"], desc: "Temporary pan" },
            { keys: ["H"], desc: "Toggle hand tool (persistent pan)" },
            { keys: [MOD, "drag"], desc: "Pan canvas" },
            { keys: [MOD, "scroll"], desc: "Zoom to cursor" },
            { keys: [MOD, "+"], desc: "Zoom in" },
            { keys: [MOD, "-"], desc: "Zoom out" },
            { keys: [MOD, "0"], desc: "Reset view" },
            { keys: ["Right-click hold"], desc: "Open radial tool menu" },
        ],
    },
    {
        title: "Selection & layers",
        items: [
            { keys: ["Click"], desc: "Select an object" },
            { keys: ["Shift", "click"], desc: "Add to selection" },
            { keys: [MOD, "A"], desc: "Select all" },
            { keys: ["↑", "↓", "←", "→"], desc: "Nudge selected by 1 px" },
            { keys: ["Shift", "↑/↓/←/→"], desc: "Nudge by 10 px" },
            { keys: [MOD, "D"], desc: "Duplicate" },
            { keys: ["Delete"], desc: "Delete selected" },
            { keys: ["Esc"], desc: "Deselect / exit editing" },
        ],
    },
    {
        title: "Editing",
        items: [
            { keys: [MOD, "Z"], desc: "Undo" },
            { keys: [MOD, "Shift", "Z"], desc: "Redo" },
            { keys: [MOD, "S"], desc: "Save canvas state" },
            { keys: ["Shift", "I"], desc: "Add image" },
            { keys: [MOD, "K"], desc: "Open command palette" },
            { keys: ["[", "]"], desc: "Brush size − / +" },
        ],
    },
    {
        title: "Tools",
        items: [
            { keys: ["V"], desc: "Select / Resize" },
            { keys: ["C"], desc: "Crop" },
            { keys: ["I"], desc: "Images" },
            { keys: ["A"], desc: "Adjust" },
            { keys: ["D"], desc: "Draw" },
            { keys: ["T"], desc: "Text" },
            { keys: ["B"], desc: "AI background" },
            { keys: ["G"], desc: "Generative extend" },
            { keys: ["E"], desc: "AI edit" },
            { keys: ["Q"], desc: "AI agent" },
        ],
    },
    {
        title: "Help",
        items: [{ keys: ["?"], desc: "Toggle this guide" }],
    },
]

const DASHBOARD_SECTIONS = [
    {
        title: "Projects",
        items: [
            { keys: ["N"], desc: "New project" },
            { keys: ["/"], desc: "Focus search (when available)" },
            { keys: ["S"], desc: "Toggle multi-select mode" },
            { keys: [MOD, "A"], desc: "Select all (in select mode)" },
            { keys: ["Delete"], desc: "Delete selected (in select mode)" },
            { keys: ["Esc"], desc: "Exit select mode / close dialogs" },
        ],
    },
    {
        title: "Help",
        items: [{ keys: ["?"], desc: "Toggle this guide" }],
    },
]

const VARIANT_SECTIONS = {
    editor: EDITOR_SECTIONS,
    dashboard: DASHBOARD_SECTIONS,
}

const Key = ({ children }) => (
    <span
        style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: 28,
            padding: "3px 8px",
            background: "#07090E",
            border: "2px solid #F4F4F5",
            color: "#F4F4F5",
            fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: "0.04em",
            boxShadow: "2px 2px 0 0 #06B8D4",
        }}
    >
        {children}
    </span>
)

const ShortcutsGuide = ({ open, onClose, variant = "editor" }) => {
    const sections = VARIANT_SECTIONS[variant] || VARIANT_SECTIONS.editor
    useEffect(() => {
        if (!open) return
        const onKey = (event) => {
            if (event.key === "Escape") onClose?.()
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [open, onClose])

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    key="shortcuts-backdrop"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    onClick={onClose}
                    style={{
                        position: "fixed",
                        inset: 0,
                        zIndex: 220,
                        background: "rgba(3, 5, 10, 0.85)",
                        backdropFilter: "blur(8px) saturate(140%)",
                        WebkitBackdropFilter: "blur(8px) saturate(140%)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 24,
                    }}
                >
                    <motion.div
                        key="shortcuts-card"
                        initial={{ opacity: 0, scale: 0.96, y: 8 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96, y: 8 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                        onClick={(event) => event.stopPropagation()}
                        style={{
                            maxWidth: 720,
                            width: "100%",
                            maxHeight: "85vh",
                            overflowY: "auto",
                            background:
                                "linear-gradient(135deg, rgba(255,255,255,0.05), rgba(255,255,255,0.012) 60%), rgba(14, 17, 24, 0.78)",
                            backdropFilter: "blur(20px) saturate(160%)",
                            WebkitBackdropFilter: "blur(20px) saturate(160%)",
                            border: "2px solid #F4F4F5",
                            boxShadow:
                                "10px 10px 0 0 #06B8D4, inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 0 1px rgba(255,255,255,0.04)",
                            padding: 28,
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                            <div>
                                <div
                                    style={{
                                        fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                        fontSize: 11,
                                        fontWeight: 700,
                                        letterSpacing: "0.18em",
                                        textTransform: "uppercase",
                                        color: "#06B8D4",
                                    }}
                                >
                                    Reference
                                </div>
                                <h2
                                    style={{
                                        marginTop: 4,
                                        fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                        fontSize: 22,
                                        fontWeight: 900,
                                        letterSpacing: "-0.01em",
                                        textTransform: "uppercase",
                                        color: "#F4F4F5",
                                    }}
                                >
                                    Keyboard Shortcuts
                                </h2>
                            </div>
                            <button
                                type="button"
                                onClick={onClose}
                                aria-label="Close shortcuts"
                                style={{
                                    width: 32,
                                    height: 32,
                                    background: "rgba(14, 17, 24, 0.85)",
                                    border: "2px solid #F4F4F5",
                                    color: "#F4F4F5",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    cursor: "pointer",
                                }}
                            >
                                <X className="h-4 w-4" strokeWidth={2.5} />
                            </button>
                        </div>

                        <div style={{ display: "grid", gap: 20 }}>
                            {sections.map((section) => (
                                <div key={section.title}>
                                    <div
                                        style={{
                                            fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                            fontSize: 10,
                                            fontWeight: 700,
                                            letterSpacing: "0.16em",
                                            textTransform: "uppercase",
                                            color: "#A1A8B4",
                                            paddingBottom: 8,
                                            marginBottom: 10,
                                            borderBottom: "2px solid #F4F4F5",
                                        }}
                                    >
                                        {section.title}
                                    </div>
                                    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10 }}>
                                        {section.items.map((item, idx) => (
                                            <li
                                                key={idx}
                                                style={{
                                                    display: "flex",
                                                    alignItems: "center",
                                                    justifyContent: "space-between",
                                                    gap: 16,
                                                }}
                                            >
                                                <span style={{ color: "#F4F4F5", fontSize: 13 }}>{item.desc}</span>
                                                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                                    {item.keys.map((k, kidx) => (
                                                        <React.Fragment key={kidx}>
                                                            <Key>{k}</Key>
                                                            {kidx < item.keys.length - 1 && (
                                                                <span style={{ color: "#6B7280", fontSize: 11 }}>+</span>
                                                            )}
                                                        </React.Fragment>
                                                    ))}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ))}
                        </div>

                        <div
                            style={{
                                marginTop: 24,
                                paddingTop: 16,
                                borderTop: "2px solid #F4F4F5",
                                fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                fontSize: 10,
                                letterSpacing: "0.16em",
                                textTransform: "uppercase",
                                color: "#A1A8B4",
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: 8,
                                flexWrap: "wrap",
                            }}
                        >
                            <span>Press <Key>?</Key> anywhere to toggle</span>
                            <span>Esc to close</span>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}

export default ShortcutsGuide
