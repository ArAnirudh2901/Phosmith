/**
 * canvas-change-describe
 * ----------------------
 * Pure classifier for canvas change events: given a Fabric event it answers
 * two questions the editor (and later the agent) needs:
 *
 *   1. WHAT happened, in human words — "Moved image", "Added text", … so the
 *      History panel can show meaningful entries instead of "Canvas edit".
 *   2. HOW MUCH happened — 'none' | 'minor' | 'major'. A 1-2px accidental
 *      nudge is a real state change that must eventually persist, but it is
 *      NOT a "main change": it should neither pollute the undo stack /
 *      History panel nor trigger the fast autosave→snapshot→flush network
 *      path. The caller routes 'minor' changes to a slow trickle save.
 *
 * Fabric v7 semantics this relies on (verified against the installed
 * node_modules/fabric source):
 *   - USER gestures fire 'object:modified' with { e, transform, target,
 *     action }, where transform.original holds the pre-gesture left/top/
 *     scaleX/scaleY/angle/skewX/skewY and action is one of 'drag'/'moving',
 *     'scale'/'scaleX'/'scaleY', 'rotate', 'skew*', 'resizing'.
 *   - PROGRAMMATIC fires from tools carry only { target } — no transform.
 *     Those are always deliberate, so they classify as 'major'.
 *   - 'object:added' / 'object:removed' / 'text:changed' carry only
 *     { target }.
 *
 * Headless-safe: no fabric import, the event/target are duck-typed (the
 * verify script exercises this under bun/node with plain objects).
 */

// A move below max(MINOR_MOVE_PX, size × MINOR_MOVE_FRACTION) is "minor":
// the absolute floor catches small objects, the fraction scales the tolerance
// up for large images where a few px is visually nothing.
export const MINOR_MOVE_PX = 3
export const MINOR_MOVE_FRACTION = 0.005
// Scale changes under 1% and rotations/skews under 1° are "minor".
export const MINOR_SCALE_FRACTION = 0.01
export const MINOR_ROTATE_DEG = 1
// Below these the gesture effectively didn't change anything → 'none'.
const EPSILON_PX = 0.01
const EPSILON_FRACTION = 0.0001
const EPSILON_DEG = 0.01

const KIND_BY_TYPE = {
    image: 'image',
    text: 'text',
    'i-text': 'text',
    itext: 'text',
    textbox: 'text',
    rect: 'shape',
    circle: 'shape',
    ellipse: 'shape',
    triangle: 'shape',
    polygon: 'shape',
    polyline: 'shape',
    line: 'shape',
    path: 'drawing',
    group: 'group',
    activeselection: 'selection',
}

/** Human noun for a fabric object ('image', 'text', 'shape', …). */
export const describeObjectKind = (target) => {
    const type = String(target?.type || '').toLowerCase()
    return KIND_BY_TYPE[type] || 'object'
}

const VERB_BY_ACTION = {
    drag: 'Moved',
    moving: 'Moved',
    scale: 'Resized',
    scaleX: 'Resized',
    scaleY: 'Resized',
    resizing: 'Resized',
    rotate: 'Rotated',
    skew: 'Skewed',
    skewX: 'Skewed',
    skewY: 'Skewed',
}

const normalizeAngleDelta = (a, b) => {
    let d = Math.abs((Number(a) || 0) - (Number(b) || 0)) % 360
    if (d > 180) d = 360 - d
    return d
}

// Rendered size of the object in canvas units — the scale-aware footprint the
// move tolerance is measured against.
const renderedSize = (target) => {
    const w = Math.abs((Number(target?.width) || 0) * (Number(target?.scaleX) || 1))
    const h = Math.abs((Number(target?.height) || 0) * (Number(target?.scaleY) || 1))
    return Math.max(w, h)
}

/**
 * How big was a user transform gesture? → 'none' | 'minor' | 'major'.
 * Programmatic events (no transform.original) are always 'major' — a tool
 * fired them deliberately.
 */
export const assessTransformSignificance = (event) => {
    const transform = event?.transform
    const original = transform?.original
    const target = event?.target
    if (!transform || !original || !target) return 'major'

    const action = String(event?.action || transform.action || '')

    if (action === 'drag' || action === 'moving') {
        const delta = Math.max(
            Math.abs((Number(target.left) || 0) - (Number(original.left) || 0)),
            Math.abs((Number(target.top) || 0) - (Number(original.top) || 0)),
        )
        if (delta < EPSILON_PX) return 'none'
        const tolerance = Math.max(MINOR_MOVE_PX, renderedSize(target) * MINOR_MOVE_FRACTION)
        return delta < tolerance ? 'minor' : 'major'
    }

    if (action === 'scale' || action === 'scaleX' || action === 'scaleY') {
        const relX = original.scaleX ? Math.abs((Number(target.scaleX) || 0) / original.scaleX - 1) : 1
        const relY = original.scaleY ? Math.abs((Number(target.scaleY) || 0) / original.scaleY - 1) : 1
        const rel = Math.max(relX, relY)
        if (rel < EPSILON_FRACTION) return 'none'
        return rel < MINOR_SCALE_FRACTION ? 'minor' : 'major'
    }

    if (action === 'rotate') {
        const delta = normalizeAngleDelta(target.angle, original.angle)
        if (delta < EPSILON_DEG) return 'none'
        return delta < MINOR_ROTATE_DEG ? 'minor' : 'major'
    }

    if (action === 'skew' || action === 'skewX' || action === 'skewY') {
        const delta = Math.max(
            Math.abs((Number(target.skewX) || 0) - (Number(original.skewX) || 0)),
            Math.abs((Number(target.skewY) || 0) - (Number(original.skewY) || 0)),
        )
        if (delta < EPSILON_DEG) return 'none'
        return delta < MINOR_ROTATE_DEG ? 'minor' : 'major'
    }

    // Unknown/compound gesture ('resizing' textbox drags, future actions) —
    // assume it matters rather than silently dropping it from history.
    return 'major'
}

/**
 * Classify a canvas change event.
 *
 * @param {'object:modified'|'object:added'|'object:removed'|'text:changed'} eventName
 * @param {object} event fabric event payload ({ target, transform?, action? })
 * @returns {{ kind: string, label: string, significance: 'none'|'minor'|'major', coalesceKey: string }}
 */
export const describeCanvasChange = (eventName, event) => {
    const kind = describeObjectKind(event?.target)

    if (eventName === 'object:added') {
        return { kind, label: `Added ${kind}`, significance: 'major', coalesceKey: `added:${kind}` }
    }
    if (eventName === 'object:removed') {
        return { kind, label: `Removed ${kind}`, significance: 'major', coalesceKey: `removed:${kind}` }
    }
    if (eventName === 'text:changed') {
        return { kind: 'text', label: 'Edited text', significance: 'major', coalesceKey: 'text:edited' }
    }

    const significance = assessTransformSignificance(event)
    const action = String(event?.action || event?.transform?.action || '')
    const verb = VERB_BY_ACTION[action] || 'Edited'
    return {
        kind,
        label: `${verb} ${kind}`,
        significance,
        coalesceKey: `${verb.toLowerCase()}:${kind}`,
    }
}
