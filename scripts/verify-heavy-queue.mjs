#!/usr/bin/env bun
/**
 * The heavy-job queue is what stops peak allocations stacking, so the property
 * that matters is "never two at once" — including when a job throws, which is
 * the failure that would otherwise wedge every heavy operation after the first.
 *
 * Usage: bun scripts/verify-heavy-queue.mjs
 */
import { runHeavy, PRIORITY, stats, clearHeavyQueue, isSuperseded, onHeavyChange } from '../src/lib/heavy-job-queue.js'

let checks = 0
let failures = 0
const check = (ok, name, detail) => {
    checks += 1
    if (!ok) failures += 1
    console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  (${detail})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── never two at once ────────────────────────────────────────────────────────
{
    let inFlight = 0
    let maxInFlight = 0
    const job = async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await sleep(12)
        inFlight -= 1
    }
    await Promise.all(Array.from({ length: 8 }, (_, i) => runHeavy(`j${i}`, job)))
    check(maxInFlight === 1, 'eight concurrent callers still run one at a time', `peak ${maxInFlight}`)
}

// ── a throwing job must not wedge the queue ──────────────────────────────────
{
    let ran = false
    const boom = runHeavy('explodes', async () => { throw new Error('boom') }).catch((e) => e.message)
    const after = runHeavy('after', async () => { ran = true; return 'ok' })
    check(await boom === 'boom', 'a throwing job rejects to its own caller')
    check(await after === 'ok' && ran, 'and the next job still runs')
    check(stats().running === null && stats().queued === 0, 'the slot is returned', JSON.stringify(stats()))
}

// ── priority ordering ────────────────────────────────────────────────────────
{
    const order = []
    const hold = runHeavy('hold', () => sleep(30))
    // queued while `hold` runs, deliberately out of priority order
    const a = runHeavy('prewarm', async () => { order.push('prewarm') }, { priority: PRIORITY.prewarm })
    const b = runHeavy('background', async () => { order.push('background') }, { priority: PRIORITY.background })
    const c = runHeavy('interactive', async () => { order.push('interactive') }, { priority: PRIORITY.interactive })
    await Promise.all([hold, a, b, c])
    check(order.join(',') === 'interactive,background,prewarm',
        'what the user is waiting on jumps the speculative work', order.join(','))
}

// ── FIFO within a priority ───────────────────────────────────────────────────
{
    const order = []
    const hold = runHeavy('hold', () => sleep(25))
    const jobs = [1, 2, 3].map((n) => runHeavy(`j${n}`, async () => { order.push(n) }))
    await Promise.all([hold, ...jobs])
    check(order.join(',') === '1,2,3', 'equal priority keeps arrival order', order.join(','))
}

// ── a newer job of the same key replaces the waiting one ─────────────────────
{
    const ran = []
    const hold = runHeavy('hold', () => sleep(30))
    const first = runHeavy('bake', async () => { ran.push('first') }, { key: 'bake' }).catch((e) => (isSuperseded(e) ? 'superseded' : 'other'))
    const second = runHeavy('bake', async () => { ran.push('second') }, { key: 'bake' })
    await Promise.all([hold, first, second])
    check(await first === 'superseded', 'the stale job of that key is dropped, and says why')
    check(ran.join(',') === 'second', 'only the newest one runs — a double click does not buy two bakes', ran.join(','))
}

// ── a running job is never superseded, only queued ones ──────────────────────
{
    const ran = []
    const running = runHeavy('bake', async () => { await sleep(25); ran.push('running') }, { key: 'bake' })
    await sleep(5)
    const queued = runHeavy('bake', async () => { ran.push('queued') }, { key: 'bake' })
    await Promise.all([running, queued])
    check(ran.join(',') === 'running,queued', 'work already in flight is left alone', ran.join(','))
}

// ── observability ────────────────────────────────────────────────────────────
{
    const seen = []
    const off = onHeavyChange((s) => seen.push(s.running))
    await runHeavy('watched', () => sleep(5))
    off()
    check(seen.includes('watched'), 'subscribers see the running label')
    check(seen[seen.length - 1] === null, 'and see it clear when the slot frees')

    const bad = onHeavyChange(() => { throw new Error('listener blew up') })
    const ok = await runHeavy('survives', async () => 'fine')
    bad()
    check(ok === 'fine', 'a broken listener cannot break the queue')
}

// ── teardown ─────────────────────────────────────────────────────────────────
{
    const hold = runHeavy('hold', () => sleep(20))
    const doomed = runHeavy('doomed', async () => 'should not run').catch(() => 'dropped')
    const n = clearHeavyQueue('shutting down')
    check(n === 1, 'clearing drops what is waiting', String(n))
    check(await doomed === 'dropped', 'and rejects those callers rather than leaving them hanging')
    await hold
    check(stats().running === null, 'the running job still completes normally')
}

console.log(`\n[verify-heavy-queue] ${checks - failures}/${checks} checks passed.`)
if (failures) process.exit(1)
