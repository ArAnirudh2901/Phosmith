#!/usr/bin/env node
/**
 * Invariant tests for the agent grade-loop primitives — pure Node, no
 * services required (matches the verify-megashader pattern):
 *
 *   planner v6:  criticFeedback deltas apply additively, bypass the no-change
 *                guard, never escape ADJUSTMENT_RANGES, and stay deterministic.
 *   validator:   accepts every planner output; rejects unknown styles, unknown
 *                adjustment keys, and out-of-range values with precise errors.
 *   critic:      passes a clean verdict, flags the worst failing axis, emits
 *                planner-compatible deltas, escalates on a repeated axis.
 *   runPlan:     executes steps in order, retries with a cap, halts on a
 *                persistent failure, resumes via startAt.
 */

import assert from 'node:assert/strict'
import { buildEditPlan, PLANNER_VERSION, ADJUSTMENT_RANGES } from '../src/lib/edit-planner.js'
import { validatePlan } from '../src/lib/agent/plan-validator.js'
import { critique, toCriticFeedback, JUDGE_AXES, CRITIC_VERSION } from '../src/lib/agent/critic.js'
import { registerDomain, runPlan } from '../src/lib/agent/command-registry.js'

let passed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`)
    process.exitCode = 1
  }
}
const atest = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`)
    process.exitCode = 1
  }
}

console.log('[verify-agent-loop] planner v6')

test('PLANNER_VERSION bumped to 6', () => {
  assert.equal(PLANNER_VERSION, 6)
})

test('criticFeedback deltas apply additively', () => {
  const base = buildEditPlan({ targetStyle: 'neutral', gain: 0, directAdjustments: { brightness: 20 } })
  const corrected = buildEditPlan({
    targetStyle: 'neutral', gain: 0,
    directAdjustments: { brightness: 20 },
    criticFeedback: { axis: 'exposure_correctness', deltas: { brightness: -8 }, notes: 'too bright' },
  })
  assert.ok(corrected.adjustments.brightness < base.adjustments.brightness,
    `expected corrective to reduce brightness (${base.adjustments.brightness} → ${corrected.adjustments.brightness})`)
  assert.ok(corrected.criticApplied, 'plan should record criticApplied')
  assert.match(corrected.notes, /too bright/)
})

test('criticFeedback bypasses the no-change guard', () => {
  const noop = buildEditPlan({ targetStyle: 'cinematic', alreadyMatchesTarget: true, gain: 0 })
  assert.equal(Object.keys(noop.adjustments).length, 0)
  const corrected = buildEditPlan({
    targetStyle: 'cinematic', alreadyMatchesTarget: true, gain: 0,
    criticFeedback: { axis: 'color_faithfulness', deltas: { temperature: 10 }, notes: '' },
  })
  assert.ok(Object.keys(corrected.adjustments).length > 0, 'corrective must produce a change')
})

test('corrective deltas never escape ADJUSTMENT_RANGES', () => {
  const plan = buildEditPlan({
    targetStyle: 'neutral', gain: 0,
    criticFeedback: { axis: 'x', deltas: { brightness: 5000, gamma: -5000, hue: 99999 } },
  })
  for (const [k, v] of Object.entries(plan.adjustments)) {
    const r = ADJUSTMENT_RANGES[k]
    assert.ok(v >= r.min && v <= r.max, `${k}=${v} escaped [${r.min},${r.max}]`)
  }
})

test('planner stays deterministic with criticFeedback', () => {
  const args = {
    features: { luminance: { mean: 0.3 }, contrast: 0.5 },
    targetStyle: 'teal-orange', gain: 0.7,
    criticFeedback: { axis: 'exposure_correctness', deltas: { brightness: -6 }, notes: 'n' },
  }
  assert.deepEqual(buildEditPlan(args), buildEditPlan(args))
})

console.log('[verify-agent-loop] validator')

test('accepts planner output', () => {
  const plan = buildEditPlan({ targetStyle: 'cinematic', gain: 0.6, features: { luminance: { mean: 0.3 } } })
  const v = validatePlan(plan)
  assert.ok(v.ok, JSON.stringify(v.errors))
})

