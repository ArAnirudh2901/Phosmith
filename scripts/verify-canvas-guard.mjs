#!/usr/bin/env bun
// The rule that stops an empty canvas from replacing a saved one (pure, no DB).
// Two projects were wiped by a save that ran before the editor had loaded them;
// these checks pin the rule and that both server write paths apply it.

import { readFileSync } from 'node:fs'
import { INTENTIONALLY_EMPTY, canvasObjectCount, isAccidentalEmpty, isLargeShrink, isUnmarkedEmpty } from '../src/lib/canvas-state-guard.js'

let checks = 0
let failures = 0
const check = (ok, name) => {
    checks += 1
    if (!ok) failures += 1
    console.log(`  ${ok ? '✓' : '✗'} ${name}`)
}

const state = (n, extra = {}) => ({ canvas: { objects: Array.from({ length: n }, () => ({ type: 'image' })) }, history: [], ...extra })

check(canvasObjectCount(state(3)) === 3, 'counts objects in the editor shape (nested under canvas)')
check(canvasObjectCount({ objects: [{}, {}] }) === 2, 'counts objects in the older flat shape')
check(canvasObjectCount(null) === 0 && canvasObjectCount(undefined) === 0, 'null and undefined count as empty')
check(canvasObjectCount({ canvas: { objects: 'x' } }) === 0, 'a non-array objects field counts as empty')
check(canvasObjectCount({ canvas: {} }) === 0, 'a missing objects field counts as empty')

check(isAccidentalEmpty(state(0), 3), 'an empty save over a project with objects is refused')
check(isAccidentalEmpty(null, 3), 'a null state over a project with objects is refused')
check(!isAccidentalEmpty(state(0, { [INTENTIONALLY_EMPTY]: true }), 3), 'an empty save the user made on purpose is accepted')
check(isAccidentalEmpty(state(0, { [INTENTIONALLY_EMPTY]: 'yes' }), 3), 'only a literal true marks it deliberate')
check(!isAccidentalEmpty(state(0), 0), 'an empty save over an empty project is accepted')
check(!isAccidentalEmpty(state(1), 9), 'a save with objects is never treated as an accidental blank')

check(isUnmarkedEmpty(state(0)) && !isUnmarkedEmpty(state(0, { [INTENTIONALLY_EMPTY]: true })) && !isUnmarkedEmpty(state(2)), 'an empty canvas is unmarked unless flagged deliberate')

check(isLargeShrink(state(0), 1), 'removing the only object is a large shrink')
check(isLargeShrink(state(2), 4), 'halving the objects is a large shrink')
check(!isLargeShrink(state(3), 4), 'removing one of four is not')
check(!isLargeShrink(state(5), 4), 'adding objects is not')
check(!isLargeShrink(state(0), 0), 'an empty project cannot shrink')

// Both server write paths must ask before they write.
const fns = readFileSync(new URL('../src/lib/neon/functions.js', import.meta.url), 'utf8')
const body = (name) => {
    const start = fns.indexOf(`"${name}": async`)
    return start < 0 ? '' : fns.slice(start, fns.indexOf('\n  },\n', start))
}
for (const name of ['projects.updateProject', 'projects.flushCanvasState']) {
    const b = body(name)
    const guard = b.indexOf('guardCanvasWrite(')
    const write = b.search(/db\.project\.update(Many)?\(/)
    check(guard > 0 && write > guard, `${name} calls guardCanvasWrite before it writes`)
}
const flush = body('projects.flushCanvasState')
check(flush.indexOf('guardCanvasWrite(') < flush.indexOf('args.force === true'), 'flushCanvasState guards before the "Keep mine" force path')

// The editor marks a deliberate empty, and never loads an empty copy over a full one.
const editor = readFileSync(new URL('../src/app/(main)/editor/[projectId]/_components/canvas.jsx', import.meta.url), 'utf8')
check(/\[INTENTIONALLY_EMPTY\]: true/.test(editor), 'the editor marks a canvas the user emptied')
check((editor.match(/isAccidentalEmpty\(/g) || []).length >= 2, 'the editor checks both the cached snapshot and the local copy before loading them')

const sync = readFileSync(new URL('../src/lib/canvas-sync.js', import.meta.url), 'utf8')
const replay = sync.slice(sync.indexOf('const replayLocal'), sync.indexOf('const handleOnlineChange'))
check(replay.indexOf('isUnmarkedEmpty(local.fullState)') > 0 && replay.indexOf('isUnmarkedEmpty(local.fullState)') < replay.indexOf('await processPending()'),
    'the startup replay drops an unmarked empty local copy instead of sending it')

console.log(`\n[verify-canvas-guard] ${checks - failures}/${checks} checks passed.`)
if (failures) process.exit(1)
