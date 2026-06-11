/**
 * Agent Command Registry
 * ----------------------
 * The single, framework-agnostic seam through which the in-app AI agent will
 * eventually drive the website WITHOUT touching the UI. Each feature (masking,
 * adjust, crop, export, …) registers a set of imperative, UI-decoupled
 * "commands" here. An agent can then enumerate (`listCommands`) and invoke
 * (`runCommand`) them.
 *
 * IMPORTANT: This is the seam ONLY — no agent is wired to it yet. Building
 * features against this registry keeps the future agent integration a
 * one-file change (register the agent as a consumer of `listCommands` /
 * `runCommand`) instead of a refactor.
 *
 * Design goals:
 *   - Pure JS, no React. Commands operate on whatever runtime context they
 *     need (usually the live Fabric canvas), passed in at registration time.
 *   - Discoverable: the registry mirrors itself onto `window.__pixxel.agent`
 *     so a dev console (or a future agent bridge) can list + call commands.
 *   - Self-describing: every command carries a `description` + `params`
 *     schema so an LLM agent can choose + fill arguments.
 *
 * Command shape:
 *   {
 *     description: string,                 // one line, agent-facing
 *     params?: Record<string, string>,     // param name -> human/type hint
 *     run: (args, ctx) => any | Promise<any>
 *   }
 *
 * @module agent/command-registry
 */

import { beginAgentAction, endAgentAction, recordChange } from '@/lib/change-journal'

/** @type {Map<string, Map<string, object>>} domain -> (name -> def) */
const registry = new Map()

/** Read-only commands (queries/inspections) that shouldn't pollute the
 *  change history — everything else an agent runs is a change. */
const READ_ONLY_NAME = /^(list|get|detect|describe|inspect|status)/i

const summarizeArgs = (args) => {
    try {
        const str = JSON.stringify(args)
        return str && str !== '{}' ? str.slice(0, 160) : undefined
    } catch {
        return undefined
    }
}

const syncWindow = () => {
    if (typeof window === 'undefined') return
    window.__pixxel = window.__pixxel || {}
    window.__pixxel.agent = { listCommands, getCommand, runCommand, runPlan, registerCommand, registerDomain }
}

/**
 * Register a single command. Returns an unregister function.
 *
 * @param {string} domain   e.g. 'mask'
 * @param {string} name     e.g. 'addLuminance'
 * @param {{ description?: string, params?: object, run: Function }} def
 * @returns {() => void}
 */
export const registerCommand = (domain, name, def) => {
    if (!domain || !name || !def || typeof def.run !== 'function') return () => {}
    if (!registry.has(domain)) registry.set(domain, new Map())
    registry.get(domain).set(name, def)
    syncWindow()
    return () => {
        registry.get(domain)?.delete(name)
        if (registry.get(domain)?.size === 0) registry.delete(domain)
        syncWindow()
    }
}

/**
 * Register a whole domain at once from a `{ name: def }` map. Returns a
 * single unregister function that removes them all (use in a React cleanup).
 *
 * @param {string} domain
 * @param {Record<string, { description?: string, params?: object, run: Function }>} defs
 * @returns {() => void}
 */
export const registerDomain = (domain, defs) => {
    const unregs = Object.entries(defs || {}).map(([name, def]) => registerCommand(domain, name, def))
    return () => unregs.forEach((u) => u())
}

/**
 * Enumerate every registered command — the agent's discovery surface.
 *
 * @returns {Array<{ id: string, domain: string, name: string, description: string, params: object }>}
 */
export const listCommands = () => {
    const out = []
    for (const [domain, cmds] of registry) {
        for (const [name, def] of cmds) {
            out.push({ id: `${domain}.${name}`, domain, name, description: def.description || '', params: def.params || {} })
        }
    }
    return out
}

/**
 * Look up a command def by domain + name.
 * @param {string} domain
 * @param {string} name
 */
export const getCommand = (domain, name) => registry.get(domain)?.get(name) || null

/**
 * Invoke a command by its dotted id (e.g. 'mask.addLuminance').
 *
 * @param {string} id        '<domain>.<name>'
 * @param {object} [args]     command arguments
 * @param {object} [ctx]      optional runtime context passed to run()
 * @returns {Promise<any>}
 */
