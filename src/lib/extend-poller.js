"use client"

import { toast } from 'sonner'
import { isCanvasLive } from './expansion-pipeline'

/**
 * extend-poller
 * --------------
 * Module-scoped background poller for AI Extend's "soft fallback" path.
 *
 * When /api/ai/extend can't finish ImageKit genfill inside its time budget it
 * applies a locally blurred "soft extension" to the canvas and returns the
 * still-cooking genfill URL. The REAL result has to replace that blurred
 * preview whenever it lands — even if the user has:
 *
 *   - switched to another tool (the AIExtender panel unmounts),
 *   - undone/redone (history restore RECREATES every Fabric object, so any
 *     captured object reference goes stale),
 *   - reloaded the page (same tab/session),
 *   - kept editing the soft preview (filters/masks must carry over).
 *
 * A React-lifecycle poll can't survive any of those, which is why this lives
 * in module scope:
 *
 *   - Jobs are keyed by projectId and persisted to sessionStorage, so a
 *     reload resumes the poll and a finished-but-unapplied result is applied
 *     on the next editor mount.
 *   - The soft preview is found BY SOURCE URL, not object identity — the src
 *     survives JSON serialization through undo/redo and project restore.
 *   - The host (canvas.jsx) registers a canvas getter + save callback once
 *     per editor session via registerExtendHost().
 */

const POLL_INTERVAL_MS = 6 * 1000
const MAX_POLL_MS = 10 * 60 * 1000
const MAX_CONSECUTIVE_FAILURES = 10
const STORAGE_KEY = 'pixxel:pending-extends'

/** projectId → job. Job: { projectId, pendingGenfillUrl, fallbackUrl,
 *  startedAt, resultUrl, timer, abort, failures } */
const jobs = new Map()

/** Last registered host: { projectId, getCanvas, save }. The editor shows one
 *  project at a time, so a single registration is enough. */
let host = null

const hasWindow = () => typeof window !== 'undefined'

const readStore = () => {
    if (!hasWindow()) return {}
    try {
        return JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || '{}') || {}
    } catch {
        return {}
    }
}

const writeStore = (store) => {
    if (!hasWindow()) return
    try {
        if (Object.keys(store).length === 0) window.sessionStorage.removeItem(STORAGE_KEY)
        else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store))
    } catch { /* storage full/blocked — polling still works for this page life */ }
}

const persistJob = (job) => {
    const store = readStore()
    store[job.projectId] = {
        pendingGenfillUrl: job.pendingGenfillUrl,
        fallbackUrl: job.fallbackUrl,
        startedAt: job.startedAt,
        ...(job.resultUrl ? { resultUrl: job.resultUrl } : {}),
    }
    writeStore(store)
}

const forgetJob = (projectId) => {
    const job = jobs.get(projectId)
    if (job) {
        if (job.timer) clearTimeout(job.timer)
        if (job.abort) { try { job.abort.abort() } catch { /* ignore */ } }
        jobs.delete(projectId)
    }
    const store = readStore()
    if (store[projectId]) {
        delete store[projectId]
        writeStore(store)
    }
}

const urlPath = (url) => {
    try {
        return new URL(url).pathname
    } catch {
        return String(url || '')
    }
}

const imageSrc = (obj) =>
    obj?.getSrc?.() || obj?._originalElement?.src || obj?._element?.src || obj?.src || ''

/** Find the soft-preview image on the canvas by matching its source URL.
 *  Pathname comparison tolerates cache-buster query params added on reload. */
const findSoftPreview = (canvas, fallbackUrl) => {
    const wanted = urlPath(fallbackUrl)
    if (!wanted) return null
    return (canvas.getObjects?.() || []).find(
        (obj) => obj?.type?.toLowerCase() === 'image' && urlPath(imageSrc(obj)) === wanted
    ) || null
}

/** Custom per-image props the editor tools hang off Fabric images. These are
 *  the same keys canvas-state.js persists — anything the user edited on the
 *  soft preview must follow it onto the real result. */
