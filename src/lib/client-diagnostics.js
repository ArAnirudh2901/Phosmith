/**
 * Knowing what breaks on other people's machines.
 *
 * Everything measured about this app so far came from one Chrome on one Mac.
 * That says nothing about the Safari user whose canvas went tainted, the phone
 * that ran out of memory mid-export, or the browser without WebGL2 — and those
 * are exactly the failures that decide whether the product feels reliable.
 *
 * So the client reports its own failures. The design constraints, in order:
 *
 *   1. It must never break the app. Every path is wrapped; a reporting failure
 *      is swallowed, and nothing here is allowed to throw into a render.
 *   2. It must never leak the user's content. Photos, canvas pixels, signed
 *      ImageKit URLs, tokens and emails are all things this could trivially
 *      pick up from an error message, so `redact` runs over everything before
 *      it leaves the page and the payload has no free-text field a caller can
 *      abuse.
 *   3. It must be cheap. Identical errors collapse, there is a hard cap per
 *      session, and delivery uses `sendBeacon` so it never delays a navigation.
 */

const ENDPOINT = '/api/diagnostics'
const MAX_PER_SESSION = 25      // a loop must not turn into a flood
const DEDUPE_WINDOW_MS = 30_000
const FLUSH_DELAY_MS = 4_000
const MAX_STACK_FRAMES = 6

let installed = false
let sentCount = 0
const recent = new Map()        // signature → last sent at
const pending = []
let flushTimer = null

/**
 * Strip anything that could carry user content or credentials.
 *
 * Deliberately aggressive: a diagnostic that is slightly less precise is a fair
 * price for one that can never carry someone's photo or session.
 */
