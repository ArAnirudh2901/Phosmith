/**
 * Chain folding — the algebra that lets the renderer skip the layers ABOVE the
 * one being edited.
 *
 * Every layer transforms the running state the same way for a given pixel:
 *
 *   colour   C → p·C + q                        (affine, p scalar, q vec3)
 *   alpha    A → clamp(α·A + β, lo, hi)         (α ≥ 0, so monotone)
 *   erase    E → max(E, e)
 *
 * All three families are closed under composition, so the whole run of layers
 * above the edited one collapses into ONE map per pixel. The renderer builds
 * that map once and then re-renders a single layer per frame, whatever the
 * chain depth.
 *
 * `overlay` is the exception: it is piecewise in A (two linear pieces around
 * A = 0.5), so a chain containing it above the edited layer cannot be folded
 * and the caller falls back to replaying those layers.
 *
 * Mirrors the GLSL in glsl-fragments.js exactly; scripts/verify-chain-fold.mjs
 * property-tests fold(chain) against a sequential evaluation.
 */

/** Ops whose alpha rule is a clamped affine map, i.e. everything but overlay. */
export const FOLDABLE_OPS = ['add', 'subtract', 'intersect', 'screen', 'lighten', 'darken', 'replace']

export const isFoldableOp = (op) => FOLDABLE_OPS.includes(op)

const clamp01 = (v) => Math.max(0, Math.min(1, v))

/** Identity maps: the state passes through untouched. */
export const identityColorMap = () => ({ p: 1, q: [0, 0, 0] })
export const identityAlphaMap = () => ({ alpha: 1, beta: 0, lo: 0, hi: 1 })

/**
 * One layer's colour map. `subtract` leaves the colour alone, `replace`
 * overwrites it, everything else mixes toward the layer colour by its alpha.
 *
 * @param {string} op
 * @param {number} a  layer alpha at this pixel, 0..1
 * @param {number[]} c  layer colour at this pixel
 */
export const layerColorMap = (op, a, c) => {
    if (op === 'subtract') return identityColorMap()
    if (op === 'replace') return { p: 0, q: [c[0], c[1], c[2]] }
    return { p: 1 - a, q: [a * c[0], a * c[1], a * c[2]] }
}

/**
 * One layer's alpha map as clamp(α·A + β, lo, hi). Returns null for `overlay`,
 * which is not affine in A.
 *
 * @param {string} op
 * @param {number} a
 * @returns {{alpha:number, beta:number, lo:number, hi:number}|null}
 */
export const layerAlphaMap = (op, a) => {
    switch (op) {
        case 'add': return { alpha: 1, beta: a, lo: 0, hi: 1 }
        case 'subtract': return { alpha: 1, beta: -a, lo: 0, hi: 1 }
        case 'intersect': return { alpha: a, beta: 0, lo: 0, hi: 1 }
        case 'screen': return { alpha: 1 - a, beta: a, lo: 0, hi: 1 }
        case 'lighten': return { alpha: 1, beta: 0, lo: a, hi: 1 }
        case 'darken': return { alpha: 1, beta: 0, lo: 0, hi: a }
        case 'replace': return { alpha: 0, beta: a, lo: 0, hi: 1 }
        default: return null   // overlay: piecewise, not foldable
    }
}

/** outer ∘ inner for colour maps: C → outer(inner(C)). */
export const composeColorMaps = (outer, inner) => ({
    p: outer.p * inner.p,
    q: [
        outer.p * inner.q[0] + outer.q[0],
        outer.p * inner.q[1] + outer.q[1],
        outer.p * inner.q[2] + outer.q[2],
    ],
})

/**
 * outer ∘ inner for clamped affine alpha maps. Valid because α ≥ 0 keeps the
 * maps monotone, so the outer clamp and the mapped inner clamp intersect into
 * a single interval. A crossed interval means the result is constant.
 */
export const composeAlphaMaps = (outer, inner) => {
    const alpha = outer.alpha * inner.alpha
    const beta = outer.alpha * inner.beta + outer.beta
    // The inner map lands in [inLo, inHi]; the outer one then clamps to its own
    // interval, so the composed interval is the intersection.
    const inLo = outer.alpha * inner.lo + outer.beta
    const inHi = outer.alpha * inner.hi + outer.beta
    let lo = Math.max(outer.lo, inLo)
    let hi = Math.min(outer.hi, inHi)
    if (lo > hi) {
        // Disjoint: the result is constant, and which constant depends on which
        // side the inner range fell on — the outer clamp decides.
        const constant = Math.max(outer.lo, Math.min(outer.hi, inLo))
        lo = constant
        hi = constant
    }
    return { alpha, beta, lo, hi }
}

