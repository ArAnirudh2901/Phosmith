# mask-verify — subject-mask cleanup regression test

Runtime verification for [`src/lib/subject-mask-cleanup.js`](../../src/lib/subject-mask-cleanup.js),
the on-device fallback that turns a soft RMBG-1.4 matte into a solid, hole-free
subject selection (the SAM 3.1 mask service is preferred when reachable).

```bash
bun run verify:subject-cleanup     # exit 0 = all pass
```

## What it checks

| Test | Guards |
|------|--------|
| **T1** | interior holes filled, sky specks removed, single solid subject, coverage ≈ subject area |
| **T2** | a second, smaller figure is kept while specks are dropped |
| **T3** | backlit-silhouette dark body recovered by the luminance assist (and inert when disabled) |
| **T4** | `holesFilledFrac` fragmentation signal is resolution-independent above `fillEnclosedMaskRegions`' 1536px downscale cap |

## Why this one needs a shim (the others don't)

The existing `scripts/verify-*.mjs` test the pure, DOM-free *core* layers
(`growCoverage`, `mask-edge-snap`, geometry) via relative imports. `cleanSubjectMatte`
is different: the fix it implements (morphological close + enclosed-hole fill) is
**delegated to canvas ops** (`growMaskCanvas`, `fillEnclosedMaskRegions`), so a
faithful test has to run real canvas code. Two obstacles, two local solutions:

- **No `<canvas>` in bun/node, and `node-canvas` needs system cairo/pango that
  aren't built here.** → [`_canvas-shim.mjs`](./_canvas-shim.mjs) is a pure-JS
  `ImageData`-backed canvas (preloaded via `--preload`). The cleanup path uses
  canvas only as a pixel buffer — `getImageData`/`putImageData`/`createImageData`/
  `drawImage`, including the 9-arg up/downscale in `fillEnclosedMaskRegions`, with
  no path/text rasterisation — so the shim is exact. `drawImage` implements real
  **source-over** compositing (transparent source pixels must leave the
  destination unchanged — `fillEnclosedMaskRegions` depends on it).

- **The app resolves the `@/` alias via `next.config.mjs`'s webpack alias; there
  is no root `tsconfig`, and bun can't read the webpack alias.** → [`tsconfig.json`](./tsconfig.json)
  in *this dir* maps `@/*` → `src/*` for the bun run. It's scoped to this subdir
  so it never affects `next build` or the editor's view of `src/`. The exact
  `@/lib/megashader` key resolves to [`_stub-megashader.mjs`](./_stub-megashader.mjs):
  `growMaskCanvas` imports four names from that barrel at module load but never
  calls them in the cleanup path, so stubbing keeps the real algorithm intact
  while avoiding the WebGL barrel in a headless run.

Files prefixed `_` are test scaffolding, not modules under test.
