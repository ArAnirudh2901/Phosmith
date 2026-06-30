/**
 * Grade Loop (planner → executor → judge → critic → corrective re-plan)
 * ---------------------------------------------------------------------
 * The orchestrator that turns the standalone pieces into a closed loop:
 *
 *   1. validate the plan against the planner's own vocabulary (plan-validator)
 *   2. execute it through the command registry (runPlan: per-step retry,
 *      halt-on-failure so the critic sees reality, not intent)
 *   3. capture the rendered result and ask /api/ai/edit-judge for a 12-axis,
 *      reasoning-first verdict (cached, deterministic, human-aligned)
 *   4. run the pure critic; on failure, re-enter the planner with a SMALL
 *      ADDITIVE corrective delta (planner v6 criticFeedback channel) —
 *      surgical edits, never throw-away-and-regenerate
 *   5. repeat up to `maxIterations`; escalate to user confirmation when the
 *      same axis fails twice in a row (convergence guard)
 *
 * Durability: every step and the final verdict are journaled to the agentRun
 * table (best-effort, via /api/neon/mutation) so a crashed run resumes from
 * the last completed step instead of replanning from scratch.
 *
 * Pure JS, framework-agnostic, browser-side. NOT wired to any UI — drive it
 * from the agent bridge or the dev console via `window.__phosmith.agent`.
 *
 * @module agent/grade-loop
 */

import { runPlan } from './command-registry'
import { critique, toCriticFeedback } from './critic'
import { validatePlan, errorsToCorrectivePrompt } from './plan-validator'

export const GRADE_LOOP_VERSION = 1

