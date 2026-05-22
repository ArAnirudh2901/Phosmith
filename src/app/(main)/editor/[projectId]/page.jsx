"use client"

import { useParams } from "next/navigation"
import React, { useEffect, useState, useCallback, useRef } from "react"
import { CanvasContext, DynamicAccentContext } from "../../../../../context/context"
import { Monitor } from "lucide-react"
import { useConvexQuery } from "../../../../../hooks/useConvexQuery"
import { useStoreUser } from "../../../../../hooks/useStoreUser"
import { useDynamicAccent as useImageAccent } from "@/hooks/useDynamicAccent"
import { api } from "../../../../../convex/_generated/api"
import AuroraLoader from "./_components/AuroraLoader"
import CanvasEditor from "./_components/canvas"
import EditorTopbar from "./_components/editor-topbar"
import EditorSidebar from "./_components/editor-sidebar"
import CommandPalette from "./_components/CommandPalette"
import RadialToolMenu from "./_components/RadialToolMenu"
import ContextualActionBar from "./_components/ContextualActionBar"
import useEditorShortcuts from "../../../../../hooks/useEditorShortcuts"
import { motion, AnimatePresence } from "framer-motion"
import { duration, easeOut, useReducedMotion } from "@/lib/motion"

const pseudoRandom = (seed, max = 1) => ((seed * 16807 + 0) % 2147483647) / 2147483647 * max

const PARTICLE_COUNT = 8

