/**
 * Plan Validator (pure function)
 * ------------------------------
 * Validates a planner/LLM-produced edit plan against the SAME vocabulary the
 * deterministic planner enforces (STYLE_KEYS, ADJUSTMENT_RANGES). Even the
 * best small models misfire roughly one tool call in six under adversarial
 * conditions — every plan that enters `runPlan` (or re-enters the planner as
 * a corrective) passes through here first, and invalid output bounces back
 * to the model with the validator's errors as a corrective prompt.
 *
 * @module agent/plan-validator
 */

// Relative import (not the @/ alias) so Node-based verify scripts can load
// this module directly, matching the megashader verifier pattern.
import { ADJUSTMENT_RANGES, STYLE_KEYS } from "../style-profiles"

export const VALIDATOR_VERSION = 1

const IMAGEKIT_AI_KEYS = new Set(["retouch", "bgRemove", "upscale", "sharpen", "contrast"])

/**
 * Validate a plan object (the shape `buildEditPlan` emits, or an LLM's
 * attempt at one). Returns `{ ok: true }` or `{ ok: false, errors: string[] }`
 * where each error is a precise, model-correctable sentence.
 */
export const validatePlan = (plan) => {
    const errors = []
    if (!plan || typeof plan !== "object") {
        return { ok: false, errors: ["plan must be a JSON object"] }
    }

    if (plan.targetStyle != null && !STYLE_KEYS.includes(plan.targetStyle)) {
        errors.push(`unknown targetStyle: ${JSON.stringify(plan.targetStyle)} (valid: ${STYLE_KEYS.join(", ")})`)
    }
    if (plan.currentStyle != null && !STYLE_KEYS.includes(plan.currentStyle)) {
        errors.push(`unknown currentStyle: ${JSON.stringify(plan.currentStyle)}`)
    }
    if (plan.gain != null) {
        const g = Number(plan.gain)
        if (!Number.isFinite(g) || g < 0 || g > 1) errors.push(`gain must be a number in [0,1]; got ${JSON.stringify(plan.gain)}`)
    }

    for (const [field, vec] of [["adjustments", plan.adjustments], ["directAdjustments", plan.directAdjustments]]) {
        if (vec == null) continue
        if (typeof vec !== "object" || Array.isArray(vec)) {
            errors.push(`${field} must be an object of { adjustmentKey: number }`)
            continue
        }
        for (const [k, v] of Object.entries(vec)) {
            const r = ADJUSTMENT_RANGES[k]
            if (!r) {
                errors.push(`unknown adjustment key in ${field}: ${k} (valid: ${Object.keys(ADJUSTMENT_RANGES).join(", ")})`)
                continue
            }
            const num = Number(v)
            if (!Number.isFinite(num)) {
                errors.push(`${field}.${k} must be a finite number; got ${JSON.stringify(v)}`)
            } else if (num < r.min || num > r.max) {
                errors.push(`${field}.${k}=${num} out of [${r.min},${r.max}]`)
            }
        }
    }

    if (plan.imagekitAi != null) {
        if (typeof plan.imagekitAi !== "object" || Array.isArray(plan.imagekitAi)) {
            errors.push("imagekitAi must be an object of booleans")
        } else {
            for (const k of Object.keys(plan.imagekitAi)) {
                if (!IMAGEKIT_AI_KEYS.has(k)) errors.push(`unknown imagekitAi key: ${k}`)
            }
        }
    }

    if (plan.steps != null) {
        if (!Array.isArray(plan.steps)) {
            errors.push("steps must be an array of { id, args }")
        } else {
            plan.steps.forEach((step, i) => {
                if (!step || typeof step !== "object") {
                    errors.push(`steps[${i}] must be an object`)
                } else if (typeof step.id !== "string" || step.id.indexOf(".") < 1) {
                    errors.push(`steps[${i}].id must be "<domain>.<name>"; got ${JSON.stringify(step.id)}`)
                } else if (step.args != null && (typeof step.args !== "object" || Array.isArray(step.args))) {
                    errors.push(`steps[${i}].args must be an object`)
                }
            })
        }
    }

    return errors.length ? { ok: false, errors } : { ok: true }
}

/**
 * Render validator errors as a corrective prompt suffix for the model retry.
 */
export const errorsToCorrectivePrompt = (errors) =>
    `Your previous plan was invalid:\n${(errors || []).map((e) => `- ${e}`).join("\n")}\nReturn a corrected JSON plan that fixes every error. Use only the valid keys and ranges listed.`