const neon = async (kind, name, args) => {
    try {
        const resp = await fetch(`/api/neon/${kind}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, args }),
        })
        if (!resp.ok) return null
        const json = await resp.json().catch(() => null)
        return json?.data ?? null
    } catch {
        return null // journaling is best-effort; the loop never dies on it
    }
}

const judgeEdit = async ({ projectId, prompt, plan, before, after, criticHistory }) => {
    const resp = await fetch('/api/ai/edit-judge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            projectId,
            prompt,
            plan,
            targetStyle: plan?.targetStyle,
            beforeImageBase64: before.base64,
            beforeImageMime: before.mime || 'image/jpeg',
            afterImageBase64: after.base64,
            afterImageMime: after.mime || 'image/jpeg',
            beforeFeatures: before.features || null,
            afterFeatures: after.features || null,
            beforeDepthBase64: before.depthBase64 || null,
            afterDepthBase64: after.depthBase64 || null,
            criticHistory,
        }),
    })
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.error || `/api/ai/edit-judge failed (${resp.status})`)
    }
    return resp.json()
}

/**
 * Run the full grade loop.
 *
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.prompt           the user's instruction (for the judge + journal)
 * @param {object} params.plan             initial plan. Either `steps` (registry commands)
 *                                         or an adjustments-plan your `applyPlan` understands.
 * @param {() => Promise<{base64: string, mime?: string, features?: object, depthBase64?: string}>} params.captureRender
 *                                         captures the CURRENT rendered canvas state.
 * @param {(plan: object, ctx: object) => Promise<any>} [params.applyPlan]
 *                                         applies a plan. Default: `runPlan` over `plan.steps`.
 * @param {(args: {criticFeedback: object, previousPlan: object, validationErrors?: string[]}) => Promise<object>} [params.replan]
 *                                         produces a corrected plan from critic feedback.
 *                                         Default: previous plan + corrective deltas via the
 *                                         planner v6 channel shape (caller-side planners can
 *                                         instead call /api/ai/edit-plan with criticFeedback).
 * @param {object} [params.ctx]            runtime context forwarded to commands
 * @param {number} [params.maxIterations=3] corrective rounds beyond the first pass
 * @param {(ev: object) => void} [params.onEvent] observability hook (step events, verdicts)
 * @returns {Promise<{ok: boolean, status: string, iterations: number, judge: object|null, critic: object|null, runId: string|null, history: Array}>}
 */
export const runGradeLoop = async ({
    projectId,
    prompt,
    plan,
    captureRender,
    applyPlan = null,
    replan = null,
    ctx = {},
    maxIterations = 3,
    onEvent = null,
} = {}) => {
    if (typeof captureRender !== 'function') throw new Error('[grade-loop] captureRender is required')
    const emit = (ev) => { try { onEvent?.(ev) } catch { /* observer errors never kill the loop */ } }

    const history = [] // critic correctives, oldest first
    let currentPlan = plan
    let judge = null
    let criticVerdict = null
    let runId = null

    // BEFORE snapshot — captured once; every iteration judges against the true origin.
    const before = await captureRender()

    const promptKey = String(prompt || '').toLowerCase().trim().replace(/\s+/g, ' ')

    for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
        // 1) Validate. An invalid plan bounces to `replan` with the validator's
        // errors as a corrective prompt (max once per iteration slot).
        let validation = validatePlan(currentPlan)
        if (!validation.ok) {
            emit({ type: 'invalid-plan', iteration, errors: validation.errors })
            if (typeof replan !== 'function') {
                return { ok: false, status: 'invalid-plan', iterations: iteration, judge, critic: criticVerdict, runId, history, errors: validation.errors }
            }
            currentPlan = await replan({
                criticFeedback: null,
                previousPlan: currentPlan,
                validationErrors: validation.errors,
                correctivePrompt: errorsToCorrectivePrompt(validation.errors),
            })
            validation = validatePlan(currentPlan)
            if (!validation.ok) {
                return { ok: false, status: 'invalid-plan', iterations: iteration, judge, critic: criticVerdict, runId, history, errors: validation.errors }
            }
        }

        // 2) Journal the run (best-effort; resume from a crashed prior run).
        if (iteration === 0 && projectId) {
            const resumable = await neon('query', 'agentRun.getResumable', {
                projectId, imageHash: before.hash || null, promptKey,
            })
            const startAt = resumable?.stepIndex || 0
            const started = resumable || await neon('mutation', 'agentRun.start', {
                projectId, imageHash: before.hash || 'unknown', promptKey, prompt, plan: currentPlan, iteration,
            })
            runId = started?.id || started?._id || null
            if (startAt > 0) emit({ type: 'resume', stepIndex: startAt })
            ctx.__resumeStartAt = startAt
        }

        // 3) Execute.
        emit({ type: 'execute', iteration, plan: currentPlan })
        if (typeof applyPlan === 'function') {
            await applyPlan(currentPlan, ctx)
        } else if (Array.isArray(currentPlan?.steps)) {
            const exec = await runPlan(currentPlan, ctx, {
                startAt: iteration === 0 ? (ctx.__resumeStartAt || 0) : 0,
                onStep: (ev) => {
                    emit({ type: 'step', iteration, ...ev })
                    if (runId && ev.status !== 'retry') {
                        neon('mutation', 'agentRun.recordStep', { runId, step: ev })
                    }
                },
            })
            if (!exec.ok) {
                if (runId) await neon('mutation', 'agentRun.finish', { runId, status: 'failed', iteration, error: 'execution halted' })
                return { ok: false, status: 'execution-failed', iterations: iteration, judge, critic: criticVerdict, runId, history, results: exec.results }
            }
        } else {
            throw new Error('[grade-loop] plan has no steps and no applyPlan was provided')
        }

        // 4) Judge the rendered result against the origin.
        const after = await captureRender()
        judge = await judgeEdit({ projectId, prompt, plan: currentPlan, before, after, criticHistory: history })
        emit({ type: 'judge', iteration, overall: judge.overall, source: judge.source, cached: judge.cached })

        // 5) Critic — prefer the route's embedded verdict; recompute locally if absent.
        criticVerdict = judge.critic || critique({
            judgeJSON: { axes: judge.axes, corrective_hint: judge.correctiveHint },
            plan: currentPlan,
            beforeFeatures: before.features,
            afterFeatures: after.features,
            history,
        })

        if (criticVerdict.ok) {
            if (runId) await neon('mutation', 'agentRun.finish', { runId, status: 'succeeded', judgeScores: judge.axes, critic: criticVerdict, iteration })
            emit({ type: 'done', iteration, status: 'succeeded' })
            return { ok: true, status: 'succeeded', iterations: iteration, judge, critic: criticVerdict, runId, history }
        }

        history.push(criticVerdict.corrective)

        // Convergence guard: same axis failing twice → hand control back to the user.
        if (criticVerdict.escalate || iteration === maxIterations) {
            const status = criticVerdict.escalate ? 'needs-confirmation' : 'max-iterations'
            if (runId) await neon('mutation', 'agentRun.finish', { runId, status: 'halted', judgeScores: judge.axes, critic: criticVerdict, iteration })
            emit({ type: 'done', iteration, status })
            return { ok: false, status, iterations: iteration, judge, critic: criticVerdict, runId, history }
        }

        // 6) Corrective re-plan — surgical delta, not a regenerate.
        const criticFeedback = toCriticFeedback(criticVerdict.corrective)
        emit({ type: 'replan', iteration, criticFeedback })
        if (typeof replan === 'function') {
            currentPlan = await replan({ criticFeedback, previousPlan: currentPlan, validationErrors: null })
        } else if (criticFeedback?.deltas) {
            // Default surgical path: carry the previous plan, attach the deltas as
            // direct adjustments the executor applies ON TOP of current state.
            currentPlan = {
                ...currentPlan,
                criticFeedback,
                directAdjustments: criticFeedback.deltas,
                notes: [currentPlan?.notes, criticFeedback.notes].filter(Boolean).join(' | '),
            }
        } else {
            // Nothing actionable — stop rather than loop on hope.
            if (runId) await neon('mutation', 'agentRun.finish', { runId, status: 'halted', judgeScores: judge.axes, critic: criticVerdict, iteration })
            return { ok: false, status: 'no-actionable-corrective', iterations: iteration, judge, critic: criticVerdict, runId, history }
        }
    }

    return { ok: false, status: 'max-iterations', iterations: maxIterations, judge, critic: criticVerdict, runId, history }
}
