"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import { useCanvas } from "../../../../../../context/context"
import { useDatabaseMutation } from "../../../../../../hooks/useDatabaseQuery"
import { api } from "@/lib/neon-api";
import { Hand, Maximize2, ZoomIn, ZoomOut, ArrowLeftRight } from "lucide-react"
import { Canvas, InteractiveFabricObject, Point, config as fabricConfig } from "fabric"
import { bindDoodlesToImage, followDoodles } from "@/lib/canvas-doodle-bind"
// PhosmithCurves/Megashader registered before loadFromJSON only when the saved state
// names them, else warmed after paint — see lib/canvas-filter-registry.js.
import { ensureCanvasFilters, stateNeedsCanvasFilters } from "@/lib/canvas-filter-registry"
// Empty collage slots must rehydrate as their own class.
import "@/lib/collage/slot"

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
import { registerExtendHost } from "../../../../../lib/extend-poller"
import { isAgentActing, recordChange, setJournalProject } from "../../../../../lib/change-journal"
import { removeExpansionFramesFromCanvas } from "../../../../../lib/expansion-pipeline"
import { fabricImageFromUrl } from "../../../../../lib/canvas-images"
import { canvasContentHash, recordSavedContent } from "../../../../../lib/canvas-content-hash"
import {
    fetchCachedSnapshot,
    flushToNeon,
    snapshotToCache,
} from "../../../../../lib/canvas-cache"
import { createCanvasSync, loadLocalState } from "../../../../../lib/canvas-sync"
import { createPresenceChannel } from "../../../../../lib/canvas-presence"
import { toast } from "sonner"
import { INTENTIONALLY_EMPTY, canvasObjectCount, isAccidentalEmpty } from "@/lib/canvas-state-guard"
import AuroraLoader from "./AuroraLoader"
import { FLUSH_DEBOUNCE_MS, MAX_NEON_STATE_CHARS, MAX_PERSISTED_HISTORY, MIN_PERSISTED_HISTORY_ENTRIES, MIN_SNAPSHOT_INTERVAL_MS, getPrimaryRemoteImageUrl } from "./canvas-editor/persistence"
import { MAX_PREVIEW_ZOOM_PERCENT, MAX_ZOOM, MIN_PREVIEW_ZOOM_PERCENT, MIN_ZOOM, VIEWPORT_PADDING, clamp, fitImageInsideProject, nextPreviewZoomStop, readPreviewZoomPercent } from "./canvas-editor/viewport"
import { useCanvasConflicts } from "./canvas-editor/use-canvas-conflicts"
import { useMegashaderPreview } from "./canvas-editor/use-megashader-preview"
import { usePanZoomInput } from "./canvas-editor/use-pan-zoom-input"
import { useHandTool } from "./canvas-editor/use-hand-tool"
import { useHistoryAutosave } from "./canvas-editor/use-history-autosave"
import { useContainerRefit } from "./canvas-editor/use-container-refit"
import { useCompare } from "./canvas-editor/use-compare"

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
    // The three overlays that track the project rect. Their geometry goes straight
    // to the DOM rather than through state: it changes on every frame of a pan,
    // zoom or resize drag, and a setState there re-renders this whole component
    // (2500 lines of JSX) per frame.
    const frameTextureRef = useRef(null)
    const frameOutlineRef = useRef(null)
    const compareOverlayRef = useRef(null)
    const isProjectFrameVisibleRef = useRef(false)
    // True for the duration of a resize gesture, so the chrome that only a human
    // reads (the zoom HUD) catches up once, at the end, instead of every step.
    const isResizingRef = useRef(false)
    const resizeSettleRef = useRef(null)
    // Before/After compare: a per-tool "session baseline" — the flattened image
    // captured when the current tool was opened. Held-down Compare overlays it on
    // the live canvas so the user sees before (baseline) vs after (current edits).
    const [compareBaselineUrl, setCompareBaselineUrl] = useState(null)
    const [isComparing, setIsComparing] = useState(false)
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
    const { mutate: createProjectMut } = useDatabaseMutation(api.projects.create)

    const disposeCanvasInstance = useCallback(() => {
        const existing = canvasInstanceRef.current
        if (existing) {
            existing.__cleanupInfiniteWorkspace?.()
            try {
                existing.dispose()
            } catch {
                /* already disposed */
            }
            // After dispose(), Fabric's internal canvas context is null.
            // Stale references held by in-flight RAF callbacks, debounced saves,
            // or React state that hasn't caught up yet will still call
            // requestRenderAll / renderAll and crash inside Fabric with
            // "t.clearRect" (t = null context). Replace them with no-ops so any
            // caller that fires after dispose silently does nothing.
            try {
                const noop = () => {}
                existing.requestRenderAll = noop
                existing.renderAll = noop
                existing.renderAndReset = noop
            } catch { /* ignore — already dead */ }
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
        // A resize re-fits the project, so the percentage changes on nearly every
        // step. The ref stays current; the render waits for the gesture to settle.
        if (isResizingRef.current) return
        setPreviewZoomPercent(nextPercent)
    }, [])

    /** Write the project rect onto whichever overlays are mounted. */
    const applyProjectFrameStyle = useCallback(() => {
        const { left, top, width, height } = projectFrameStyleRef.current
        for (const node of [frameTextureRef.current, frameOutlineRef.current, compareOverlayRef.current]) {
            if (!node) continue
            node.style.left = `${left}px`
            node.style.top = `${top}px`
            node.style.width = `${width}px`
            node.style.height = `${height}px`
        }
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

        // Use 85% of canvas area as the safe zone, ensuring visible breathing
        // room on all four sides. Math.min ensures BOTH the percentage margin
        // AND the fixed padding are respected (the tighter constraint wins).
        const safeW = Math.min(canvasW * 0.85, canvasW - VIEWPORT_PADDING * 2)
        const safeH = Math.min(canvasH * 0.85, canvasH - VIEWPORT_PADDING * 2)
        if (safeW <= 0 || safeH <= 0) return
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

    const pushHistoryState = useCallback((canvas, meta) => {
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
        // Journal AFTER the dedup check, so no-op pushes never log. While an
        // agent command runs, runCommand already records the SPECIFIC command
        // — skip the generic entry to avoid double-logging the same change.
        // meta.silent pushes the undo state WITHOUT a journal entry (used by
        // the initial rehydration push, which isn't a user change).
        if (!isAgentActing() && !meta?.silent) {
            recordChange({
                label: meta?.label || 'Canvas edit',
                detail: meta?.detail,
                source: 'user',
                domain: meta?.domain || 'canvas',
                coalesceKey: meta?.coalesceKey,
            })
        }
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
        recordChange({ label: 'Undo', domain: 'history' })
        return true
    }, [restoreCanvasState])

    const redoCanvasState = useCallback(async () => {
        const canvas = canvasInstanceRef.current
        if (!canvas || historyIndexRef.current >= historyRef.current.length - 1) return false
        historyIndexRef.current += 1
        await restoreCanvasState(canvas, historyRef.current[historyIndexRef.current])
        recordChange({ label: 'Redo', domain: 'history' })
        return true
    }, [restoreCanvasState])

    // Canvas sync manager, lazily created per project (see the useEffect below
    // that recreates it when projectId changes). It owns the write-behind path:
    // dedup, single-flight, the durable IndexedDB mirror, reconnect replay, and
    // the unload beacon. We never let two managers exist for the same project.
    const syncRef = useRef(null)
    // Content the editor loaded from, to recognise our own write racing a reload.
    const loadedContentHashRef = useRef(null)
    const rebasedRevisionRef = useRef(null)
    const scheduleSaveRef = useRef(null)
    // Stable indirection to the latest direct-Neon writer so the sync manager
    // (created once per project) always calls the current updateProject mutation.
    const directWriteRef = useRef(async () => {})
    // False until the project's saved state has finished loading. A flush that
    // runs in that window (pagehide, visibilitychange, a fast navigation away)
    // would otherwise persist the still-empty canvas over the real one.
    const hydratedRef = useRef(false)
    // Whether this session has seen the canvas hold objects. An empty save is
    // only marked deliberate when it has — see lib/canvas-state-guard.js.
    const everHadObjectsRef = useRef(false)
    const wasOfflineRef = useRef(false)
    // 'idle' | 'saving' | 'saved' | 'offline' | 'error' | 'conflict' | 'paused' — drives the status pill.
    const [syncStatus, setSyncStatus] = useState("idle")

    // Surface sync-manager status: update the pill and toast on offline/online
    // transitions (deduped via wasOfflineRef so we don't spam).
    const handleSyncStatus = useCallback((status) => {
        if (canvasInstanceRef.current?.__phosmithRestoreFailed) return
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

    const { onConcurrentRef, onConflictRef } = useCanvasConflicts({ canvasInstanceRef, createProjectMut, createProjectRevisionMut, historyIndexRef, historyRef, loadedContentHashRef, projectRef, rebasedRevisionRef, setSyncStatus, syncRef })

    const saveCanvasState = useCallback(async ({ rethrow = false, immediate = false } = {}) => {
        const canvas = canvasInstanceRef.current
        const proj = projectRef.current
        if (!canvas || !proj) return
        // Saved state failed to load: never overwrite it with the fallback canvas.
        if (canvas.__phosmithRestoreFailed) {
            if (rethrow) throw new Error("Saved edits failed to load — reload before saving")
            return
        }
        // An empty canvas before hydration is not an edit, it is the blank one the
        // user has not seen yet. Two projects were overwritten with objects: []
        // this way by navigating away mid-load.
        if (!hydratedRef.current && canvas.getObjects().length === 0) {
            if (rethrow) throw new Error("Project is still loading — nothing to save yet")
            return
        }

        const canvasJSON = serializeCanvasState(canvas)
        const currentImageUrl = getPrimaryRemoteImageUrl(canvas)
        const objectCount = canvasObjectCount(canvasJSON)
        if (objectCount > 0) everHadObjectsRef.current = true
        let fullState = {
            ...canvasJSON,
            history: historyRef.current.slice(-MAX_PERSISTED_HISTORY),
            historyIndex: historyIndexRef.current,
            ...(objectCount === 0 && everHadObjectsRef.current ? { [INTENTIONALLY_EMPTY]: true } : {}),
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
        recordSavedContent(projectRef.current?._id, canvasContentHash(fullState))
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
            flushDebounceMs: FLUSH_DEBOUNCE_MS,
            minSnapshotIntervalMs: MIN_SNAPSHOT_INTERVAL_MS,
        })
        syncRef.current = manager
        return () => {
            manager.flushNow()
            manager.destroy()
            // Dismiss the conflict toast so it doesn't persist on navigation
            // (it has duration: Infinity and would follow the user to the dashboard).
            toast.dismiss("canvas-conflict")
            if (syncRef.current === manager) syncRef.current = null
        }
    }, [project?._id, handleSyncStatus])

    // Concurrent-device presence: heartbeat so we learn the instant the same
    // project is opened on another device, and react via the stable ref handler.
    useEffect(() => {
        const projectId = project?._id
        if (!projectId) return
        const channel = createPresenceChannel({
            projectId,
            onConcurrent: (info) => onConcurrentRef.current(info),
        })
        return () => {
            channel.stop()
            toast.dismiss("canvas-presence")
        }
    }, [project?._id])

    // Host the AI Extend background poller. Lives at canvas level (not in the
    // extender panel) so a pending genfill keeps polling and can swap the soft
    // preview for the real result no matter which tool is open — and resumes
    // after a reload (the poller persists pending jobs to sessionStorage).
    // Bind the change journal to this project so the History panel shows the
    // right log (persisted per project in sessionStorage).
    useEffect(() => {
        if (project?._id) setJournalProject(project._id)
    }, [project?._id])

    useEffect(() => {
        const projectId = project?._id
        if (!canvasEditor || !projectId) return
        return registerExtendHost({
            projectId,
            getCanvas: () => canvasEditor,
            save: async (id, currentImageUrl, canvas) => {
                await updateProject({
                    projectId: id,
                    currentImageUrl,
                    canvasState: serializeCanvasState(canvas),
                })
            },
        })
    }, [canvasEditor, project?._id, updateProject])

    // beforeunload + pagehide: capture the very latest state before the user
    // navigates away. The manager beacons it to Redis (surviving unload) and
    // keepalive-flushes to Neon, so edits made inside the autosave window aren't
    // lost; the IndexedDB mirror is the backstop if the beacon is dropped.
    useEffect(() => {
        const projectId = project?._id
        if (!projectId) return

        // Page is going away for good (real navigation / tab close): fire-and-forget
        // IDB update then beacon whatever latest the manager holds. Can't await in
        // unload handlers — the beacon + IDB mirror are the backstops.
        const persistOnUnload = () => {
            saveCanvasState().catch(() => {})
            try { syncRef.current?.beaconUnload() } catch { /* ignore */ }
        }

        const persistWhileAlive = () => {
            // Only flush when there's actually dirty/unsynced state. Skipping
            // when nothing is pending avoids bumping the server revision on every
            // tab/window/screen switch, which was the root cause of spurious
            // "edited elsewhere" conflict notifications in single-session use.
            if (!syncRef.current?.hasPendingSync()) return
            saveCanvasState({ immediate: true }).catch(() => {})
        }

        const onBeforeUnload = () => persistOnUnload()
        const onPageHide = (e) => {
            // A persisted (bfcache) pagehide may be restored alive → keep the
            // manager coherent; a non-persisted one is a real unload.
            if (e?.persisted) persistWhileAlive()
            else persistOnUnload()
        }
        const onVisibility = () => {
            if (typeof document !== "undefined" && document.visibilityState === "hidden") {
                persistWhileAlive()
            }
        }
        window.addEventListener("beforeunload", onBeforeUnload)
        window.addEventListener("pagehide", onPageHide)
        document.addEventListener("visibilitychange", onVisibility)
        return () => {
            window.removeEventListener("beforeunload", onBeforeUnload)
            window.removeEventListener("pagehide", onPageHide)
            document.removeEventListener("visibilitychange", onVisibility)
        }
    }, [project?._id, saveCanvasState])

    useEffect(() => {
        if (!canvasRef.current || !projectRef.current) return

        const initGen = ++initGenerationRef.current
        let mounted = true
        hydratedRef.current = false
        everHadObjectsRef.current = false

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
                    if (cachedUpdatedAt > bestUpdatedAt && isAccidentalEmpty(cachedSnapshot.canvasState, canvasObjectCount(rawCanvasState))) {
                        console.warn("[canvas] ignoring a newer but empty cached snapshot; the saved project has objects")
                    } else if (cachedUpdatedAt > bestUpdatedAt) {
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
                    if (localUpdatedAt > bestUpdatedAt && isAccidentalEmpty(localState.fullState, canvasObjectCount(rawCanvasState))) {
                        console.warn("[canvas] ignoring a newer but empty local copy; the saved project has objects")
                    } else if (localUpdatedAt > bestUpdatedAt) {
                        rawCanvasState = localState.fullState
                        if (localState.currentImageUrl) {
                            effectiveCurrentImageUrl = localState.currentImageUrl
                        }
                        bestUpdatedAt = localUpdatedAt
                        // Only adopt the local IDB revision if it's >= the
                        // project's current server revision. If the local
                        // revision is OLDER, the data was already flushed (e.g.
                        // via beacon on tab close) but IDB wasn't cleaned up.
                        // Adopting the stale revision would make the first flush
                        // send baseRevision=OLD → server has NEW → spurious conflict.
                        const localRev = Number(localState.baseRevision)
                        const serverRev = Number(proj.revision) || 0
                        if (Number.isFinite(localRev) && localRev >= serverRev) {
                            effectiveBaseRevision = localRev
                        }
                    }
                }
            } catch (localError) {
                console.warn("[canvas] local snapshot lookup failed:", localError?.message || localError)
            }

            // Tell the sync manager which revision the loaded content is based on,
            // so its first flush is checked against the right baseline.
            try { syncRef.current?.setBaseRevision(effectiveBaseRevision) } catch { /* manager may not exist yet */ }

            loadedContentHashRef.current = canvasContentHash(rawCanvasState)
            everHadObjectsRef.current = canvasObjectCount(rawCanvasState) > 0
            const canvasState = normalizeCanvasState(rawCanvasState)
            const persistedHistory = Array.isArray(rawCanvasState?.history) ? rawCanvasState.history : null
            let hasRestoredViewport = false

            if (!canvasState && (effectiveCurrentImageUrl || proj.originalImageUrl)) {
                try {
                    const imageUrl = effectiveCurrentImageUrl || proj.originalImageUrl
                    const fabricImage = await fabricImageFromUrl(imageUrl)
                    fitImageInsideProject(fabricImage, proj)
                    canvas.add(fabricImage)
                } catch (error) { console.error("Error loading project image:", error) }
            }

            if (canvasState) {
                let loadedFromState = false
                try {
                    // A filter class Fabric cannot enliven is dropped silently, so the
                    // lazy registration is awaited whenever the state names one.
                    if (stateNeedsCanvasFilters(canvasState)) await ensureCanvasFilters()
                    await canvas.loadFromJSON(canvasState.canvas || canvasState)
                    // Restore the "grade background" intent so it keeps tracking after reload.
                    canvas.__phosmithGradeBackground = Boolean(canvasState.gradeBackground)
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
                if (!loadedFromState && initGen === initGenerationRef.current && mounted) {
                    canvas.__phosmithRestoreFailed = true
                    setSyncStatus("paused")
                    toast.error("Couldn't restore your saved edits. Reload to try again — autosave is paused so they aren't overwritten.", { duration: Infinity, id: "restore-failed" })
                }
                if (!loadedFromState) {
                    const imageUrl = effectiveCurrentImageUrl || proj.originalImageUrl
                    if (imageUrl && canvas.getObjects().length === 0) {
                        try {
                            const fallbackImage = await fabricImageFromUrl(imageUrl)
                            fitImageInsideProject(fallbackImage, proj)
                            canvas.add(fallbackImage)
                            canvas.requestRenderAll()
                        } catch (error) { console.error("Fallback image load failed:", error) }
                    }
                }
            }

            // Always fit the project to the current viewport on load so the
            // canvas content is centered with proper margins, regardless of
            // the viewport state that was saved (which may have been for a
            // different window/container size).
            createInitialViewport(canvas)
            if (initGen !== initGenerationRef.current || !mounted) {
                canvas.dispose()
                canvasInstanceRef.current = null
                return
            }

            canvas.renderOnAddRemove = true
            canvas.calcOffset()
            canvas.requestRenderAll()
            hydratedRef.current = true
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
                    // Mask gizmo handles are Fabric objects and need hit-testing;
                    // the pixel-tool lock already makes the photo non-evented.
                    canvas.skipTargetFind = !canvas.__maskGizmoActive
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
            canvas.__pushHistoryState = (meta) => pushHistoryState(canvas, meta)
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
            // Doodle ↔ image binding — strokes drawn on a photo follow it when
            // it moves/scales/rotates. Exposed so the Resize tool (which scales
            // the image programmatically) can snapshot before and replay after.
            canvas.__bindDoodles = (image) => bindDoodlesToImage(canvas, image)
            canvas.__followDoodles = (image) => followDoodles(canvas, image)

            const syncProjectFrame = () => {
                const proj = projectRef.current
                if (!proj?.width || !proj?.height) {
                    if (projectFrameStyleRef.current.width !== 0) {
                        projectFrameStyleRef.current = { left: 0, top: 0, width: 0, height: 0 }
                        applyProjectFrameStyle()
                        isProjectFrameVisibleRef.current = false
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
                applyProjectFrameStyle()
                if (!isProjectFrameVisibleRef.current) {
                    isProjectFrameVisibleRef.current = true
                    setIsProjectFrameVisible(true)
                }
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
                // Seed the undo baseline without journaling — opening a project
                // is not a user change ("Canvas edit" used to appear on every
                // fresh project open).
                pushHistoryState(canvas, { silent: true })
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
        applyProjectFrameStyle,
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
        canvas.__pushHistoryState = (meta) => pushHistoryState(canvas, meta)
        // Pass options through: Save relies on { rethrow, immediate } to report a failed save.
        canvas.__saveCanvasState = (opts) => saveCanvasState(opts)
        canvas.__getHistoryState = () => ({
            canUndo: historyIndexRef.current > 0,
            canRedo: historyIndexRef.current < historyRef.current.length - 1,
        })
    }, [canvasEditor, undoCanvasState, redoCanvasState, pushHistoryState, saveCanvasState])

    useMegashaderPreview({ canvasEditor, canvasInstanceRef, scheduleSaveRef })

    usePanZoomInput({ activeTool, canvasEditor, canvasInstanceRef, ctrlPressedRef, handToolActiveRef, isPanningRef, lastPointerRef, project, projectRef, setIsHandToolActive, spacePressedRef })

    const { toggleHandTool } = useHandTool({ activeToolRef, canvasEditor, canvasInstanceRef, containerRef, handToolActiveRef, project, projectRef, setIsHandToolActive })

    useHistoryAutosave({ canvasEditor, isRestoringRef, project, pushHistoryState, saveCanvasState, scheduleSaveRef })

    useContainerRefit({ canvasInstanceRef, containerRef, fitProjectToViewport, isResizingRef, previewZoomPercentRef, project, projectRef, resizeFrameRef, resizeSettleRef, setPreviewZoomPercent })

    const { canCompare, endCompare, handleCompareKeyDown, startCompare } = useCompare({ activeTool, applyProjectFrameStyle, canvasEditor, canvasInstanceRef, compareBaselineUrl, isBusy, isComparing, isLoading, isProjectFrameVisible, projectFrameStyleRef, setCompareBaselineUrl, setIsComparing })

    const previewSliderValue = clamp(previewZoomPercent, MIN_PREVIEW_ZOOM_PERCENT, MAX_PREVIEW_ZOOM_PERCENT)
    const canAdjustPreview = Boolean(canvasEditor)

    const applyPreviewZoomPercent = (percent) => {
        const nextPercent = clamp(Number(percent) || 100, MIN_PREVIEW_ZOOM_PERCENT, MAX_PREVIEW_ZOOM_PERCENT)
        setCanvasPreviewZoom(canvasInstanceRef.current, nextPercent)
    }

    const adjustPreviewZoomPercent = (dir) => {
        applyPreviewZoomPercent(nextPreviewZoomStop(previewZoomPercentRef.current, dir))
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
                <div ref={frameTextureRef} className="editor-canvas-project-texture pointer-events-none absolute" />
            )}

            <div className='absolute inset-0 editor-canvas-fabric-layer'>
                <canvas id='canvas' className='rounded-xl editor-canvas-surface' ref={canvasRef} />
            </div>

            {/* Before/After compare overlay — the session baseline stretched over
                the live canvas's project frame. Shown only while Compare is held. */}
            {isComparing && compareBaselineUrl && isProjectFrameVisible && (
                <>
                    <img
                        ref={compareOverlayRef}
                        src={compareBaselineUrl}
                        alt=""
                        aria-hidden="true"
                        className="editor-canvas-compare-overlay pointer-events-none absolute"
                    />
                    <div className="editor-canvas-compare-pill" role="status" aria-live="polite">Before</div>
                </>
            )}

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
                <div ref={frameOutlineRef} className="editor-canvas-project-frame pointer-events-none absolute" />
            )}

            {!isBusy && (
                <button
                    type="button"
                    className={`editor-canvas-compare-button${isComparing ? " is-active" : ""}`}
                    onPointerDown={canCompare ? startCompare : undefined}
                    onPointerUp={endCompare}
                    onKeyDown={canCompare ? handleCompareKeyDown : undefined}
                    onKeyUp={endCompare}
                    disabled={!canCompare}
                    aria-pressed={isComparing}
                    title={canCompare ? "Hold to compare before / after" : "Compare (no changes yet)"}
                >
                    <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{isComparing ? "Before" : "Compare"}</span>
                </button>
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
                    onClick={() => adjustPreviewZoomPercent(-1)}
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
                    onClick={() => adjustPreviewZoomPercent(1)}
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

            {(syncStatus === "offline" || syncStatus === "error" || syncStatus === "saving" || syncStatus === "conflict" || syncStatus === "paused") && (
                // Top-right: top-centre collided with Sonner toasts.
                <div
                    className="absolute z-30 flex items-center gap-2"
                    style={{
                        top: 12,
                        right: 12,
                        pointerEvents: "none",
                        padding: "5px 12px",
                        background: "var(--bg-elevated, #0a0d14)",
                        border: "2px solid",
                        borderColor:
                            syncStatus === "offline" ? "var(--accent-amber, #f5b945)"
                                : (syncStatus === "error" || syncStatus === "conflict" || syncStatus === "paused") ? "var(--accent-coral, #ff6b5e)"
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
                                    : (syncStatus === "error" || syncStatus === "conflict" || syncStatus === "paused") ? "var(--accent-coral, #ff6b5e)"
                                        : "var(--accent-primary, #38e0c8)",
                        }}
                    />
                    {syncStatus === "offline"
                        ? "Offline · saved locally"
                        : syncStatus === "conflict"
                            ? "Edited elsewhere"
                            : syncStatus === "paused"
                                ? "Autosave paused · reload"
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
