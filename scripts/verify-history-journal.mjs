#!/usr/bin/env node
/**
 * Invariant tests for the history/journal/save-throttling stack:
 *
 *   - canvas-change-describe: kinds, verbs, and the none/minor/major
 *     significance thresholds that gate the undo stack, the History panel,
 *     and the fast autosave path.
 *   - change-journal: burst coalescing (count bump instead of a new entry),
 *     attribution keys, cap trimming — all headless (no window).
 *   - canvas-sync: minSnapshotIntervalMs collapses a burst of distinct states
 *     into one immediate + one trailing snapshot carrying the NEWEST state,
 *     without delaying the Neon flush; immediate saves bypass the hold.
 *
 * Usage: node scripts/verify-history-journal.mjs   (or bun)
 */

import {
    MINOR_MOVE_PX,
    assessTransformSignificance,
    describeCanvasChange,
    describeObjectKind,
} from '../src/lib/canvas-change-describe.js'
import { clearChanges, getChanges, recordChange } from '../src/lib/change-journal.js'
import { createCanvasSync } from '../src/lib/canvas-sync.js'

let passed = 0
let failed = 0
const check = (label, condition, detail) => {
    if (condition) {
        passed += 1
        console.log(`  ✓ ${label}`)
    } else {
        failed += 1
        console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── canvas-change-describe ──────────────────────────────────────────────────
console.log('[verify-history-journal] canvas-change-describe')

check('image kind', describeObjectKind({ type: 'Image' }) === 'image')
check('textbox kind', describeObjectKind({ type: 'textbox' }) === 'text')
check('rect kind', describeObjectKind({ type: 'rect' }) === 'shape')
check('unknown kind falls back to object', describeObjectKind({ type: 'wat' }) === 'object')

const dragEvent = (dx, target = {}) => ({
    action: 'drag',
    target: { type: 'image', left: 100 + dx, top: 50, width: 200, height: 100, scaleX: 1, scaleY: 1, ...target },
    transform: { action: 'drag', original: { left: 100, top: 50, scaleX: 1, scaleY: 1, angle: 0 } },
})

check('zero-delta drag → none', assessTransformSignificance(dragEvent(0)) === 'none')
check('1px drag → minor', assessTransformSignificance(dragEvent(1)) === 'minor')
check(`${MINOR_MOVE_PX + 7}px drag → major`, assessTransformSignificance(dragEvent(MINOR_MOVE_PX + 7)) === 'major')
check(
    'tolerance scales with object size (8px on a 2000px image → minor)',
    assessTransformSignificance(dragEvent(8, { width: 2000, height: 1500 })) === 'minor',
)
check(
    'same 8px on a small object → major',
    assessTransformSignificance(dragEvent(8, { width: 120, height: 80 })) === 'major',
)

const scaleEvent = (factor) => ({
    action: 'scale',
    target: { type: 'image', scaleX: factor, scaleY: factor, width: 200, height: 100 },
    transform: { action: 'scale', original: { left: 0, top: 0, scaleX: 1, scaleY: 1, angle: 0 } },
})
check('0.5% scale → minor', assessTransformSignificance(scaleEvent(1.005)) === 'minor')
check('5% scale → major', assessTransformSignificance(scaleEvent(1.05)) === 'major')

const rotateEvent = (angle) => ({
    action: 'rotate',
    target: { type: 'image', angle, width: 200, height: 100, scaleX: 1, scaleY: 1 },
    transform: { action: 'rotate', original: { left: 0, top: 0, scaleX: 1, scaleY: 1, angle: 0 } },
})
check('0.5° rotate → minor', assessTransformSignificance(rotateEvent(0.5)) === 'minor')
check('10° rotate → major', assessTransformSignificance(rotateEvent(10)) === 'major')
check('rotation wraps (359° ≈ -1°) → minor', assessTransformSignificance(rotateEvent(359.5)) === 'minor')

check(
    'programmatic fire (no transform) → major',
    assessTransformSignificance({ target: { type: 'image' } }) === 'major',
)
check(
    'unknown action → major',
    assessTransformSignificance({
        action: 'resizing',
        target: { type: 'textbox' },
        transform: { action: 'resizing', original: { left: 0, top: 0 } },
    }) === 'major',
)

const moved = describeCanvasChange('object:modified', dragEvent(50))
check('drag label', moved.label === 'Moved image', moved.label)
check('drag coalesce key', moved.coalesceKey === 'moved:image', moved.coalesceKey)
const added = describeCanvasChange('object:added', { target: { type: 'i-text' } })
check('added label', added.label === 'Added text' && added.significance === 'major', added.label)
const removed = describeCanvasChange('object:removed', { target: { type: 'Image' } })
check('removed label', removed.label === 'Removed image', removed.label)
const typed = describeCanvasChange('text:changed', { target: { type: 'textbox' } })
check('text label', typed.label === 'Edited text' && typed.coalesceKey === 'text:edited', typed.label)

// ── change-journal coalescing (headless: no window) ─────────────────────────
console.log('[verify-history-journal] change-journal coalescing')

clearChanges()
recordChange({ label: 'Moved image', coalesceKey: 'moved:image' })
recordChange({ label: 'Moved image', coalesceKey: 'moved:image' })
recordChange({ label: 'Moved image', coalesceKey: 'moved:image' })
let entries = getChanges()
check('burst coalesces into one entry', entries.length === 1, `got ${entries.length}`)
check('coalesced count is 3', entries[0]?.count === 3, `got ${entries[0]?.count}`)

recordChange({ label: 'Added text', coalesceKey: 'added:text' })
entries = getChanges()
check('different action appends', entries.length === 2, `got ${entries.length}`)
check('newest first', entries[0]?.label === 'Added text', entries[0]?.label)

// A different action between repeats breaks the run — the next repeat is a
// NEW entry (only the newest entry coalesces, history stays chronological).
recordChange({ label: 'Moved image', coalesceKey: 'moved:image' })
entries = getChanges()
check('interleaved repeat starts a new entry', entries.length === 3, `got ${entries.length}`)

clearChanges()
recordChange({ label: 'Mask: add layer', source: 'user', domain: 'mask' })
recordChange({ label: 'Mask: add layer', source: 'agent', domain: 'mask' })
entries = getChanges()
check('different sources never merge', entries.length === 2, `got ${entries.length}`)

clearChanges()
recordChange({ label: 'Adjusted text shadow', coalesceKey: 'text-style-slider' })
recordChange({ label: 'Adjusted text glow', coalesceKey: 'text-style-slider' })
entries = getChanges()
check('shared coalesceKey merges across labels', entries.length === 1, `got ${entries.length}`)
check('freshest label wins', entries[0]?.label === 'Adjusted text glow', entries[0]?.label)

clearChanges()
for (let i = 0; i < 230; i++) recordChange({ label: `edit ${i}` })
entries = getChanges()
check('cap holds at 200', entries.length === 200, `got ${entries.length}`)
check('cap drops oldest', entries[entries.length - 1]?.label === 'edit 30', entries[entries.length - 1]?.label)
check('empty label is rejected', recordChange({ label: '   ' }) === null)
clearChanges()

// ── canvas-sync: min snapshot interval ──────────────────────────────────────
console.log('[verify-history-journal] canvas-sync snapshot throttling')

const runSyncScenario = async () => {
    const snapshots = []
    const flushes = []
    const sync = createCanvasSync({
        projectId: 'verify-project',
        snapshotFn: async (_id, fullState) => { snapshots.push(fullState); return true },
        flushFn: async (_id, { canvasState }) => { flushes.push(canvasState); return { flushed: true, revision: (flushes.length + 1) } },
        onStatus: () => {},
        minSnapshotIntervalMs: 150,
        flushDebounceMs: 200,
        initialRevision: 1,
    })

    await sync.save({ step: 1 }, null)
    check('first distinct state snapshots immediately', snapshots.length === 1, `got ${snapshots.length}`)

    await sync.save({ step: 2 }, null)
    await sync.save({ step: 3 }, null)
    check('burst within interval is held (still 1 snapshot)', snapshots.length === 1, `got ${snapshots.length}`)

    await sleep(220)
    check('trailing snapshot fires once after the interval', snapshots.length === 2, `got ${snapshots.length}`)
    check('trailing snapshot carries the NEWEST state', snapshots[1]?.step === 3, JSON.stringify(snapshots[1]))

    await sleep(250)
    check('flush still happened on its own debounce', flushes.length >= 1, `got ${flushes.length}`)
    check('flush carried the newest state', flushes[flushes.length - 1]?.step === 3, JSON.stringify(flushes.at(-1)))

    const before = snapshots.length
    await sleep(160) // let the interval fully elapse so the next test isn't held
    await sync.save({ step: 4 }, null, { immediate: true })
    check('immediate save bypasses the hold', snapshots.length === before + 1, `got ${snapshots.length - before}`)

    sync.destroy()

    const afterDestroy = snapshots.length
    await sleep(250)
    check('destroy cancels pending timers', snapshots.length === afterDestroy, `got ${snapshots.length - afterDestroy}`)
}

await runSyncScenario()

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n[verify-history-journal] ${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exitCode = 1
