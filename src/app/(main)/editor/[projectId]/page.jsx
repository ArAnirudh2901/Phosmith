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

const pseudoRandom = (seed, max = 1) => ((seed * 16807 + 0) % 2147483647) / 2147483647 * max

const PARTICLE_DATA = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    width: 4 + pseudoRandom(i * 7, 4),
    height: 4 + pseudoRandom(i * 13, 4),
    opacityBase: 0.3 + pseudoRandom(i * 17, 0.3),
    left: pseudoRandom(i * 23, 100),
    top: pseudoRandom(i * 31, 100),
    duration: 2 + pseudoRandom(i * 41, 2),
    delay: i * 0.1,
}))

const Editor = () => {
    const params = useParams()
    const projectId = params.projectId
    const { isLoading: isAuthLoading, isAuthenticated } = useStoreUser()

    const [canvasEditor, setCanvasEditor] = useState(null)
    const [processingMessage, setProcessingMessage] = useState(null)
    const [processingPhase, setProcessingPhase] = useState("initial")
    const [showCommandPalette, setShowCommandPalette] = useState(false)
    const [showRadialMenu, setShowRadialMenu] = useState(false)
    const [radialMenuPosition, setRadialMenuPosition] = useState({ x: 0, y: 0 })
    const [activeTool, setActiveTool] = useState("resize")
    const [cachedProject, setCachedProject] = useState(null)
    const [contextualBarPosition, setContextualBarPosition] = useState({ x: 0, y: 120 })

    useEffect(() => {
        if (!canvasEditor?.getActiveObject?.()) return
        const frame = requestAnimationFrame(() => {
            setContextualBarPosition({ x: window.innerWidth / 2, y: 120 })
        })
        return () => cancelAnimationFrame(frame)
    }, [canvasEditor])

    useEditorShortcuts(canvasEditor, activeTool, setActiveTool, () => setShowCommandPalette(prev => !prev))

    const handleContextMenu = useCallback((e) => {
        const target = e.target
        if (target?.closest?.("input, textarea, select, button, a, [contenteditable='true'], .editor-sidebar, .editor-topbar")) {
            return
        }

        e.preventDefault()
        const margin = 150
        setRadialMenuPosition({
            x: Math.min(Math.max(e.clientX, margin), window.innerWidth - margin),
            y: Math.min(Math.max(e.clientY, margin), window.innerHeight - margin),
        })
        setShowRadialMenu(true)
    }, [])

    useEffect(() => {
        window.addEventListener("contextmenu", handleContextMenu)
        return () => window.removeEventListener("contextmenu", handleContextMenu)
    }, [handleContextMenu])

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
            <motion.div className="flex flex-col items-center gap-4" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4 }}>
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
            <motion.div className="text-center" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
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
        <CanvasContext.Provider value={{ canvasEditor, setCanvasEditor, activeTool, onToolChange: setActiveTool, processingMessage, setProcessingMessage, setProcessingPhase }}>
            <div className="editor-shell hidden h-screen min-h-screen flex-col overflow-hidden lg:flex" style={{ ...accentCSS }}>
                {/* Processing overlay */}
                <AnimatePresence>
                    {processingMessage && (
                        <motion.div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(7,9,14,0.88)", backdropFilter: "blur(16px)" }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                                {PARTICLE_DATA.map((p) => (
                                    <motion.div key={p.id} className="absolute rounded-full"
                                        style={{
                                            width: p.width, height: p.height,
                                            background: `radial-gradient(circle, rgba(0,229,255,${p.opacityBase}), transparent)`,
                                            left: `${p.left}%`, top: `${p.top}%`,
                                        }}
                                        animate={{ y: [0, -120, 0], opacity: [0, 1, 0], scale: [0, 1.5, 0] }}
                                        transition={{ duration: p.duration, repeat: Infinity, delay: p.delay, ease: "easeInOut" }}
                                    />
                                ))}
                            </div>
                            <AuroraLoader message={processingMessage} phase={processingPhase} />
                        </motion.div>
                    )}
                </AnimatePresence>

                <CommandPalette isOpen={showCommandPalette} onClose={() => setShowCommandPalette(false)} />
                <RadialToolMenu visible={showRadialMenu} position={radialMenuPosition} onClose={() => setShowRadialMenu(false)} onToolSelect={setActiveTool} />
                <ContextualActionBar visible={!!canvasEditor?.getActiveObject?.()} position={contextualBarPosition} />
                <EditorTopbar project={activeProject} />

                <motion.div className="editor-workspace flex min-h-0 flex-1 overflow-hidden">
                    <EditorSidebar project={activeProject} />
                    <div className="min-w-0 flex-1">
                        <CanvasEditor project={activeProject} />
                    </div>
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
