---
name: cleanmymac-wipes-caches
description: "The user runs CleanMyMac cleanups by hand; one on 2026-10-08 removed ~/Library/Caches/ms-playwright and the repo's .cache/ mid-session"
metadata:
  node_type: memory
  type: reference
  originSessionId: eebdaeeb-9d07-4851-8205-311aea0469da
  modified: 2026-10-08T06:00:41.890Z
---

On 2026-10-08 the user ran a CleanMyMac 5 cleanup themselves while a session was working. It removed `~/Library/Caches/ms-playwright` and emptied the repo's `.cache/` (preview photos, `playwright-client-ai` model cache, harness bundles). It is not a background job, so no need to warn about it or work around it permanently.

Symptom after a cleanup: `Executable doesn't exist at …/ms-playwright/chromium_headless_shell-1223/…`, or `ENOENT .cache/...` from `preview-stretch.mjs`.

LaMa's weights were also gone afterwards (`~/.cache/torch/hub/checkpoints` empty, 2026-10-08), so the segment service's first inpaint re-downloads ~200 MB — ask before triggering that.

Recovery: `bunx playwright install chromium` (a copy also lives in `node_modules/playwright-core/.local-browsers`, usable with `PLAYWRIGHT_BROWSERS_PATH=0`). Preview photos come back from `services/segment/.venv/lib/python3.11/site-packages/skimage/data` (motorcycle_left, astronaut, chelsea, coffee, rocket) via that venv's Python + PIL. Related: [[verify-by-looking]].
