/**
 * One heavy job at a time.
 *
 * The editor has several operations whose PEAK allocation is measured in tens or
 * hundreds of megabytes: a full-resolution megashader commit, a pixel-stretch
 * bake (source snapshot + ribbon buffer + PNG encode, each the size of the
 * image), an export re-render, a model load, a RAW develop. Nothing stopped them
 * overlapping, so their peaks stacked — and on an 8 GB machine the difference
 * between one 180 MB peak and three at once is the difference between a smooth
 * editor and a swapping one. (Measured on this project's own hardware: 0.3 GB
 * free with 3.4 GB of swap in use, where every pointer event took seconds.)
 *
 * So they take turns. Concurrency is 1, ordering is by priority then arrival,
 * and a job that supersedes an earlier queued one of the same `key` replaces it
 * rather than both running — a second click should not buy you two bakes.
 *
 * Deliberately NOT a general scheduler: only wrap work whose memory peak is
 * large. Serialising cheap work would make the app feel slower, not safer.
 */

/** Lower runs first. */
export const PRIORITY = {
    /** The user is waiting and watching — a commit, an export, an apply. */
    interactive: 0,
    /** The user asked for it but is not blocked on it. */
    background: 10,
    /** Nobody asked; we are getting ahead of them. First to be dropped. */
    prewarm: 20,
}

/**
 * A job that never settles would block every other heavy job for the session —
 * a worse failure than the overlap this exists to prevent. After this long the
 * slot is released and the job is left to finish on its own, which degrades to
 * the old behaviour instead of bricking the editor.
 */
const SLOT_WATCHDOG_MS = 45_000

const queue = []
let active = null
let seq = 0
const listeners = new Set()

const notify = () => {
    const snapshot = stats()
    for (const fn of listeners) {
        try { fn(snapshot) } catch { /* a listener must never break the queue */ }
    }
}

/** Subscribe to busy/queued changes (for a spinner or a debug panel). */
export const onHeavyChange = (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
}

export const stats = () => ({
    running: active ? active.label : null,
    runningFor: active ? Date.now() - active.startedAt : 0,
    queued: queue.length,
    labels: queue.map((j) => j.label),
})

const pump = () => {
    if (active || !queue.length) return
    queue.sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq))
    const job = queue.shift()
    active = { label: job.label, startedAt: Date.now() }
    notify()

    let released = false
    const release = () => {
        if (released) return
        released = true
        clearTimeout(watchdog)
        active = null
        notify()
        // Let the current task finish unwinding before starting the next, so a
        // job's buffers are actually collectable when its successor allocates.
        Promise.resolve().then(pump)
    }
    const watchdog = setTimeout(() => {
        console.warn(`[heavy] "${job.label}" held the slot for ${SLOT_WATCHDOG_MS}ms — releasing it so the editor keeps working`)
        release()
    }, SLOT_WATCHDOG_MS)

    // `finally` is what guarantees the slot comes back on a throw — the failure
    // mode that would otherwise wedge every heavy operation after the first error.
    Promise.resolve()
        .then(job.fn)
        .then((value) => { release(); job.resolve(value) },
            (error) => { release(); job.reject(error) })
}

/**
 * Run `fn` when no other heavy job is running.
 *
 * @param {string} label            what it is, for diagnostics
 * @param {() => Promise<any>|any} fn
 * @param {object} [opts]
 * @param {number} [opts.priority]  see PRIORITY
 * @param {string} [opts.key]       queueing another job with this key REPLACES
 *                                  the one still waiting (the newer intent wins)
 * @returns {Promise<any>} whatever fn returns
 */
export const runHeavy = (label, fn, { priority = PRIORITY.interactive, key = null } = {}) =>
    new Promise((resolve, reject) => {
        if (key) {
            const stale = queue.findIndex((j) => j.key === key)
            if (stale !== -1) {
                const [dropped] = queue.splice(stale, 1)
                dropped.reject(Object.assign(new Error(`Superseded by a newer ${key}`), { superseded: true }))
            }
        }
        seq += 1
        queue.push({ label, fn, priority, key, seq, resolve, reject })
        pump()
    })

/** True when a superseded job's rejection should be swallowed rather than shown. */
export const isSuperseded = (error) => Boolean(error?.superseded)

/** Test hook: drop everything queued (does not touch a running job). */
export const clearHeavyQueue = (reason = 'cleared') => {
    const dropped = queue.splice(0, queue.length)
    for (const j of dropped) j.reject(Object.assign(new Error(reason), { superseded: true }))
    notify()
    return dropped.length
}

// Test hook, matching window.__phosmith.mask / .agent: lets a harness watch the
// queue from the page without reaching into module internals.
if (typeof window !== 'undefined') {
    window.__phosmith = window.__phosmith || {}
    window.__phosmith.heavy = { stats, onHeavyChange, runHeavy, PRIORITY }
}
