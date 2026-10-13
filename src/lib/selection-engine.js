/**
 * selection-engine — where SlimSAM runs: this device, or the server.
 *
 * One choice for every selection tool (click / box select, Select Subject,
 * Detect All Subjects, the remover's click, Pixel Stretch's subject): the
 * `selection` capabilities in `ai-routing.js` move together. 'auto' resolves
 * by `device-profile.js`. Each call runs on exactly one side — there is no
 * fall-through, so a choice the user made is the engine that answers.
 *
 * Also tracks what the card shows about the server (ready / asleep / not set
 * up), from `/api/ai/health` and from real calls as they succeed or fail.
 */

import { AI_CAPABILITIES, getRoutingMode, resolveOrder, setRoutingMode, subscribeRouting } from './ai-routing'
import { getDeviceProfile } from './device-profile'

export const SELECTION_CAPABILITIES = Object.keys(AI_CAPABILITIES).filter((cap) => AI_CAPABILITIES[cap].selection)

const STATUS_EVENT = 'phosmith:selection-server'
const hasWindow = () => typeof window !== 'undefined'

/** 'auto' | 'client' | 'server' as the user chose it. */
export const getSelectionMode = () => getRoutingMode('sam')

export const setSelectionMode = (mode) => {
    for (const cap of SELECTION_CAPABILITIES) setRoutingMode(cap, mode)
}

/** The side a selection call runs on right now: 'client' | 'server'. */
export const selectionSide = (capability = 'sam') => resolveOrder(capability)[0]

/** Everything the card renders, in one read. */
export const getSelectionEngine = () => {
    const mode = getSelectionMode()
    return { mode, side: selectionSide('sam'), device: getDeviceProfile(), server: serverStatus }
}

/*
 * Server status:
 *   unknown      not checked yet
 *   checking     a health probe is in flight
 *   ready        SlimSAM is loaded on the service
 *   cold         reachable; the model loads on first use (a few seconds)
 *   asleep       no answer (an idle Space wakes on the first request)
 *   unconfigured no service URL — Server cannot work here
 *   unsupported  the service answers but has no SlimSAM (an older deploy)
 */
let serverStatus = { state: 'unknown', detail: '' }

const setStatus = (next) => {
    serverStatus = { ...next, at: Date.now() }
    if (!hasWindow()) return
    try { window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: serverStatus })) } catch { /* SSR */ }
}

export const getSelectionServerStatus = () => serverStatus

let probe = null
export const checkSelectionServer = () => {
    if (probe) return probe
    if (serverStatus.state === 'unknown') setStatus({ state: 'checking', detail: '' })
    probe = (async () => {
        try {
            const res = await fetch('/api/ai/health', { cache: 'no-store', signal: AbortSignal.timeout(8000) })
            const j = await res.json().catch(() => ({}))
            if (!j.available) {
                setStatus(/not configured/i.test(j.reason || '')
                    ? { state: 'unconfigured', detail: 'No selection service is configured for this app.' }
                    : { state: 'asleep', detail: 'No answer — an idle server wakes on the first selection.' })
            } else if (!j.sam) {
                setStatus({ state: 'unsupported', detail: 'The service runs, but without SlimSAM.' })
            } else {
                setStatus(j.samLoaded ? { state: 'ready', detail: '' } : { state: 'cold', detail: 'The model loads on first use.' })
            }
        } catch {
            setStatus({ state: 'asleep', detail: 'No answer — an idle server wakes on the first selection.' })
        } finally {
            probe = null
        }
        return serverStatus
    })()
    return probe
}

/** Load SlimSAM on the server ahead of the first click. Fire-and-forget. */
export const warmSelectionServer = () => {
    if (!hasWindow()) return
    fetch('/api/ai/warmup', { method: 'POST' })
        .catch(() => {})
        .finally(() => { checkSelectionServer() })
}

/** client-ai reports real calls, so the card shows what actually happened. */
export const noteSelectionServer = (ok, detail = '') => {
    if (ok) {
        if (serverStatus.state !== 'ready') setStatus({ state: 'ready', detail: '' })
    } else if (/not configured|not set up/i.test(detail)) {
        setStatus({ state: 'unconfigured', detail })
    }
}

/** Re-render on a mode change or a server status change. Returns unsubscribe. */
export const subscribeSelectionEngine = (cb) => {
    if (!hasWindow() || typeof cb !== 'function') return () => {}
    const handler = () => cb(getSelectionEngine())
    const unRouting = subscribeRouting(handler)
    window.addEventListener(STATUS_EVENT, handler)
    return () => {
        unRouting()
        window.removeEventListener(STATUS_EVENT, handler)
    }
}
