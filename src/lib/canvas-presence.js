// canvas-presence — detect when the SAME project is being edited on another
// device, concurrently, in real time.
//
// The editor opens a presence "channel" per project: it heartbeats
// /api/canvas/presence every few seconds and watches the returned list of OTHER
// live devices. The first time a different device is seen, it fires
// `onConcurrent` so the editor can warn the user and fork the work into a
// separate project (see canvas.jsx) — proactively, before the two sessions race
// to overwrite each other.
//
// Identity model (two ids, different lifetimes):
//   - clientId  : stable per BROWSER/DEVICE (localStorage). Distinguishes "a
//                 different machine" from "a reload / second tab on this one".
//   - sessionId : fresh per PAGE LOAD (in memory). Identifies this tab's session
//                 within the presence map and stamps a stable joinedAt.
// Only sessions with a DIFFERENT clientId count as concurrent devices, so a
// reload or a second tab here never trips the warning.

const HEARTBEAT_MS = 10_000
const ENDPOINT = "/api/canvas/presence"
const CLIENT_ID_KEY = "phosmith:client-id"

const hasWindow = () => typeof window !== "undefined"

const randomId = () => {
    try {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
            return crypto.randomUUID()
        }
    } catch { /* fall through */ }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// Stable per-browser id. Persisted so the same device is recognised across
// reloads (and therefore NOT flagged as a second device against itself).
export const getClientId = () => {
    if (!hasWindow()) return randomId()
    try {
        let id = window.localStorage.getItem(CLIENT_ID_KEY)
        if (!id) {
            id = randomId()
            window.localStorage.setItem(CLIENT_ID_KEY, id)
        }
        return id
    } catch {
        // Storage blocked (private mode): fall back to a per-load id. Worst case a
        // reload in this mode looks like a new device — acceptable and rare.
        return randomId()
    }
}

// Human-friendly device label from the UA, e.g. "Chrome on macOS". Best-effort;
// only ever shown in a notification, so a rough guess is fine.
export const describeDevice = () => {
    if (!hasWindow() || typeof navigator === "undefined") return "Another device"
    const ua = navigator.userAgent || ""
    let browser = "Browser"
    if (/Edg\//.test(ua)) browser = "Edge"
    else if (/OPR\//.test(ua) || /Opera/.test(ua)) browser = "Opera"
    else if (/Firefox\//.test(ua)) browser = "Firefox"
    else if (/Chrome\//.test(ua)) browser = "Chrome"
    else if (/Safari\//.test(ua)) browser = "Safari"

    let os = ""
    if (/iPhone|iPad|iPod/.test(ua)) os = "iOS"
    else if (/Android/.test(ua)) os = "Android"
    else if (/Windows/.test(ua)) os = "Windows"
    else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS"
    else if (/Linux/.test(ua)) os = "Linux"

    return os ? `${browser} on ${os}` : browser
}

// Am I the newcomer relative to the live `others`? The session that joined
// EARLIEST keeps the original project; everyone who joined later forks. Ties
// (same ms) break on clientId so the decision is symmetric across devices.
const computeIsNewcomer = (selfJoinedAt, selfClientId, others) => {
    return others.some((o) =>
        o.joinedAt < selfJoinedAt ||
        (o.joinedAt === selfJoinedAt && String(o.clientId) < String(selfClientId)),
    )
}

/**
 * Start a presence channel for a project.
 *
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {(info: { others: Array, isNewcomer: boolean, newDevices: Array }) => void} opts.onConcurrent
 *        Called when one or more NEW concurrent devices appear. `isNewcomer`
 *        tells the caller whether THIS session should fork (true) or stay put
 *        and just inform the user (false).
 * @returns {{ stop: () => void }}
 */
export const createPresenceChannel = ({ projectId, onConcurrent } = {}) => {
    if (!hasWindow() || !projectId) return { stop: () => {} }

    const clientId = getClientId()
    const sessionId = randomId()
    const deviceLabel = describeDevice()
    const seenClientIds = new Set()
    let selfJoinedAt = null
    let timer = null
    let stopped = false
    let inFlight = false

    const beat = async () => {
        if (stopped || inFlight) return
        inFlight = true
        try {
            const res = await fetch(ENDPOINT, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ projectId, sessionId, clientId, deviceLabel }),
                cache: "no-store",
            })
            if (!res.ok) return
            const data = await res.json().catch(() => null)
            if (!data || stopped) return
            if (data.self?.joinedAt) selfJoinedAt = data.self.joinedAt

            const others = Array.isArray(data.others) ? data.others : []
            // Only act on devices we haven't already reported, so a steady-state
            // concurrent device fires the warning exactly once (not every beat).
            const newDevices = others.filter((o) => o.clientId && !seenClientIds.has(o.clientId))
            if (newDevices.length > 0 && selfJoinedAt != null) {
                for (const o of others) if (o.clientId) seenClientIds.add(o.clientId)
                const isNewcomer = computeIsNewcomer(selfJoinedAt, clientId, others)
                // onConcurrent may be async — attach a no-op .catch so a rejected
            // Promise doesn't surface as an unhandledRejection in the browser.
            try { onConcurrent?.({ others, isNewcomer, newDevices })?.catch?.(() => {}) } catch { /* caller cb must not break the channel */ }
            }
        } catch { /* network blip — try again next beat */ } finally {
            inFlight = false
        }
    }

    // Best-effort "I'm gone" on tab close so other devices stop seeing this one
    // promptly (otherwise it lingers until PRESENCE_STALE_MS).
    const leave = () => {
        try {
            const body = JSON.stringify({ projectId, sessionId, clientId, deviceLabel, action: "leave" })
            if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
                navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))
            }
        } catch { /* ignore */ }
    }

    const onPageHide = () => leave()
    window.addEventListener("pagehide", onPageHide)

    // Kick off immediately, then on the interval.
    beat()
    timer = setInterval(beat, HEARTBEAT_MS)

    return {
        stop() {
            if (stopped) return
            stopped = true
            if (timer) { clearInterval(timer); timer = null }
            window.removeEventListener("pagehide", onPageHide)
            leave()
        },
    }
}
