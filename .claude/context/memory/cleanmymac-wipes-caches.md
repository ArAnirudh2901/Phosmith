---
name: cleanmymac-wipes-caches
description: CleanMyMac 5 on this Mac deletes ~/Library/Caches/ms-playwright and the repo's .cache/ mid-session; browser suites then fail or skip
metadata:
  type: reference
---

On 2026-10-08 CleanMyMac 5 (running in the background) deleted `~/Library/Caches/ms-playwright` twice within minutes and emptied the repo's `.cache/` (preview photos, `playwright-client-ai` model cache, harness bundles).

Symptom: `Executable doesn't exist at …/ms-playwright/chromium_headless_shell-1223/…`, or `ENOENT .cache/...` from `preview-stretch.mjs`.

Workaround that survives it: install the browser inside node_modules and point the run at it —
`PLAYWRIGHT_BROWSERS_PATH=0 bunx playwright install --only-shell chromium`, then prefix runs with `PLAYWRIGHT_BROWSERS_PATH=0`.
Preview photos come back from `services/segment/.venv/lib/python3.11/site-packages/skimage/data` (motorcycle_left, astronaut, chelsea, coffee, rocket) via that venv's Python + PIL.

Do not touch CleanMyMac itself; it is the user's tool. Mention it when a suite fails this way. Related: [[verify-by-looking]].