const CARRY_PROPS = [
    'pixxelAdjustValues', '_pixxelAdjustValues',
    'pixxelAdjustmentId', '_pixxelAdjustmentId',
    'pixxelImageKitAdjustBaseSrc', '_pixxelImageKitAdjustBaseSrc',
    'pixxelImageKitAdjustValues',
    'pixxelCollageSource', '_pixxelCollageSource',
    '_pixxelMaskCanvas', '_pixxelHasMask', 'pixxelHasMask',
    'pixxelMaskFeather', '_pixxelMaskFeather',
]

/** Swap the soft preview for the real result, preserving placement, z-order,
 *  and every edit made to the preview while the poll was running. */
const applyResult = async (job) => {
    const canvas = host?.getCanvas?.()
    if (!isCanvasLive(canvas)) {
        // Editor not mounted (navigated away / reloading). Keep the result in
        // storage — the next registerExtendHost() for this project applies it.
        persistJob(job)
        return false
    }

    const target = findSoftPreview(canvas, job.fallbackUrl)
    if (!target) {
        // Either the user deleted/replaced the soft preview, or an undo/redo
        // restore is mid-loadFromJSON and the canvas is transiently empty.
        // Tolerate a few misses before declaring the preview gone for good.
        job.missing = (job.missing || 0) + 1
        if (job.missing >= 3) {
            console.log('[extend-poller] Soft preview no longer on canvas, dropping result')
            forgetJob(job.projectId)
            return true
        }
        return false
    }
    job.missing = 0

    const { FabricImage } = await import('fabric')
    let replacement
    try {
        replacement = await FabricImage.fromURL(job.resultUrl, { crossOrigin: 'anonymous' })
    } catch (err) {
        console.warn('[extend-poller] Result image failed to load:', err)
        return false
    }
    if (!replacement?.width || !replacement?.height) return false

    // Keep the on-screen size identical even if the generated image came back
    // at slightly different pixel dimensions than the soft preview.
    const scaleFix = {
        x: (target.width * (target.scaleX || 1)) / replacement.width,
        y: (target.height * (target.scaleY || 1)) / replacement.height,
    }
    replacement.set({
        left: target.left,
        top: target.top,
        scaleX: scaleFix.x,
        scaleY: scaleFix.y,
        angle: target.angle,
        originX: target.originX,
        originY: target.originY,
        flipX: target.flipX,
        flipY: target.flipY,
        skewX: target.skewX,
        skewY: target.skewY,
        opacity: target.opacity,
        selectable: target.selectable,
        evented: target.evented,
    })

    const sameDims = target.width === replacement.width && target.height === replacement.height
    if (sameDims && target.clipPath) {
        replacement.clipPath = target.clipPath
    }
    for (const key of CARRY_PROPS) {
        if (target[key] !== undefined) replacement[key] = target[key]
    }
    if (Array.isArray(target.filters) && target.filters.length) {
        replacement.filters = [...target.filters]
        try { replacement.applyFilters?.() } catch { /* keep unfiltered over failing */ }
    }

    const index = canvas.getObjects().indexOf(target)
    canvas.remove(target)
    canvas.add(replacement)
    if (index >= 0 && typeof canvas.moveObjectTo === 'function') {
        canvas.moveObjectTo(replacement, index)
    }
    replacement.setCoords()
    canvas.requestRenderAll()
    canvas.__pushHistoryState?.({ label: 'AI extended image', domain: 'extend' })
    toast.success('AI extension finished — the preview was replaced with the real result')

    try {
        await host?.save?.(job.projectId, job.resultUrl, canvas)
    } catch (err) {
        console.warn('[extend-poller] Saving real result failed (autosave will retry):', err)
    }

    forgetJob(job.projectId)
    return true
}

const scheduleTick = (job, delay = POLL_INTERVAL_MS) => {
    if (job.timer) clearTimeout(job.timer)
    job.timer = setTimeout(() => tick(job), delay)
}

const onTimeout = (job) => {
    console.warn('[extend-poller] Poll timed out for project', job.projectId)
    persistJob(job)
    toast.error('The AI extension is taking unusually long.', {
        duration: 15_000,
        action: {
            label: 'Keep waiting',
            onClick: () => {
                job.startedAt = Date.now()
                persistJob(job)
                scheduleTick(job, 1000)
            },
        },
    })
}

