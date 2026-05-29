"use client"

import { useParams } from "next/navigation"
import React, { useEffect, useState, useCallback, useRef } from "react"
import { CanvasContext, DynamicAccentContext } from "../../../../../context/context"
import { Database, Monitor } from "lucide-react"
import { useDatabaseQuery } from "../../../../../hooks/useDatabaseQuery"
import { useStoreUser } from "../../../../../hooks/useStoreUser"
import { useDynamicAccent as useImageAccent } from "@/hooks/useDynamicAccent"
import { api } from "@/lib/neon-api";
import AuroraLoader from "./_components/AuroraLoader"
import CanvasEditor from "./_components/canvas"
import EditorTopbar from "./_components/editor-topbar"
import EditorSidebar from "./_components/editor-sidebar"
import CommandPalette from "./_components/CommandPalette"
import RadialToolMenu from "./_components/RadialToolMenu"
import ContextualActionBar from "./_components/ContextualActionBar"
import useEditorShortcuts from "../../../../../hooks/useEditorShortcuts"
import { motion, AnimatePresence } from "framer-motion"
import { duration, easeOut } from "@/lib/motion"

const SIDEBAR_WIDTH_KEY = "pixxel-editor-sidebar-width"
const AGENT_SIDEBAR_WIDTH_KEY = "pixxel-editor-agent-sidebar-width"
const DEFAULT_SIDEBAR_WIDTH = 320
const DEFAULT_AGENT_SIDEBAR_WIDTH = 476
const MIN_SIDEBAR_WIDTH = 260
const MAX_SIDEBAR_WIDTH = 560
const MIN_AGENT_SIDEBAR_WIDTH = 360
const MAX_AGENT_SIDEBAR_WIDTH = 680

const clampPanelWidth = (value, min, max) => Math.min(Math.max(value, min), max)

const getStoredPanelWidth = (key, fallback, min, max) => {
    if (typeof window === "undefined") return fallback
    const stored = Number(window.localStorage.getItem(key))
    return Number.isFinite(stored) ? clampPanelWidth(stored, min, max) : fallback
}

