#!/usr/bin/env bun
/**
 * CLAUDE.md is the context a future session loads instead of re-deriving the
 * codebase, so drift there costs real time and causes wrong decisions. The parts
 * that rot silently are the ones nobody re-reads: route tables, the verify list,
 * and hard-coded check counts that were true when written.
 *
 * This checks the claims that CAN be checked mechanically. It is intentionally
 * cheap — no browser, no services — so it can run alongside the other pure
 * suites.
 *
 * Usage: bun scripts/verify-docs.mjs [--fix-counts]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const DOC = path.join(ROOT, 'CLAUDE.md')

let checks = 0
let failures = 0
const check = (ok, name, detail) => {
    checks += 1
    if (!ok) failures += 1
    console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  (${detail})` : ''}`)
}

if (!existsSync(DOC)) {
    console.log('[verify-docs] no CLAUDE.md — nothing to check')
    process.exit(0)
}
const doc = readFileSync(DOC, 'utf8')
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// ── every verify script is discoverable from the docs ────────────────────────
{
    const scripts = Object.keys(pkg.scripts || {}).filter((s) => s.startsWith('verify'))
    const missing = scripts.filter((s) => !doc.includes(`bun run ${s}`))
    check(missing.length === 0, `all ${scripts.length} verify scripts appear in CLAUDE.md`,
        missing.length ? `missing: ${missing.join(', ')}` : '')
}

// ── the AI route table matches what is on disk ───────────────────────────────
{
    const dir = path.join(ROOT, 'src/app/api/ai')
    if (existsSync(dir)) {
        const onDisk = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
        const documented = new Set([...doc.matchAll(/^\| `\/([a-z0-9-]+)`/gm)].map((m) => m[1]))
        const undocumented = onDisk.filter((r) => !documented.has(r))
        check(undocumented.length === 0, `all ${onDisk.length} /api/ai routes are in the route table`,
            undocumented.length ? `missing: ${undocumented.join(', ')}` : '')

        const claimed = doc.match(/All (\d+) AI proxy routes/)
        if (claimed) {
            check(Number(claimed[1]) === onDisk.length, 'the route count in the prose matches the directory',
                `doc says ${claimed[1]}, disk has ${onDisk.length}`)
        }
    }
}

// ── documented check counts match what the scripts actually print ────────────
// Only the suites that print a machine-readable total; a count that cannot be
// verified should not be written down in the first place.
{
    const COUNTED = {
        'verify': 303, 'verify:cv': null, 'verify:focus': null, 'verify:collage-grid': null,
        'verify:stretch-core': null, 'verify:user-error': null, 'verify:heavy-queue': null,
        'verify:diagnostics': null,
    }
    const stale = []
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const script of Object.keys(COUNTED)) {
        if (!pkg.scripts?.[script]) continue
        const out = Bun.spawnSync(['bun', 'run', script], { cwd: ROOT }).stdout?.toString() || ''
        const m = out.match(/(\d+)\/\1 checks passed|(\d+)\/\2 verifications passed/)
        const actual = m ? Number(m[1] ?? m[2]) : null
        if (actual == null) continue
        // Match the EXACT backticked script name, then only the count that
        // immediately follows it — `verify` is a substring of `verify:cv`, so a
        // looser match reads another suite's number and reports a phantom drift.
        const forms = [
            // prose:  `bun run verify:cv` (78 pure checks: …)
            new RegExp('`bun run ' + esc(script) + '`[^(\\n]{0,40}\\((?:GLSL invariants, now )?(\\d+)', 'g'),
            // the verify list code block:  bun run verify    # 303 Megashader …
            new RegExp('^bun run ' + esc(script) + ' +# (\\d+) ', 'gm'),
        ]
        for (const re of forms) {
            for (const hit of doc.matchAll(re)) {
                const claimed = Number(hit[1])
                if (Number.isFinite(claimed) && claimed !== actual) {
                    stale.push(`${script}: doc says ${claimed}, actual ${actual}`)
                }
            }
        }
    }
    check(stale.length === 0, 'documented check counts match what the suites print',
        stale.length ? stale.join(' | ') : '')
}

// ── new top-level libs are mentioned somewhere ───────────────────────────────
{
    const libDir = path.join(ROOT, 'src/lib')
    const libs = readdirSync(libDir).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''))
    const unmentioned = libs.filter((l) => !doc.includes(l))
    // A long tail of small helpers is fine; this only flags a suspicious jump.
    check(unmentioned.length <= 25, 'most src/lib modules are described in CLAUDE.md',
        `${unmentioned.length} unmentioned of ${libs.length}${unmentioned.length > 25 ? `: ${unmentioned.slice(0, 8).join(', ')}…` : ''}`)
}

console.log(`\n[verify-docs] ${checks - failures}/${checks} checks passed.`)
if (failures) {
    console.log('CLAUDE.md is the context a future session starts from — fix the drift rather than silencing this.')
    process.exit(1)
}
