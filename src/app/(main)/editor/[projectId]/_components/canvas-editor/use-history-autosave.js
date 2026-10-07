import { useEffect } from "react"
import { syncBackgroundGrade } from "../../../../../../lib/canvas-background"
import { describeCanvasChange } from "../../../../../../lib/canvas-change-describe"
import { isPhosmithMaskOverlay } from "../../../../../../lib/canvas-mask"
import { isExpansionFrameLike } from "../../../../../../lib/expansion-pipeline"
import { MAJOR_SAVE_DEBOUNCE_MS, MINOR_SAVE_TRICKLE_MS, TEXT_HISTORY_DEBOUNCE_MS } from "../canvas-editor/persistence"

// Canvas changes push undo history and schedule the autosave.
export function useHistoryAutosave({
    canvasEditor,
    isRestoringRef,
    project,
    pushHistoryState,
    saveCanvasState,
    scheduleSaveRef,
}) {
    // Uncompiled, like the component it was cut from.
    "use no memo"

    useEffect(() => {
        if (!canvasEditor) return
        let saveTimeout = null
        let historyTimeout = null
        let historyDueAt = Infinity

        // Sooner-wins scheduling with one exception: a pending push for the
        // SAME action (matching coalesceKey — e.g. consecutive text:changed
        // keystrokes) is debounced properly, the timer resets so exactly one
        // undo state lands per typing pause. Across different actions a
        // sooner pending push survives (a 900ms text push must never cancel
        // an immediate push from another event), while an equal-or-sooner new
        // push replaces it so the freshest label wins.
        let historyPendingKey = null
        const scheduleHistoryPush = (meta, delay = 0) => {
            const due = Date.now() + delay
            const key = meta?.coalesceKey || null
            if (historyTimeout) {
                const samePending = key !== null && historyPendingKey === key
                if (!samePending && historyDueAt < due) return
                clearTimeout(historyTimeout)
            }
            historyPendingKey = key
            historyDueAt = due
            historyTimeout = setTimeout(() => {
                historyTimeout = null
                historyDueAt = Infinity
                historyPendingKey = null
                pushHistoryState(canvasEditor, meta)
            }, delay)
        }

        // Tiered autosave (see MAJOR_SAVE_DEBOUNCE_MS / MINOR_SAVE_TRICKLE_MS):
        // majors debounce-reset the fast timer; minors only arm the slow
        // trickle when NOTHING is pending — whatever save is already scheduled
        // carries them, and repeated nudges must not keep pushing the deadline
        // out (a fidgety user would otherwise never save).
        const scheduleSave = (tier) => {
            if (tier === 'minor') {
                if (saveTimeout) return
                saveTimeout = setTimeout(() => {
                    saveTimeout = null
                    saveCanvasState()
                }, MINOR_SAVE_TRICKLE_MS)
                return
            }
            clearTimeout(saveTimeout)
            saveTimeout = setTimeout(() => {
                saveTimeout = null
                saveCanvasState()
            }, MAJOR_SAVE_DEBOUNCE_MS)
        }
        scheduleSaveRef.current = scheduleSave

        const makeChangeHandler = (eventName) => (event) => {
            // Guard: when restoring from undo/redo, canvas events fire (object:added,
            // object:modified, etc.) but they must NOT push a new history entry —
            // otherwise the redo stack is truncated immediately after an undo.
            if (isRestoringRef.current) return
            if (isExpansionFrameLike(event?.target)) return
            if (isPhosmithMaskOverlay(event?.target)) return
            // UI-only objects (tool overlays, gizmos, rubber bands) never persist.
            if (event?.target?.excludeFromExport) return

            const change = describeCanvasChange(eventName, event)
            // Zero-delta gesture (click without movement) — nothing happened.
            // Checked BEFORE the grade mirror so a sub-epsilon event can't
            // mutate the background with no save scheduled to persist it.
            if (change.significance === 'none') return

            // When "color grade background" is on, mirror the photo's grade onto the
            // canvas background. Gated to image edits (skip text/shape moves) and to
            // when a background actually exists; change-detected inside.
            if (
                canvasEditor.__phosmithGradeBackground &&
                canvasEditor.backgroundImage &&
                event?.target?.type?.toLowerCase?.() === 'image'
            ) {
                try { syncBackgroundGrade(canvasEditor, true, event.target) } catch { /* ignore */ }
            }
            // Sub-threshold nudge: a real state change that must persist, but
            // not a "main change" — no undo entry, no journal noise, no fast
            // network save. The trickle (or any already-pending save / the
            // unload beacon) carries it; the next major push captures it in
            // the undo stack.
            if (change.significance === 'minor') {
                scheduleSave('minor')
                return
            }

            scheduleHistoryPush(
                { label: change.label, coalesceKey: change.coalesceKey },
                eventName === 'text:changed' ? TEXT_HISTORY_DEBOUNCE_MS : 0,
            )
            scheduleSave('major')
        }

        const handlers = [
            ['object:modified', makeChangeHandler('object:modified')],
            ['object:added', makeChangeHandler('object:added')],
            ['object:removed', makeChangeHandler('object:removed')],
            ['text:changed', makeChangeHandler('text:changed')],
        ]
        handlers.forEach(([name, handler]) => canvasEditor.on(name, handler))

        return () => {
            scheduleSaveRef.current = null
            clearTimeout(saveTimeout)
            clearTimeout(historyTimeout)
            handlers.forEach(([name, handler]) => canvasEditor.off(name, handler))
        }
    }, [canvasEditor, project?._id, pushHistoryState, saveCanvasState])
}