const Editor = () => {
    const params = useParams()
    const projectId = params.projectId
    const { isLoading: isAuthLoading, isAuthenticated, databaseSetupMissing } = useStoreUser()

    const [canvasEditor, setCanvasEditor] = useState(null)
    const [processingMessage, setProcessingMessage] = useState(null)
    const [processingPhase, setProcessingPhase] = useState("initial")
    const [showCommandPalette, setShowCommandPalette] = useState(false)
    const [showRadialMenu, setShowRadialMenu] = useState(false)
    const [radialMenuPosition, setRadialMenuPosition] = useState({ x: 0, y: 0 })
    const [activeTool, setActiveTool] = useState("resize")
    const [expansionPreview, setExpansionPreview] = useState(null)
    const [cachedProject, setCachedProject] = useState(null)
    const [sidebarWidth, setSidebarWidth] = useState(() =>
        getStoredPanelWidth(SIDEBAR_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
    )
    const [agentSidebarWidth, setAgentSidebarWidth] = useState(() =>
        getStoredPanelWidth(AGENT_SIDEBAR_WIDTH_KEY, DEFAULT_AGENT_SIDEBAR_WIDTH, MIN_AGENT_SIDEBAR_WIDTH, MAX_AGENT_SIDEBAR_WIDTH)
    )
    const [resizingSidebar, setResizingSidebar] = useState(null)
    // Narrow-viewport overlay mode for the sidebar (tablets, 768–1023px). The
    // sidebar slides over the canvas on demand instead of consuming a permanent
    // 292px column, so there's enough room for a usable canvas at 768px width.
    // At lg+ this state is ignored — the sidebar is always persistent there.
    const [isNarrowViewport, setIsNarrowViewport] = useState(false)
    const [isSidebarOpen, setIsSidebarOpen] = useState(false)
    const workspaceRef = useRef(null)
    const [contextualBarPosition, setContextualBarPosition] = useState({ x: 0, y: 120 })
    const radialHoldRef = useRef(false)
    const hoveredRadialToolRef = useRef(null)
    const hoveredRadialSubRef = useRef(null)

    useEffect(() => {
        if (!canvasEditor?.getActiveObject?.()) return
        const frame = requestAnimationFrame(() => {
            setContextualBarPosition({ x: window.innerWidth / 2, y: 120 })
        })
        return () => cancelAnimationFrame(frame)
    }, [canvasEditor])

    const handleActiveToolChange = useCallback((toolId, subId = null) => {
        setActiveTool(toolId)
        if (toolId !== "ai_extender") {
            setExpansionPreview(null)
        }
        if (subId) {
            // Sub-action hint: broadcast on window so individual tools can react
            // without prop-drilling. Tools listen for "pixxel:tool-sub" with
            // { detail: { toolId, subId } } and apply their own preset.
            try {
                window.dispatchEvent(new CustomEvent("pixxel:tool-sub", { detail: { toolId, subId } }))
            } catch { /* SSR safe */ }
        }
    }, [])

    useEditorShortcuts(canvasEditor, activeTool, handleActiveToolChange, () => setShowCommandPalette(prev => !prev))

    useEffect(() => {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
    }, [sidebarWidth])

    useEffect(() => {
        window.localStorage.setItem(AGENT_SIDEBAR_WIDTH_KEY, String(agentSidebarWidth))
    }, [agentSidebarWidth])

    // Track whether we're below the lg breakpoint (1024px). At narrow widths
    // the sidebar enters overlay mode — hidden by default, slides over the
    // canvas when toggled. matchMedia is used directly so this stays in sync
    // with the corresponding @media query in globals.css.
    useEffect(() => {
        if (typeof window === "undefined") return undefined
        const mql = window.matchMedia("(max-width: 1023.98px)")
        const apply = () => setIsNarrowViewport(mql.matches)
        apply()
        // Older Safari uses addListener/removeListener (non-prefixed equivalents
        // are recent). Detect with feature check rather than UA sniffing.
        if (typeof mql.addEventListener === "function") {
            mql.addEventListener("change", apply)
            return () => mql.removeEventListener("change", apply)
        }
        mql.addListener(apply)
        return () => mql.removeListener(apply)
    }, [])

    // When the viewport grows past lg, reset the overlay-open state — the
    // user shouldn't be left with a toggle button that's no longer rendered.
    // The persistent sidebar then takes over and ignores isSidebarOpen.
    useEffect(() => {
        if (!isNarrowViewport && isSidebarOpen) setIsSidebarOpen(false)
    }, [isNarrowViewport, isSidebarOpen])

    // Escape closes the overlay sidebar. We deliberately do NOT auto-close on
    // tool change — when a user picks Crop in the topbar while the sidebar
    // already shows the Adjust panel, the sidebar should stay open and switch
    // to the Crop panel (the panel content follows activeTool).
    useEffect(() => {
        if (!isNarrowViewport || !isSidebarOpen) return undefined
        const onKey = (e) => {
            if (e.key === "Escape") setIsSidebarOpen(false)
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [isNarrowViewport, isSidebarOpen])

    const handleSidebarToggle = useCallback(() => {
        setIsSidebarOpen((open) => !open)
    }, [])

    useEffect(() => {
        if (!resizingSidebar) return undefined

        const handlePointerMove = (event) => {
            const rect = workspaceRef.current?.getBoundingClientRect()
            if (!rect) return

            if (resizingSidebar === "left") {
                setSidebarWidth(clampPanelWidth(event.clientX - rect.left, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH))
            } else {
                setAgentSidebarWidth(clampPanelWidth(rect.right - event.clientX, MIN_AGENT_SIDEBAR_WIDTH, MAX_AGENT_SIDEBAR_WIDTH))
            }
        }

        const handlePointerUp = () => {
            setResizingSidebar(null)
            window.dispatchEvent(new Event("resize"))
        }

        document.body.classList.add("editor-sidebar-is-resizing")
        window.addEventListener("pointermove", handlePointerMove)
        window.addEventListener("pointerup", handlePointerUp, { once: true })

        return () => {
            document.body.classList.remove("editor-sidebar-is-resizing")
            window.removeEventListener("pointermove", handlePointerMove)
            window.removeEventListener("pointerup", handlePointerUp)
        }
    }, [resizingSidebar])

    const startSidebarResize = useCallback((side) => (event) => {
        event.preventDefault()
        setResizingSidebar(side)
    }, [])

    const handleSidebarResizeKey = useCallback((side) => (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        event.preventDefault()
        const step = 16
        if (side === "left") {
            setSidebarWidth((current) =>
                clampPanelWidth(current + (event.key === "ArrowRight" ? step : -step), MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
            )
        } else {
            setAgentSidebarWidth((current) =>
                clampPanelWidth(current + (event.key === "ArrowLeft" ? step : -step), MIN_AGENT_SIDEBAR_WIDTH, MAX_AGENT_SIDEBAR_WIDTH)
            )
        }
        window.dispatchEvent(new Event("resize"))
    }, [])

    const isRadialBlockedTarget = useCallback((target) => {
        return Boolean(
            target?.closest?.(
                "input, textarea, select, button, a, [contenteditable='true'], .editor-sidebar, .editor-topbar"
            )
        )
    }, [])

    const clampRadialPosition = useCallback((clientX, clientY) => {
        const margin = 150
        return {
            x: Math.min(Math.max(clientX, margin), window.innerWidth - margin),
            y: Math.min(Math.max(clientY, margin), window.innerHeight - margin),
        }
    }, [])

    const handleContextMenu = useCallback((e) => {
        e.preventDefault()
    }, [])

    const handleRadialPointerDown = useCallback(
        (e) => {
            if (e.button !== 2) return
            if (isRadialBlockedTarget(e.target)) return

            e.preventDefault()
            radialHoldRef.current = true
            hoveredRadialToolRef.current = null
            setRadialMenuPosition(clampRadialPosition(e.clientX, e.clientY))
            setShowRadialMenu(true)
        },
        [clampRadialPosition, isRadialBlockedTarget]
    )

    const handleRadialPointerUp = useCallback((e) => {
        if (e.button !== 2 || !radialHoldRef.current) return

        radialHoldRef.current = false
        const toolId = hoveredRadialToolRef.current
        const subId = hoveredRadialSubRef.current
        hoveredRadialToolRef.current = null
        hoveredRadialSubRef.current = null
        setShowRadialMenu(false)

        if (toolId) handleActiveToolChange(toolId, subId)
    }, [handleActiveToolChange])

    const handleRadialHoverChange = useCallback((toolId, subId = null) => {
        if (radialHoldRef.current) {
            hoveredRadialToolRef.current = toolId
            hoveredRadialSubRef.current = subId
        }
    }, [])

    useEffect(() => {
        window.addEventListener("pointerdown", handleRadialPointerDown, true)
        window.addEventListener("pointerup", handleRadialPointerUp, true)
        window.addEventListener("contextmenu", handleContextMenu)
        return () => {
            window.removeEventListener("pointerdown", handleRadialPointerDown, true)
            window.removeEventListener("pointerup", handleRadialPointerUp, true)
            window.removeEventListener("contextmenu", handleContextMenu)
        }
    }, [handleContextMenu, handleRadialPointerDown, handleRadialPointerUp])

    const { data: project, isLoading: isProjectLoading, error } = useDatabaseQuery(
        api.projects.getProject,
        isAuthenticated ? { projectId } : "skip"
    )

    useEffect(() => {
        const cacheTimeout = setTimeout(() => {
            if (project) setCachedProject(project)
            else if (!isAuthLoading && !isAuthenticated) setCachedProject(null)
        }, 0)
        return () => clearTimeout(cacheTimeout)
    }, [project, isAuthLoading, isAuthenticated])

    const activeProject = project || (cachedProject?._id === projectId ? cachedProject : null)
    const isLoading = (isAuthLoading || isProjectLoading) && !activeProject
    const dynamicAccent = useImageAccent(activeProject?.currentImageUrl || activeProject?.originalImageUrl)

    if (isLoading) return (
        <div className="neo-loader-surface relative min-h-screen flex items-center justify-center">
            <AuroraLoader message="Loading editor" />
        </div>
    )

    if (databaseSetupMissing) return (
        <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-void-darkest)" }}>
            <motion.div
                className="max-w-md px-6 text-center"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: duration.normal, ease: easeOut }}
            >
                <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-lg border border-cyan-300/35 bg-cyan-300/10">
                    <Database className="h-7 w-7 text-cyan-300" />
                </div>
                <h1 className="mb-2 text-xl font-bold" style={{ color: "var(--text-primary)" }}>Neon database setup required</h1>
                <p style={{ color: "var(--text-muted)" }} className="text-sm leading-6">
                    Add `DATABASE_URL` and `DIRECT_URL`, then run `bun run db:push` before opening saved projects.
                </p>
            </motion.div>
        </div>
    )

    if (error || !activeProject) return (
        <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-void-darkest)" }}>
            <motion.div
                className="text-center"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: duration.normal, ease: easeOut }}
            >
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-5" style={{ background: "rgba(244,63,94,0.1)", border: "1px solid rgba(244,63,94,0.2)" }}>
                    <span className="text-2xl">🔍</span>
                </div>
                <h1 className="text-xl font-bold mb-2" style={{ color: "var(--text-primary)" }}>Project not found</h1>
                <p style={{ color: "var(--text-muted)" }} className="text-sm max-w-xs mx-auto">This project does not exist or you do not have permission to view it.</p>
            </motion.div>
        </div>
    )

    const accentCSS = {
        "--accent-ink": dynamicAccent.accent,
        "--accent-primary": dynamicAccent.accent,
        "--accent-ink-glow": `rgba(${dynamicAccent.accentRgb}, 0.35)`,
        "--accent-ink-dim": `rgba(${dynamicAccent.accentRgb}, 0.12)`,
        "--shadow-glow": `0 0 20px rgba(${dynamicAccent.accentRgb}, 0.15)`,
    }

    const editorContent = (
        <CanvasContext.Provider value={{ canvasEditor, setCanvasEditor, activeTool, onToolChange: handleActiveToolChange, processingMessage, setProcessingMessage, setProcessingPhase, expansionPreview, setExpansionPreview }}>
            {/* editor-shell is hidden below md (768px) — the editor is too cramped
                on phones. At md–lg (768–1023px, tablet) the sidebar enters overlay
                mode via data-sidebar-mode="overlay"; at lg+ it's persistent. */}
            <div
                className="editor-shell hidden h-screen min-h-screen flex-col overflow-hidden md:flex"
                data-agent-mode={activeTool === "ai_agent"}
                data-sidebar-mode={isNarrowViewport ? "overlay" : "persistent"}
                data-sidebar-open={isSidebarOpen ? "true" : "false"}
                style={{ ...accentCSS }}
            >
                {/* Processing overlay */}
                <AnimatePresence>
                    {processingMessage && (
                        <motion.div
                            className="neo-loader-surface fixed inset-0 z-50 flex items-center justify-center"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.2 }}
                        >
                            <AuroraLoader message={processingMessage} phase={processingPhase} />
                        </motion.div>
                    )}
                </AnimatePresence>

                <CommandPalette isOpen={showCommandPalette} onClose={() => setShowCommandPalette(false)} />
                <RadialToolMenu
                    visible={showRadialMenu}
                    position={radialMenuPosition}
                    holdMode
                    onClose={() => {
                        radialHoldRef.current = false
                        hoveredRadialToolRef.current = null
                        hoveredRadialSubRef.current = null
                        setShowRadialMenu(false)
                    }}
                    onHoverToolChange={handleRadialHoverChange}
                    onToolSelect={handleActiveToolChange}
                />
                <ContextualActionBar visible={!!canvasEditor?.getActiveObject?.()} position={contextualBarPosition} />
                <EditorTopbar
                    project={activeProject}
                    onToggleSidebar={isNarrowViewport ? handleSidebarToggle : undefined}
                    isSidebarOpen={isSidebarOpen}
                    isNarrowViewport={isNarrowViewport}
                />

                {/* Sidebar backdrop — appears only when the overlay sidebar is open
                    on a narrow viewport. Clicking outside the sidebar dismisses it,
                    matching the standard overlay-drawer pattern. The element is
                    always mounted but inert when closed so the fade-in transition
                    can play on open without remounting. */}
                <AnimatePresence>
                    {isNarrowViewport && isSidebarOpen && (
                        <motion.div
                            key="sidebar-backdrop"
                            className="editor-sidebar-backdrop"
                            onClick={() => setIsSidebarOpen(false)}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.18, ease: easeOut }}
                            aria-hidden="true"
                        />
                    )}
                </AnimatePresence>

                {/* CanvasEditor MUST stay mounted across the AI-agent toggle so the
                    Fabric canvas (and its undo/mask state) isn't disposed and
                    rebuilt. To guarantee that, the three children — sidebar,
                    resizer, canvas pane — are rendered as the SAME element types
                    at the SAME sibling indices in both modes, so React reconciles
                    instead of remounting. Only props/className change between modes.
                    Agent mode visually places the canvas on the left and the
                    sidebar on the right; we flip the visual order with
                    `flex-row-reverse` on the container (DOM order stays
                    [sidebar, resizer, canvas]) rather than reordering the DOM,
                    which would force a remount. The original agent layout was
                    literally that DOM order reversed, so the result is identical. */}
                {(() => {
                    const isAgent = activeTool === "ai_agent"
                    return (
                        <motion.div ref={workspaceRef} className={`editor-workspace flex min-h-0 flex-1 overflow-hidden ${isAgent ? "flex-row-reverse editor-workspace--agent" : ""}`}>
                            <EditorSidebar project={activeProject} width={isAgent ? agentSidebarWidth : sidebarWidth} />
                            <div
                                role="separator"
                                tabIndex={0}
                                className={`editor-sidebar-resizer ${isAgent ? "editor-sidebar-resizer--right" : "editor-sidebar-resizer--left"}`}
                                onPointerDown={startSidebarResize(isAgent ? "right" : "left")}
                                onKeyDown={handleSidebarResizeKey(isAgent ? "right" : "left")}
                                aria-label={isAgent ? "Resize agent sidebar" : "Resize editor sidebar"}
                                aria-orientation="vertical"
                                aria-valuemin={isAgent ? MIN_AGENT_SIDEBAR_WIDTH : MIN_SIDEBAR_WIDTH}
                                aria-valuemax={isAgent ? MAX_AGENT_SIDEBAR_WIDTH : MAX_SIDEBAR_WIDTH}
                                aria-valuenow={isAgent ? agentSidebarWidth : sidebarWidth}
                                title="Drag to resize sidebar"
                            />
                            <div className={`min-w-0 flex-1${isAgent ? " agent-live-image-pane" : ""}`}>
                                <CanvasEditor project={activeProject} />
                            </div>
                        </motion.div>
                    )
                })()}
            </div>

            {/* Mobile fallback — below 768px (sm and smaller) the editor's
                canvas + toolbar can't fit usefully even with overlays. iPad
                portrait (768×1024) and larger now reach the full editor. */}
            <div className="md:hidden min-h-screen flex items-center justify-center p-6" style={{ background: "var(--bg-void-darkest)" }}>
                <motion.div className="text-center max-w-md" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6" style={{ background: "rgba(6,184,212,0.1)", border: "1px solid rgba(6,184,212,0.2)" }}>
                        <Monitor className="h-7 w-7" style={{ color: "var(--accent-ink)" }} />
                    </div>
                    <h1 className="text-xl font-bold mb-3" style={{ color: "var(--text-primary)" }}>Tablet or larger needed</h1>
                    <p style={{ color: "var(--text-muted)" }} className="text-sm">The editor works on tablets (768px+) and up. Rotate to landscape or open this on a larger screen.</p>
                </motion.div>
            </div>
        </CanvasContext.Provider>
    )

    return (
        <DynamicAccentContext.Provider value={dynamicAccent}>
            {editorContent}
        </DynamicAccentContext.Provider>
    )
}

export default Editor
