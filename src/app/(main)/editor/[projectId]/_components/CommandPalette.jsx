"use client"

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
    Sparkles,
    ChevronDown,
    X,
    Search,
    Command,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    Move,
    Maximize2,
    Zap,
    Layers,
    Settings,
    Undo2,
    Redo2,
    Download,
    RotateCw,
    ZoomIn,
    ZoomOut,
    Bot,
} from "lucide-react"
import { useCanvas } from "../../../../../../context/context"
import useEditorShortcuts from "../../../../../../hooks/useEditorShortcuts"

/**
 * CommandPalette — Adobe-style command palette (Cmd+K).
 *
 * Features:
 * - Fuzzy search across all commands
 * - Categorized commands (Tools, Actions, View, Edit)
 * - Keyboard navigation
 * - Action execution with visual feedback
 */

const COMMANDS = [
    // Tools
    { id: "tool-resize", label: "Resize Tool", category: "Tools", icon: Move, shortcut: "V" },
    { id: "tool-crop", label: "Crop Tool", category: "Tools", icon: Maximize2, shortcut: "C" },
    { id: "tool-adjust", label: "Adjust Tool", category: "Tools", icon: Settings },
    { id: "tool-text", label: "Text Tool", category: "Tools", icon: Layers },
    { id: "tool-generative", label: "Generative Fill", category: "Tools", icon: Sparkles, shortcut: "G" },

    // Actions
    { id: "action-undo", label: "Undo", category: "Actions", icon: Undo2, shortcut: "⌘Z" },
    { id: "action-redo", label: "Redo", category: "Actions", icon: Redo2, shortcut: "⌘⇧Z" },
    { id: "action-export", label: "Export Image", category: "Actions", icon: Download },
    { id: "action-reset-view", label: "Reset View", category: "Actions", icon: ZoomOut },
    { id: "action-save", label: "Save Project", category: "Actions", icon: Command },

    // AI Actions
    { id: "ai-extend", label: "AI Extend", category: "AI", icon: ArrowUp, pro: true },
    { id: "ai-background", label: "AI Background", category: "AI", icon: Layers, pro: true },
    { id: "ai-enhance", label: "AI Enhance", category: "AI", icon: Zap, pro: true },
    { id: "ai-agent", label: "ImageKit Agent", category: "AI", icon: Bot },
]