const tick = async (job) => {
    job.timer = null
    if (!jobs.has(job.projectId)) return

    if (job.resultUrl) {
        // Result already known — just keep trying to apply it. Cap the
        // attempts so a permanently unloadable result (deleted file, CORS)
        // can't spin forever.
        job.applyAttempts = (job.applyAttempts || 0) + 1
        if (job.applyAttempts > 20) {
            console.warn('[extend-poller] Giving up applying result for', job.projectId)
            toast.error('The finished AI extension could not be loaded onto the canvas.')
            forgetJob(job.projectId)
            return
        }
        const done = await applyResult(job)
        if (!done) scheduleTick(job)
        return
    }

    if (Date.now() - job.startedAt > MAX_POLL_MS) {
        onTimeout(job)
        return
    }

    const controller = new AbortController()
    job.abort = controller
    let data = null
    let status = 0
    try {
        const res = await fetch('/api/ai/extend/poll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pendingGenfillUrl: job.pendingGenfillUrl }),
            signal: controller.signal,
        })
        status = res.status
        data = await res.json().catch(() => null)
    } catch (err) {
        if (err?.name === 'AbortError') return
        console.warn('[extend-poller] Poll request failed:', err?.message || err)
    }
    if (job.abort === controller) job.abort = null

    if (status === 401) {
        // Signed out — polling can't continue. Keep the job stored so the next
        // signed-in editor session resumes it.
        persistJob(job)
        toast.error('Sign in again to finish your AI extension — it will resume automatically.')
        return
    }

    if (!data?.ready || !data?.url) {
        job.failures = data ? 0 : (job.failures || 0) + 1
        if (job.failures >= MAX_CONSECUTIVE_FAILURES) {
            onTimeout(job)
            return
        }
        scheduleTick(job)
        return
    }

    job.resultUrl = data.url
    persistJob(job)
    const done = await applyResult(job)
    if (!done) scheduleTick(job)
}

/**
 * Start (or restart) the background poll for a project's pending genfill.
 * Supersedes any previous job for the same project.
 */
export const startExtendPoll = ({ projectId, pendingGenfillUrl, fallbackUrl }) => {
    if (!projectId || !pendingGenfillUrl || !fallbackUrl) return
    forgetJob(projectId)
    const job = {
        projectId,
        pendingGenfillUrl,
        fallbackUrl,
        startedAt: Date.now(),
        resultUrl: null,
        timer: null,
        abort: null,
        failures: 0,
    }
    jobs.set(projectId, job)
    persistJob(job)
    scheduleTick(job, 4000)
}

/** Cancel and forget the pending job for a project (e.g. superseded). */
export const cancelExtendPoll = (projectId) => forgetJob(projectId)

export const hasPendingExtend = (projectId) => {
    if (jobs.has(projectId)) return true
    return Boolean(readStore()[projectId])
}

/**
 * Register the live editor as the poller's host. Called from canvas.jsx once
 * the Fabric canvas exists. Resumes any stored job for this project — both
 * "still polling" (reload mid-poll) and "result ready but unapplied"
 * (result arrived while the editor was closed).
 */
export const registerExtendHost = ({ projectId, getCanvas, save }) => {
    host = { projectId, getCanvas, save }

    const stored = readStore()[projectId]
    if (stored && !jobs.has(projectId)) {
        const job = {
            projectId,
            pendingGenfillUrl: stored.pendingGenfillUrl,
            fallbackUrl: stored.fallbackUrl,
            // Resume with a fresh budget — the stored startedAt may be long
            // past, but the user just reopened the project and expects it to
            // finish, not to instantly time out.
            startedAt: Date.now(),
            resultUrl: stored.resultUrl || null,
            timer: null,
            abort: null,
            failures: 0,
        }
        jobs.set(projectId, job)
        scheduleTick(job, 1500)
    }

    return () => {
        if (host?.projectId === projectId) host = null
        // Jobs stay alive in storage; only the canvas hookup is released.
        const job = jobs.get(projectId)
        if (job) {
            persistJob(job)
            if (job.timer) clearTimeout(job.timer)
            if (job.abort) { try { job.abort.abort() } catch { /* ignore */ } }
            jobs.delete(projectId)
        }
    }
}
