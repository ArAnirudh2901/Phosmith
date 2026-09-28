/**
 * Turning a thrown error into something worth showing a person.
 *
 * Nearly every catch in the editor ended by putting the raw `message` in a
 * toast. That reads fine when the throw came from our own code, and badly the
 * moment it did not: a dropped connection makes `fetch` reject with the literal
 * string "Failed to fetch", a cancelled request gives "The user aborted a
 * request", and a browser refusing a huge canvas gives "IndexSizeError". None
 * of those tell a person what happened or what to do, and on a phone with a
 * flaky signal the first one is the message they meet in every feature.
 *
 * This maps the failures that are actually common onto plain sentences, and
 * passes anything we raised ourselves straight through — those are already
 * written for the user.
 */

/** Errors we threw on purpose read like sentences; raw platform errors do not. */
const PLATFORM_NOISE = [
    /^(TypeError|NetworkError|AbortError|SecurityError|DOMException|IndexSizeError|QuotaExceededError|RangeError)\b/i,
    /^Failed to fetch$/i,
    /^Load failed$/i,
    /^NetworkError when attempting to fetch resource/i,
    /^The user aborted a request/i,
    /^signal is aborted/i,
    /is not valid JSON/i,
    /^JSON\.parse/i,
]

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false

const looksLikeNetwork = (message, error) =>
    (error?.name === 'TypeError' && /fetch|network|load failed/i.test(message))
    || /^(failed to fetch|load failed|networkerror)/i.test(message)

const looksAborted = (message, error) =>
    error?.name === 'AbortError' || /\babort(ed)?\b|\bcancell?ed\b/i.test(message)

/**
 * @param {unknown} error     what was caught
 * @param {string} fallback   what to say when the error tells us nothing useful
 * @returns {string} a sentence safe to put in front of a user
 */
export const toUserMessage = (error, fallback = 'Something went wrong. Please try again.') => {
    const raw = error?.message ?? (typeof error === 'string' ? error : '')
    // `String({})` is "[object Object]" — never show that to anyone.
    const message = String(raw ?? '').trim() === '[object Object]' ? '' : String(raw ?? '').trim()

    if (looksAborted(message, error)) return 'That was cancelled.'
    if (isOffline()) return "You're offline — reconnect and try again."
    if (looksLikeNetwork(message, error)) {
        return 'Could not reach the server. Check your connection and try again.'
    }

    // HTTP statuses that callers attach to the error (see mask-service-client).
    const status = Number(error?.status)
    if (status === 401 || status === 403) return 'Your session expired — sign in again.'
    if (status === 404) return `${fallback} (not found)`
    if (status === 413) return 'That image is too large for this step. Try a smaller one.'
    if (status === 429) return 'Too many requests just now — wait a moment and try again.'
    if (status === 501) return 'That runs on a service which is not available right now.'
    if (status >= 500) return 'The server had a problem with that. Please try again.'

    if (!message) return fallback
    if (PLATFORM_NOISE.some((re) => re.test(message))) return fallback
    return message
}

/** Convenience for the common `catch (e) { toast.error(...) }` shape. */
export const reportError = (toast, error, fallback) => {
    toast?.error?.(toUserMessage(error, fallback))
}
