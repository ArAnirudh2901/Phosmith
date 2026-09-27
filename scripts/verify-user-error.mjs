#!/usr/bin/env bun
/**
 * The error humaniser is in front of every toast in the editor, so a regression
 * here is a regression in ~35 user-facing messages at once.
 *
 * Usage: bun scripts/verify-user-error.mjs
 */
import { toUserMessage } from '../src/lib/user-error.js'

let checks = 0
let failures = 0
const check = (ok, name, detail) => {
    checks += 1
    if (!ok) failures += 1
    console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  (${detail})` : ''}`)
}
const FB = 'Could not apply that'

check(toUserMessage(new TypeError('Failed to fetch'), FB).includes('connection'),
    'a dropped connection reads as a connection problem, not "Failed to fetch"')
check(toUserMessage(Object.assign(new Error('Load failed'), { name: 'TypeError' }), FB).includes('connection'),
    "Safari's wording for the same failure is caught too")
check(toUserMessage(Object.assign(new Error('x'), { name: 'AbortError' }), FB) === 'That was cancelled.',
    'a cancelled request is not reported as an error')

for (const [status, needle] of [[401, 'sign in'], [413, 'too large'], [429, 'Too many'], [501, 'not available'], [503, 'server had a problem']]) {
    check(toUserMessage(Object.assign(new Error('raw'), { status }), FB).includes(needle),
        `HTTP ${status} is explained`, needle)
}

const ours = 'That colour matches 92% of the photo — lower "Match width"'
check(toUserMessage(new Error(ours), FB) === ours, 'a message we wrote ourselves is passed through untouched')

check(toUserMessage(new Error(''), FB) === FB, 'an empty message falls back')
check(toUserMessage({}, FB) === FB, 'a thrown plain object never prints [object Object]')
check(toUserMessage(null, FB) === FB, 'null falls back')
check(toUserMessage(undefined, FB) === FB, 'undefined falls back')
check(toUserMessage(new Error('IndexSizeError: canvas too big'), FB) === FB, 'raw DOM exception names fall back')
check(toUserMessage('plain string problem', FB) === 'plain string problem', 'a thrown string is shown as-is')
check(!/\bfetch\b/i.test(toUserMessage(new TypeError('Failed to fetch'), FB)), 'the word "fetch" never reaches a user')

console.log(`\n[verify-user-error] ${checks - failures}/${checks} checks passed.`)
if (failures) process.exit(1)
