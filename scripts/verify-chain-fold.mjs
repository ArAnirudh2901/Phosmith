#!/usr/bin/env node
/**
 * Property tests for the chain-folding algebra (src/lib/megashader/chain-fold.js).
 *
 * The renderer skips the layers above the one being edited by collapsing them
 * into one colour map, one alpha map and one erase max. That is only safe if
 * folding is exactly equal to running the layers one by one, so this script
 * hammers random chains and compares fold against a sequential evaluation.
 *
 * Usage: bun scripts/verify-chain-fold.mjs
 */

import {
    FOLDABLE_OPS,
    applyAlphaMap,
    applyColorMap,
    composeAlphaMaps,
    composeColorMaps,
    evalChain,
    evalWithFold,
    foldRun,
    identityAlphaMap,
    identityColorMap,
    isFoldableOp,
    layerAlphaMap,
    layerColorMap,
} from '../src/lib/megashader/chain-fold.js'

let failures = 0
const check = (label, cond, detail = '') => {
    if (cond) console.log(`[verify-chain-fold] ok ${label}`)
    else { failures += 1; console.error(`[verify-chain-fold] ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

// Deterministic RNG so a failure is reproducible.
let seed = 20260921
const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
}
const randColor = () => [rand(), rand(), rand()]
const EPS = 1e-6
const close = (a, b, eps = EPS) => Math.abs(a - b) <= eps
const colorsClose = (a, b, eps = EPS) => a.every((v, i) => close(v, b[i], eps))

const randomChain = (n, { ops = FOLDABLE_OPS, eraseChance = 0 } = {}) =>
    Array.from({ length: n }, () => ({
        op: ops[Math.floor(rand() * ops.length)],
        a: rand(),
        c: randColor(),
        erase: rand() < eraseChance ? rand() : 0,
    }))

// ── identities ─────────────────────────────────────────────────────────────
{
    const c = randColor()
    check('identity colour map is a no-op', colorsClose(applyColorMap(identityColorMap(), c), c))
    check('identity alpha map is a no-op', close(applyAlphaMap(identityAlphaMap(), 0.42), 0.42))
    check('every op except overlay is foldable',
        FOLDABLE_OPS.every(isFoldableOp) && !isFoldableOp('overlay') && layerAlphaMap('overlay', 0.5) === null)
}

// ── composition equals sequential application, per family ──────────────────
{
    let worstColor = 0
    let worstAlpha = 0
    for (let trial = 0; trial < 20000; trial += 1) {
        const op1 = FOLDABLE_OPS[Math.floor(rand() * FOLDABLE_OPS.length)]
        const op2 = FOLDABLE_OPS[Math.floor(rand() * FOLDABLE_OPS.length)]
        const a1 = rand()
        const a2 = rand()
        const c1 = randColor()
        const c2 = randColor()
        const startC = randColor()
        const startA = rand()

        const seqC = applyColorMap(layerColorMap(op2, a2, c2), applyColorMap(layerColorMap(op1, a1, c1), startC))
        const foldC = applyColorMap(
            composeColorMaps(layerColorMap(op2, a2, c2), layerColorMap(op1, a1, c1)),
            startC,
        )
        worstColor = Math.max(worstColor, ...seqC.map((v, i) => Math.abs(v - foldC[i])))

        const seqA = applyAlphaMap(layerAlphaMap(op2, a2), applyAlphaMap(layerAlphaMap(op1, a1), startA))
        const foldA = applyAlphaMap(composeAlphaMaps(layerAlphaMap(op2, a2), layerAlphaMap(op1, a1)), startA)
        worstAlpha = Math.max(worstAlpha, Math.abs(seqA - foldA))
    }
    check('composed colour maps match two sequential applications (20k pairs)', worstColor < EPS, `worst ${worstColor}`)
    check('composed alpha maps match two sequential applications (20k pairs)', worstAlpha < EPS, `worst ${worstAlpha}`)
}

// ── folding a whole run equals running it layer by layer ───────────────────
{
    let worst = 0
    let worstAlpha = 0
    for (let trial = 0; trial < 5000; trial += 1) {
        const n = 1 + Math.floor(rand() * 12)
        const run = randomChain(n)
        const startC = randColor()
        const startA = rand()

        let seqC = [...startC]
        let seqA = startA
        for (const entry of run) {
            seqC = applyColorMap(layerColorMap(entry.op, entry.a, entry.c), seqC)
            seqA = applyAlphaMap(layerAlphaMap(entry.op, entry.a), seqA)
        }
        const folded = foldRun(run)
        const foldC = applyColorMap(folded.color, startC)
        const foldA = applyAlphaMap(folded.alpha, startA)
        worst = Math.max(worst, ...seqC.map((v, i) => Math.abs(v - foldC[i])))
        worstAlpha = Math.max(worstAlpha, Math.abs(seqA - foldA))
    }
    check('folded run matches layer-by-layer colour (5k chains, ≤12 layers)', worst < 1e-5, `worst ${worst}`)
    check('folded run matches layer-by-layer alpha (5k chains, ≤12 layers)', worstAlpha < 1e-5, `worst ${worstAlpha}`)
}

// ── the renderer's actual question: edit layer k in an N-layer chain ────────
{
    let worstColor = 0
    let worstAlpha = 0
    let worstErase = 0
    let cases = 0
    for (let trial = 0; trial < 5000; trial += 1) {
        const n = 2 + Math.floor(rand() * 30)
        const chain = randomChain(n, { eraseChance: 0.15 })
        const hot = Math.floor(rand() * n)
        const src = randColor()

        // State below the edited layer, exactly as the prefix cache holds it.
        const below = hot === 0
            ? { color: [...src], alpha: 0, erase: 0 }
            : evalChain(chain.slice(0, hot), src)

        const direct = evalChain(chain, src)
        const folded = evalWithFold(chain, hot, below, src)
        if (!folded) continue
        cases += 1
        worstColor = Math.max(worstColor, ...direct.color.map((v, i) => Math.abs(v - folded.color[i])))
        worstAlpha = Math.max(worstAlpha, Math.abs(direct.alpha - folded.alpha))
        worstErase = Math.max(worstErase, Math.abs(direct.erase - folded.erase))
    }
    check('fold reproduces the full chain — colour (5k chains up to 31 layers)', worstColor < 1e-5, `worst ${worstColor}`)
    check('fold reproduces the full chain — alpha', worstAlpha < 1e-5, `worst ${worstAlpha}`)
    check('fold reproduces the full chain — erase', worstErase < 1e-9, `worst ${worstErase}`)
    check('every random chain was foldable', cases === 5000, `${cases}/5000`)
}

// ── overlay must refuse to fold, and only above the edited layer ───────────
{
    const withOverlay = [
        { op: 'replace', a: 0.5, c: [0.2, 0.3, 0.4], erase: 0 },
        { op: 'add', a: 0.4, c: [0.6, 0.2, 0.1], erase: 0 },
        { op: 'overlay', a: 0.7, c: [0.1, 0.9, 0.5], erase: 0 },
    ]
    check('a run containing overlay reports itself unfoldable', foldRun(withOverlay).foldable === false)
    check('overlay above the edited layer blocks folding',
        evalWithFold(withOverlay, 0, { color: [0, 0, 0], alpha: 0, erase: 0 }, [0.5, 0.5, 0.5]) === null)
    // Overlay BELOW the edited layer is fine: it is already baked into the state.
    const hotAbove = evalWithFold(withOverlay, 2, evalChain(withOverlay.slice(0, 2), [0.5, 0.5, 0.5]), [0.5, 0.5, 0.5])
    check('overlay below the edited layer still folds', hotAbove !== null)
}

// ── degenerate clamps stay consistent ──────────────────────────────────────
{
    // darken to 0 then lighten to 1 crosses the interval; both paths must agree.
    const chain = [
        { op: 'replace', a: 0.8, c: [0.5, 0.5, 0.5], erase: 0 },
        { op: 'darken', a: 0, c: [0, 0, 0], erase: 0 },
        { op: 'lighten', a: 1, c: [1, 1, 1], erase: 0 },
        { op: 'intersect', a: 0.3, c: [0.2, 0.2, 0.2], erase: 0 },
    ]
    const src = [0.4, 0.4, 0.4]
    const direct = evalChain(chain, src)
    const folded = evalWithFold(chain, 1, evalChain(chain.slice(0, 1), src), src)
    check('crossed clamp intervals fold correctly',
        folded && close(direct.alpha, folded.alpha) && colorsClose(direct.color, folded.color),
        `direct ${JSON.stringify(direct)} fold ${JSON.stringify(folded)}`)
}

// ── erase layers ───────────────────────────────────────────────────────────
{
    const chain = [
        { op: 'replace', a: 0.6, c: [0.3, 0.3, 0.3], erase: 0 },
        { op: 'add', a: 0.5, c: [0.7, 0.1, 0.1], erase: 0.9 },   // erase layer
        { op: 'intersect', a: 0.4, c: [0.2, 0.8, 0.2], erase: 0 },
    ]
    const src = [0.5, 0.5, 0.5]
    const direct = evalChain(chain, src)
    const folded = evalWithFold(chain, 0, { color: [...src], alpha: 0, erase: 0 }, src)
    check('erase layers contribute 0 alpha but keep their knockout',
        folded && close(direct.erase, folded.erase) && close(direct.alpha, folded.alpha),
        `direct ${JSON.stringify(direct)} fold ${JSON.stringify(folded)}`)
}

if (failures > 0) {
    console.error(`\n[verify-chain-fold] ✗ ${failures} check(s) failed`)
    process.exit(1)
}
console.log('\n[verify-chain-fold] ✓ all checks passed')