test('rejects unknown style / key / range', () => {
  const v = validatePlan({ targetStyle: 'vaporwave-9000', adjustments: { brightness: 500, clarity: 10 } })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.includes('vaporwave-9000')))
  assert.ok(v.errors.some((e) => e.includes('brightness=500')))
  assert.ok(v.errors.some((e) => e.includes('clarity')))
})

test('rejects malformed steps', () => {
  const v = validatePlan({ steps: [{ id: 'nodot' }, { id: 'mask.addLuminance', args: [] }] })
  assert.equal(v.ok, false)
  assert.equal(v.errors.length, 2)
})

console.log('[verify-agent-loop] critic')

const makeAxes = (overrides = {}) => {
  const axes = {}
  for (const a of JUDGE_AXES) axes[a] = { score: 0.9, reasoning: 'fine' }
  for (const [k, v] of Object.entries(overrides)) axes[k] = v
  return axes
}

test('clean verdict passes', () => {
  assert.deepEqual(critique({ judgeJSON: { axes: makeAxes() } }), { ok: true })
})

test(`flags the worst failing axis (CRITIC_VERSION=${CRITIC_VERSION})`, () => {
  const out = critique({
    judgeJSON: {
      axes: makeAxes({
        exposure_correctness: { score: 0.4, reasoning: 'overexposed' },
        color_faithfulness: { score: 0.5, reasoning: 'skin drifted orange' },
      }),
      corrective_hint: 'Lift highlights -8 inside mask.',
    },
    afterFeatures: { luminance: { mean: 0.7 } },
  })
  assert.equal(out.ok, false)
  assert.equal(out.escalate, false)
  assert.equal(out.corrective.axis, 'exposure_correctness')
  assert.deepEqual(out.corrective.deltas, { brightness: -8 })
  const fb = toCriticFeedback(out.corrective)
  assert.deepEqual(fb.deltas, { brightness: -8 })
  // The feedback must round-trip into the planner
  const plan = buildEditPlan({ targetStyle: 'neutral', gain: 0, criticFeedback: fb })
  assert.ok(plan.adjustments.brightness < 0)
})

test('escalates when the same axis fails twice', () => {
  const judgeJSON = { axes: makeAxes({ exposure_correctness: { score: 0.3, reasoning: 'still blown' } }) }
  const first = critique({ judgeJSON })
  const second = critique({ judgeJSON, history: [first.corrective] })
  assert.equal(second.escalate, true)
})

console.log('[verify-agent-loop] runPlan')

let calls = []
let failuresLeft = 0
registerDomain('test', {
  ok: { description: 't', run: (args) => { calls.push(['ok', args]); return args.v } },
  flaky: { description: 't', run: () => { if (failuresLeft-- > 0) throw new Error('flaky'); calls.push(['flaky']); return 'recovered' } },
  broken: { description: 't', run: () => { throw new Error('always fails') } },
})

await atest('runs steps in order', async () => {
  calls = []
  const r = await runPlan({ steps: [{ id: 'test.ok', args: { v: 1 } }, { id: 'test.ok', args: { v: 2 } }] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.results.map((x) => x.out), [1, 2])
})

await atest('retries a flaky step within the cap', async () => {
  calls = []; failuresLeft = 2
  const events = []
  const r = await runPlan({ steps: [{ id: 'test.flaky' }] }, {}, { onStep: (e) => events.push(e.status) })
  assert.equal(r.ok, true)
  assert.deepEqual(events, ['retry', 'retry', 'ok'])
})

await atest('halts on a persistent failure with partial results', async () => {
  const r = await runPlan({ steps: [{ id: 'test.ok', args: { v: 1 } }, { id: 'test.broken' }, { id: 'test.ok', args: { v: 3 } }] }, {}, { maxRetries: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.halted, true)
  assert.equal(r.results.length, 2)
  assert.equal(r.results[1].status, 'failed')
})

await atest('resumes from startAt', async () => {
  calls = []
  const r = await runPlan({ steps: [{ id: 'test.ok', args: { v: 1 } }, { id: 'test.ok', args: { v: 2 } }] }, {}, { startAt: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.results[0].status, 'skipped')
  assert.deepEqual(calls, [['ok', { v: 2 }]])
})

console.log(`\n[verify-agent-loop] ${passed} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`)
