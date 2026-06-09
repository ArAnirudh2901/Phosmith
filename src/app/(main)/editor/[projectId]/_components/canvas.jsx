"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import { useCanvas } from "../../../../../../context/context"
import { useDatabaseMutation } from "../../../../../../hooks/useDatabaseQuery"
import { api } from "@/lib/neon-api";
import { Hand, Maximize2, ZoomIn, ZoomOut } from "lucide-react"
import {
    Canvas,
    FabricImage,
    InteractiveFabricObject,
    Point,
    config as fabricConfig,
} from "fabric"
// Side-effect import: registers PixxelCurves filter in Fabric's classRegistry so
// loadFromJSON can rehydrate saved canvas state that contains it.
import "../../../../../lib/curves-filter"
// Eagerly register the MegashaderFilter class with Fabric's classRegistry at
// module load. Without this, a project saved with a persisted megashader mask
// chain would have its `type: "Megashader"` filter silently dropped by
// loadFromJSON (the class wouldn't be registered yet — it was previously only
// imported lazily when the mask tool fired its first change event).
import "@/lib/megashader/fabric-megashader-filter"

// Force the Canvas2D filter backend instead of WebGL. The custom curves LUT filter
// has a WebGL fragment-shader path that worked in isolation but had subtle issues
// in real filter chains (corrupted source texture state on some images, leading to
// black canvases and other downstream filters not visibly applying). 2D is slower
// for large images but correct in every chain shape.
if (typeof window !== "undefined" && fabricConfig) {
    fabricConfig.enableGLFiltering = false
}

// Neo-brutalist defaults for selected-object controls (corners, border, padding,
// rotation handle). Fabric reads InteractiveFabricObject.ownDefaults at object
// construction, so this needs to run before any FabricImage / Rect / etc. is
// created — at module init, before Canvas mounts.
if (typeof window !== "undefined" && InteractiveFabricObject?.ownDefaults) {
    InteractiveFabricObject.ownDefaults = {
        ...InteractiveFabricObject.ownDefaults,
        // Square cyan corners with a hard cream stroke — same palette as the
        // editor's Projects header, preview controls, and resolution HUD.
        cornerStyle: "rect",
        cornerColor: "#06B8D4",
        cornerStrokeColor: "#F4F4F5",
        cornerSize: 11,
        touchCornerSize: 22,
        transparentCorners: false,
        cornerDashArray: null,
        // Solid cream marquee border with a slight float-off-the-image padding.
        // Thicker than default so it reads at any zoom.
        borderColor: "#F4F4F5",
        borderScaleFactor: 1.6,
        borderDashArray: null,
        borderOpacityWhenMoving: 0.9,
        padding: 6,
    }
}
import { normalizeCanvasState, serializeCanvasState } from "../../../../../lib/canvas-state"
import { hydrateCanvasImages, restoreCanvasFromHistory } from "../../../../../lib/canvas-history"
import { isExpansionFrameLike, removeExpansionFramesFromCanvas } from "../../../../../lib/expansion-pipeline"
import { addImageFilesToCanvas } from "../../../../../lib/canvas-images"
import {
    fetchCachedSnapshot,
    flushToNeon,
    snapshotToCache,
} from "../../../../../lib/canvas-cache"
import { createCanvasSync, loadLocalState, clearLocalState } from "../../../../../lib/canvas-sync"
import { toast } from "sonner"
import { isPixxelMaskOverlay } from "../../../../../lib/canvas-mask"
import { syncBackgroundGrade } from "../../../../../lib/canvas-background"
import AuroraLoader from "./AuroraLoader"

const MIN_ZOOM = 0.05
const MAX_ZOOM = 64
const MIN_PREVIEW_ZOOM_PERCENT = 5
const MAX_PREVIEW_ZOOM_PERCENT = 300
const PREVIEW_ZOOM_STEP_PERCENT = 1
const VIEWPORT_PADDING = 32
const MAX_PERSISTED_HISTORY = 30
const MIN_PERSISTED_HISTORY_ENTRIES = 3
const MAX_NEON_STATE_CHARS = 900_000
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
const readPreviewZoomPercent = (canvas) => Math.round((canvas?.getZoom?.() || 1) * 100)
const getPrimaryRemoteImageUrl = (canvas) => {
    const image = canvas
        ?.getObjects?.()
        ?.find((object) => object?.type?.toLowerCase() === 'image')
    const src =
        image?.getSrc?.() ||
        image?._originalElement?.src ||
        image?._element?.src ||
        image?.src ||
        ''

    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return null
    return src.startsWith('http') ? src : null
}

const fitImageInsideProject = (image, projectSize) => {
    const projectW = Math.max(1, projectSize?.width || image?.width || 1)
    const projectH = Math.max(1, projectSize?.height || image?.height || 1)
    const imageW = Math.max(1, image?.width || projectW)
    const imageH = Math.max(1, image?.height || projectH)
    const scale = Math.min(projectW / imageW, projectH / imageH)

    image.set({
        left: projectW / 2,
        top: projectH / 2,
        originX: "center",
        originY: "center",
        scaleX: scale,
        scaleY: scale,
        selectable: true,
        evented: true,
    })
    image.setCoords()
}

