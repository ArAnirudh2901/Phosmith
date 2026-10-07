import { useCallback, useRef } from "react"
import { toast } from "sonner"
import { snapshotToCache } from "../../../../../../lib/canvas-cache"
import { canvasContentHash, savedContentTime, writtenRevision } from "../../../../../../lib/canvas-content-hash"
import { serializeCanvasState } from "../../../../../../lib/canvas-state"
import { clearLocalState } from "../../../../../../lib/canvas-sync"
import { MAX_PERSISTED_HISTORY, getPrimaryRemoteImageUrl } from "../canvas-editor/persistence"

// Another session wrote first, or the project is open on another device: reconcile, or fork a copy.
export function useCanvasConflicts({
    canvasInstanceRef,
    createProjectMut,
    createProjectRevisionMut,
    historyIndexRef,
    historyRef,
    loadedContentHashRef,
    projectRef,
    rebasedRevisionRef,
    setSyncStatus,
    syncRef,
}) {
    // Uncompiled, like the component it was cut from.
    "use no memo"

    // Save the CURRENT live canvas (with its history) as a brand-new project and
    // return the new project's id (null on failure, e.g. the free-plan limit).
    // Shared by the proactive concurrent-device path (presence) and the reactive
    // flush-conflict path, so "your work becomes its own copy" behaves identically.
    const forkLiveCanvasToProject = useCallback(async (titleSuffix) => {
        const canvas = canvasInstanceRef.current
        const proj = projectRef.current
        if (!proj) return null
        let localCanvasState
        let localCurrentImageUrl
        if (canvas) {
            const localState = serializeCanvasState(canvas)
            localCurrentImageUrl = getPrimaryRemoteImageUrl(canvas) || undefined
            localCanvasState = {
                ...localState,
                history: historyRef.current.slice(-MAX_PERSISTED_HISTORY),
                historyIndex: historyIndexRef.current,
            }
        } else {
            // Canvas not initialised yet (concurrency detected mid-load) — fork
            // from the loaded project state, which is exactly what this device sees.
            localCanvasState = proj.canvasState || null
            localCurrentImageUrl = proj.currentImageUrl || undefined
        }
        try {
            return await createProjectMut({
                title: `${proj.title || "Project"} — ${titleSuffix}`,
                canvasState: localCanvasState,
                currentImageUrl: localCurrentImageUrl || proj.currentImageUrl,
                width: proj.width,
                height: proj.height,
            })
        } catch (forkErr) {
            console.warn("[canvas] fork to new project failed:", forkErr?.message || forkErr)
            return null
        }
    }, [createProjectMut])

    // Conflict handler: another session (device/tab) advanced the project's
    // revision while we were editing, so the flush was rejected (no overwrite).
    // We resolve it NON-DESTRUCTIVELY — both versions land in version history —
    // then let the user pick which becomes current.
    const handleConflict = useCallback(async (serverProject) => {
        // A reload can read the project before the previous page's unload save
        // lands, so our own write shows up as "another device". If the server
        // holds exactly what we loaded, nobody diverged: rebase instead of forking.
        // Also rebase when the server holds an OLDER state this browser saved
        // (a slow in-flight save from the previous page) and we loaded a newer one.
        const serverRev = Number(serverProject?.revision)
        const loadedHash = loadedContentHashRef.current
        const serverHash = canvasContentHash(serverProject?.canvasState)
        const projectId = projectRef.current?._id
        const serverT = savedContentTime(projectId, serverHash)
        const loadedT = savedContentTime(projectId, loadedHash)
        const ownOlderWrite = serverT !== null && loadedT !== null && serverT <= loadedT
        // Server revision is the last one this tab wrote (e.g. a stale cached
        // snapshot's base after a remount): same lineage, not another device.
        const ownLatestRevision = Number.isFinite(serverRev) && writtenRevision(projectId) === serverRev
        if (
            Number.isFinite(serverRev)
            && rebasedRevisionRef.current !== serverRev
            && ((loadedHash && (serverHash === loadedHash || ownOlderWrite)) || ownLatestRevision)
        ) {
            rebasedRevisionRef.current = serverRev
            setSyncStatus("saving")
            syncRef.current?.rebaseAndRetry?.(serverRev)
            return
        }
        setSyncStatus("conflict")
        const canvas = canvasInstanceRef.current
        const proj = projectRef.current
        if (!canvas || !proj) return

        const localState = serializeCanvasState(canvas)
        const localCurrentImageUrl = getPrimaryRemoteImageUrl(canvas) || undefined
        const localCanvasState = {
            ...localState,
            history: historyRef.current.slice(-MAX_PERSISTED_HISTORY),
            historyIndex: historyIndexRef.current,
        }

        // Always preserve OUR working copy in version history first, so it's
        // recoverable no matter which way the user resolves.
        try {
            await createProjectRevisionMut({
                projectId: proj._id,
                canvasState: localCanvasState,
                width: proj.width,
                height: proj.height,
                currentImageUrl: localCurrentImageUrl,
                title: "Your version (edit conflict)",
                summary: "Auto-saved because this project was edited on another device.",
            })
        } catch (error) {
            console.warn("[canvas] failed to preserve local conflict copy:", error?.message || error)
        }

        // Auto-save the local diverged state as a NEW PROJECT so both versions
        // coexist independently — each device can continue on its own copy
        // without either overwriting the other.
        const forkProjectId = await forkLiveCanvasToProject("your device's copy")

        if (forkProjectId) {
            // The fork owns our work now. Point the original's caches at the server
            // copy, or a plain reload replays the stale snapshot and forks again.
            clearLocalState(proj._id).catch(() => {})
            if (serverProject?.canvasState) {
                snapshotToCache(proj._id, serverProject.canvasState, serverProject.currentImageUrl || null, serverProject.revision).catch(() => {})
            }
            // Fork succeeded: auto-reload this tab to the server's version so the
            // two devices no longer compete for the same project. The user can open
            // the forked project separately at any time.
            toast.success("Conflict detected — your version saved as a new project.", {
                id: "canvas-conflict",
                duration: Infinity,
                dismissible: true,
                description: `"${proj.title || "Project"} — your device's copy" has been created. Reload this tab to see the other version, or open your copy.`,
                action: {
                    label: "Open my copy",
                    onClick: () => {
                        if (typeof window !== "undefined") {
                            window.open(`/editor/${forkProjectId}`, "_blank")
                        }
                    },
                },
                cancel: {
                    label: "Reload this tab",
                    onClick: () => {
                        Promise.resolve()
                            .then(() => clearLocalState(proj._id).catch(() => {}))
                            .then(() => {
                                if (serverProject?.canvasState) {
                                    return snapshotToCache(proj._id, serverProject.canvasState, serverProject.currentImageUrl || null, serverProject.revision).catch(() => {})
                                }
                            })
                            .finally(() => {
                                if (typeof window !== "undefined") window.location.reload()
                            })
                    },
                },
            })
        } else {
            // Fallback: fork failed (plan limit etc.) — show the original dialog
            // so the user can manually choose which version to keep.
            toast.warning("This project was edited on another device.", {
                id: "canvas-conflict",
                duration: Infinity,
                dismissible: true,
                description: "Your version is saved in version history. Reload the latest, or keep yours (overwrites the other copy).",
                // "Keep mine" must be the `action` — Sonner v2's action.onClick fires
                // reliably, but cancel.onClick is broken (auto-dismiss kills it).
                action: {
                    label: "Keep mine",
                    onClick: () => {
                        syncRef.current?.overwriteRemote()
                        toast.dismiss("canvas-conflict")

                        if (serverProject?.canvasState) {
                            createProjectRevisionMut({
                                projectId: proj._id,
                                canvasState: serverProject.canvasState,
                                width: serverProject.width || proj.width,
                                height: serverProject.height || proj.height,
                                currentImageUrl: serverProject.currentImageUrl || undefined,
                                title: "Other device's version (edit conflict)",
                                summary: "Preserved before overwriting with your version.",
                            }).catch((error) => {
                                console.warn("[canvas] failed to preserve remote conflict copy:", error?.message || error)
                            })
                        }
                    },
                },
                cancel: {
                    label: "Reload latest",
                    onClick: () => {
                        Promise.resolve()
                            .then(() => clearLocalState(proj._id).catch(() => {}))
                            .then(() => {
                                if (serverProject?.canvasState) {
                                    return snapshotToCache(proj._id, serverProject.canvasState, serverProject.currentImageUrl || null, serverProject.revision).catch(() => {})
                                }
                            })
                            .finally(() => {
                                if (typeof window !== "undefined") window.location.reload()
                            })
                    },
                },
            })
        }
    }, [createProjectRevisionMut, forkLiveCanvasToProject])

    // Stable indirection so the per-project sync manager always calls the latest
    // conflict handler without being torn down when it changes identity.
    const onConflictRef = useRef(() => {})
    onConflictRef.current = handleConflict

    // Proactive concurrent-device handler (driven by the presence heartbeat).
    // Unlike handleConflict (which only fires once a flush is REJECTED), this
    // fires the moment a different device opens the same project — before either
    // side has overwritten the other.
    //   - Newcomer (joined later): immediately fork our work into its own project
    //     and move this tab to it, so the two devices never compete for one project.
    //   - Keeper (joined first): just inform the user; we keep the original.
    const handleConcurrentDevice = useCallback(async ({ others, isNewcomer }) => {
        const proj = projectRef.current
        if (!proj) return
        const otherLabel = others?.[0]?.deviceLabel || "another device"

        if (!isNewcomer) {
            // We were here first — keep the original project, just let the user know.
            toast.info("This project was opened on another device.", {
                id: "canvas-presence",
                duration: 8000,
                description: `${otherLabel} is now editing a separate copy, so your work here is safe.`,
            })
            return
        }

        // We're the newcomer: fork our state into its own project and switch to it.
        toast.loading("This project is open on another device — saving your work as a separate copy…", {
            id: "canvas-presence",
            duration: Infinity,
        })
        const forkProjectId = await forkLiveCanvasToProject("this device's copy")
        if (forkProjectId) {
            toast.success("Saved as a separate copy to avoid conflicts.", {
                id: "canvas-presence",
                duration: 6000,
                description: "Opening your own copy so both devices keep their work.",
            })
            // Let the toast paint, then move this tab onto the fork. A full
            // navigation rebinds the editor cleanly to the new project id.
            setTimeout(() => {
                if (typeof window !== "undefined") window.location.href = `/editor/${forkProjectId}`
            }, 1200)
        } else {
            // Couldn't fork (e.g. free-plan project limit) — fall back to a warning
            // so the user can resolve it manually; the reactive flush-conflict path
            // is still the backstop if they keep editing.
            toast.warning("This project is open on another device.", {
                id: "canvas-presence",
                duration: Infinity,
                dismissible: true,
                description: "Editing it here too may overwrite the other device's changes. Couldn't auto-create a separate copy (project limit reached).",
            })
        }
    }, [forkLiveCanvasToProject])

    const onConcurrentRef = useRef(() => {})
    onConcurrentRef.current = handleConcurrentDevice

    return { onConcurrentRef, onConflictRef }
}