const PARTICLE_DATA = Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
    id: i,
    width: 4 + pseudoRandom(i * 7, 4),
    height: 4 + pseudoRandom(i * 13, 4),
    opacityBase: 0.3 + pseudoRandom(i * 17, 0.3),
    left: pseudoRandom(i * 23, 100),
    top: pseudoRandom(i * 31, 100),
    duration: 2 + pseudoRandom(i * 41, 2),
    delay: i * 0.1,
}))

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
    const reduced = useReducedMotion()
    const { isLoading: isAuthLoading, isAuthenticated } = useStoreUser()

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
    const workspaceRef = useRef(null)
    const [contextualBarPosition, setContextualBarPosition] = useState({ x: 0, y: 120 })
    const radialHoldRef = useRef(false)
    const hoveredRadialToolRef = useRef(null)

    useEffect(() => {
        if (!canvasEditor?.getActiveObject?.()) return
        const frame = requestAnimationFrame(() => {
            setContextualBarPosition({ x: window.innerWidth / 2, y: 120 })
        })
        return () => cancelAnimationFrame(frame)
    }, [canvasEditor])

    const handleActiveToolChange = useCallback((toolId) => {
        setActiveTool(toolId)
        if (toolId !== "ai_extender") {
            setExpansionPreview(null)
        }
    }, [])

    useEditorShortcuts(canvasEditor, activeTool, handleActiveToolChange, () => setShowCommandPalette(prev => !prev))

    useEffect(() => {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
    }, [sidebarWidth])

    useEffect(() => {
        window.localStorage.setItem(AGENT_SIDEBAR_WIDTH_KEY, String(agentSidebarWidth))
    }, [agentSidebarWidth])

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
        hoveredRadialToolRef.current = null
        setShowRadialMenu(false)

        if (toolId) handleActiveToolChange(toolId)
    }, [handleActiveToolChange])

    const handleRadialHoverChange = useCallback((toolId) => {
        if (radialHoldRef.current) {
            hoveredRadialToolRef.current = toolId
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

    const { data: project, isLoading: isProjectLoading, error } = useConvexQuery(
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
        <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-void-darkest)" }}>
            <motion.div
                className="flex flex-col items-center gap-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: duration.normal, ease: easeOut }}
            >
                <div className="w-10 h-10 rounded-xl flex items-center justify-center animate-pulse-glow"
                    style={{ background: `rgba(${dynamicAccent.accentRgb}, 0.15)` }}>
                    <div className="w-5 h-5 rounded-md" style={{ background: dynamicAccent.accent }} />
                </div>
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading editor...</p>
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
            <div className="editor-shell hidden h-screen min-h-screen flex-col overflow-hidden lg:flex" data-agent-mode={activeTool === "ai_agent"} style={{ ...accentCSS }}>
                {/* Processing overlay */}
                <AnimatePresence>
                    {processingMessage && (
                        <motion.div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(7,9,14,0.88)", backdropFilter: "blur(16px)" }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                            {!reduced && (
                                <div className="absolute inset-0 overflow-hidden pointer-events-none">
                                    {PARTICLE_DATA.map((p) => (
                                        <motion.div
                                            key={p.id}
                                            className="absolute rounded-full"
                                            style={{
                                                width: p.width,
                                                height: p.height,
                                                background: `radial-gradient(circle, rgba(0,229,255,${p.opacityBase}), transparent)`,
                                                left: `${p.left}%`,
                                                top: `${p.top}%`,
                                            }}
                                            animate={{ y: [0, -80, 0], opacity: [0, 0.6, 0] }}
                                            transition={{
                                                duration: p.duration,
                                                repeat: Infinity,
                                                delay: p.delay,
                                                ease: easeOut,
                                            }}
                                        />
                                    ))}
                                </div>
                            )}
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
                        setShowRadialMenu(false)
                    }}
                    onHoverToolChange={handleRadialHoverChange}
                    onToolSelect={handleActiveToolChange}
                />
                <ContextualActionBar visible={!!canvasEditor?.getActiveObject?.()} position={contextualBarPosition} />
                <EditorTopbar project={activeProject} />

                <motion.div ref={workspaceRef} className={`editor-workspace flex min-h-0 flex-1 overflow-hidden ${activeTool === "ai_agent" ? "editor-workspace--agent" : ""}`}>
                    {activeTool === "ai_agent" ? (
                        <>
                            <div className="agent-live-image-pane min-w-0 flex-1">
                                <CanvasEditor project={activeProject} />
                            </div>
                            <div
                                role="separator"
                                tabIndex={0}
                                className="editor-sidebar-resizer editor-sidebar-resizer--right"
                                onPointerDown={startSidebarResize("right")}
                                onKeyDown={handleSidebarResizeKey("right")}
                                aria-label="Resize agent sidebar"
                                aria-orientation="vertical"
                                aria-valuemin={MIN_AGENT_SIDEBAR_WIDTH}
                                aria-valuemax={MAX_AGENT_SIDEBAR_WIDTH}
                                aria-valuenow={agentSidebarWidth}
                                title="Drag to resize sidebar"
                            />
                            <EditorSidebar project={activeProject} width={agentSidebarWidth} />
                        </>
                    ) : (
                        <>
                            <EditorSidebar project={activeProject} width={sidebarWidth} />
                            <div
                                role="separator"
                                tabIndex={0}
                                className="editor-sidebar-resizer editor-sidebar-resizer--left"
                                onPointerDown={startSidebarResize("left")}
                                onKeyDown={handleSidebarResizeKey("left")}
                                aria-label="Resize editor sidebar"
                                aria-orientation="vertical"
                                aria-valuemin={MIN_SIDEBAR_WIDTH}
                                aria-valuemax={MAX_SIDEBAR_WIDTH}
                                aria-valuenow={sidebarWidth}
                                title="Drag to resize sidebar"
                            />
                            <div className="min-w-0 flex-1">
                                <CanvasEditor project={activeProject} />
                            </div>
                        </>
                    )}
                </motion.div>
            </div>

            {/* Mobile restriction */}
            <div className="lg:hidden min-h-screen flex items-center justify-center p-6" style={{ background: "var(--bg-void-darkest)" }}>
                <motion.div className="text-center max-w-md" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6" style={{ background: "rgba(0,229,255,0.1)", border: "1px solid rgba(0,229,255,0.2)" }}>
                        <Monitor className="h-7 w-7" style={{ color: "var(--accent-ink)" }} />
                    </div>
                    <h1 className="text-xl font-bold mb-3" style={{ color: "var(--text-primary)" }}>Desktop Required</h1>
                    <p style={{ color: "var(--text-muted)" }} className="text-sm">The editor requires a larger screen for the best experience.</p>
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
