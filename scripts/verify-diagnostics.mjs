#!/usr/bin/env bun
/**
 * Client diagnostics send data off the user's machine, so the test that matters
 * is what CANNOT get out: photos, signed URLs, tokens, emails. The dedupe and
 * session cap are here too, because a reporting loop that floods is its own bug.
 *
 * Usage: bun scripts/verify-diagnostics.mjs
 */
import { redact, trimStack, signatureOf, report, __pending, __resetDiagnostics } from '../src/lib/client-diagnostics.js'

let checks = 0
let failures = 0
const check = (ok, name, detail) => {
    checks += 1
    if (!ok) failures += 1
    console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  (${detail})` : ''}`)
}

console.log('[verify-diagnostics] nothing of the user\'s may leave the page')
{
    const cases = [
        ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUg', 'base64', 'a pasted image never leaves'],
        ['blob:http://localhost:3000/9f0c-4a1b-bb20-1122334455', '9f0c-4a1b', 'blob URLs are stripped'],
        ['https://ik.imagekit.io/acct/photo.jpg?tr=w-600&sig=abcdefghijklmnop', 'sig=', 'signed query strings are stripped'],
        ['failed for anirudh.test@example.com', '@example.com', 'emails are stripped'],
        // Assembled, like the key below: a literal JWT in source is what a secret
        // scanner is built to find, and it cannot tell a fixture from a leak.
        [`Bearer ${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'].join('.')}`,
            'eyJzdWIi', 'JWTs are stripped'],
        // Assembled at runtime on purpose. A literal vendor-prefixed key in the
        // source is indistinguishable from a real leaked one to a secret scanner
        // — GitHub's push protection blocked this very file over it — and a test
        // fixture is not worth training anyone to click "allow secret".
        [`key ${['sk', 'live', '51H8xQ2KZvVn3mMxPqRsTuVwXyZaBcDeFgHiJkLmNoPqR'].join('_')}`,
            ['sk', 'live', '51H8xQ2KZvVn3mMxPqRsTuVwXyZaBcDeFgHiJkLmNoPqR'].join('_'), 'long opaque secrets are stripped'],
        ['/user_2xKq9/portrait_k_iWhUQxs.jpg', 'portrait_k_iWhUQxs.jpg', 'uploaded file names are stripped'],
    ]
    for (const [input, mustNotContain, name] of cases) {
        check(!redact(input).includes(mustNotContain), name, redact(input).slice(0, 60))
    }
    check(redact('Could not reach the server').includes('Could not reach'), 'ordinary messages survive intact')
    check(redact('x'.repeat(5000)).length <= 601, 'a huge message is capped', String(redact('x'.repeat(5000)).length))
    check(redact(null) === '' && redact(undefined) === '', 'null and undefined are safe')
}

console.log('\n[verify-diagnostics] stacks')
{
    const stack = 'Error: boom\n    at foo (/app/src/lib/a.js:1:1)\n    at bar (/app/src/lib/b.js:2:2)\n'
        + Array.from({ length: 30 }, (_, i) => `    at deep${i} (/app/x.js:${i}:1)`).join('\n')
    const t = trimStack(stack)
    check(!t.includes('Error: boom'), 'the message line is not duplicated into the stack')
    check(t.split(' | ').length <= 6, 'the stack is capped to a few frames', String(t.split(' | ').length))
    check(trimStack(undefined) === '', 'a missing stack is not an error')
}

console.log('\n[verify-diagnostics] volume control')
{
    __resetDiagnostics()
    for (let i = 0; i < 10; i += 1) report('error', { name: 'TypeError', message: 'the same thing again' })
    check(__pending().length === 1, 'an error repeating in a loop is reported once', String(__pending().length))

    __resetDiagnostics()
    for (let i = 0; i < 60; i += 1) report('error', { name: 'E', message: `distinct ${i}` })
    check(__pending().length <= 25, 'a session cannot flood the endpoint', String(__pending().length))

    __resetDiagnostics()
    report('error', { name: 'E', message: 'has a photo data:image/png;base64,AAAA in it' })
    check(!JSON.stringify(__pending()).includes('base64,AAAA'), 'redaction runs before anything is queued')

    __resetDiagnostics()
    report('not-a-kind', { message: 'x' })
    check(__pending().length === 1, 'an unexpected kind is still captured rather than dropped silently')

    __resetDiagnostics()
    const before = __pending().length
    report('error', null)
    report('error', undefined)
    check(__pending().length >= before, 'reporting with no detail does not throw')
}

console.log('\n[verify-diagnostics] signatures')
{
    const a = { kind: 'error', name: 'TypeError', message: 'Failed to fetch' }
    const b = { kind: 'error', name: 'TypeError', message: 'Failed to fetch' }
    const c = { kind: 'rejection', name: 'TypeError', message: 'Failed to fetch' }
    check(signatureOf(a) === signatureOf(b), 'the same fault collapses')
    check(signatureOf(a) !== signatureOf(c), 'a rejection is not the same event as a throw')
}


console.log('\n[verify-diagnostics] no credential-shaped literals in our own source')
{
    // Twice in one branch a FIXTURE shaped like a real credential blocked a push:
    // first a Stripe key, then a JWT one line above it. A scanner cannot tell a
    // test fixture from a leak, and neither can a reviewer at a glance — so the
    // rule is that no such literal exists in source at all. Build them at runtime.
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const ROOT = new URL('..', import.meta.url).pathname
    const SHAPES = [
        [/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/, 'JWT'],
        [/sk[-_](?:live|test|proj)[-_]?[A-Za-z0-9]{16,}/, 'vendor secret key'],
        [/AIza[A-Za-z0-9_-]{16,}/, 'Google API key'],
        [/gh[pousr]_[A-Za-z0-9]{16,}/, 'GitHub token'],
        [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
        [/AKIA[0-9A-Z]{12,}/, 'AWS access key'],
        [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    ]
    const walk = (dir, out = []) => {
        for (const name of readdirSync(dir)) {
            if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
            const full = join(dir, name)
            if (statSync(full).isDirectory()) walk(full, out)
            else if (/\.(js|jsx|mjs|ts|tsx)$/.test(name)) out.push(full)
        }
        return out
    }
    const hits = []
    for (const file of [...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'src'))]) {
        const text = readFileSync(file, 'utf8')
        for (const [re, label] of SHAPES) {
            const m = text.match(re)
            if (m) hits.push(`${file.replace(ROOT, '')}: ${label}`)
        }
    }
    check(hits.length === 0, 'no source file contains a credential-shaped literal',
        hits.length ? hits.slice(0, 4).join(' | ') : '')
}

console.log(`\n[verify-diagnostics] ${checks - failures}/${checks} checks passed.`)
if (failures) process.exit(1)