const CanvasEditor = ({ project }) => {
    const [isLoading, setIsLoading] = useState(true)
    const canvasRef = useRef()
    const containerRef = useRef()
    const canvasInstanceRef = useRef(null)
    const isPanningRef = useRef(false)
    const ctrlPressedRef = useRef(false)
    const spacePressedRef = useRef(false)
    const handToolActiveRef = useRef(false)
    const [isHandToolActive, setIsHandToolActive] = useState(false)
    const [isProjectFrameVisible, setIsProjectFrameVisible] = useState(false)
    const [previewZoomPercent, setPreviewZoomPercent] = useState(100)
    const projectFrameStyleRef = useRef({ left: 0, top: 0, width: 0, height: 0 })
    const [projectFrameStyle, setProjectFrameStyle] = useState({ left: 0, top: 0, width: 0, height: 0 })
    const [imageNativeSize, setImageNativeSize] = useState(null)
    const lastPointerRef = useRef(null)
    const historyRef = useRef([])
    const historyIndexRef = useRef(-1)
    const isRestoringRef = useRef(false)
    const resizeFrameRef = useRef(null)
    const initGenerationRef = useRef(0)
    const previewZoomPercentRef = useRef(100)
    const projectRef = useRef(project)
    projectRef.current = project

    const { canvasEditor, setCanvasEditor, activeTool, expansionPreview, processingMessage } = useCanvas()
    // Hide the floating canvas chrome (zoom bar, hand tool, resolution HUD) any
    // time we're showing a full-screen processing overlay or the initial canvas
    // loader. Otherwise those controls bleed through the blurred background.
    const isBusy = Boolean(processingMessage) || isLoading
    const activeToolRef = useRef(activeTool)
    activeToolRef.current = activeTool
    const { mutate: updateProject } = useDatabaseMutation(api.projects.updateProject)
    const { mutate: createProjectRevisionMut } = useDatabaseMutation(api.projects.createProjectRevision)

    const disposeCanvasInstance = useCallback(() => {
        const existing = canvasInstanceRef.current
        if (existing) {
            existing.__cleanupInfiniteWorkspace?.()
            try {
                existing.dispose()
            } catch {
                /* already disposed */
            }
            canvasInstanceRef.current = null
        }
        setCanvasEditor(null)
    }, [setCanvasEditor])

    const getContainerSize = () => {
        if (typeof window === 'undefined' || !containerRef.current) return { width: 0, height: 0 }
        return { width: containerRef.current.clientWidth, height: containerRef.current.clientHeight }
    }

    const getViewportState = useCallback((canvas) => {
        const viewportTransform = canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
        const zoom = viewportTransform[0] || 1
        return {
            zoom,
            center: { x: (canvas.getWidth() / 2 - viewportTransform[4]) / zoom, y: (canvas.getHeight() / 2 - viewportTransform[5]) / zoom },
        }
    }, [])

    const setViewportState = useCallback((canvas, viewportState, fallbackCenter) => {
        const zoom = clamp(viewportState?.zoom || 1, MIN_ZOOM, MAX_ZOOM)
        const center = viewportState?.center || fallbackCenter
        if (!center) return
        canvas.setViewportTransform([zoom, 0, 0, zoom, canvas.getWidth() / 2 - center.x * zoom, canvas.getHeight() / 2 - center.y * zoom])
    }, [])

    const syncPreviewZoomState = useCallback((canvas) => {
        const nextPercent = readPreviewZoomPercent(canvas)
        if (previewZoomPercentRef.current === nextPercent) return
        previewZoomPercentRef.current = nextPercent
        setPreviewZoomPercent(nextPercent)
    }, [])

    const setCanvasPreviewZoom = useCallback((canvas, percent) => {
        if (!canvas) return
        const viewportState = getViewportState(canvas)
        setViewportState(canvas, {
            ...viewportState,
            zoom: clamp(Number(percent) / 100, MIN_ZOOM, MAX_ZOOM),
        })
        canvas.calcOffset()
        canvas.requestRenderAll()
        syncPreviewZoomState(canvas)
    }, [getViewportState, setViewportState, syncPreviewZoomState])

    const fitProjectToViewport = useCallback((canvas, size) => {
        const canvasW = canvas.getWidth()
        const canvasH = canvas.getHeight()
        const proj = size || projectRef.current
        const projectW = Math.max(1, proj?.width || 1)
        const projectH = Math.max(1, proj?.height || 1)
        if (!canvasW || !canvasH || !projectW || !projectH) return

        // Use 92% of canvas area as the safe zone. This gives a tighter fit
        // on small screens (13" MacBook Air) while still having breathing room.
        // The fixed VIEWPORT_PADDING acts as a minimum margin.
        const safeW = Math.max(canvasW * 0.92, canvasW - VIEWPORT_PADDING * 2, 1)
        const safeH = Math.max(canvasH * 0.92, canvasH - VIEWPORT_PADDING * 2, 1)
        const fitZoom = Math.min(safeW / projectW, safeH / projectH)
        setViewportState(canvas, {
            zoom: clamp(fitZoom || 1, MIN_ZOOM, MAX_ZOOM),
            center: { x: projectW / 2, y: projectH / 2 },
        })
    }, [setViewportState])

    const createInitialViewport = useCallback((canvas) => fitProjectToViewport(canvas), [fitProjectToViewport])

    const emitHistoryChange = (canvas) => {
        if (!canvas) return
        canvas.fire('history:changed', {
            canUndo: historyIndexRef.current > 0,
            canRedo: historyIndexRef.current < historyRef.current.length - 1,
            index: historyIndexRef.current,
            length: historyRef.current.length,
        })
    }

    const pushHistoryState = useCallback((canvas) => {
        if (!canvas || isRestoringRef.current) return
        const nextState = serializeCanvasState(canvas)
        if (!nextState?.canvas) return
        const nextSignature = JSON.stringify(nextState)
        const currentState = historyRef.current[historyIndexRef.current]
        const currentSignature = currentState ? JSON.stringify(currentState) : null
        if (nextSignature === currentSignature) return
        historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1)
        historyRef.current.push(nextState)
        while (historyRef.current.length > MAX_PERSISTED_HISTORY) {
            historyRef.current.shift()
            historyIndexRef.current = Math.max(0, historyIndexRef.current - 1)
        }
        historyIndexRef.current = historyRef.current.length - 1
        emitHistoryChange(canvas)
    }, [])

    const restoreCanvasState = useCallback(async (canvas, state) => {
        if (!canvas || !state) return
        const proj = projectRef.current
        isRestoringRef.current = true
        try {
            const imageUrl = proj?.currentImageUrl || proj?.originalImageUrl
            await restoreCanvasFromHistory(canvas, state, {
                imageUrl,
                setViewportState,
                fallbackCenter: { x: proj.width / 2, y: proj.height / 2 },
            })
        } finally {
            isRestoringRef.current = false
            emitHistoryChange(canvas)
        }
    }, [setViewportState])

    const undoCanvasState = useCallback(async () => {
        const canvas = canvasInstanceRef.current
        if (!canvas || historyIndexRef.current <= 0) return false
        historyIndexRef.current -= 1
        await restoreCanvasState(canvas, historyRef.current[historyIndexRef.current])
        return true
    }, [restoreCanvasState])

    const redoCanvasState = useCallback(async () => {
        const canvas = canvasInstanceRef.current
        if (!canvas || historyIndexRef.current >= historyRef.current.length - 1) return false
        historyIndexRef.current += 1
        await restoreCanvasState(canvas, historyRef.current[historyIndexRef.current])
        return true
    }, [restoreCanvasState])

    // Canvas sync manager, lazily created per project (see the useEffect below
    // that recreates it when projectId changes). It owns the write-behind path:
    // dedup, single-flight, the durable IndexedDB mirror, reconnect replay, and
    // the unload beacon. We never let two managers exist for the same project.
    const syncRef = useRef(null)
    // Stable indirection to the latest direct-Neon writer so the sync manager
    // (created once per project) always calls the current updateProject mutation.
    const directWriteRef = useRef(async () => {})
    const wasOfflineRef = useRef(false)
    // 'idle' | 'saving' | 'saved' | 'offline' | 'error' — drives the status pill.
    const [syncStatus, setSyncStatus] = useState("idle")

    // Surface sync-manager status: update the pill and toast on offline/online
    // transitions (deduped via wasOfflineRef so we don't spam).
    const handleSyncStatus = useCallback((status) => {
        setSyncStatus(status)
        if (status === "offline") {
            if (!wasOfflineRef.current) {
                wasOfflineRef.current = true
                toast.warning(
                    "You're offline — changes are saved on this device and will sync when you reconnect.",
                    { id: "canvas-sync", duration: Infinity },
                )
            }
        } else if (status === "saved" && wasOfflineRef.current) {
            wasOfflineRef.current = false
            toast.success("Back online — your changes are synced.", { id: "canvas-sync", duration: 3000 })
        }
    }, [])

    // Conflict handler: another session (device/tab) advanced the project's
    // revision while we were editing, so the flush was rejected (no overwrite).
    // We resolve it NON-DESTRUCTIVELY — both versions land in version history —
    // then let the user pick which becomes current.
    const handleConflict = useCallback(async (serverProject) => {
        setSyncStatus("conflict")
        const canvas = canvasInstanceRef.current
        const proj = projectRef.current
        if (!canvas || !proj) return

        // Always preserve OUR working copy in version history first, so it's
        // recoverable no matter which way the user resolves.
        try {
            const localState = serializeCanvasState(canvas)
            await createProjectRevisionMut({
                projectId: proj._id,
                canvasState: {
                    ...localState,
                    history: historyRef.current.slice(-MAX_PERSISTED_HISTORY),
                    historyIndex: historyIndexRef.current,
                },
                width: proj.width,
                height: proj.height,
                currentImageUrl: getPrimaryRemoteImageUrl(canvas) || undefined,
                title: "Your version (edit conflict)",
                summary: "Auto-saved because this project was edited on another device.",
            })
        } catch (error) {
            console.warn("[canvas] failed to preserve local conflict copy:", error?.message || error)
        }

        toast.warning("This project was edited on another device.", {
            id: "canvas-conflict",
            duration: Infinity,
            // Require an explicit choice — dismissing without resolving would leave
            // the manager holding all saves with no way to resume.
            dismissible: false,
            description: "Your version is saved in version history. Reload the latest, or keep yours (overwrites the other copy).",
            action: {
                label: "Reload latest",
                onClick: async () => {
                    // Point every cache at the remote so the reload shows it, then
                    // reuse the normal mount/rehydration path.
                    try { await clearLocalState(proj._id) } catch { /* ignore */ }
                    try {
                        if (serverProject?.canvasState) {
                            await snapshotToCache(proj._id, serverProject.canvasState, serverProject.currentImageUrl || null, serverProject.revision)
                        }
                    } catch { /* ignore */ }
                    if (typeof window !== "undefined") window.location.reload()
                },
            },
            cancel: {
                label: "Keep mine",
                onClick: async () => {
                    // Preserve the OTHER device's version too before we overwrite it.
                    try {
                        if (serverProject?.canvasState) {
                            await createProjectRevisionMut({
                                projectId: proj._id,
                                canvasState: serverProject.canvasState,
                                width: serverProject.width || proj.width,
                                height: serverProject.height || proj.height,
                                currentImageUrl: serverProject.currentImageUrl || undefined,
                                title: "Other device's version (edit conflict)",
                                summary: "Preserved before overwriting with your version.",
                            })
                        }
                    } catch (error) {
                        console.warn("[canvas] failed to preserve remote conflict copy:", error?.message || error)
                    }
                    syncRef.current?.overwriteRemote()
                    toast.dismiss("canvas-conflict")
                },
            },
        })
    }, [createProjectRevisionMut])

    // Stable indirection so the per-project sync manager always calls the latest
    // conflict handler without being torn down when it changes identity.
    const onConflictRef = useRef(() => {})
    onConflictRef.current = handleConflict

    const saveCanvasState = useCallback(async ({ rethrow = false, immediate = false } = {}) => {
        const canvas = canvasInstanceRef.current
        const proj = projectRef.current
        if (!canvas || !proj) return

        const canvasJSON = serializeCanvasState(canvas)
        const currentImageUrl = getPrimaryRemoteImageUrl(canvas)
        let fullState = {
            ...canvasJSON,
            history: historyRef.current.slice(-MAX_PERSISTED_HISTORY),
            historyIndex: historyIndexRef.current,
        }
        // Large projects (lots of objects + many history entries) can push the
        // serialized JSON over MAX_NEON_STATE_CHARS, which would make Neon
        // reject the write. Trim history with a sliding window — drop the
        // OLDEST entries — until the JSON fits. We always keep at least
        // MIN_PERSISTED_HISTORY_ENTRIES so the user can still undo a few steps
        // even on a very large project.
        //
        // Previously this branch wiped the entire history (history: [],
        // historyIndex: -1), which left the user with no undo at all after the
        // first save of a large project. See Bug G.
        if (fullState.history.length > 0 && JSON.stringify(fullState).length > MAX_NEON_STATE_CHARS) {
            const originalHistoryLength = fullState.history.length
            let persistedHistory = fullState.history
            while (
                persistedHistory.length > MIN_PERSISTED_HISTORY_ENTRIES
                && JSON.stringify({ ...fullState, history: persistedHistory }).length > MAX_NEON_STATE_CHARS
            ) {
                persistedHistory = persistedHistory.slice(1)
            }
            const droppedCount = originalHistoryLength - persistedHistory.length
            if (droppedCount > 0) {
                console.warn(
                    `[canvas] History trimmed for storage: dropped ${droppedCount} oldest entries ` +
                    `(${originalHistoryLength} → ${persistedHistory.length}) to fit within ` +
                    `${MAX_NEON_STATE_CHARS} chars. The in-memory undo stack is unaffected.`
                )
            }
            fullState = {
                ...fullState,
                history: persistedHistory,
            }
        }

        // Delegate persistence to the sync manager: it mirrors to IndexedDB
        // FIRST (durable across reload/disconnect/tab-close), dedups identical
        // states, single-flights, and — when online — writes through the cache to
        // Neon, falling back to a direct Neon write when the cache is unavailable.
        // When offline it keeps the local copy and replays it on reconnect.
        const manager = syncRef.current
        if (!manager) {
            // Manager not constructed yet (very first paint) — write directly so
            // the initial state isn't lost.
            try {
                await directWriteRef.current(fullState, currentImageUrl)
            } catch (error) {
                if (rethrow) throw error
                console.error("Error saving canvas state", error)
            }
            return
        }
        try {
            await manager.save(fullState, currentImageUrl, { immediate, rethrow })
        } catch (error) {
            if (error?.status === 401) {
                console.warn("Transient 401 saving canvas state", error.message)
            } else {
                console.error("Error saving canvas state", error)
            }
            if (rethrow) throw error
        }
    }, [])

    // Keep the direct-Neon writer current so the per-project sync manager (built
    // once) always calls the latest updateProject mutation.
    useEffect(() => {
        directWriteRef.current = async (fullState, currentImageUrl) => {
            const proj = projectRef.current
            if (!proj) return
            await updateProject({
                projectId: proj._id,
                canvasState: fullState,
                ...(currentImageUrl ? { currentImageUrl } : {}),
            })
        }
    }, [updateProject])

    // One sync manager per project. On unmount or projectId change, flush any
    // pending writes (best-effort) and tear down its listeners/timers so the next
    // editor session starts clean.
    useEffect(() => {
        const projectId = project?._id
        if (!projectId) return
        const manager = createCanvasSync({
            projectId,
            snapshotFn: snapshotToCache,
            flushFn: flushToNeon,
            onStatus: handleSyncStatus,
            onConflict: (serverProject) => onConflictRef.current(serverProject),
            initialRevision: Number(projectRef.current?.revision) || 0,
            flushDebounceMs: 8000,
        })
        syncRef.current = manager
        return () => {
            manager.flushNow()
            manager.destroy()
            if (syncRef.current === manager) syncRef.current = null
        }
    }, [project?._id, handleSyncStatus])

    // beforeunload + pagehide: capture the very latest state before the user
    // navigates away. The manager beacons it to Redis (surviving unload) and
    // keepalive-flushes to Neon, so edits made inside the autosave window aren't
    // lost; the IndexedDB mirror is the backstop if the beacon is dropped.
    useEffect(() => {
        const projectId = project?._id
        if (!projectId) return
        const persistNow = () => {
            // Push the CURRENT canvas into the manager FIRST — the 2s autosave
            // debounce may not have fired yet, so without this the manager's
            // `latest` (and therefore the beacon) would carry stale state and the
            // final edits would be lost. saveCanvasState() updates `latest`
            // synchronously and fires a full snapshot before the beacon reads it.
            try { saveCanvasState() } catch { /* ignore */ }
            try { syncRef.current?.beaconUnload() } catch { /* ignore */ }
        }
        // visibilitychange → hidden is the reliable save point: it fires while the
        // page is still ALIVE (so the normal full-state snapshot fetch completes,
        // sidestepping the 64KB beacon cap for large states) and, unlike
        // beforeunload, it fires on mobile/tab-switch and bfcache navigations.
        const onVisibility = () => {
            if (typeof document !== "undefined" && document.visibilityState === "hidden") persistNow()
        }
        window.addEventListener("beforeunload", persistNow)
        window.addEventListener("pagehide", persistNow)
        document.addEventListener("visibilitychange", onVisibility)
        return () => {
            window.removeEventListener("beforeunload", persistNow)
            window.removeEventListener("pagehide", persistNow)
            document.removeEventListener("visibilitychange", onVisibility)
        }
    }, [project?._id, saveCanvasState])

    useEffect(() => {
        if (!canvasRef.current || !projectRef.current) return

        const initGen = ++initGenerationRef.current
        let mounted = true

        disposeCanvasInstance()
        historyRef.current = []
        historyIndexRef.current = -1

        const initializeCanvas = async () => {
            if (initGen !== initGenerationRef.current || !mounted) return

            setIsLoading(true)
            const proj = projectRef.current
            if (!proj) return
            const { width, height } = getContainerSize()
            const el = canvasRef.current
            if (!el) return

            const canvas = new Canvas(el, {
                width: width || proj.width, height: height || proj.height,
                backgroundColor: "transparent",
                preserveObjectStacking: true, controlsAboveOverlay: true, selection: true,
                hoverCursor: "move", moveCursor: "move", defaultCursor: "default",
                allowTouchScrolling: false, renderOnAddRemove: false, skipTargetFind: false,
            })

            if (initGen !== initGenerationRef.current || !mounted) {
                canvas.dispose()
                return
            }

            canvasInstanceRef.current = canvas
            canvas.setDimensions({ width: width || proj.width, height: height || proj.height }, { backstoreOnly: false })

            // Read-through: if the server cache has a newer snapshot than what's
            // in Neon (because a previous session ended with pending debounced
            // writes that haven't been flushed yet), prefer that. Otherwise the
            // user would see an old version of their work after a reload.
            let rawCanvasState = proj.canvasState
            let effectiveCurrentImageUrl = proj.currentImageUrl
            let bestUpdatedAt = Number(proj.updatedAt) || 0
            // The revision the WINNING content is based on. Neon content → the
            // project's current revision; an unflushed Redis/IDB snapshot → the
            // revision IT was based on. The sync manager must flush against this,
            // not always the current Neon revision, or replaying older unflushed
            // content would clobber a newer concurrent write.
            let effectiveBaseRevision = Number(proj.revision) || 0
            try {
                const cachedSnapshot = await fetchCachedSnapshot(proj._id)
                if (cachedSnapshot?.canvasState) {
                    // Prefer the server-stamped time (comparable to Neon's
                    // server-set updatedAt) so a skewed client clock can't make a
                    // Redis snapshot wrongly win or lose against Neon. Older
                    // snapshots without it fall back to the client time.
                    const cachedUpdatedAt = Number(cachedSnapshot.serverUpdatedAt ?? cachedSnapshot.updatedAt) || 0
                    if (cachedUpdatedAt > bestUpdatedAt) {
                        rawCanvasState = cachedSnapshot.canvasState
                        if (cachedSnapshot.currentImageUrl) {
                            effectiveCurrentImageUrl = cachedSnapshot.currentImageUrl
                        }
                        bestUpdatedAt = cachedUpdatedAt
                        if (Number.isFinite(Number(cachedSnapshot.baseRevision))) {
                            effectiveBaseRevision = Number(cachedSnapshot.baseRevision)
                        }
                    }
                }
            } catch (cacheError) {
                console.warn("[canvas] cached snapshot lookup failed:", cacheError?.message || cacheError)
            }

            // Offline backstop: a prior session may have ended offline (or closed
            // before the unload beacon landed), leaving the freshest work only in
            // the local IndexedDB mirror. If it's newer than both Neon and Redis,
            // restore from it — the sync manager replays it to the server on
            // reconnect / next edit.
            try {
                const localState = await loadLocalState(proj._id)
                // Only let the local mirror override server state when it holds
                // UNSYNCED work (dirty). A clean local copy already reached the
                // server, so prefer the server — this stops a skewed client clock
                // from clobbering newer server state across devices.
                if (localState?.fullState && localState.dirty !== false) {
                    const localUpdatedAt = Number(localState.updatedAt) || 0
                    if (localUpdatedAt > bestUpdatedAt) {
                        rawCanvasState = localState.fullState
                        if (localState.currentImageUrl) {
                            effectiveCurrentImageUrl = localState.currentImageUrl
                        }
                        bestUpdatedAt = localUpdatedAt
                        if (Number.isFinite(Number(localState.baseRevision))) {
                            effectiveBaseRevision = Number(localState.baseRevision)
                        }
                    }
                }
            } catch (localError) {
                console.warn("[canvas] local snapshot lookup failed:", localError?.message || localError)
            }

            // Tell the sync manager which revision the loaded content is based on,
            // so its first flush is checked against the right baseline.
            try { syncRef.current?.setBaseRevision(effectiveBaseRevision) } catch { /* manager may not exist yet */ }

            const canvasState = normalizeCanvasState(rawCanvasState)
            const persistedHistory = Array.isArray(rawCanvasState?.history) ? rawCanvasState.history : null
            let hasRestoredViewport = false

            if (!canvasState && (effectiveCurrentImageUrl || proj.originalImageUrl)) {
                try {
                    const imageUrl = effectiveCurrentImageUrl || proj.originalImageUrl
                    const fabricImage = await FabricImage.fromURL(imageUrl, { crossOrigin: "anonymous" })
                    fitImageInsideProject(fabricImage, proj)
                    canvas.add(fabricImage)
                } catch (error) { console.error("Error loading project image:", error) }
            }

            if (canvasState) {
                let loadedFromState = false
                try {
                    await canvas.loadFromJSON(canvasState.canvas || canvasState)
                    // Restore the "grade background" intent so it keeps tracking after reload.
                    canvas.__pixxelGradeBackground = Boolean(canvasState.gradeBackground)
                    removeExpansionFramesFromCanvas(canvas)
                    if (canvasState.viewport) { setViewportState(canvas, canvasState.viewport, { x: proj.width / 2, y: proj.height / 2 }); hasRestoredViewport = true }
                    const imageUrl = effectiveCurrentImageUrl || proj.originalImageUrl
                    await hydrateCanvasImages(canvas, imageUrl, {
                        forcePrimaryImageUrl: true,
                        canvasSize: { width: proj.width, height: proj.height },
                    })
                    for (const obj of canvas.getObjects()) {
                        if (obj?.type?.toLowerCase() === 'image' && obj.filters?.length) {
                            try {
                                obj.applyFilters?.()
                            } catch (filterError) {
                                // Silently swallowing here once hid a real curves regression
                                // for hours. Keep going (don't break the load) but log so
                                // the next failure is diagnosable.
                                console.error('[canvas] applyFilters failed for image:', filterError)
                            }
                        }
                    }
                    canvas.requestRenderAll()
                    loadedFromState = canvas.getObjects().length > 0
                } catch (error) { console.error("Error loading canvas state: ", error) }

                // Fallback: if loadFromJSON threw or produced an empty canvas (e.g. a
                // saved filter type Fabric can no longer enliven), still show the project
                // image so the user doesn't stare at a blank canvas.
                if (!loadedFromState) {
                    const imageUrl = effectiveCurrentImageUrl || proj.originalImageUrl
                    if (imageUrl && canvas.getObjects().length === 0) {
                        try {
                            const fallbackImage = await FabricImage.fromURL(imageUrl, { crossOrigin: "anonymous" })
                            fitImageInsideProject(fallbackImage, proj)
                            canvas.add(fallbackImage)
                            canvas.requestRenderAll()
                        } catch (error) { console.error("Fallback image load failed:", error) }
                    }
                }
            }

            if (!hasRestoredViewport) createInitialViewport(canvas)
            if (initGen !== initGenerationRef.current || !mounted) {
                canvas.dispose()
                canvasInstanceRef.current = null
                return
            }

            canvas.renderOnAddRemove = true
            canvas.calcOffset()
            canvas.requestRenderAll()
            setCanvasEditor(canvas)

            const isExpansionMode = () =>
                activeToolRef.current === 'ai_extender' ||
                Boolean(canvas.__expansionMode)

            const isTypingTarget = (target) => {
                if (!target) return false
                const tag = target.tagName
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
                if (target.isContentEditable) return true
                return false
            }

            const isPanModifierActive = () =>
                spacePressedRef.current ||
                handToolActiveRef.current

            const isMiddleButtonDrag = (event) =>
                event?.button === 1 ||
                event?.buttons === 4

            const shouldStartPan = (opt) => {
                if (isExpansionMode()) return false
                const event = opt?.e
                if (isMiddleButtonDrag(event)) return true
                if (opt?.target) return false
                return isPanModifierActive()
            }

            const applyCursorForMode = () => {
                if (isExpansionMode()) {
                    canvas.skipTargetFind = false
                    canvas.defaultCursor = 'default'
                    canvas.hoverCursor = 'default'
                    canvas.moveCursor = 'default'
                    canvas.upperCanvasEl.style.cursor = 'default'
                    return
                }
                const wantsPan = isPanModifierActive()
                if (
                    canvas.__pixelToolActive ||
                    activeToolRef.current === 'mask' ||
                    activeToolRef.current === 'erase'
                ) {
                    const cursor = wantsPan ? 'grab' : 'crosshair'
                    canvas.skipTargetFind = true
                    canvas.defaultCursor = cursor
                    canvas.hoverCursor = cursor
                    canvas.moveCursor = cursor
                    canvas.upperCanvasEl.style.cursor = cursor
                    return
                }
                canvas.skipTargetFind = false
                canvas.defaultCursor = wantsPan ? 'grab' : 'default'
                canvas.hoverCursor = 'move'
                canvas.moveCursor = 'move'
                canvas.upperCanvasEl.style.cursor = wantsPan ? 'grab' : 'default'
            }

            const endPanning = () => {
                isPanningRef.current = false
                lastPointerRef.current = null
                applyCursorForMode()
            }

            const resetPanInputState = ({ resetHandTool = false } = {}) => {
                isPanningRef.current = false
                lastPointerRef.current = null
                ctrlPressedRef.current = false
                spacePressedRef.current = false
                if (resetHandTool) {
                    handToolActiveRef.current = false
                    setIsHandToolActive(false)
                }
                applyCursorForMode()
            }

            const handleKeyDown = (event) => {
                if (isExpansionMode()) return
                if (event.key === ' ' && !event.repeat && !isTypingTarget(event.target)) {
                    spacePressedRef.current = true
                    applyCursorForMode()
                    event.preventDefault()
                    return
                }
                if (event.key === 'Control' && !event.repeat) {
                    ctrlPressedRef.current = true
                }
            }
            const handleKeyUp = (event) => {
                if (event.key === ' ') {
                    spacePressedRef.current = false
                    endPanning()
                    return
                }
                if (event.key === 'Control') {
                    ctrlPressedRef.current = false
                }
            }
            const handleMouseDown = (opt) => {
                if (shouldStartPan(opt)) {
                    isPanningRef.current = true
                    lastPointerRef.current = { x: opt.e.clientX, y: opt.e.clientY }
                    // Cursor is a DOM style change (no canvas render needed). The
                    // viewport hasn't moved yet, so a render here would paint nothing
                    // new — the first mouse:move pans and renders.
                    canvas.upperCanvasEl.style.cursor = 'grabbing'
                    opt.e.preventDefault()
                    opt.e.stopPropagation()
                }
            }
            const handleMouseMove = (opt) => {
                if (isExpansionMode() || !isPanningRef.current || !lastPointerRef.current) return
                const deltaX = opt.e.clientX - lastPointerRef.current.x
                const deltaY = opt.e.clientY - lastPointerRef.current.y
                canvas.relativePan(new Point(deltaX, deltaY))
                lastPointerRef.current = { x: opt.e.clientX, y: opt.e.clientY }
                canvas.requestRenderAll()
            }
            const handleMouseUp = () => {
                if (isExpansionMode()) return
                endPanning()
            }
            canvas.__setHandToolActive = (active) => {
                handToolActiveRef.current = Boolean(active)
                applyCursorForMode()
            }
            canvas.__syncPanCursor = applyCursorForMode
            const handleMouseWheel = (opt) => {
                if (isExpansionMode()) return
                if (!(opt.e.ctrlKey || ctrlPressedRef.current)) return
                opt.e.preventDefault()
                const zoom = clamp(canvas.getZoom() * Math.pow(0.999, opt.e.deltaY), MIN_ZOOM, MAX_ZOOM)
                const pointer = canvas.getViewportPoint(opt.e)
                canvas.zoomToPoint(new Point(pointer.x, pointer.y), zoom)
                canvas.requestRenderAll()
            }
            const handleWindowPointerUp = () => endPanning()
            const handleWindowBlur = () => resetPanInputState({ resetHandTool: true })
            const handleVisibilityChange = () => {
                if (document.visibilityState === 'hidden') {
                    resetPanInputState({ resetHandTool: true })
                }
            }

            window.addEventListener('keydown', handleKeyDown)
            window.addEventListener('keyup', handleKeyUp)
            window.addEventListener('pointerup', handleWindowPointerUp)
            window.addEventListener('blur', handleWindowBlur)
            document.addEventListener('visibilitychange', handleVisibilityChange)
            canvas.on('mouse:down', handleMouseDown)
            canvas.on('mouse:move', handleMouseMove)
            canvas.on('mouse:up', handleMouseUp)
            canvas.on('mouse:wheel', handleMouseWheel)

            canvas.__cleanupInfiniteWorkspace = () => {
                window.removeEventListener('keydown', handleKeyDown)
                window.removeEventListener('keyup', handleKeyUp)
                window.removeEventListener('pointerup', handleWindowPointerUp)
                window.removeEventListener('blur', handleWindowBlur)
                document.removeEventListener('visibilitychange', handleVisibilityChange)
                canvas.off('mouse:down', handleMouseDown)
                canvas.off('mouse:move', handleMouseMove)
                canvas.off('mouse:up', handleMouseUp)
                canvas.off('mouse:wheel', handleMouseWheel)
                canvas.off('after:render', syncViewportChrome)
                delete canvas.__syncPanCursor
            }
            canvas.__undoCanvasState = () => undoCanvasState()
            canvas.__redoCanvasState = () => redoCanvasState()
            canvas.__pushHistoryState = () => pushHistoryState(canvas)
            canvas.__saveCanvasState = (opts) => saveCanvasState(opts)
            canvas.__getHistoryState = () => ({
                canUndo: historyIndexRef.current > 0,
                canRedo: historyIndexRef.current < historyRef.current.length - 1,
            })
            canvas.__fitCanvasToProject = (size) => {
                fitProjectToViewport(canvas, size)
                canvas.calcOffset()
                canvas.requestRenderAll()
                syncProjectFrame()
                syncPreviewZoomState(canvas)
            }
            canvas.__resetCanvasView = () => {
                fitProjectToViewport(canvas)
                canvas.calcOffset()
                canvas.requestRenderAll()
                syncProjectFrame()
                syncPreviewZoomState(canvas)
            }
            canvas.__setPreviewZoom = (percent) => setCanvasPreviewZoom(canvas, percent)
            canvas.__getPreviewZoom = () => readPreviewZoomPercent(canvas)

            const syncProjectFrame = () => {
                const proj = projectRef.current
                if (!proj?.width || !proj?.height) {
                    if (projectFrameStyleRef.current.width !== 0) {
                        projectFrameStyleRef.current = { left: 0, top: 0, width: 0, height: 0 }
                        setProjectFrameStyle(projectFrameStyleRef.current)
                        setIsProjectFrameVisible(false)
                    }
                    return
                }
                const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
                const zoom = vpt[0] || 1
                const left = vpt[4]
                const top = vpt[5]
                const width = proj.width * zoom
                const height = proj.height * zoom
                const previous = projectFrameStyleRef.current
                if (
                    previous.left === left &&
                    previous.top === top &&
                    previous.width === width &&
                    previous.height === height
                ) return
                projectFrameStyleRef.current = { left, top, width, height }
                setProjectFrameStyle(projectFrameStyleRef.current)
                setIsProjectFrameVisible(true)
            }
            canvas.__syncProjectFrame = syncProjectFrame
            const syncViewportChrome = () => {
                syncProjectFrame()
                syncPreviewZoomState(canvas)
            }
            canvas.on('after:render', syncViewportChrome)
            syncViewportChrome()

            if (persistedHistory?.length) {
                historyRef.current = persistedHistory.slice(-MAX_PERSISTED_HISTORY)
                historyIndexRef.current = Math.min(
                    Math.max(0, rawCanvasState.historyIndex ?? historyRef.current.length - 1),
                    historyRef.current.length - 1
                )
            } else {
                pushHistoryState(canvas)
            }
            emitHistoryChange(canvas)
            setIsLoading(false)
        }

        initializeCanvas()
        return () => {
            mounted = false
            initGenerationRef.current += 1
            disposeCanvasInstance()
        }
    }, [
        project?._id,
        createInitialViewport,
        disposeCanvasInstance,
        fitProjectToViewport,
        pushHistoryState,
        redoCanvasState,
        saveCanvasState,
        setCanvasEditor,
        setCanvasPreviewZoom,
        setViewportState,
        syncPreviewZoomState,
        undoCanvasState,
    ])

    useEffect(() => {
        const canvas = canvasInstanceRef.current
        if (!canvas) return
        canvas.__undoCanvasState = () => undoCanvasState()
        canvas.__redoCanvasState = () => redoCanvasState()
        canvas.__pushHistoryState = () => pushHistoryState(canvas)
        canvas.__saveCanvasState = () => saveCanvasState()
        canvas.__getHistoryState = () => ({
            canUndo: historyIndexRef.current > 0,
            canRedo: historyIndexRef.current < historyRef.current.length - 1,
        })
    }, [canvasEditor, undoCanvasState, redoCanvasState, pushHistoryState, saveCanvasState])

    // ─── Megashader filter wiring ────────────────────────────────────────────
    // The megashader is a stateful pipeline shared via the window event bus
    // (see useMaskLayers in /hooks). Whenever the mask layer stack changes,
    // we find the primary Fabric image on the canvas and install/update the
    // MegashaderFilter. The filter itself is a 2D passthrough that delegates
    // to a private WebGL2 context (see src/lib/megashader/), so installing it
    // doesn't disturb Fabric's filter chain for the curves/grade filters.
    //
    // BOTH refs are component-level so they survive `useEffect` re-runs
    // (which happen when `canvasEditor` changes). Pre-fix, the
    // `getLastAppliedStackRef` was a plain object declared INSIDE the
    // effect, so each re-run created a fresh one starting at `{ chain: [] }`
    // — the first `handleGlobalAlpha` after a re-run would re-apply with
    // an empty stack and silently drop the megashader. The component-level
    // `useRef` keeps the value stable across the effect's re-mounts.
    //
    // Step 10.2 — `recompileTimerRef` is a component-level `useRef`
    // holding the debounce timer for `handleLayersChanged`. Without
    // this, dragging a slider (e.g. per-layer exposure) fires
    // `pixxel:mask-layers-changed` on every step; the GLSL compiler
    // (50-200 ms for a complex chain) re-runs for every step, blocking
    // the main thread. The 150 ms debounce coalesces a rapid burst
    // into one recompile after the user pauses.
    const megashaderAlphaRef = useRef(1)
    // "Show mask" overlay + global invert — chain-wide render options driven
    // by the Mask tool via window events; mirror globalAlpha's ref pattern.
    const megashaderOverlayRef = useRef(false)
    const megashaderInvertRef = useRef(false)
    const getLastAppliedStackRef = useRef(/** @type {import('@/lib/megashader/mask-types').MaskStack} */ ({ chain: [] }))
    const recompileTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null))
    useEffect(() => {
        if (typeof window === 'undefined') return undefined

        const findPrimaryImage = () => {
            const canvas = canvasInstanceRef.current
            if (!canvas) return null
            const objects = canvas.getObjects?.() || []
            return objects.find(
                (obj) => obj?.type?.toLowerCase?.() === 'image' && !isPixxelMaskOverlay(obj)
            ) || null
        }

        // The actual recompile — factored out so the debounced wrapper
        // and `handleGlobalAlpha` both call the same code path.
        const doApply = (stack) => {
            const image = findPrimaryImage()
            if (!image) return
            // Lazy-load the megashader module so the production editor bundle
            // never pulls in the GLSL compiler unless the dev test panel
            // (or a Step 2+ tool) actually subscribes.
            import('@/lib/megashader').then((mod) => {
                mod.applyMegashaderFilter(image, stack, {
                    globalMaskAlpha: megashaderAlphaRef.current,
                    globalInvert: megashaderInvertRef.current,
                    maskOverlay: megashaderOverlayRef.current,
                })
                canvasInstanceRef.current?.requestRenderAll?.()
            }).catch(() => { /* noop — module not available in non-test paths */ })
        }

        // Step 10.2: debounced entry point. Cancels any pending
        // recompile and schedules a new one 150 ms out. The 150 ms
        // window is short enough to feel instant on slider release
        // but long enough to coalesce a fast slider drag into a
        // single recompile.
        const RECOMPILE_DEBOUNCE_MS = 150
        const handleLayersChanged = (event) => {
            const stack = event?.detail?.stack
            if (recompileTimerRef.current !== null) {
                clearTimeout(recompileTimerRef.current)
            }
            recompileTimerRef.current = setTimeout(() => {
                recompileTimerRef.current = null
                doApply(stack)
            }, RECOMPILE_DEBOUNCE_MS)
        }

        const handleGlobalAlpha = (event) => {
            const value = event?.detail?.value
            if (typeof value !== 'number') return
            megashaderAlphaRef.current = Math.max(0, Math.min(1, value))
            // Alpha is a uniform, not a shader-struct change — skip
            // the debounce so the slider feels live. The shader
            // recompile is gated on the LRU cache, so if the program
            // was already compiled for this exact stack, the second
            // call is just a `applyFilters` re-run.
            doApply(getLastAppliedStackRef.current)
        }

        // "Show mask" overlay + global invert — chain-wide render options.
        // Like alpha, they're uniforms (no recompile), so re-apply live
        // against the last-applied stack.
        const handleOverlay = (event) => {
            megashaderOverlayRef.current = Boolean(event?.detail?.value)
            doApply(getLastAppliedStackRef.current)
        }
        const handleInvert = (event) => {
            megashaderInvertRef.current = Boolean(event?.detail?.value)
            doApply(getLastAppliedStackRef.current)
        }

        const wrapped = (event) => {
            getLastAppliedStackRef.current = event?.detail?.stack || { chain: [] }
            handleLayersChanged(event)
        }

        window.addEventListener('pixxel:mask-layers-changed', wrapped)
        window.addEventListener('pixxel:mask-global-alpha', handleGlobalAlpha)
        window.addEventListener('pixxel:mask-overlay', handleOverlay)
        window.addEventListener('pixxel:mask-invert', handleInvert)

        return () => {
            window.removeEventListener('pixxel:mask-layers-changed', wrapped)
            window.removeEventListener('pixxel:mask-global-alpha', handleGlobalAlpha)
            window.removeEventListener('pixxel:mask-overlay', handleOverlay)
            window.removeEventListener('pixxel:mask-invert', handleInvert)
            // Step 10.2: clear any pending debounced recompile so a
            // canvasEditor change mid-debounce doesn't fire a stale
            // apply against a torn-down renderer.
            if (recompileTimerRef.current !== null) {
                clearTimeout(recompileTimerRef.current)
                recompileTimerRef.current = null
            }
        }
    }, [canvasEditor])

    // Register the UI-decoupled mask command surface so the in-app agent can
    // drive masking headlessly (NOT wired to any agent yet — see
    // src/lib/agent/). Resolves the active primary image from the live canvas
    // on each call so commands always target the current image.
    useEffect(() => {
        let unregister = () => {}
        let cancelled = false
        Promise.all([
            import('@/lib/agent/command-registry'),
            import('@/lib/agent/mask-commands'),
        ]).then(([reg, mask]) => {
            if (cancelled) return
            const getPrimaryImage = () => {
                const canvas = canvasInstanceRef.current
                if (!canvas) return null
                const objects = canvas.getObjects?.() || []
                return objects.find(
                    (obj) => obj?.type?.toLowerCase?.() === 'image' && !isPixxelMaskOverlay(obj)
                ) || null
            }
            unregister = reg.registerDomain('mask', mask.createMaskCommands({ getPrimaryImage }))
        }).catch(() => { /* agent layer optional */ })
        return () => { cancelled = true; unregister() }
    }, [])

    // Track the last-hydrated URL so we skip redundant re-hydrations when
    // the parent re-renders (e.g. during sidebar resize) without the image
    // URL actually changing. This prevents the "image refreshing" flicker.
    const lastHydratedUrlRef = useRef(null)

    useEffect(() => {
        const canvas = canvasInstanceRef.current
        const imageUrl = project?.currentImageUrl || project?.originalImageUrl
        if (!canvas || !imageUrl) return

        // Guard: skip if we've already hydrated this exact URL
        if (lastHydratedUrlRef.current === imageUrl) return
        lastHydratedUrlRef.current = imageUrl

        let cancelled = false
        hydrateCanvasImages(canvas, imageUrl, {
            forcePrimaryImageUrl: true,
            canvasSize: { width: project.width, height: project.height },
        }).then(() => {
            if (!cancelled) canvas.requestRenderAll()
        })

        return () => {
            cancelled = true
        }
    }, [canvasEditor, project?.currentImageUrl, project?.originalImageUrl, project?.width, project?.height])

    useEffect(() => {
        const canvas = canvasInstanceRef.current
        if (!canvas?.upperCanvasEl) return

        if (activeTool === 'ai_extender') {
            isPanningRef.current = false
            ctrlPressedRef.current = false
            spacePressedRef.current = false
            handToolActiveRef.current = false
            setIsHandToolActive(false)
            lastPointerRef.current = null
            canvas.__expansionMode = true
            canvas.skipTargetFind = false
            canvas.defaultCursor = 'default'
            canvas.hoverCursor = 'default'
            canvas.moveCursor = 'default'
            if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = 'default'
        } else if (canvas.__expansionMode) {
            canvas.__expansionMode = false
            canvas.__syncPanCursor?.()
        }

        // Drawing mode management (handled in draw.jsx useEffect, but ensure cleanup here)
        if (activeTool !== 'draw' && canvas.isDrawingMode) {
            canvas.isDrawingMode = false
        }
        // Mask/Erase manage their own crosshair + skipTargetFind via
        // usePixelMaskTool's canvas lock; don't stomp it here or the brush cursor
        // flickers back to the move cursor on tool entry.
        if (
            activeTool !== 'draw' &&
            activeTool !== 'ai_extender' &&
            activeTool !== 'mask' &&
            activeTool !== 'erase'
        ) {
            canvas.skipTargetFind = false
            canvas.hoverCursor = 'move'
            canvas.moveCursor = 'move'
            canvas.__syncPanCursor?.()
        }
    }, [activeTool, canvasEditor])

    useEffect(() => {
        if (!canvasEditor) return
        const readPrimaryImageSize = () => {
            const objects = canvasEditor.getObjects?.() || []
            const image = objects.find((obj) => obj?.type?.toLowerCase() === 'image')
            if (!image) {
                setImageNativeSize(null)
                return
            }
            const w = Math.round(image._originalElement?.naturalWidth || image.width || 0)
            const h = Math.round(image._originalElement?.naturalHeight || image.height || 0)
            if (!w || !h) {
                setImageNativeSize(null)
                return
            }
            setImageNativeSize((prev) => (prev?.width === w && prev?.height === h ? prev : { width: w, height: h }))
        }
        readPrimaryImageSize()
        canvasEditor.on('object:added', readPrimaryImageSize)
        canvasEditor.on('object:removed', readPrimaryImageSize)
        canvasEditor.on('object:modified', readPrimaryImageSize)
        return () => {
            canvasEditor.off('object:added', readPrimaryImageSize)
            canvasEditor.off('object:removed', readPrimaryImageSize)
            canvasEditor.off('object:modified', readPrimaryImageSize)
        }
    }, [canvasEditor])

    const toggleHandTool = useCallback(() => {
        const canvas = canvasInstanceRef.current
        // Disabled while painting (Mask/Erase) or expanding — the hand tool would
        // pan-drag while the brush is also painting. Hold Space to pan instead.
        if (
            !canvas ||
            activeToolRef.current === 'ai_extender' ||
            activeToolRef.current === 'mask' ||
            activeToolRef.current === 'erase'
        ) return
        const next = !handToolActiveRef.current
        canvas.__setHandToolActive?.(next)
        setIsHandToolActive(next)
    }, [])

    useEffect(() => {
        const handleHandHotkey = (event) => {
            if (event.repeat) return
            if (event.key !== 'h' && event.key !== 'H') return
            const target = event.target
            if (
                target &&
                (target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.tagName === 'SELECT' ||
                    target.isContentEditable)
            ) return
            if (event.metaKey || event.ctrlKey || event.altKey) return
            event.preventDefault()
            toggleHandTool()
        }
        window.addEventListener('keydown', handleHandHotkey)
        return () => window.removeEventListener('keydown', handleHandHotkey)
    }, [toggleHandTool])

    // ─── Image drag-and-drop onto canvas ───
    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const handleDragOver = (e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
        }

        const handleDrop = async (e) => {
            e.preventDefault()
            const canvas = canvasInstanceRef.current
            if (!canvas) return

            const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'))
            if (files.length === 0) return

            // Use a ref so this handler always sees the latest project, even if the
            // effect isn't re-bound (e.g. switching projects with same dimensions).
            await addImageFilesToCanvas(canvas, files, projectRef.current)
        }

        container.addEventListener('dragover', handleDragOver)
        container.addEventListener('drop', handleDrop)
        return () => {
            container.removeEventListener('dragover', handleDragOver)
            container.removeEventListener('drop', handleDrop)
        }
    }, [canvasEditor, project?.width, project?.height])

    useEffect(() => {
        if (!canvasEditor) return
        let saveTimeout
        let historyTimeout

        const scheduleHistoryPush = () => {
            clearTimeout(historyTimeout)
            historyTimeout = setTimeout(() => pushHistoryState(canvasEditor), 0)
        }

        const handleCanvasChange = (event) => {
            // Guard: when restoring from undo/redo, canvas events fire (object:added,
            // object:modified, etc.) but they must NOT push a new history entry —
            // otherwise the redo stack is truncated immediately after an undo.
            if (isRestoringRef.current) return
            if (isExpansionFrameLike(event?.target)) return
            if (isPixxelMaskOverlay(event?.target)) return
            // When "color grade background" is on, mirror the photo's grade onto the
            // canvas background. Gated to image edits (skip text/shape moves) and to
            // when a background actually exists; change-detected inside.
            if (
                canvasEditor.__pixxelGradeBackground &&
                canvasEditor.backgroundImage &&
                event?.target?.type?.toLowerCase?.() === 'image'
            ) {
                try { syncBackgroundGrade(canvasEditor, true, event.target) } catch { /* ignore */ }
            }
            scheduleHistoryPush()
            clearTimeout(saveTimeout)
            saveTimeout = setTimeout(() => { saveCanvasState() }, 2000)
        }

        canvasEditor.on("object:modified", handleCanvasChange)
        canvasEditor.on("object:added", handleCanvasChange)
        canvasEditor.on("object:removed", handleCanvasChange)
        canvasEditor.on("text:changed", handleCanvasChange)

        return () => {
            clearTimeout(saveTimeout)
            clearTimeout(historyTimeout)
            canvasEditor.off("object:modified", handleCanvasChange)
            canvasEditor.off("object:added", handleCanvasChange)
            canvasEditor.off("object:removed", handleCanvasChange)
            canvasEditor.off("text:changed", handleCanvasChange)
        }
    }, [canvasEditor, project?._id, pushHistoryState, saveCanvasState])

    useEffect(() => {
        const handleResize = () => {
            if (resizeFrameRef.current) cancelAnimationFrame(resizeFrameRef.current)
            resizeFrameRef.current = requestAnimationFrame(() => {
                resizeFrameRef.current = null
                const canvas = canvasInstanceRef.current
                const proj = projectRef.current
                if (!canvas || !proj || !containerRef.current) return

                const prevWidth = canvas.getWidth()
                const prevHeight = canvas.getHeight()
                const nextWidth = containerRef.current.clientWidth
                const nextHeight = containerRef.current.clientHeight
                if (!nextWidth || !nextHeight) return

                if (prevWidth === nextWidth && prevHeight === nextHeight) {
                    canvas.calcOffset()
                    return
                }

                // Capture the current viewport state BEFORE resizing the canvas
                // element so we can preserve the user's pan position and scale
                // the zoom proportionally to the container size change. This
                // avoids the jarring snap-to-fit that __fitCanvasToProject does.
                const currentViewport = getViewportState(canvas)
                const scaleRatio = Math.min(
                    nextWidth / (prevWidth || 1),
                    nextHeight / (prevHeight || 1),
                )

                canvas.setDimensions({ width: nextWidth, height: nextHeight }, { backstoreOnly: false })

                // Scale zoom proportionally but keep the same logical center
                // point. The effect is a smooth proportional resize rather than
                // a full recomputation from project dimensions.
                const adjustedZoom = clamp(
                    currentViewport.zoom * scaleRatio,
                    MIN_ZOOM,
                    MAX_ZOOM,
                )
                setViewportState(canvas, {
                    zoom: adjustedZoom,
                    center: currentViewport.center,
                })
                canvas.calcOffset()
                canvas.requestRenderAll()

                // Sync the project frame overlay and the zoom percentage HUD
                if (typeof canvas.__syncProjectFrame === 'function') {
                    canvas.__syncProjectFrame()
                }
                syncPreviewZoomState(canvas)
            })
        }

        const resizeObserver = typeof ResizeObserver !== "undefined" && containerRef.current
            ? new ResizeObserver(handleResize)
            : null

        resizeObserver?.observe(containerRef.current)
        window.addEventListener("resize", handleResize)
        handleResize()
        return () => {
            resizeObserver?.disconnect()
            window.removeEventListener("resize", handleResize)
            if (resizeFrameRef.current) cancelAnimationFrame(resizeFrameRef.current)
            resizeFrameRef.current = null
        }
    }, [getViewportState, project?._id, setViewportState, syncPreviewZoomState])

    useEffect(() => {
        const canvas = canvasInstanceRef.current
        const proj = projectRef.current
        if (!canvas || !proj?.width || !proj?.height) return
        fitProjectToViewport(canvas, proj)
        canvas.calcOffset()
        canvas.requestRenderAll()
    }, [fitProjectToViewport, project?._id, project?.width, project?.height])

    const previewSliderValue = clamp(previewZoomPercent, MIN_PREVIEW_ZOOM_PERCENT, MAX_PREVIEW_ZOOM_PERCENT)
    const canAdjustPreview = Boolean(canvasEditor)

    const applyPreviewZoomPercent = (percent) => {
        const nextPercent = clamp(Number(percent) || 100, MIN_PREVIEW_ZOOM_PERCENT, MAX_PREVIEW_ZOOM_PERCENT)
        setCanvasPreviewZoom(canvasInstanceRef.current, nextPercent)
    }

    const adjustPreviewZoomPercent = (delta) => {
        applyPreviewZoomPercent(previewZoomPercentRef.current + delta)
    }

    const handlePreviewZoomChange = (event) => {
        applyPreviewZoomPercent(event.target.value)
    }

    const stopPreviewControlPropagation = (event) => {
        event.stopPropagation()
    }

    return (
        <div ref={containerRef} className='relative h-full min-h-0 w-full overflow-hidden editor-canvas-host'>
            {/* Dot grid */}
            <div className='absolute inset-0 pointer-events-none editor-canvas-grid' />

            {isProjectFrameVisible && !isBusy && (
                <div
                    className="editor-canvas-project-texture pointer-events-none absolute"
                    style={{
                        left: `${projectFrameStyle.left}px`,
                        top: `${projectFrameStyle.top}px`,
                        width: `${projectFrameStyle.width}px`,
                        height: `${projectFrameStyle.height}px`,
                    }}
                />
            )}

            <div className='absolute inset-0 editor-canvas-fabric-layer'>
                <canvas id='canvas' className='rounded-xl editor-canvas-surface' ref={canvasRef} />
            </div>

            {!isBusy && (
                <button
                    type="button"
                    onClick={toggleHandTool}
                    className="editor-icon-button absolute z-10 flex items-center justify-center"
                    style={{
                        bottom: 16,
                        right: 16,
                        width: 36,
                        height: 36,
                        background: isHandToolActive ? 'var(--accent-primary)' : 'var(--bg-elevated)',
                        color: isHandToolActive ? '#03050A' : 'var(--text-primary)',
                        borderColor: isHandToolActive ? 'var(--accent-primary)' : 'var(--border-default)',
                    }}
                    title={isHandToolActive ? 'Hand tool on — click to exit (H or Space)' : 'Hand tool — pan the canvas (H or hold Space)'}
                    aria-pressed={isHandToolActive}
                >
                    <Hand className="h-4 w-4" />
                </button>
            )}

            {isProjectFrameVisible && !isBusy && (
                <div
                    className="editor-canvas-project-frame pointer-events-none absolute"
                    style={{
                        left: `${projectFrameStyle.left}px`,
                        top: `${projectFrameStyle.top}px`,
                        width: `${projectFrameStyle.width}px`,
                        height: `${projectFrameStyle.height}px`,
                    }}
                />
            )}

            <div
                className="editor-canvas-preview-controls"
                aria-label="Preview size"
                onPointerDown={stopPreviewControlPropagation}
                onMouseDown={stopPreviewControlPropagation}
                hidden={isBusy}
                style={isBusy ? { display: 'none' } : undefined}
            >
                <button
                    type="button"
                    className="editor-canvas-preview-button"
                    onClick={() => adjustPreviewZoomPercent(-PREVIEW_ZOOM_STEP_PERCENT)}
                    disabled={!canAdjustPreview}
                    title="Shrink preview"
                    aria-label="Shrink preview"
                >
                    <ZoomOut className="h-3.5 w-3.5" />
                </button>
                <input
                    className="editor-canvas-preview-slider"
                    type="range"
                    min={MIN_PREVIEW_ZOOM_PERCENT}
                    max={MAX_PREVIEW_ZOOM_PERCENT}
                    step="1"
                    value={previewSliderValue}
                    onChange={handlePreviewZoomChange}
                    disabled={!canAdjustPreview}
                    aria-label="Preview size"
                />
                <button
                    type="button"
                    className="editor-canvas-preview-button"
                    onClick={() => adjustPreviewZoomPercent(PREVIEW_ZOOM_STEP_PERCENT)}
                    disabled={!canAdjustPreview}
                    title="Enlarge preview"
                    aria-label="Enlarge preview"
                >
                    <ZoomIn className="h-3.5 w-3.5" />
                </button>
                <button
                    type="button"
                    className="editor-canvas-preview-button"
                    onClick={() => canvasInstanceRef.current?.__resetCanvasView?.()}
                    disabled={!canAdjustPreview}
                    title="Fit preview"
                    aria-label="Fit preview"
                >
                    <Maximize2 className="h-3.5 w-3.5" />
                </button>
                <output className="editor-canvas-preview-percent" aria-live="polite">
                    {previewZoomPercent}%
                </output>
            </div>

            {!isBusy && project?.width && project?.height && (
                <div className="editor-canvas-resolution-hud">
                    <span>{imageNativeSize ? "Image Resolution" : "Document"}</span>
                    <strong>
                        {activeTool === "ai_extender" && expansionPreview?.targetWidth
                            ? `${expansionPreview.targetWidth} × ${expansionPreview.targetHeight} px`
                            : imageNativeSize
                                ? `${imageNativeSize.width} × ${imageNativeSize.height} px`
                                : `${project.width} × ${project.height} px`}
                    </strong>
                </div>
            )}

            {(syncStatus === "offline" || syncStatus === "error" || syncStatus === "saving" || syncStatus === "conflict") && (
                <div
                    className="absolute left-1/2 z-30 flex items-center gap-2"
                    style={{
                        top: 12,
                        transform: "translateX(-50%)",
                        pointerEvents: "none",
                        padding: "5px 12px",
                        background: "var(--bg-elevated, #0a0d14)",
                        border: "2px solid",
                        borderColor:
                            syncStatus === "offline" ? "var(--accent-amber, #f5b945)"
                                : (syncStatus === "error" || syncStatus === "conflict") ? "var(--accent-coral, #ff6b5e)"
                                    : "var(--accent-primary, #38e0c8)",
                        boxShadow: "3px 3px 0 0 rgba(0,0,0,0.55)",
                        borderRadius: 6,
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        color: "var(--text-primary, #f5f7fa)",
                        whiteSpace: "nowrap",
                    }}
                    role="status"
                    aria-live="polite"
                >
                    <span
                        style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background:
                                syncStatus === "offline" ? "var(--accent-amber, #f5b945)"
                                    : (syncStatus === "error" || syncStatus === "conflict") ? "var(--accent-coral, #ff6b5e)"
                                        : "var(--accent-primary, #38e0c8)",
                        }}
                    />
                    {syncStatus === "offline"
                        ? "Offline · saved locally"
                        : syncStatus === "conflict"
                            ? "Edited elsewhere"
                            : syncStatus === "error"
                                ? "Sync retrying…"
                                : "Syncing…"}
                </div>
            )}

            {isLoading && (
                <div className='neo-loader-surface absolute inset-0 z-40 flex items-center justify-center'>
                    <AuroraLoader message="Loading canvas" />
                </div>
            )}
        </div>
    )
}

export default React.memo(CanvasEditor)