const CommandPalette = ({ isOpen, onClose, onExecute }) => {
    const [query, setQuery] = useState("")
    const [selectedIndex, setSelectedIndex] = useState(0)
    const inputRef = useRef(null)
    const { canvasEditor, onToolChange } = useCanvas()

    const filteredCommands = useMemo(() => {
        if (!query.trim()) return COMMANDS

        const lowerQuery = query.toLowerCase()
        return COMMANDS.filter(
            (cmd) =>
                cmd.label.toLowerCase().includes(lowerQuery) ||
                cmd.category.toLowerCase().includes(lowerQuery)
        )
    }, [query])

    const groupedCommands = useMemo(() => {
        const groups = {}
        filteredCommands.forEach((cmd) => {
            if (!groups[cmd.category]) groups[cmd.category] = []
            groups[cmd.category].push(cmd)
        })
        return groups
    }, [filteredCommands])

    useEffect(() => {
        if (!isOpen) return
        const frame = requestAnimationFrame(() => {
            inputRef.current?.focus()
            setQuery("")
            setSelectedIndex(0)
        })
        return () => cancelAnimationFrame(frame)
    }, [isOpen])

    const executeCommand = useCallback(
        (cmd) => {
            onClose()

            // Execute the command
            switch (cmd.id) {
                case "action-undo":
                    canvasEditor?.__undoCanvasState?.()
                    break
                case "action-redo":
                    canvasEditor?.__redoCanvasState?.()
                    break
                case "action-save":
                    canvasEditor?.__saveCanvasState?.()
                    break
                case "action-reset-view":
                    canvasEditor?.__resetCanvasView?.()
                    break
                case "tool-resize":
                    onToolChange?.("resize")
                    break
                case "tool-crop":
                    onToolChange?.("crop")
                    break
                case "tool-adjust":
                    onToolChange?.("adjust")
                    break
                case "tool-text":
                    onToolChange?.("text")
                    break
                case "tool-generative":
                    onToolChange?.("ai_extender")
                    break
                case "ai-extend":
                    onToolChange?.("ai_extender")
                    break
                case "ai-background":
                    onToolChange?.("ai_background")
                    break
                case "ai-enhance":
                    onToolChange?.("ai_edit")
                    break
                case "ai-agent":
                    onToolChange?.("ai_agent")
                    break
                default:
                    onExecute?.(cmd)
            }
        },
        [canvasEditor, onToolChange, onClose, onExecute]
    )

    const handleKeyDown = useCallback(
        (e) => {
            if (e.key === "Escape") {
                onClose()
                return
            }

            if (e.key === "ArrowDown") {
                e.preventDefault()
                setSelectedIndex((prev) =>
                    Math.min(prev + 1, filteredCommands.length - 1)
                )
                return
            }

            if (e.key === "ArrowUp") {
                e.preventDefault()
                setSelectedIndex((prev) => Math.max(prev - 1, 0))
                return
            }

            if (e.key === "Enter") {
                e.preventDefault()
                const cmd = filteredCommands[selectedIndex]
                if (cmd) executeCommand(cmd)
            }
        },
        [executeCommand, filteredCommands, selectedIndex, onClose]
    )

    if (!isOpen) return null

    return (
        <AnimatePresence>
            <motion.div
                className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
            >
                {/* Backdrop */}
                <motion.div
                    className="absolute inset-0"
                    style={{ background: 'rgba(11, 13, 18, 0.75)', backdropFilter: 'blur(4px)' }}
                    onClick={onClose}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                />

                {/* Palette */}
                <motion.div
                    className="relative w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl"
                    style={{
                        background: 'var(--bg-panel)',
                        border: '1px solid var(--border-subtle)',
                    }}
                    initial={{ opacity: 0, scale: 0.96, y: -20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.96, y: -10 }}
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                >
                    {/* Search input */}
                    <div className="flex items-center gap-3 px-4 py-3.5"
                         style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <Search className="h-4 w-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
                        <input
                            ref={inputRef}
                            type="text"
                            value={query}
                            onChange={(e) => {
                                setQuery(e.target.value)
                                setSelectedIndex(0)
                            }}
                            onKeyDown={handleKeyDown}
                            placeholder="Type a command..."
                            className="flex-1 bg-transparent text-sm outline-none"
                            style={{ color: 'var(--text-primary)' }}
                        />
                        <div className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium"
                             style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                            <span>ESC</span>
                        </div>
                    </div>

                    {/* Results */}
                    <div className="max-h-80 overflow-y-auto py-2">
                        {filteredCommands.length === 0 ? (
                            <div className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                                <p className="text-sm">No commands found</p>
                            </div>
                        ) : (
                            Object.entries(groupedCommands).map(([category, commands]) => (
                                <div key={category} className="mb-2">
                                    <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                                         style={{ color: 'var(--text-muted)' }}>
                                        {category}
                                    </div>
                                    {commands.map((cmd) => {
                                        const globalIndex = filteredCommands.indexOf(cmd)
                                        const Icon = cmd.icon
                                        const isSelected = globalIndex === selectedIndex

                                        return (
                                            <motion.button
                                                key={cmd.id}
                                                className="flex w-full items-center gap-3 px-4 py-2.5 text-left"
                                                style={{
                                                    background: isSelected ? 'var(--bg-hover)' : 'rgba(255,255,255,0)',
                                                }}
                                                onClick={() => executeCommand(cmd)}
                                                onMouseEnter={() => setSelectedIndex(globalIndex)}
                                                whileTap={{ scale: 0.98 }}
                                            >
                                                <div className="flex h-7 w-7 items-center justify-center rounded-lg"
                                                     style={{
                                                         background: isSelected ? 'rgba(0, 229, 255, 0.2)' : 'var(--bg-elevated)',
                                                         color: isSelected ? 'var(--accent-primary)' : 'var(--text-muted)',
                                                     }}>
                                                    <Icon className="h-3.5 w-3.5" />
                                                </div>
                                                <span className="flex-1 text-sm"
                                                      style={{ color: 'var(--text-primary)' }}>
                                                    {cmd.label}
                                                </span>
                                                {cmd.shortcut && (
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded"
                                                          style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                                                        {cmd.shortcut}
                                                    </span>
                                                )}
                                                {cmd.pro && (
                                                    <span className="text-[9px] px-1.5 py-0.5 rounded font-medium"
                                                          style={{ background: 'rgba(251, 191, 36, 0.15)', color: 'var(--accent-warning)' }}>
                                                        PRO
                                                    </span>
                                                )}
                                            </motion.button>
                                        )
                                    })}
                                </div>
                            ))
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center gap-4 px-4 py-2.5"
                         style={{ borderTop: '1px solid var(--border-subtle)' }}>
                        <div className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            <span className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-elevated)' }}>↑↓</span>
                            Navigate
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            <span className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-elevated)' }}>↵</span>
                            Select
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            <span className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-elevated)' }}>ESC</span>
                            Close
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )
}

export default CommandPalette
