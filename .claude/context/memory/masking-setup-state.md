---
name: masking-setup-state
description: Local masking setup — selection is SlimSAM (device, or /sam/* on 8002 for weak devices); services are depth+SlimSAM (8002) + LaMa (8001); mask-studio is a testbed of phosmith src
metadata:
  type: project
---

- Since 2026-10-07 selection runs on SlimSAM (`client-ai.js`), with CLIPSeg for text. Since 2026-10-13 the same SlimSAM also runs on the service for weak devices (`/sam/embed`, `/sam/decode`; the Selection engine card picks the side). `services/masking` (8002) serves `/depth` (Depth Anything V2 Small, ~100 MB) and `/sam/*` (`nielsr/slimsam-77-uniform`, ~38 MB, pinned to CPU); `services/segment` (8001) serves only `/inpaint` (LaMa, ~200 MB) and `/shape/fill` (OpenCV). SAM 3.1, BiRefNet, rembg, the sam3 package pins and `/crop/auto` are gone — see [[one-selection-model]]. The dead SAM3_* / SEGMENT_MODEL keys were cleared from the local `services/masking/.env` on 2026-10-13 (its custom CORS origins and DEPTH_CACHE_MAX=6 kept).
- The model caches (`~/.u2net`, `~/.cache/huggingface`) were found wiped on 2026-10-07, most likely by a disk-cleanup app; on a fresh start the services re-download Depth and LaMa on first use.
- `../mask-studio` (sibling repo) is NOT a separate implementation — it bundles phosmith's own `src/` via an `@/` alias. UX features DO get ported from its `app.jsx` (studio-only UI); read it when the user says a mask feature "works in mask studio".
- On-device AI needs `public/ort/` (`scripts/setup-ort.mjs`, run by dev/build): a bundler breaks onnxruntime-web's runtime fetch, giving "webgpuInit is not a function" / "no available backend found".
- `bun run verify:client-ai` runs the real SlimSAM + CLIPSeg (~150 s on WebGPU once the models are cached in `.cache/playwright-client-ai`), plus a server pass first when 8002 has SlimSAM (`--server-only` for just that, ~10 s). It buffers output if piped through `tail`; write it to a file. Playwright needs `PLAYWRIGHT_BROWSERS_PATH=0` here (headless shell 1223 lives in node_modules).
- The 8 GB dev Mac: run the rebuilt services side by side on spare ports (e.g. `PORT=18001`, `PORT=18002` with `services/segment/.venv/bin/python`) to test without touching the user's running copies.
- Mutating a mask layer's TEXTURE from panel code: do NOT rely on `useMaskLayers.updateLayer` React sync; swap the chain entry + `applyMegashaderFilter(image, stack, opts)` + `requestRenderAll` + dispatch `phosmith:mask-chain-replaced`.