export const runCommand = async (id, args = {}, ctx = {}) => {
    const idx = String(id).indexOf('.')
    if (idx < 0) throw new Error(`[agent] command id must be "<domain>.<name>": ${id}`)
    const domain = id.slice(0, idx)
    const name = id.slice(idx + 1)
    const def = getCommand(domain, name)
    if (!def) throw new Error(`[agent] unknown command: ${id}`)

    // Everything inside a command execution is agent-attributed — including
    // nested history pushes and mask-stack mutations the command triggers.
    // The journal flag is refcounted, so nested runCommand calls are safe.
    beginAgentAction()
    try {
        const out = await def.run(args || {}, ctx || {})
        if (!READ_ONLY_NAME.test(name) && !args?.dryRun) {
            recordChange({
                label: id,
                detail: summarizeArgs(args),
                source: 'agent',
                domain,
            })
        }
        return out
    } finally {
        endAgentAction()
    }
}

/**
 * Drive a multi-step plan through the registry with per-step validation,
 * bounded retry, and observable per-step events — the executor half of the
 * planner-executor-critic loop.
 *
 * Each step is `{ id: '<domain>.<name>', args?: object }`. Steps run
 * SEQUENTIALLY (mask-chain mutations are order-dependent). A step that still
 * fails after `maxRetries` attempts HALTS the run — partial results are
 * returned so the critic can re-plan from what actually happened instead of
 * what was intended.
 *
 * Resumability: pass `startAt` (e.g. from a persisted agentRun row's
 * stepIndex) to skip already-completed steps after a crash.
 *
 * @param {{ steps: Array<{id: string, args?: object}> }} plan
 * @param {object} [ctx]    runtime context forwarded to every command
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=3]  attempts per step beyond the first
 * @param {number} [opts.startAt=0]     resume index (skip completed steps)
 * @param {(ev: {stepIndex:number,id:string,status:'ok'|'retry'|'failed'|'skipped',attempt:number,out?:any,error?:string}) => void} [opts.onStep]
 * @returns {Promise<{ok: boolean, halted: boolean, results: Array}>}
 */
export const runPlan = async (plan, ctx = {}, opts = {}) => {
    const { maxRetries = 3, startAt = 0, onStep } = opts
    const steps = Array.isArray(plan?.steps) ? plan.steps : []
    const results = []

    for (const [i, step] of steps.entries()) {
        if (i < startAt) {
            results.push({ stepIndex: i, id: step?.id, status: 'skipped' })
            onStep?.({ stepIndex: i, id: step?.id, status: 'skipped', attempt: 0 })
            continue
        }
        const id = step?.id
        if (typeof id !== 'string' || id.indexOf('.') < 1) {
            const error = `[agent] invalid step id at ${i}: ${JSON.stringify(id)}`
            results.push({ stepIndex: i, id, status: 'failed', error })
            onStep?.({ stepIndex: i, id, status: 'failed', attempt: 0, error })
            return { ok: false, halted: true, results }
        }

        let attempt = 0
        let lastErr = null
        let done = false
        while (attempt <= maxRetries) {
            try {
                const out = await runCommand(id, step.args || {}, ctx)
                results.push({ stepIndex: i, id, status: 'ok', attempt, out })
                onStep?.({ stepIndex: i, id, status: 'ok', attempt, out })
                done = true
                break
            } catch (e) {
                lastErr = e
                attempt += 1
                if (attempt <= maxRetries) {
                    onStep?.({ stepIndex: i, id, status: 'retry', attempt, error: String(e?.message || e) })
                }
            }
        }
        if (!done) {
            const error = String(lastErr?.message || lastErr)
            results.push({ stepIndex: i, id, status: 'failed', attempt, error })
            onStep?.({ stepIndex: i, id, status: 'failed', attempt, error })
            // Halt: let the critic see partial reality and re-plan.
            return { ok: false, halted: true, results }
        }
    }
    return { ok: true, halted: false, results }
}

// Expose immediately (idempotent) so the console / future agent bridge can
// reach the registry even before any domain registers.
syncWindow()
