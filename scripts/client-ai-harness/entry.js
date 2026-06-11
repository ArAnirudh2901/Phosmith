/**
 * Browser harness entry for the on-device AI self-test.
 *
 * Bundled by scripts/verify-client-ai.mjs (`bun build --target=browser`) into
 * a standalone page — no Next.js, no Clerk, no env — so the EXACT production
 * module (src/lib/client-ai.js + transformers.js) runs in a real browser and
 * can be driven headlessly by Playwright.
 */

import { getClientAIState, runClientAISelfTest } from '../../src/lib/client-ai.js'

window.__clientAI = {
    run: (opts = {}) =>
        runClientAISelfTest({
            onProgress: (msg) => console.log('[selftest]', msg),
            ...opts,
        }),
    state: getClientAIState,
}
window.__harnessReady = true
console.log('[harness] ready')
