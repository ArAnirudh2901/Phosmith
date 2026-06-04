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

/** @type {Map<string, Map<string, object>>} domain -> (name -> def) */
const registry = new Map()

const syncWindow = () => {
    if (typeof window === 'undefined') return
    window.__pixxel = window.__pixxel || {}
    window.__pixxel.agent = { listCommands, getCommand, runCommand, registerCommand, registerDomain }
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
    return def.run(args || {}, ctx || {})
}

// Expose immediately (idempotent) so the console / future agent bridge can
// reach the registry even before any domain registers.
syncWindow()