export const redact = (input) => {
    let s = String(input ?? '')
    if (s.length > 600) s = `${s.slice(0, 600)}…`
    return s
        // data: and blob: URLs are image bytes
        .replace(/\b(data|blob):[^\s"')]+/gi, '$1:[stripped]')
        // any URL keeps its origin and path shape, never its query
        .replace(/(https?:\/\/[^\s"')?]+)\?[^\s"')]*/gi, '$1?[stripped]')
        // ImageKit / storage paths often embed the account and file name
        .replace(/\/[A-Za-z0-9_-]{10,}\.(jpe?g|png|webp|gif|avif|arw|nef|cr2|dng)\b/gi, '/[file]')
        .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
        // A JWT's middle segment is base64 of the user's own claims, so this must
        // run BEFORE the generic rule and must not assume long segments — a real
        // Clerk header segment is only ~20 characters.
        .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+)?/g, '[jwt]')
        .replace(/\b(?:[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]{10,}\b/g, '[jwt]')
        // long opaque strings are the shape of keys and ids
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]')
}

/** A short, comparable stack — enough to locate the fault, not a whole trace. */
export const trimStack = (stack) => redact(
    String(stack || '')
        .split('\n')
        .slice(1, 1 + MAX_STACK_FRAMES)
        .map((l) => l.trim().replace(/^at\s+/, ''))
        .join(' | '),
)

/** What the error is, independent of run-specific detail — used to collapse repeats. */
export const signatureOf = (event) =>
    `${event.kind}:${event.name}:${String(event.message).slice(0, 120)}`

/** Facts about the environment that explain device-specific failures. */
const environment = () => {
    const nav = typeof navigator === 'undefined' ? {} : navigator
    const scr = typeof window === 'undefined' ? {} : window
    return {
        ua: redact(nav.userAgent || ''),
        lang: nav.language || null,
        // The two numbers that explain most "it broke on my laptop" reports.
        deviceMemoryGb: nav.deviceMemory ?? null,
        cores: nav.hardwareConcurrency ?? null,
        viewport: scr.innerWidth ? `${scr.innerWidth}x${scr.innerHeight}@${scr.devicePixelRatio || 1}` : null,
        online: nav.onLine ?? null,
        // Path only — a project id is not content, a query string might be.
        route: typeof location === 'undefined' ? null : location.pathname.replace(/\/[a-z0-9]{20,}/gi, '/:id'),
    }
}

const scheduleFlush = () => {
    if (flushTimer || typeof window === 'undefined') return
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS)
}

/** Send whatever has accumulated. Never throws, never blocks a navigation. */
export const flush = () => {
    flushTimer = null
    if (!pending.length || typeof navigator === 'undefined') return
    const batch = pending.splice(0, pending.length)
    const body = JSON.stringify({ events: batch, env: environment(), at: Date.now() })
    try {
        if (navigator.sendBeacon) {
            navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
            return
        }
        fetch(ENDPOINT, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true })
            .catch(() => {})
    } catch {
        /* a diagnostic that fails to send is not worth another error */
    }
}

/**
 * Record one failure.
 *
 * @param {'error'|'rejection'|'handled'|'capability'} kind
 * @param {object} detail  { name, message, stack, context }
 */
export const report = (kind, detail = {}) => {
    try {
        if (sentCount >= MAX_PER_SESSION) return
        const event = {
            kind,
            name: redact(detail.name || 'Error').slice(0, 60),
            message: redact(detail.message || ''),
            stack: trimStack(detail.stack),
            // `context` is a short enum-ish label from the call site, never free text
            // from a user or a server.
            context: detail.context ? redact(String(detail.context)).slice(0, 60) : null,
        }
        const sig = signatureOf(event)
        const last = recent.get(sig)
        if (last && Date.now() - last < DEDUPE_WINDOW_MS) return
        recent.set(sig, Date.now())
        sentCount += 1
        pending.push(event)
        scheduleFlush()
    } catch {
        /* never let reporting throw into the app */
    }
}

/** Note that a capability the app depends on is missing on this device. */
export const reportCapability = (name, available) => {
    if (available) return
    report('capability', { name: 'CapabilityMissing', message: name, context: name })
}


/**
 * A rejection is not always an Error. `String({})` gives "[object Object]",
 * which is exactly as useless in a diagnostic as it is in a toast — this was
 * caught by reading this module's own output from a real Safari session.
 */
export const describeReason = (reason) => {
    if (reason == null) return `non-Error rejection (${reason === null ? 'null' : 'undefined'})`
    if (typeof reason === 'string') return reason
    if (typeof reason?.message === 'string' && reason.message) return reason.message
    // Describe the shape instead: its keys are usually enough to find the source.
    try {
        const json = JSON.stringify(reason)
        if (json && json !== '{}' && json !== 'null') return `non-Error rejection: ${json.slice(0, 200)}`
        const keys = Object.keys(reason)
        if (keys.length) return `non-Error rejection with keys: ${keys.slice(0, 8).join(', ')}`
    } catch { /* circular or exotic — fall through to the type */ }
    // `Object.prototype.toString` yields "[object Object]" for a bare object —
    // the very token this function exists to keep out of a report.
    const tag = Object.prototype.toString.call(reason).replace(/^\[object |\]$/g, '')
    return `non-Error rejection (${tag === 'Object' ? 'empty object' : tag})`
}

/** Install the global listeners. Safe to call more than once. */
export const installDiagnostics = () => {
    if (installed || typeof window === 'undefined') return () => {}
    installed = true

    const onError = (e) => report('error', { name: e?.error?.name, message: e?.message || e?.error?.message, stack: e?.error?.stack })
    const onRejection = (e) => {
        const r = e?.reason
        report('rejection', { name: r?.name, message: describeReason(r), stack: r?.stack })
    }
    const onHide = () => { if (document.visibilityState === 'hidden') flush() }

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    document.addEventListener('visibilitychange', onHide)

    // One-off capability census: these are the things whose absence turns into
    // a confusing failure later rather than an obvious one now.
    try {
        const canvas = document.createElement('canvas')
        reportCapability('webgl2', Boolean(canvas.getContext('webgl2')))
        reportCapability('offscreen-canvas', typeof OffscreenCanvas !== 'undefined')
        reportCapability('webgpu', 'gpu' in navigator || true)   // absence is normal; recorded as present
    } catch { /* a census failure is not worth reporting */ }

    return () => {
        window.removeEventListener('error', onError)
        window.removeEventListener('unhandledrejection', onRejection)
        document.removeEventListener('visibilitychange', onHide)
        installed = false
    }
}

/** Test hook. */
export const __resetDiagnostics = () => {
    sentCount = 0
    recent.clear()
    pending.length = 0
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    installed = false
}

/** Test hook: what is waiting to go out. */
export const __pending = () => pending.slice()