export const applyColorMap = (map, c) => [
    map.p * c[0] + map.q[0],
    map.p * c[1] + map.q[1],
    map.p * c[2] + map.q[2],
]

export const applyAlphaMap = (map, a) => Math.max(map.lo, Math.min(map.hi, map.alpha * a + map.beta))

/**
 * Fold a run of layers into one colour map, one alpha map and one erase max.
 * `entries` are evaluated in chain order; each needs its per-pixel alpha and
 * colour already resolved (`{ op, a, c, erase }`, erase alpha for erase layers).
 *
 * @returns {{ color: object, alpha: object, erase: number, foldable: boolean }}
 *   foldable false means an op in the run is not affine (overlay); callers must
 *   replay those layers instead of folding them.
 */
export const foldRun = (entries) => {
    let color = identityColorMap()
    let alpha = identityAlphaMap()
    let erase = 0
    for (const entry of entries) {
        const isErase = entry.erase > 0
        const a = isErase ? 0 : entry.a
        const alphaMap = layerAlphaMap(entry.op, a)
        if (!alphaMap) return { color, alpha, erase, foldable: false }
        color = composeColorMaps(layerColorMap(entry.op, a, entry.c || [0, 0, 0]), color)
        alpha = composeAlphaMaps(alphaMap, alpha)
        erase = Math.max(erase, entry.erase || 0)
    }
    return { color, alpha, erase, foldable: true }
}

/**
 * Sequential reference: run the chain the way the GLSL does. Slot 0 acts as
 * `replace` (the compiler forces it), and erase layers contribute 0 to the
 * recolour alpha while feeding the erase channel.
 *
 * @param {Array<{op:string,a:number,c:number[],erase?:number}>} entries
 * @param {number[]} srcRgb
 * @returns {{ color:number[], alpha:number, erase:number }}
 */
export const evalChain = (entries, srcRgb) => {
    let color = [...srcRgb]
    let alpha = 0
    let erase = 0
    entries.forEach((entry, i) => {
        const op = i === 0 ? 'replace' : entry.op
        const isErase = (entry.erase || 0) > 0
        const a = isErase ? 0 : entry.a
        erase = Math.max(erase, entry.erase || 0)
        if (op === 'replace') {
            color = [...(entry.c || srcRgb)]
            alpha = a
            return
        }
        const map = layerAlphaMap(op, a)
        if (op !== 'subtract') color = applyColorMap(layerColorMap(op, a, entry.c || srcRgb), color)
        if (map) {
            alpha = applyAlphaMap(map, alpha)
        } else {
            // overlay, evaluated directly
            alpha = alpha < 0.5
                ? clamp01(2 * alpha * a)
                : clamp01(1 - 2 * (1 - alpha) * (1 - a))
        }
    })
    return { color, alpha, erase }
}

/**
 * The renderer's question: given a chain, an edited layer index and the state
 * below it, what does the final state look like? Folds everything above the
 * edited layer into maps and applies them.
 *
 * @param {Array} entries  full chain
 * @param {number} hot  index of the edited layer
 * @param {{color:number[], alpha:number, erase:number}} below  state before `hot`
 * @param {number[]} srcRgb
 */
export const evalWithFold = (entries, hot, below, srcRgb) => {
    const layer = entries[hot]
    const op = hot === 0 ? 'replace' : layer.op
    const isErase = (layer.erase || 0) > 0
    const a = isErase ? 0 : layer.a
    let color = op === 'subtract'
        ? [...below.color]
        : applyColorMap(layerColorMap(op, a, layer.c || srcRgb), below.color)
    if (op === 'replace') color = [...(layer.c || srcRgb)]
    const alphaMap = layerAlphaMap(op, a)
    let alpha = alphaMap ? applyAlphaMap(alphaMap, below.alpha) : below.alpha
    let erase = Math.max(below.erase, layer.erase || 0)

    const suffix = foldRun(entries.slice(hot + 1))
    if (!suffix.foldable) return null
    color = applyColorMap(suffix.color, color)
    alpha = applyAlphaMap(suffix.alpha, alpha)
    erase = Math.max(erase, suffix.erase)
    return { color, alpha, erase }
}
