# Project Instructions

This project uses Neon/Postgres through Prisma for application data.

When changing database-backed behavior, update `prisma/schema.prisma` first, keep Prisma access behind the existing lazy database helpers, and run `bun run prisma:generate` after schema edits.

## Two Python services (AI selection + erase/crop)

The masking model code is split into **two** FastAPI services so each deploys to its own Hugging Face Space:

- **`services/masking/`** (port 8002, `bun run masking:dev`) — the AI **selection** tools: **Select Subject** / **Select Background** (rembg/BiRefNet + SAM 3.1), **click / box select** (SAM 3.1 point/box prompts, `/sam2/click` + `/segment/box`), **multi-subject** (`/segment/instances`), **Depth Anything V2** (`/depth`), **text grounding** (`/ground/text`). Proxied by `src/app/api/ai/{segment,sam3,depth,ground,segment-instances}/route.js`.
- **`services/segment/`** (port 8001, `bun run mask:dev`) — erase/**inpaint** (LaMa `/inpaint`), **auto-crop** (`/crop/auto`), **shape-fill** (`/shape/fill`). Proxied by `src/app/api/ai/{inpaint,auto-crop,shape-mask}/route.js`. It still loads SAM 3.1/Depth/rembg internally because `/crop/auto` composes them.

Environment variables in `.env.local` (both optional):

```env
MASKING_SERVICE_URL=http://127.0.0.1:8002   # selection: subject/SAM 3.1/depth/ground
MASK_SERVICE_URL=http://127.0.0.1:8001      # erase/inpaint/crop/shape
```

The masking proxy routes prefer `MASKING_SERVICE_URL`, **falling back to `MASK_SERVICE_URL`** so a single combined service still works. Without any service:
- `/api/ai/sam3`, `/api/ai/depth`, `/api/ai/segment-instances`, `/api/ai/ground` return **501** — but the editor's Mask tool degrades to **on-device** engines (SAM 3 Tracker click/box with sticky SlimSAM demotion, RMBG subject, CLIPSeg/Depth in-browser) per the `sam`/`segment`/`depth`/`ground` routing policy, so selection still works.
- `/api/ai/segment` falls back to HuggingFace background-removal models.

**Model warmup:** `/api/ai/warmup` (POST, no auth, `maxDuration 300`) proactively warm-starts all lazy-loaded models on both services so the first real AI request doesn't surprise the user. Fire-and-forget.

**Browser masking client:** `src/lib/mask-service-client.js` wraps the proxy calls (downscale-for-upload, `pngToMaskCanvas`, `bboxOfMaskCanvas`, `serviceSubjectMask`/`serviceSamClick`/`serviceSamBox`/`serviceGroundText`, `checkMaskService` → `/api/ai/health`). The Mask tool's **Select Subject** does a saliency→SAM-3-box-seed upgrade, **Select Background** inverts the subject matte, and **click/box select** runs live per interaction with an on-device fallback (`clientSamClick`/`clientSamBox` in `client-ai.js`): SAM 3 Tracker (`onnx-community/sam3-tracker-ONNX`, q4f16 on WebGPU / q8 on WASM — explicit dtype is mandatory, fp32 is 1.9 GB) with sticky demotion to SlimSAM, mirroring the SEGMENT_ENGINES pattern and pinned by verify:client-ai's click-select check.

**Multi-subject selection:** the service's `/segment/instances` endpoint returns one refined soft mask PER detected subject (label, confidence, bbox, centroid, base64 PNG) instead of /segment's single union mask. `/api/ai/segment-instances` proxies it, and the agent commands `mask.detectSubjects` / `mask.selectSubjects` (src/lib/agent/mask-commands.js) let the agent enumerate and target individual subjects ("person 2", "the dog"). The Mask tool exposes a **"Detect All Subjects"** button that runs the same endpoint and shows clickable chips for the union and each instance, with results cached on the Fabric image (one detection pass per image). Verify with `bun run verify:instances`.

**Auto-crop** (Step 7): runs **entirely in the browser and never touches SAM or the segmentation service**. Subject-aware **reads the photo first**: `/api/ai/crop-analyze` (Gemini vision, the same model the agent uses, `temperature 0`, schema-enforced) returns scene type, subject boxes with `facing`, must-keep details (faces, hands, labels), eye line, horizon + emphasis, symmetry axis, clutter edges and a suggested ratio (`src/lib/crop-analysis.js` owns the prompt/schema/validator; boxes use Gemini's native `box_2d` = `[ymin, xmin, ymax, xmax]` on 0-1000). Subject edges are then tightened with the **Mask studio's on-device matte** (RMBG-1.4 via `clientSubjectMask` + `cleanSubjectMatte`); `refineBoxWithMatte` may tighten a model box by ≤15%/side or extend it to the real edges, and ignores a matte that found something else. `composeAnalyzedCrop` (`src/lib/auto-crop-core.js`) does the composition: per-scene frame share, lead room on the side the subject faces, eyes on the upper third, horizon on a third per emphasis, symmetry-axis centring, clutter-edge trimming, a hard "never cut what must stay" clamp (balanced trim when the ratio cannot hold it, flagged `compromised`) and a minimum crop area so nothing zooms into a fragment. Aspect/content/depth strategies are pure ports of the old Python maths (`computeAspectCrop`, `computeContentFillCrop`, `computeDepthCrop` — depth uses in-browser Depth Anything V2). Without a vision key, or on quota/timeout (429 sets a 90 s cooldown), `heuristicCropAnalysis` analyses on-device instead: matte + saliency open side + `detectHorizon` row profile + `mirrorSymmetry`. The engine is `runAutoCropEngine` in `src/lib/auto-crop-client.js`, shared by the Crop panel and the agent's `crop.*` commands (`src/lib/agent/crop-commands.js`), with the vision pass and matte cached per image element. The panel shows what the analysis understood ("Read as portrait · person sitting — …") and the crop's rationale in plain English. `/api/ai/auto-crop` (service, SAM/YOLO-based) is left in place but is no longer used by the editor or the agent. Verify with `bun run verify:crop-compose` (pure checks: lead room, eye line, group faces, horizon thirds, symmetry, clutter, min area, matte refinement, detectors, heuristics, hostile model replies) and `bun run verify:auto-crop` (service path, skips when the service is down).

**NL masking** (Step 9): the agent command `mask.fromDescription` masks a region described in natural language ("the dog on the left", "everything except the sky", "the shadows but not the person", "the red jacket, extend by 12px"). Pipeline: `/api/ai/mask-plan` (text-only Gemini → validated MaskPlan; deterministic heuristic parser in `src/lib/agent/nl-mask-parser.js` as the keyless fallback) → executor `src/lib/agent/nl-mask.js` resolves each plan step to a layer: `subjects` via `/api/ai/segment-instances` + qualifier scoring (position/ordinal/size/color, plural vs singular) with automatic fallback to text grounding when no instance matches; `concept` via `/api/ai/ground` (service `/ground/text`: CLIPSeg heatmap → peak-relative threshold → connected components → SAM 3.1 box+point refinement → matte cleanup; CLIPSeg lazy-loads like SAM 3.1/Depth, ~600 MB, `GROUND_MODEL_ID`); `depth`/`luminance`/`colorRange`/`region` via the corresponding megashader layer kinds. Steps compose through the chain's native add/subtract/intersect ops, so every part stays individually editable.

**Mask tool: studio-parity features (ported from the mask-studio testbed):**
- **Base grade (two-pass):** `stack.base` holds a whole-image grade (gamma / curves / 3-way wheels, edited in the pinned "Base — whole image" card). When non-identity, `fabric-megashader-filter` pre-grades the source with a full-white semantic layer (pass 1) so per-layer grades stack on top; zero cost when identity. Persists with the stack; the base curve LUT rebuilds from points on load.
- **Click-select refine:** with a semantic/lasso/path layer selected, the "Refine" toggle composites each SAM result onto that layer (add = lighten, remove = inverted multiply), minting a NEW texture key + re-seeding `baseTextureKey` (undo stays key-based; boundary resets to 0).
- **NL phrase input:** "Mask it" input in Select Subject — background-ish phrases invert the subject; others go `/api/ai/ground` → on-device CLIPSeg per the `ground` routing policy.
- **Subject matte tuning:** Sensitivity slider + fill-holes toggle feed `cleanSubjectMatte` on the ON-DEVICE Select Subject/Background fallback.
- **Undo:** ⌘Z/⌘⇧Z/Ctrl+Y while the Mask tool is mounted (input-focus guarded); param edits (sliders/gamma/wheels/curves/base) snapshot once per 350 ms burst; history entries carry `{ chain, base }`.
- **Gizmos:** radial = centre + e/w/n/s resize (rotated axes) + green rotate lollipop; linear = p1/p2 + midpoint move-both. "Clean view" hides gizmos + marching ants.
- **Persistence fixes:** curve LUTs (layer + base) rebuild in `MegashaderFilter.fromObject` from persisted points; `baseTextureKey` is in `TEXTURE_KEY_FIELDS` (dedupes when identical to the mask texture) so Boundary re-grow is non-cumulative after reload.
- **Coordinate contract:** `pointerToImage`/`imageToDisplay` convert between the Fabric object's logical size and the element's NATURAL pixels (no-op when equal) — brush/click/box always land in natural px, matching the GLSL/brush-canvas/SAM dims.
- **Server-SAM latch:** a 501/404 from `/api/ai/sam3` marks server SAM unavailable for the session (no per-click retry storms/429s); explicit "Server" routing still probes; a success clears it.
- **Photoshop-parity selection tools:** **Magic Wand** (`src/lib/magic-wand.js`: tolerance / contiguous / anti-alias / point-3×3-5×5 sampling on unfiltered source pixels; Shift/Alt+click composite into the selected texture layer) and **Marquee** (rect/ellipse, Shift constrain, Alt from centre) both emit `lasso`-kind layers tagged `tool: 'wand' | 'marquee'`. Texture layers (incl. pen paths) get **Select-and-Mask edge controls** — Boundary, Smooth, Contrast — derived non-cumulatively from `baseTextureKey` (`refineCoverage` in `mask-grow-core.js`, keys `::grow{px}~s{smooth}c{contrast}`). Mask view: overlay tint or black & white (`uMaskView`). Keys while the tool is open: W wand, M marquee (⇧M shape), L lasso, `\` view cycle, ⌘⇧I invert, Delete removes the selected layer. Verify with `bun run verify:selection`.
- **Undo interleave:** ⌘Z in the Mask tool steps whichever changed last — the layer-chain stack or the brush-stroke stack (entries carry `at` timestamps) — and only falls back to canvas history when both are empty. Project hydration is not an undo step.
- **Test hooks:** `window.__phosmith.mask` (installed while the tool is mounted) exposes add/update/applyCurve/setGamma/setWheel/setBase/undo/redo/refine/runSubject/samBox/clickSelect/runConcept/expandBoundary/pixels… for console/Playwright driving.

**Mask boundary extension:** `mask.expandLayer { id, pixels }` grows/shrinks any texture-backed layer's boundary (AI-detected subjects included) by an ABSOLUTE signed px amount — the pristine texture is kept under `baseTextureKey`, so 0 restores the original edge. Same engine (`src/lib/mask-grow.js`, pure morphology in `mask-grow-core.js`) drives the per-layer "Boundary" slider in the Mask tool's layer cards. Verify with `bun run verify:nl-mask` (parser/validator/qualifier-scoring/morphology/journal are service-free; the grounding check skips when the service is down).

**Magnetic lasso / edge snap:** `src/lib/mask-edge-snap.js` — Photoshop-style magnetic-lasso edge snapping. `computeGradientMagnitude(rgba, w, h)` builds a normalised Sobel gradient map; `snapToEdge(…)` walks a rough path toward the nearest high-contrast edge. Used by the Mask tool's interactive lasso and the agent's `mask-commands.js`. Pure, DOM-free, unit-testable. Verify with `bun run verify:mask`.

**Subject mask cleanup:** `src/lib/subject-mask-cleanup.js` — post-process pipeline for soft RMBG-1.4 / background-removal mattes: binarize at threshold → morphological close (via `mask-grow.js`) → fill enclosed interior holes → drop small connected components → optional luminance-assist for backlit silhouettes. Returns diagnostics (`fragmented` flag) the UI uses to nudge toward SAM click-select. Verify with `bun run verify:subject-cleanup`.

**Contour tracing:** `src/lib/contour-trace.js` — extract a polygon boundary from an alpha matte canvas via marching squares → Douglas-Peucker simplification → normalised (0-1) coordinates. Used by the Pixel Stretch tool to convert a SAM/RMBG subject mask into a lasso polygon.

**Shape-fill mask:** `/api/ai/shape-mask` (Clerk auth, rate-limited) → proxies to the segment service's `/shape/fill` endpoint (OpenCV fillPoly). Accepts `{ width, height, points: [[x,y]...] }`, returns a binary PNG mask. Used by the Mask tool for custom shape selections.

## Pixel Stretch tool

**`pixel-stretch.jsx`** (2500+ LOC) — a full Pixel Stretch / glitch-art tool with AI planning, multiple stretch modes, and real-time preview:

- **Length is measured against the FRAME, not the slice.** `length` is stored as a multiple of the band's own extent, but the reference workflow selects a slice two or three percent tall and stretches it clear past the top of the picture. The old clamp of 8 meant a 2% slice could only ever cover 16% of the frame, so the trend was literally not reproducible; the clamp is 200 now (`MIN_BAND` is 2%, so that is ~4 frame-heights from the thinnest legal slice). The panel's Length slider reads in **% of frame** and converts through the live slice extent, `PIXEL_STRETCH_PRESETS` are re-expressed the same way when applied (they were written for a roughly quarter-height band), and the agent sizes its default length to cross the room it found rather than using a fixed multiple.
- **The tip may be much wider than the seed.** `taper` reaches **-12** on the flare side (tip 13x the seed width) because the reference fans open from a near-point to most of the frame; at the old floor of -1 the tip was only twice the seed and a fan was unreachable. The slider is **Tip width** (0% = narrows to a point, 100% = parallel, up to 1300% = a fan) and sits next to Bend rather than under Refine, since with Length it is what makes the reference look. `fan` and `spear` presets ship it. The bend's fold guard measures the ribbon at its WIDEST point, so a flared ribbon still cannot self-intersect.
- **The ribbon can twist.** `twistTurns` (0..3 half-turns) modulates the half-width by `cos(pi * turns * t)` and leaves it **SIGNED** — the mesh builds its edges as `centre -/+ n*hw`, so as the cosine passes zero the ribbon narrows to an edge and its two sides trade places. That is a real half-turn, and it is what the reference clips show when the colour order flips across a narrow waist. `twistDepth` (0..1) scales it: **below 0.5 the width never reaches zero**, so the ribbon pinches to a waist without turning over — the trumpet shape, a pinched neck flaring into a bell. Both fold guards read `Math.abs(hw)` now that it is signed, and the straight fast path declines a twist. Presets: `twisted`, `trumpet`.
- **Core engine:** `src/lib/pixel-stretch.js` (pure, no Fabric/React) — sweeps a seed line of pixels along a cubic Bézier path with bend/twist/taper/fade/mirror controls. Same function renders live preview (screen res) and final committed bitmap (full image res). All geometry params normalised to [0..1].
- **Flow Path mode:** An ordered list of 3-12 normalised points the streak travels along (far more expressive than simple bend/twist — weaves through the composition like a brushstroke). Flow presets, anchor insert/remove, smoothing. `FLOW_PRESETS` catalog.
- **Warp Grid mode:** Photoshop-style warp mesh (default 4×4 Catmull-Rom bicubic surface) — every control point lies ON the surface. Draggable handles, grid splitting, warp presets (`WARP_PRESETS`). Streaks bend through the deformed grid.
- **Scanline mode** (`DEFAULT_SCANLINE`, `scanlineStretchPixels`, `renderScanlineStretch`): the OTHER pixel stretch — no selection at all. Each row (or column) keeps the pixels that pass a luminance threshold and drags the last survivor's colour across the ones it removed, stopping after `length`, optionally fading to black. One linear pass per scanline, mutating RGBA in place; the shape of the effect is [TD-Pixel-Stretch-TOP](https://github.com/lou-evoy/TD-Pixel-Stretch-TOP)'s "single segmented inclusive scan over the frame", on the CPU. Reachable from the selection step with **Skip — smear the whole photo**, because the one mode that needs no region must not sit behind one.
- **Lasso / Subject-aware stretch:** Select a freehand lasso region or auto-detect the subject (via SlimSAM → contour trace) and stretch ONLY inside that polygon.
- **Every image is frozen while the tool is open** — not only the one being edited. The selection is drawn by dragging on the canvas, and any drag the tool's own surface does not catch falls through to Fabric. Re-editing a committed layer made that certain: the layer was locked and the photo underneath was left live, so a stray drag slid the photo out from under its own stretch and off the canvas. `lockImage` now snapshots and freezes every image object, `unlockImage` restores them all, and a freshly committed layer joins the frozen set immediately.
- **Placement:** the stretch commits as its own layer — **Above / Partial / Behind**. What stays in FRONT defaults to **your own selection** (the lasso polygon, else the band): that is what "behind" means to the person who just drew a region, and it costs no model, no download and no extra memory. **Auto-detect** (SlimSAM) and **Draw subject** remain one tap away for the cases they suit; detection runs on a copy bounded to `SUBJECT_DETECT_MAX_DIM` (1024px long edge) and releases the model afterwards, because at native size a 45MP frame had it allocating a full RGBA mask per seed. The agent mirrors this: `behind` uses the slice, `behindSubject: true` opts into detection, a blend mode (`STRETCH_BLEND_MODES`: Normal/Screen/Multiply/Overlay/Lighten/Soft light/Hard light/Difference) and opacity. Re-selecting the layer re-enters the tool with its stored params.
- **Seeding is scored, not guessed** (`bestSeedInBand`): the ribbon IS one line of pixels repeated, so a line through a plain area can only make a plain slab. Confirming a region scores every line in it by saturation, tonal spread and how often the colour actually changes, and seeds on the winner; **Find the most colourful line** re-runs it after the band moves.
- **AI Auto Stretch:** `/api/ai/stretch-plan` (Gemini vision) analyses the image and recommends the optimal region, direction, flow path, and parameters. Rule-based fallback when Gemini is unavailable. Client-side `analyzeStretchPlan()` as a no-API-key fallback.
- **PIXEL_STRETCH_PRESETS:** Curated named presets (editorial, dramatic, flowing, etc.).
- **Shared commit path** (`src/lib/pixel-stretch-apply.js`): bake to a transparent buffer at ≤4096px → PNG → ImageKit → place the layer above the photo with `data.pixelStretch` (params, coverage, feather, blend, and a DURABLE copy of the source so the layer survives the photo being deleted). The panel and the agent both go through it, so an agent stretch and a hand stretch are the same object.
- **Agent domain `stretch.*`** (`src/lib/agent/stretch-commands.js`, registered in `canvas.jsx`): `ribbon`, `warp`, `flow`, `scanline`, `auto`, `clear`, `fromDescription`. `from: "subject"` detects the subject and routes the ribbon through the side with the most ROOM — a ribbon aimed at the nearest frame edge leaves the picture immediately, and one aimed into the subject is knocked straight back out by the `behind` matte. `parseStretchPrompt` is deterministic (no model call) and runs in `imagekit-agent.jsx` right after the focus check, so "give it a cinematic grade" still reaches the edit planner. Note one deliberate precedence: *ribbon* only selects the flow preset of that name when the sentence also asks for a path.

Four bugs were found by LOOKING at the output — on real photos, and on a magenta probe backdrop that makes any lost opacity obvious — rather than by a test:
- **Horizontal stretches drew nothing.** The seed column was rotated into the strip with the destination rect's width and height swapped, so it landed outside the 1px-tall buffer.
- **Every curved ribbon was translucent and cross-hatched.** A 1px-tall texture magnified hundreds of times by the ribbon mesh gets sampled against the transparent space outside it, draining alpha at every triangle seam. The strip now carries `SEED_ROWS = 3` identical copies of the line and the mesh samples the middle band (v 1..2), so no sample ever reaches the texture edge.
- **Dragging a warp handle hung the tab.** `drawTexturedTriangle` blitted the WHOLE buffer per triangle and let the clip discard the rest, so a tessellated mesh cost (triangles × image) — thousands of full-canvas transformed blits per frame. It now blits only the triangle's source bounding box, padded by one pixel so the bilinear filter still reads real texels at the patch edge; the output is identical and the cost is O(output pixels). A 4096px warp went from hanging to 30 ms, and a live handle drag from never returning to ~34 ms/frame.
- **A hard-bent ribbon folded into a bow-tie with a hole in it.** A swept ribbon self-intersects wherever its half-width exceeds the path's radius of curvature — a property of the BEND, not the strip. `resolveGeometry` now treats the arc as circular (chord `total`, sagitta `s`, `R = (total² + 4s²) / 8s`) and limits the bend to the largest `s` whose radius still clears the half-width, so the ribbon bends as far as geometry allows and stays one continuous sheet at full width. A ribbon longer than it is wide never reaches the limit. The flow path can't have its curve clamped (it is the user's), so there the WIDTH gives way instead, uniformly — one O(n) pass finds the tightest turn and scales every section by the same factor (floor `FOLD_FLOOR`), because an evenly narrower ribbon reads as a ribbon while one that pinches at a single corner reads as a fault.
- **A commit left tens of MB of scratch canvases resident.** The seed strip, the ribbon compositing buffer and the warp buffer are deliberately kept between frames (re-allocating per pointermove stutters a drag), but a bake sizes them to the full image — ~45 MB each at 4096px, on 8 GB machines. `releaseStretchScratch()` runs in the bake's `finally`, so the next interaction re-allocates at preview size.

Measured on an Apple M2 at bake resolution (4096×2731, from a 45.4 MP Nikon NEF through the production RAW intake): straight 0 ms, bend 11 ms, warp 30 ms, flow 24 ms, scanline 292 ms (that one is `getImageData` + one linear pass + `putImageData`; at preview size it is ~40 ms). Every pass is O(output pixels) — which is the floor for a raster effect — and the two ANALYSIS passes are O(1) in image size: `bestSeedInBand` subsamples to at most 160 lines × 220 samples and `analyzeStretchPlan` to a fixed 180×180 grid, whatever the photo.

`fadeIn` joins `fade` so a ribbon can dissolve into the photo at its root instead of starting on a hard cut; both are placed along the ribbon's ARC (each section's alpha is set at its projection onto the start→end chord) rather than across the chord, which is what keeps the taper where the pixels are on a bend.

Verify with `bun run verify:stretch` (flow-path geometry, pure) and `bun run verify:stretch-core` (83 checks: the scanline scan's propagation, length budget, direction, fade, region, both modes, a no-survivor scanline left byte-identical, hostile config, the ribbon fold guard, and the NL parser — 18 phrasings routed, 8 other-tool requests that must fall through). `bun scripts/preview-stretch.mjs --photos <dir> --specs <file.json> --sheet` renders any set of params on real photos through the real Chrome on `:9222` and writes a labelled contact sheet — that is how both render bugs were found.

## AI Extender: grabbing the frame

The expansion frame is a Fabric `Rect` with edge-midpoint and corner controls, and the panel tells you to "drag the edge handles outward". Fabric only scales from a control's hit box, which defaults to `cornerSize` — a 14px dot at the midpoint of an edge that is hundreds of pixels long. Everyone tries to drag the BORDER, hits nothing, and concludes the tool is broken.

`sizeEdgeControls(frame, canvas)` (`src/lib/expansion-pipeline.js`) therefore gives each edge control a hit box spanning its whole edge — `sizeY` for `ml`/`mr`, `sizeX` for `mt`/`mb` — minus a gap at each end so the corners still resize both axes. Two details make it work:

- Fabric uses `sizeX`/`sizeY` for BOTH hit-testing and drawing, so a widened control would paint a bar the length of the frame. The edge controls carry their own `render` that draws the normal dot.
- Hit rectangles are cached in `oCoords` and only rebuilt by `setCoords()`, so the new size does nothing until the coords are recomputed.

The sizes are in SCREEN pixels, so they are refreshed wherever the frame or the view changes — setup, `modified`, re-selection, `after:transform` — but **never from `mouse:move`**: calling `setCoords` inside Fabric's own pointer dispatch stalls the canvas, and a hit box briefly sized for the previous zoom is a far smaller problem than a frozen editor.

## Vision-driven collage planner

**`/api/ai/collage-plan`** — Gemini VISION pass over photo thumbnails, strict response schema. The model SEES the photos and proposes N tasteful templates (layout + frame style + background) that MATCH the content (food → warm/marble, nature → airy botanical, product → bold/minimal). Pipeline:

- **`src/lib/collage-ai.js`** (pure, no Fabric) — shared contract: `COLLAGE_LAYOUT_CATALOG` (14 layouts), `COLLAGE_THEME_CATALOG` (6 AI background themes), `COLLAGE_CONTENT_TYPES` (19 categories). `buildCollagePlanSystemPrompt/UserText/Schema`, `validateCollagePlan` clamps every field to the allowed catalog.
- Falls back to client-side heuristic gallery (`generateTemplateRecipes`) when no API key or model failure.
- Supports a `directionHint` creative brief from the user or in-app agent.
- **Plan cache (shared):** `collagePlanCacheKey` / `readCollagePlan` / `writeCollagePlan` in `collage-ai.js`, keyed by the photo set's perceptual hashes + brief + canvas aspect + `COLLAGE_PLAN_VERSION`. The Collage panel AND the agent's `suggestTemplates` both read it, so the same question costs one vision pass. The panel's requests also carry a generation counter + `AbortController`: cycling templates can no longer let a slow earlier reply paint over a newer gallery.

## Collage: grid engine hardening

`src/lib/collage-layout.js` is the grid engine (the composer in `src/lib/collage/*` is separate). What the edge-case work changed:

- **Whole-pixel cells.** `clampCells` rounds cell EDGES, not widths, so neighbours resolve to the same integer boundary — 1080 ÷ 3 = 360.33 no longer leaves a hairline of backdrop between columns — and `getCellFitScale` adds a 0.5px `COVER_BLEED` so the clip path's anti-aliased edge has photo under it. Non-finite gap/padding coerce to 0 instead of poisoning every cell with NaN.
- **Fit modes.** `getCellFitScale(image, cell, 'cover' | 'contain')`; `setCellFitMode` switches an already-framed photo without re-running the layout (so the mat inset is not applied twice). `clampToCell` enforces the clamp that belongs to the mode: cover may never shrink below filling the cell, contain may never grow past it, and each pans within its own slack. The panel exposes it as **Fill frame / Fit whole photo** — the honest answer for a 16:1 panorama.
- **Resolution honesty.** `assessCellResolution(image, cell, dpr)` reports the source-to-needed pixel ratio; the panel warns after a layout when a photo is under half the pixels its frame wants.
- **Partial fill.** Fewer photos than cells is a normal state: the remaining cells become `CollageSlot` placeholders (already excluded from export by `canvas-snapshot.js`), in the panel and in the agent's `createTemplate`. It used to refuse the layout outright.
- **Content-aware arrangement** (`src/lib/collage-arrange.js`, pure): `photoDescriptor` wraps `analyzeElement`'s existing on-device analysis; `assignPhotosToCells` gives the biggest frame to the strongest photo and matches every other photo to the cell whose shape suits it; `rankLayoutsForPhotos` / `bestLayoutForPhotos` pick a layout from the photos' aspect mix (a set with a panorama gets a layout with a wide cell); `focusForCell` feeds `fitImageToCell`'s `focus` option so a subject near the top of the frame is not centre-cropped out. Panel toggle: **Arrange by content** (default on). Agent: `createTemplate { fit, arrange }`.
- **Swap vs pan.** A swap now needs deliberate travel (12px) and the pointer leaving the photo's own cell by a margin; one pointer owns a gesture, so a second finger cancels the pending swap instead of fighting the pinch.
- **Adjustable frames.** Layouts are no longer fixed splits: `LAYOUT_WEIGHT_SCHEMA` / `defaultWeightsFor` describe each layout's dividers as weights (`{ cols, rows, split }`), `layoutBoundaries` returns them as draggable lines in canvas coordinates, and `applyBoundaryDrag` moves one — clamped by `MIN_CELL_FRACTION = 0.08`, so the "resize one frame, the neighbour collapses to zero" case cannot happen (the clamp is in the maths, not the UI). Uniform weights reproduce the old constants exactly (feature 62%, mosaic 48%, top band 50%). In the panel you drag the lines on the canvas: the gutter is a wide hit band, and over a photo it narrows to half that so panning the middle of a photo still pans it. A live drag locks the photo under the pointer and stands the swap gesture down (`dividerDragRef`), re-fits through the recorded cell→photo assignment so a content-aware arrangement survives, and **Even** resets. The panel's settings (layout, spacing, shape, fit, mat, panel, arrange, weights) persist per project under `phosmith:collage:<projectId>` in localStorage, so reopening the editor finds the dividers where the collage on the canvas was built — the cells themselves still recover from their clip paths.
- **Mat, inward or outward.** `insetCellForFrame` takes `frameMode: 'inner' | 'outer'`; outward grows into the gutter by at most **half the gap** per side (so neighbours can touch but never overlap) and is a no-op at gap 0, because there is nowhere to grow. Panel: the **Mat** slider plus *Mat inside / Mat outside*; agent: `createTemplate { mat }`.
- **Per-cell panel (matte).** `buildCellMatte` / `isCollageMatte` in `collage-styles.js` put a solid panel in the cell's own shape behind the photo, so a transparent PNG reads as a photo instead of a hole. It is a real exported object (not `excludeFromExport`), rebuilt with every layout and never accumulated. Panel: swatches + colour picker; agent: `createTemplate { matte: '#rrggbb' }`. Filling an empty slot later goes through the same `fitImageToCell` path, so fit mode, mat and panel apply to it too (composer polygon slots keep their own placement).
- **Working resolution.** `workingEdgeForProject` (project long edge × 3, capped at the serving limit) + `imagekitResized` fetch a bounded variant through the URL, so eight 6000×4000 frames no longer decode to ~770 MB of RGBA. The transform lives in the URL, so a reload gets the same pixels, and nothing is re-encoded client-side.

**Device canvas limits:** `src/lib/canvas-limits.js` probes this device's real maximum canvas edge AND area (allocate, paint, read one pixel back — past the area cap Safari returns a blank canvas rather than throwing) and owns the ImageKit serving constants that `canvas-images.js` and the dashboard's project-creation flow both clamp against. `renderLiveCanvasElement` caps the export scale through `maxRenderScale` and reports `limitedBy`, which the topbar surfaces ("Exported at 2.13× instead of 3×…"). An export finishing while the tab is hidden waits for `visibilitychange` before triggering the download, because Safari drops a background download.

**Orientation and colour at intake** (`canvas-images.js#prepareForCanvas`): a decoder always applies an image's own EXIF orientation and there is no way to ask it not to (`imageOrientation: "none"` was dropped from the spec), so `flattenOrientation` in `raw-preview.js` decodes and re-encodes to move the rotation into the pixels — necessary because the upload path strips the tag. `bakeOrientation` keeps its manual transform for the RAW case, where the orientation lives in the container and not in the preview's own EXIF. CMYK/YCCK JPEGs are refused on the header (`jpegMeta` now reports `components` and `adobe`) with a message instead of being rendered inverted, and both `createImageBitmap` calls pass `colorSpaceConversion: 'default'`. The byte cap is 64 MB, since a 50 MP DSLR JPEG is legitimately 25-45 MB and the pixel caps already bound the decode.

Verify with `bun run verify:collage-grid` (72 pure checks: cell integers/tiling/overlap across every layout × canvas × gap × padding, clamp extremes incl. NaN, mat clamps, both fits and their pan clamps, low-res detection, clip-path round trip, device-limit maths, hostile plan validation, arrangement determinism, URL bounding, divider drags shoved 25× past both limits on every layout, inward/outward mat bounds) and `bun run verify:collage-render` (49 checks in a REAL browser via Chrome on `:9222`, Playwright fallback: seam scan on every layout at 1081×1921, cover-vs-contain backdrop, partial fill, the real canvas ceiling, a capped 3× export that is still painted, EXIF orientation 3/6/8 read → flattened → tag-free, CMYK header detection, taint recognition, transparent cut-out with and without the panel, dragged dividers rendering seam-free, viewport flip leaves cells untouched). Point `PHOSMITH_PHOTO_DIR` at a folder of real photos and the render harness also parses and decodes those.

## AI routing (per-capability client/server policy)

`src/lib/ai-routing.js` is the single source of truth for WHERE each AI capability runs. The registry declares seven capabilities — `maskPlan` (Gemini vs the on-device rule parser), `ground` (service SAM 3.1/CLIPSeg vs in-browser CLIPSeg), `depth` (service vs in-browser Depth Anything V2), `subjects` (YOLO; "Device" = degraded text-grounding path), `segment` (BiRefNet service vs in-browser RMBG-1.4), `sam` (SAM 3.1 click/box vs in-browser SAM 3 Tracker → SlimSAM), `inpaint` (LaMa vs HF Stable Diffusion) — each with a user preference `auto | client | server` (localStorage `phosmith:ai-routing`; the legacy `phosmith:client-ai` boolean migrates on first read). `resolveOrder(cap)` returns the ORDERED attempt list executors follow: preferred side first, the other side as runtime fallback, so a missing side degrades instead of failing. `auto` = server-first. The Mask tool's "AI Processing" section is the UI (Auto/Device/Server per capability). In-browser engines live in `src/lib/client-ai.js` (`@huggingface/transformers`, WebGPU→WASM; models download once and cache).

**ORT runtime files are REQUIRED for on-device AI:** bundlers (Next/Turbopack included) break onnxruntime-web's runtime fetch of `ort-wasm-simd-threaded.jsep.{mjs,wasm}` — WebGPU throws "webgpuInit is not a function" and WASM reports "no available backend found", killing every in-browser model. `scripts/setup-ort.mjs` (wired into `bun run dev`/`build`, also `bun run setup:ort`) copies the version-matched files to `public/ort/` (gitignored); `client-ai.js#loadTransformers` probes `/ort/` once and pins `wasmPaths` + single-threaded WASM to it. The verify harness serves the same `/ort/` path.

**On-device model set (one model):** the browser ships **SlimSAM** (`Xenova/slimsam-77-uniform`, ~40 MB) for click select, box select AND one-click Select Subject — `clientSubjectMask` seeds it with a saliency box plus prompt points (box centre, saliency centroid, saliency peak) and keeps the candidate that best fills the box without leaking outside it (`scoreSubjectMask`). SlimSAM's prompt encoder always reads point tensors, so a box-only prompt throws; `samBoxOnce` always sends a seed point with the box. **CLIPSeg** stays for in-browser text grounding (the one job SlimSAM cannot do offline). Removed on purpose: SAM 3 Tracker and MODNet (duplicated SlimSAM), RMBG-1.4 (subject cutout is SlimSAM now), in-browser Depth Anything V2 (depth is service-only — the `depth` capability has `client: false`, and the Mask tool / auto-crop say so), and `/api/ai/segment`'s hosted SegFormer/DETR fallback. Models are released from RAM after 5 minutes idle (`MODEL_SLOTS`, `withModelUse`, `releaseClientModels`). The services (HF Spaces) are untouched and still run SAM 3.1, rembg/BiRefNet, Depth Anything V2 and LaMa.

**On-device AI verification pipeline:** the in-browser path is hardened and verifiable, not works-on-my-machine. Layers: (1) per-inference output validation + load/inference timeouts + sticky WebGPU→WASM downgrade-and-retry, with a diagnostics ring on `window.__phosmith.clientAI` (pure guards in `src/lib/client-ai-core.js`, pinned by `verify:nl-mask`); (2) a **golden-input calibration gate** — a freshly loaded CLIPSeg must score ≥0.5 peak on the built-in red-disc scene before serving (healthy ≈0.96; the observed cold-start failure mode scored ≈0.06 wrong-but-finite), with one automatic model rebuild before failing over to the server; (3) `runClientAISelfTest()` runs the REAL models on that scene — exposed as the Mask tool's "Test device AI" button and driven headlessly by `bun run verify:client-ai` (Playwright Chromium + a standalone `bun build` bundle of the production module, no Next/Clerk/env; persistent profile in `.cache/playwright-client-ai` caches the model downloads; skips gracefully when Playwright/Chromium aren't installed).

## Editor tools

The editor has **16 tool panels** in `src/app/(main)/editor/[projectId]/_components/tools/`:

| Tool | File | Description |
|------|------|-------------|
| Adjust | `adjust.jsx` | Brightness, contrast, saturation, vibrance, temperature, sharpness, blur, noise, gamma, hue — plus curves (via `curves-filter.js` / `curve-lut.js`) and 40+ style profiles (`style-profiles.js`) |
| AI Background | `ai-background.jsx` | Background removal (ImageKit / on-device RMBG-1.4), replacement with Unsplash photos, solid colors, or AI-generated scenes |
| AI Edit | `ai-edit.jsx` | AI agent chat for natural-language photo editing (routes through grade loop) |
| AI Extender | `ai-extender.jsx` | Generative fill / outpainting — expansion frame → async genfill via `extend-poller.js` / `expansion-pipeline.js` |
| Collage | `collage.jsx` | Multi-photo collage engine — 14 layouts, 10 style presets, 12 backdrops, vision-driven AI template planner, AI background generation |
| Crop | `crop.jsx` | Manual crop + AI Auto-Crop (4 strategies: subject, aspect, content, depth) |
| Draw | `draw.jsx` | Pencil, marker, circle, spray, eraser brushes — drawn paths follow image transforms via `canvas-doodle-bind.js` |
| Erase | `erase.jsx` | Brush erase (alpha mask) + AI Object Remover (click → SAM 3.1 → LaMa inpaint → ImageKit upload) |
| Agent Chat | `imagekit-agent.jsx` | Full agent chat — routes collage/edit/mask intents, manages agent edit sets |
| Images | `images.jsx` | Add/manage multiple images on canvas |
| Mask | `mask.jsx` | Megashader masking — layer kinds + base (whole-image) grade, NL phrase input, detect subjects, click-select refine, edge snap, AI routing toggles, ⌘Z undo, clean view |
| Pixel Stretch | `pixel-stretch.jsx` | Pixel streak / glitch art with flow paths, warp grids, lasso, AI auto stretch |
| Resize | `resize.jsx` | Canvas resize with presets |
| Text | `text.jsx` | Text tool with Google Fonts integration |

Shared internal components: `_layer-grade-editor.jsx` (per-layer curves/grading), `_pixel-tool-ui.jsx` (shared brush/pixel tool framework).

## Additional core library modules

- **`canvas-background.js`** — Canvas-sized background management: apply, merge foreground, sync grading.
- **`canvas-snapshot.js`** — Live-canvas flattening (single source of truth for "what the image currently looks like"). Export (PNG/JPEG/WebP download + clipboard) and AI agent image capture both flow through here. UI-decoupled.
- **`color-extraction.js`** — Extract dominant colors from an image URL via canvas pixel sampling + k-means-style bucketing.
- **`color-utils.js`** — HSL/RGB conversion helpers.
- **`curves-filter.js`** — Custom Fabric filter for per-channel curves adjustment. Cubic spline interpolation over user-placed control points → 256-entry LUT. Registered as `CurvesFilter` in the Fabric class registry.
- **`curve-lut.js`** — LUT builder from cubic spline control points. Shared by the curves filter and the layer grade editor.
- **`image-features.js`** — Deterministic image feature extractor. Pure function from HTMLImageElement → numeric feature vector (brightness, contrast, saturation, hue distribution, sharpness, noise, skin tone, colorfulness…) that the planner and style profiler consume.
- **`image-fingerprint.js`** — Perceptual hashing (dHash) for image deduplication / cache keying.
- **`image-histogram.js`** — Per-channel histogram computation for the Adjust tool's live histogram display.
- **`professional-image-filters.js`** — Core Fabric filters for the Adjust tool sliders (brightness, contrast, saturation, vibrance, temperature, sharpness, blur, noise, gamma, hue).
- **`style-profiles.js`** — 40+ curated style profiles (film stocks: Kodachrome, Portra, Fuji Pro400H, CineStill 800T, Polaroid, Super8, Tri-X; cameras: RED Cinema, ARRI Alexa; looks: cinematic, editorial, vintage, warm-portrait, B&W classic, etc.). Each profile is a target adjustment vector the planner scales by `gain`. `STYLE_KEYS`, `STYLE_LABELS`, `STYLE_PROFILES`, `STYLE_DESCRIPTORS`, `STYLE_VOCABULARY` tables.
- **`strip-metadata.js`** — Binary-level EXIF/XMP/IPTC/GPS metadata stripping for JPEG and PNG. No re-encoding, no quality loss, no external libraries.
- **`canvas-doodle-bind.js`** — Doodle ↔ image binding. Drawn paths follow the parent image's transform (translate/scale/rotate) via Fabric's parent→child matrix recipe. Association is geometric (auto-bound by position), needs no persisted state, survives save/reload.
- **`project-pixel-effect.js`** — Dashboard pixel shimmer effect for project thumbnails.

## Megashader layer batching (unlimited layers, depth-independent cost)

`MAX_LAYERS_PER_PASS = 8` is the per-GPU-pass budget (one sampler per texture-backed layer plus one per curve LUT, inside WebGL2's guaranteed 16 units); `MAX_LAYERS = 64` is the chain cap the UI/agent enforce. A chain longer than one pass is split by `planPasses` (sized from the real `MAX_TEXTURE_IMAGE_UNITS`): every batch but the last renders into an RGBA8 state texture (`runningColor.rgb`, `runningAlpha.a`) that the next batch reads through `uPrevState`, and the last batch composites to pixels. `compilePass(entries, { role, readsPrevState, readsErase, readsSuffix })` emits the variants (`buildFragmentTemplate`, `buildBooleanChain(entries, { fromState, eraseOnly, suffix })`); the roles are `single | state | final | erase | suffixColor | suffixAlpha`. Erase is a max over erase layers — order-independent — so it accumulates in its own texture with `gl.MAX` blending and is folded in by the final pass.

**Prefix cache (the reason cost stops growing with depth):** while one layer is being edited, every batch below it renders identical pixels, so the composite at that boundary is kept in its own texture and reused. Per-batch signatures (`layerSignature`, including mask-texture versions) find the first changed batch; that boundary is rendered straight into the prefix texture, and the next frame restarts from it. Active only when the caller passes `options.sourceVersion` (a promise that the source pixels are unchanged) — the preview session does, the commit path does not.

**Suffix fold (the reason the edited layer's POSITION stops mattering):** the prefix cache removes the layers below the edited one; the fold removes the ones above it. Every layer transforms the running state the same way for a given pixel — colour `C → p·C + q`, alpha `A → clamp(α·A + β, lo, hi)` with `α ≥ 0`, erase `E → max(E, e)` — and all three families are closed under composition, so the whole run above the edited layer collapses into two per-pixel maps plus the erase texture that already exists. `src/lib/megashader/chain-fold.js` owns the algebra (`layerColorMap`, `layerAlphaMap`, `composeColorMaps`, `composeAlphaMaps`, `foldRun`) and `buildBooleanChain(entries, { suffix })` is its GLSL mirror. `overlay` is piecewise at `A = 0.5`, so it is NOT foldable: `isFoldableOp` refuses it and the renderer replays those layers instead.

A frame then costs one draw whatever the depth: the cached prefix state, the edited layer, the two maps, the erase texture. The maps are rebuilt only when the user moves to a different layer (`findHotLayer` requires exactly ONE changed layer signature). Budget: three resident full-size textures (RGBA8 prefix, colour map, RGBA16F alpha map — the alpha offset is signed, so it cannot be 8-bit) plus one scratch texture during a rebuild, ~140 MB at the `FOLD_MAX_PIXELS = 8.7e6` cap. The colour map is RGBA8 when the suffix fits ONE batch and RGBA16F when it needs more, because every extra batch re-reads and rewrites the map and 1/255 of quantisation per round trip would add up past the parity gate's 2/255. Any failure — allocation, or a map target the driver reports as not framebuffer-complete — calls `retireFold` (metric `foldRetired`), and the batched path serves that frame and every frame after it for the session. Every render target is checked with `checkFramebufferStatus` before it is drawn into, since an incomplete attachment makes `clear`/`drawArrays` silent no-ops and would otherwise be composited as undefined pixels; `supportsFloatTargets` proves renderability with a 1×1 probe rather than trusting `EXT_color_buffer_float`, and both it and the texture-unit cap reset on context teardown and on `webglcontextlost`. Like the prefix cache it needs `options.sourceVersion`, so the commit path never folds. `options.disableFold` forces it off for A/B measurement.

Other renderer invariants: the source texture is uploaded once per `sourceVersion` (33 MB at 4K otherwise, every frame), uniform locations are cached per program, `reuseOutput` reuses one output canvas, each layer skips its grade where its coverage is 0 (except slot 0 / `replace`, which read the colour regardless), and `ensureStateTargets` creates textures on a scratch unit so it cannot evict the source on unit 0.

Measured on an Apple M2 at 3840×2160 (production build, `window.__phosmith.megashaderBench`), dragging one layer: 8 layers 16.4 ms, 16 layers 11.3 ms, 32 layers 11.6 ms, 64 layers 12.1 ms per frame (82.9 fps, 688 Mpix/s) — a 64-layer chain now costs LESS than an 8-layer one, because above 8 layers the frame is one folded pass instead of a full 8-layer pass. The previous engine hard-capped at 8 (17.7 ms).

Editing depth is what the fold fixes. Same machine, same 4K frame, `window.__phosmith.megashaderEditBench({ size: '4k', layers, hots, fold })`:

| chain | edited layer | no fold | fold | speed-up |
|---|---|---|---|---|
| 32 | 0 (bottom) | 35.3 ms | 13.2 ms | 2.7× |
| 32 | 16 | 23.5 ms | 13.3 ms | 1.8× |
| 32 | 31 (top) | 17.3 ms | 11.4 ms | 1.5× |
| 64 | 0 (bottom) | 60.1 ms | 17.2 ms | 3.5× |
| 64 | 32 | 36.0 ms | 16.3 ms | 2.2× |
| 64 | 63 (top) | 16.6 ms | 13.7 ms | 1.2× |

Correctness gates: `bun run verify:chain-fold` property-tests the algebra against a sequential evaluation (20k composition pairs, 5k folded runs, 5k edit-any-layer chains up to 31 layers with erase layers, crossed clamps, overlay refusal) with no GPU; `bun run verify:fold` drives the real GPU — it opens a tab in an already-running Chrome on `--remote-debugging-port=9222` (falling back to Playwright, else skipping) and asserts that the folded render matches a full re-render within 2/255 of premultiplied colour at 16/24/32/64 layers and every edit depth, with erase layers above, below and ON the edited layer, that the fold refuses to run past an `overlay`, that a single-pass chain is left alone, and that frame time stays flat across edit depth, and that a GPU with no float targets — or one that advertises them but refuses a full-size half-float attachment — retires the fold and still renders the frame correctly. `window.__phosmith.megashaderParity({ layers, batch })` still checks batch-size parity (max channel diff ≤ 1 at 6/8/12/16/32 layers). Readbacks are compared PREMULTIPLIED: `getImageData` unpremultiplies, so a 1/255 difference under an erase layer comes back amplified by 1/alpha and means nothing.

## Focus & Light: optical blur, depth of field, colour pop, shadows

Eight photo features — Instagram's **Lux / Structure / Fade**, **tilt-shift**, **depth of field / bokeh**, **motion blur**, **selective colour**, **drop shadows** — built on classical computer vision and one GPU gather. **No second browser model**: SlimSAM is the only network on device, and depth-of-field works without it and without the Python service.

**Classical CV core (`src/lib/cv/`, pure, Fabric-free, DOM-free except `plane-image.js`):**
- `box-filter.js` — integral-image box mean (O(1) per pixel at any radius), area-average resample, bilinear upsample, separable Gaussian. Planes are `{ width, height, data: Float32Array }`.
- `guided-filter.js` — Guided Image Filtering (He, Sun & Tang) + the Fast Guided Filter (arXiv:1505.00996): box filters at 1/s, `q = ā·I + b̄` evaluated against the full-resolution guide. One routine solves three problems: a 512² matte becomes a 24MP mask whose edge follows hair; a halo-free base layer for Structure (`detailSplit`); and `propagateSparse`, which replaces the defocus paper's matting Laplacian with two O(N) passes.
- `distance-transform.js` — exact Euclidean DT (Felzenszwalb–Huttenlocher), signed variant, `distanceRamp` for background falloff.
- `defocus-map.js` — single-image defocus estimation (Zhuo & Sim): re-blur by σ0, gradient ratio `R` at edges, `σ = σ0/√(R²−1)`, over a LADDER of scales because one σ0 is only conditioned near `R ≈ √2`. The 3×3 Sobel carries its own smoothing (σs ≈ 0.75, calibrated on synthetic edges), removed in quadrature — recovery of a known σ is within 1%.
- `coc.js` — every focus intent normalised to one 0..1 circle-of-confusion plane: `fromDepth` (thin lens in disparity space, with a foreground `nearBias`), `fromDefocus`, `fromMatte` (subject sharp, background by distance), `fromLinear` / `fromRadial` (tilt-shift), `fromGroundPlane`, `combine`, `refocus`.
- `plane-image.js` — image → working luma (512px long edge), plane → coverage canvas for `setMaskTexture`.

**GPU: the gather blur lives in the megashader.** A new `gradient` mask kind reads a texture as a RAMP (unlike `semantic`, which binarises at 0.5), so any CV output can drive an effect. New per-layer grade fields `blurPx`, `blurKind` (`disc | hex | ring | motion | spin`), `blurAngle`, `blurLength`, `highlightGain`, `highlightThreshold`, plus `structure`, `lux`, `fade`. **Blur radius = `blurPx` × the layer's own coverage**, so a feathered mask IS the circle of confusion and tilt-shift needs no extra map. The gather is a golden-angle spiral whose tap count scales with the radius (16-64) and whose mip level comes from the tap spacing, so a 200px radius costs what a 10px one does; mips are generated once per `sourceVersion`, only when a layer asks for blur, only on WebGL2. Two artefacts were found by LOOKING at real photos and fixed: a full random spiral rotation decorrelates neighbours and turns a night frame into speckle (the jitter is now at most half a tap), and too little mip averaging leaves a regular hatch (the level now matches the spacing). Highlight weighting reads the UNREDUCED pixel, because a mip has already averaged a specular point below any threshold — that is what makes bokeh balls instead of a smudge (the same two controls GEGL's `lens-blur` exposes).

**Lux / Structure / Fade** share one edge-aware local base (bilateral-weighted taps, the same precedent as the `smartBrush` kind): Structure is midtone-weighted local contrast with no halo at a hard edge, Lux is local tone mapping (shadow lift, highlight roll-off, midtone S-curve, saturation), Fade is a print model (black lift, highlight roll-off, colour drain). They sit in the **Adjust** panel and write a full-frame megashader layer (`adjust-tone`) that merges with whatever the Mask tool owns.

**Effects (`src/lib/effects/`)** turn those pieces into layers: `focus.js` (`tiltShiftLayer`, `motionBlurLayer`, `buildDepthOfField` — resolves depth from the service, else the subject matte, else the single-image defocus map, and reports which), `color-pop.js` (subject or colour-range keep mask, guided-filter refined, `keep` leaves ~15% saturation in the surround because a dead grey reads worse), `shadow.js` (`frameShadowParams` maps Photoshop's angle/distance/size/spread/opacity onto offsets; `castShadowAlpha` projects the silhouette onto the ground plane with softness growing by EDT distance from the contact line).

**Agent:** `src/lib/agent/focus-commands.js`, registered as the `focus` domain in `canvas.jsx` alongside mask/crop/collage — `focus.tiltShift`, `focus.depthOfField` (reports which source answered: service depth, subject matte or the photo's own defocus), `focus.motionBlur`, `focus.colorPop` (subject or a hex target), `focus.frameShadow`, `focus.castShadow`, `focus.clear`, plus `focus.fromDescription`. They build the same layers the panel does, so agent edits land in the change journal with the Bot badge, and every command clamps hostile parameters and reports what it actually used rather than echoing the request.

`parseFocusPrompt` is a DETERMINISTIC natural-language parser (no model call): the agent chat in `imagekit-agent.jsx` runs it right after the collage intent check and routes to `focus.fromDescription` only when it recognises something, so "give it a cinematic grade", "brighten the shadows" and "sharpen the sky" still reach the edit planner. It understands the effect names, strength words (subtle / strong), explicit units ("by 12px", "at 45 degrees"), aperture words (hex / ring), named colours and hex, and the phrasings people actually use ("make everything black and white except the red bus", "keep the purple, lose the rest", "make it look like a toy town"). Note one deliberate precedence: "drop" is not a removal verb, because *drop shadow* is the effect's name.

**UI:** a new **Focus & Light** panel (`tools/focus.jsx`, registered in `editor-sidebar.jsx` + `editor-topbar.jsx`) with Focus / Motion / Colour pop / Shadow sections. Colour pop takes a colour picked off the canvas (sampled in IMAGE space, so zoom and pan do not matter) and floods from that point with the existing **Magic Wand** rather than a hue test, which is what stops a matching colour elsewhere in the frame from surviving; a keep mask that covers more than 85% or less than 0.5% of the photo is refused with a reason instead of applying an invisible layer. A cast shadow is composited INTO an opaque photo (a shadow object under it would be invisible) and added as its own layer only for a cut-out; when the projection would land entirely inside the subject — a head-and-shoulders crop with no ground — it refuses with a reason instead of silently doing nothing.

Measured on an Apple M2 (`bun run verify:blur-perf`, real Chrome on `:9222`, one blur layer, mean ms/frame):

| | radius 8 | 24 | 60 | 120 |
|---|---|---|---|---|
| 1080p preview (2.1 MP) | 4.2 | 4.5 | 6.1 | 6.6 |
| 4K preview (8.3 MP) | 17.3 | 17.5 | 23.0 | 25.6 |
| 12 MP commit, no reuse | — | 33.3 | — | 46.1 |

Measured on the user's own camera files (three Sony ARW, two Nikon NEF, 20–45.4 MP) through the production RAW path — container → embedded preview → orientation baked → full-resolution depth-of-field commit: import 246–1072 ms, commit 58–336 ms, the 45.4 MP D850 frame being the slowest at 336 ms. `PHOSMITH_PHOTO_DIR` pointed at a folder of RAW makes `verify:collage-render` exercise that path (it recognises the container, refuses to call a plain decode on it, and asserts the extracted preview is a full frame rather than the 160×120 thumbnail a NEF's first IFD reports).

The renderer's own floor with no blur at all is 3.8 ms at 1080p and 13.7 ms at 4K, so the blur's own cost is ~3 ms and ~12 ms respectively at the widest radius — a 15× radius increase costs 1.5×, which is the mip level doing its job rather than the tap count. The gate asserts the 1080p frame stays inside 16 ms, that the 4K overhead stays under 1.5× the floor and clears 25 fps, that the mip chain is not rebuilt per frame, that a hexagonal aperture costs the same as a round one, and that a 12 MP commit lands under 2 s.

Verify with `bun run verify:cv` (78 pure checks: box mean and EDT against brute force, guided-filter regimes, σ recovery from synthetic blur, CoC monotonicity, hostile inputs, and the extremes — a 1×4096 strip, a radius larger than the image, NaN/zero eps, an all-masked and an unmasked distance transform, pure noise through the defocus estimator), `bun run verify:focus` (40 checks on the NL parser and the shadow/CoC maths: 27 real phrasings routed, 11 other-tool requests that must fall through, hostile and unicode input, intent precedence, shadow direction and degenerate geometry), `bun run verify` (GLSL invariants, now 303) and `bun run verify:mask-render` — which now drives the REAL Chrome on `:9222` over CDP before falling back to Playwright, and measures blur spread, `blurPx 0` byte-identity, highlight bloom, motion direction, Structure without halo, Lux shadow/highlight movement and Fade. `bun scripts/preview-effects.mjs --photos <dir>` renders the whole set on real photos for a visual judgement — that is how the speckle and hatch were found.

## Brush latency pipeline (Mask/Erase painting)

In-stroke feedback is composited on Fabric's TOP canvas (`contextTop`) — `usePixelMaskTool`'s liveSync fast path — so `requestRenderAll` is NEVER called mid-stroke (no full-scene redraw, no uncached full-res overlay object draw, no `after:render` viewport-chrome DOM sync per frame). The object-based overlay is hidden at stroke start and restored on mouse:up by the full sync. Pointer input uses `getCoalescedEvents()` so high-Hz mice paint smooth curves while visual sync stays one-per-frame with dirty-rect overlay repaints. If brushing ever lags again, check for anything calling `requestRenderAll` per pointermove.

**SAM 3.1 box prompt:** `/sam2/click` accepts an optional `box=[x0,y0,x1,y1]` form field (alone or with clicks) — boxes are SAM 3.1's strongest whole-object prompt. `/api/ai/sam3` validates/scales it; the Mask tool's Click-to-Select section has a "Draw box" drag mode; the agent command is `mask.addSubjectBox { box: [x,y,w,h] }`.

**AI Object Remover (click → SAM 3.1 → inpaint):** the Erase tool's click mode removes the whole object AND fills the hole with background (professional-eraser behavior), not just cut-to-transparency. Pipeline: click → `/api/ai/sam3` segments the object → `usePixelMaskTool.doObjectErase` posts image+mask to `/api/ai/inpaint`, whose `backend` field follows the `inpaint` routing capability (Device → **LaMa** on the mask service's `/inpaint`, lazy-loaded via `simple-lama-inpainting`; Server → **HF Stable Diffusion**; Auto → LaMa-first with HF fallback; explicit `lama` does NOT fall back). The route crops BOTH backends to padded mask bounds (LaMa runs at native res — a 12MP full-frame pass on CPU would take minutes; the patch is composited back with mask feathering). The committed result is uploaded to ImageKit first (data:-URL fallback) — NEVER `setSrc` a `blob:` URL: undo/redo recreates images from serialized src and the state is persisted, so a revoked page-scoped URL breaks both. Restore mode and inpaint-failure fall back to the alpha-mask path. Rate bucket `ai-inpaint` 5/min. Verify with `bun run verify:inpaint` (service-direct: asserts the object is gone, the fill matches the background, and pixels outside the mask are byte-identical; warm LaMa ≈3s on CPU for a 512×384 scene).

**Change history + agent attribution:** `src/lib/change-journal.js` logs every change with `source: 'user' | 'agent'` (per-project sessionStorage). `command-registry.runCommand` wraps execution in refcounted `beginAgentAction()/endAgentAction()` and records each mutating command; canvas history pushes and Mask-panel edits record user entries (suppressed while an agent acts, to avoid double-logging). The sidebar's pinned History panel (`_components/history-panel.jsx`) lists entries newest-first with a cyan Bot badge on agent-made changes. Verify with `bun run verify:history`.

To start the services in dev: `bun run services:dev` (both at once), or individually `bun run mask:dev` (segment) and `bun run masking:dev` (masking). Each script goes through `scripts/run-service.mjs`, which picks an interpreter that actually has the deps — the service's own `.venv`, else the sibling's (masking's requirements are a subset of segment's), else `$PYTHON`/`python3` — because a bare `python` resolves to the active pyenv shim and usually lacks fastapi. `bun scripts/run-service.mjs <segment|masking> --check` prints the interpreter without starting anything. BOTH must run for the full editor — selection endpoints live only on 8002, erase/crop only on 8001.

The services' env templates are at `services/segment/.env.example` and `services/masking/.env.example` — copy to `.env` and set model choices. Default models (BiRefNet, Meta SAM 3.1, Depth Anything V2 Small) download ~500 MB on first run.

For unit/integration tests that hit the service directly, the `scripts/verify-*.mjs` scripts default `MASK_SERVICE_URL` to `http://127.0.0.1:8001` and work without `.env.local`.

## Agent grade loop (planner → executor → judge → critic)

The colour-grading agent runs as a closed loop, all under `src/lib/agent/`:

- `grade-loop.js` — the orchestrator (`runGradeLoop`): validate → execute → judge → critique → corrective re-plan, max 3 iterations, escalates to the user when the same axis fails twice.
- `/api/ai/edit-judge` — 12-axis, reasoning-first Gemini judge (temperature 0, seed 42) cached in Neon `EditJudgeCache` keyed `(beforeHash, afterHash, planHash, judgeVersion)`. Deterministic no-change short-circuit; heuristic feature-delta fallback without an API key.
- `critic.js` — pure-function critic; maps the worst failing axis to additive corrective deltas. `plan-validator.js` — validates plans against `STYLE_KEYS`/`ADJUSTMENT_RANGES`.
- `command-registry.js#runPlan` — per-step retry (cap 3), halt-on-failure, resumable via `startAt`.
- Planner v6 (`src/lib/edit-planner.js`) accepts `criticFeedback` `{ axis, deltas, notes }` as a final additive layer; `/api/ai/edit-plan` accepts it in the POST body and folds it into the cache key.
- Durable run journal: `AgentRun` Prisma model via the `agentRun.*` Neon functions.

Invariant tests: `bun run verify:agent` (no services needed). Bump `JUDGE_VERSION` in the judge route when axes/prompt change, and `PLANNER_VERSION` when planner output changes.

## AI API routes

All 20 AI proxy routes live under `src/app/api/ai/`, plus `/api/diagnostics` for client failure reports:

| Route | Purpose |
|-------|---------|
| `/segment` | BiRefNet subject segmentation (fallback: HuggingFace) |
| `/sam3` | SAM 3.1 click/box/point prompts |
| `/sam2` | Legacy alias for `/sam3`, kept so older clients keep working |
| `/depth` | Depth Anything V2 monocular depth |
| `/ground` | CLIPSeg text grounding |
| `/segment-instances` | YOLO multi-instance detection |
| `/inpaint` | LaMa / HF Stable Diffusion inpainting |
| `/auto-crop` | 4-strategy AI auto-crop |
| `/shape-mask` | OpenCV fillPoly shape mask |
| `/background` | FLUX.1 AI background generation |
| `/extend` | Generative fill / outpainting |
| `/edit-plan` | Gemini AI edit planner |
| `/edit-judge` | 12-axis Gemini edit judge |
| `/mask-plan` | Gemini NL mask planner |
| `/stretch-plan` | Gemini vision pixel stretch planner |
| `/collage-plan` | Gemini vision collage template planner |
| `/collage-direct` | Composer art director — vision + on-device analysis → composition SPECS the layout solvers realise (no catalogue templates) |
| `/crop-analyze` | Gemini vision read of the photo for subject-aware crop (scene, subject boxes, eye line, horizon); no SAM, edges come from the on-device matte |
| `/warmup` | Proactive model warm-start for both services |
| `/health` | Service health check |
| `/diagnostics` | Client failure reports (not under `/ai`) — see **Client diagnostics** |

## Load performance

Measured over a real page load with CDP (`Network.*` + `Page.lifecycleEvent`), not guessed. Four things dominated, all on the data path rather than the bundle:

- **`projects.getUserProjects` selected every column, `canvasState` included** — the whole serialised Fabric document per project. The dashboard's first query was **19.8 MB and 14.3 s** to render a title, a thumbnail and a date. It selects `PROJECT_LIST_FIELDS` now; the editor still reads the canvas one project at a time through `projects.getProject`.
- **Every Neon call fetched the Clerk profile.** `getNeonAuthContext` called `currentUser()` — a network round trip to Clerk — on reads that only need the user id the session claims already carry. `auth()` alone verifies the JWT locally. The profile is now lazy (`loadProfile()`) and only pulled before a WRITE, with one fallback: a row predating `clerkUserId` can only be matched by email, so a lookup miss with no email in the claims pays for the profile once rather than creating a duplicate account.
- **`users.store` wrote on every page load** to refresh `lastActiveAt`. A known user whose row is fresher than `ACTIVITY_REFRESH_MS` (10 min) returns straight from the lookup, and `useStoreUser` no longer awaits `/api/billing/sync` before letting the app render.
- **Reads waited on that write.** `isAuthenticated` only turns true after `users.store` resolves, so the project query sat behind a full round trip. `useStoreUser` also returns **`isSessionReady`** (Clerk session present) and the read queries gate on that instead — every Neon function authenticates from the session itself. A brand-new account then has several calls racing to create its row, so `upsertAuthenticatedUser` catches `P2002` and reads the winner's row.

Warm, same machine, dev server:

| | dashboard | editor |
|---|---|---|
| before | 20.47 MB · FCP 1250 ms · network idle 18.2 s | 2.22 MB · 243 requests · network idle 9.5 s |
| after | 1.10 MB · FCP 499 ms · network idle 3.6 s | 1.15 MB · 120 requests · network idle 2.1 s |

The slowest single dashboard request went from 14,295 ms to ~420 ms, and no API call is in the top four any more — what is left is the HTML document and dev-mode chunk loading, which production bundles.

**Starting the project fetch before the bundle boots.** The editor's first request used to leave at ~990 ms — the cost of the client bundle booting and Clerk resolving a session — and a project row is ~840 KB, almost entirely `canvasState`. Moving the fetch into a server component was the obvious idea and the wrong one: inlining 840 KB into the RSC payload puts it in front of first paint. What helps is starting the SAME request earlier so it overlaps the boot. `src/components/project-preload.jsx` renders one inline `<script>` from the **root layout** that fires the `projects.getProject` POST immediately and parks the promise on `window.__phosmithPreload`, keyed by the exact request body; `useDatabaseQuery` adopts an in-flight promise once, then falls back to fetching (a refresh after a mutation must never replay a stale preload). Measured: first query at **+200 ms instead of +990 ms**.

Two placements were tried and rejected, both instructive:
- **A `<script>` in the editor's own route layout.** React never executes a script element rendered during a CLIENT render, so the preload was silently dead on every soft navigation into the editor — and React logged a console error each time. The root layout does not re-render on navigation, so its script is only ever part of the server-rendered document.
- **`next/script` with `strategy="beforeInteractive"`**, which looks idiomatic but is slower here: for an inline script it emits a stub that pushes onto `self.__next_s` for Next's runtime to execute, so the fetch would wait for that runtime — the delay this exists to avoid.

The project id is read from `location.pathname` at run time rather than route params, which is what lets this live in the root layout with no per-route wiring. It is an inline script, so a future strict CSP needs a nonce here.

**Mutations no longer invalidate every query.** `useDatabaseMutation` broadcast a global event that made every mounted query refetch, and `users.store` runs on every page load — so the 840 KB project row was fetched **twice** on every load, which the preload work exposed. Mutations may now declare `{ invalidates: ['query.name'] }`; omitting it keeps the broadcast, and `users.store` passes `[]` because it touches `lastActiveAt` and nothing any query renders. Measured: `projects.getProject` goes from 2 network fetches per load to 1.

### What each route downloads

The data path was the first half of the load problem; the JavaScript is the second. Measured by driving the real signed-in Safari against a production build and adding up the on-disk bytes of every `.js` the page fetched, so a warm HTTP cache cannot understate the payload (`performance.getEntriesByType('resource')` → `statSync` in `.next/static/chunks`).

Framework and vendor code dominate, and naming them is what stops a future session optimising the wrong thing: react-dom 200 KB, the Next client router 126 KB + 111 KB + 31 KB, `@clerk/nextjs` 84 KB + 54 KB, fabric 289 KB (editor only), lucide icons ~70 KB across three chunks. The landing page's own code is 38 KB of that.

What moved:

- **framer-motion is no longer in any route's initial load.** The landing page, the dashboard and the `neo/*` components animate with CSS keyframes in `src/styles/animations.css` instead; `src/hooks/useReveal.js` is the scroll reveal (an `IntersectionObserver` that adds `reveal-armed` then `reveal-in`, with `revealDelay(index)` writing the `--rise-delay` the stagger used to be). The group is armed by JS, so with JS off or before hydration the marketing copy renders fully visible — it is the page's own SEO payload.
- **The dashboard's two dialogs are `next/dynamic`.** The upload dialog pulls react-dropzone, the RAW preview decoder and the metadata stripper; nobody reading their project list needs any of it. Static per-route measurement: 536 KB → 430 KB (the route's own share 176 KB → 71 KB). Verified by looking: `[role=dialog]` count is 0 at load and 1 after clicking New Project, with a live `input[type=file]` in it. Each dialog latches a `…Mounted` state on first open and renders on `open || mounted`, so a lazily-loaded dialog still plays its exit animation.
- **The agent's five canvas command domains load when the agent panel opens, not when the canvas mounts** (`src/lib/agent/domain-host.js`). The canvas publishes its accessors to that module — which imports nothing — and `ensureDomains()` pulls `command-registry` + the mask/crop/collage/focus/stretch command modules on first use, so the pixel-stretch engine, the classical-CV core and the collage solvers are no longer fetched before the photo is on screen. Measured in the browser: 16 chunks, 503 KB, fetched only on opening the panel; `window.__phosmith.agentDomains` is `undefined` at load and `5` after. A canvas that remounts while the chunks are in flight is detected by identity, so the domains never register against a dead canvas.
- **The two Fabric filter classes that exist only for rehydration are registered lazily** (`src/lib/canvas-filter-registry.js`). `canvas.jsx` imported `curves-filter` and `fabric-megashader-filter` for their side effects, which put the megashader on the critical path of every editor load including projects that have no mask. `stateNeedsCanvasFilters(state)` tests the serialised state for `"PhosmithCurves"` / `"Megashader"` (either casing — `setClass` registers both) and `loadFromJSON` awaits the import only then; otherwise an idle callback warms it after first paint, so a project that had neither still has both before the first grade. A filter class Fabric cannot enliven is dropped **silently**, which is why the check reads the whole state as text rather than walking it. Measured: the editor's critical path 1517 KB → 1405 KB in 27 files, with the 82 KB megashader chunk arriving on the idle callback at ~1.9 s instead of before paint.

One change was measured and then deleted: `experimental.optimizePackageImports: ['@clerk/nextjs', …]`, on the theory that Clerk's single entry point drags the organization and user-profile surfaces into the marketing page. The landing payload was byte-identical either way (same 33 files, same 928 KB, the same 84 KB Clerk chunk), so the config line went back out rather than stay as an unbacked claim.

- **The marketing route no longer loads Clerk at all.** `ClerkProvider` sat in the root layout, so `/` downloaded the whole Clerk client SDK — 138 KB of app chunks plus 16 requests to `clerk.accounts.dev` and one to `img.clerk.com` — to render a header whose only question is *is someone signed in*. Clerk already answers that in the readable **`__client_uat`** cookie, published for exactly this purpose, so `src/lib/session-hint.js#hasSessionCookie()` reads it and the marketing header needs no SDK. The provider moved to `src/app/clerk-shell.jsx`, a **server** component (keeping Clerk's server-side auth prefetch, so `isLoaded` is not false on first paint) mounted by `src/app/(main)/layout.js` and `src/app/(auth)/layout.js` — the two route groups that actually use Clerk. `header.jsx` split into `header-shell.jsx` (all the chrome, no auth dependency, auth controls passed in as a slot) plus the Clerk variant, with `landing-header.jsx` as the Clerk-free one.

  Three details are load-bearing. **Sign in / sign up are plain `<a>`** on `/`, not `next/link`: prefetching either route pulls Clerk straight back onto the page for the visitors least likely to need it. **`useDashboardNavigation` gates its `router.prefetch('/dashboard')` on the same cookie** — an ungated prefetch put the 84 KB and 54 KB Clerk chunks back in the fetch set at low priority, which is how this was caught (total landing JS had gone *up*, 928 → 960 KB, while the critical path went down). And the static HTML renders the **signed-out** links, which is both the common case and what a crawler should see; the cookie check corrects it on hydration.

  Measured on a production build in the real signed-in Safari, one window and one tab, `?r=N` forcing fresh navigations. Signed-out is the same server on the LAN origin, which carries no Clerk cookies:

  | | before | after |
  |---|---|---|
  | landing route manifest | 397 KB, 9 chunks | **172 KB, 6 chunks** |
  | shared baseline manifest | 360 KB, 8 chunks | **111 KB, 5 chunks** |
  | landing JS, signed out | 928 KB in 23 files | **632 KB in 15 files** |
  | landing requests, signed out | 51 (35 local + 16 Clerk CDN) | **25, all local** |
  | landing API calls | `/api/neon/query` 683–1458 ms | **none** |
  | `window.Clerk` on `/` | `object` | **`undefined`** |

  A signed-in visitor on `/` still fetches the dashboard route and its Clerk chunks — deferred, after `loadEventEnd` — because for them the prefetch is the point. The dashboard route (440 KB) and the editor (940 KB) are unchanged, and `/` is still prerendered static.

  **One capability was traded for this, deliberately:** the marketing header shows a signed-in visitor only a *Dashboard* link — no `UserButton` avatar and no `ProBadge`. The badge is what pulled `usePlanAccess` and therefore the `/api/neon/query`; both controls remain on `/dashboard` and in the editor, which is where someone manages their account.

  Fixed while in this file: the mobile drawer's `inert` was passed as the empty string, which React 19 reads as a boolean and treats as falsy — so a closed drawer kept its links focusable. It is `inert={!mobileMenuOpen}` now, verified by driving the real page (closed `inert: true` / `visibility: hidden`, open `false` / `visible`, closing by the X and by the scrim both restoring it).

Still on the list, in the order they are worth doing: `mask.jsx` (5627 lines), `imagekit-agent.jsx` (3207), `pixel-stretch.jsx` (2754) and `canvas.jsx` (2502) are each a module boundary waiting to be drawn, and none of them is on the critical path in a way that bytes measure; the editor's `/api/canvas/snapshot` takes 737 ms on load.

**Animations cannot be measured in an occluded window.** Safari never *starts* a CSS animation on a page whose `visibilityState` is `hidden`, and a terminal in fullscreen over the browser is enough to make it hidden — `getAnimations()` reports `playState: "running"` with `startTime: null` and `currentTime: 0` forever, so a reveal reads as a permanent `opacity: 0` and looks exactly like a broken keyframe. `activate` does not fix it across Spaces. Call `finish()` on each animation and read the computed style instead: the 17 `.reveal` elements on the landing page all resolve to `opacity: 1` and an identity transform, which is what a visitor with a visible tab gets.

**Profiler:** not in the repo; profile with CDP against a page and look at the API waterfall (start offset + duration per `/api/` call).

**Memory discipline** (the sibling `seglab` project is the reference): one heavy job at a time so peak allocations cannot stack, lazy modules that are disposed after use, and a megapixel cap before any full-resolution unpack. Pixel Stretch already follows the second of those — see `releaseStretchScratch`.

## Resize path, and the selection toolbar

**A resize step costs one canvas render and no React render.** Dragging the sidebar or a window edge fires the `ResizeObserver` tens of times a second, and each step re-fits the project, which moved two pieces of React state:

- `projectFrameStyle` — the rect the project-frame outline, its texture and the Compare overlay are drawn at. It was recomputed in `syncProjectFrame`, which runs on every `after:render`, so every frame of a pan, zoom or resize re-rendered the whole 2500-line `CanvasEditor`. The rect now lives only in `projectFrameStyleRef` and is written straight onto the three nodes by `applyProjectFrameStyle` (refs, `node.style.left/top/width/height`). A mount effect places a node that has just appeared, because an overlay mounted between renders would otherwise carry no geometry until the next canvas render — seconds away on an idle canvas. `isProjectFrameVisible` stays state (it mounts and unmounts the nodes) but is guarded by a ref so it is set once, not per frame.
- `previewZoomPercent` — the zoom HUD. Re-fitting changes the percentage on nearly every step, and nobody reads a number that is moving. `isResizingRef` makes `syncPreviewZoomState` keep the ref current and skip the setState during a gesture; a `RESIZE_SETTLE_MS = 150` timer publishes the final value once the drag stops.

The redundant `__syncProjectFrame()` + `syncPreviewZoomState()` after the synchronous `renderAll()` are gone — `renderAll` fires `after:render`, which already ran both.

Measured in Safari 27 on an Apple M2, driving 200 resize steps on the real signed-in editor at a 1880px host, three runs each side, with the served bundle probed before every run (Turbopack hot-swaps modules under a live page, so an unverified run measures the wrong code):

| | frame time mean | p95 | frames > 20 ms | HUD text writes |
|---|---|---|---|---|
| before | 16.7–17.2 ms | 18–21 ms | 1–10 | 79 |
| after | 16.6–17.5 ms | 18–20 ms | 0–8 | 0 |

**The frame time is unchanged, and saying otherwise would be the easy lie.** At this canvas size on this machine the resize work already fitted inside one vsync interval, so the metric that moves is the React work: 79 HUD text writes per 200 steps become 0, and the whole editor no longer re-renders per frame. That headroom is what a slower device or a larger canvas spends.

One "optimisation" was measured and then deleted: a `canvas.cancelRequestedRender()` after the synchronous `renderAll()`, on the theory that `setDimensions` and `setViewportTransform` each queue an rAF render the manual render does not clear. Counting real renders (patch `clearRect` on the lower canvas — fabric clears it exactly once per `renderCanvas`) gave **0.98 renders per step with and without it**. Fabric's own `renderAll()` calls `cancelRequestedRender()` first (`fabric/dist/index.mjs:2622`), so there was never a duplicate to remove.

**The floating selection toolbar** (`ContextualActionBar.jsx`) was positioned by `page.jsx` state initialised to `window.innerWidth / 2` once on mount, and gated on `visible={!!canvasEditor?.getActiveObject?.()}` — a value read during a render of a component with no `selection:*` subscription, so it lagged a selection by one unrelated re-render and lingered after a deselect. The bar now owns its own selection state and places itself: it maps the object's `getCoords()` corners through the viewport transform, centres on that bbox, sits `GAP` above it, flips below when it would leave the top edge, and clamps to the viewport. It re-places on `selection:created|updated|cleared`, `after:render`, window resize and scroll, plus a `ResizeObserver` on the canvas element, since opening a tool panel resizes the canvas without firing a window resize. Its own width is measured once per content change into `sizeRef` rather than read from `offsetWidth` inside `after:render`, which would put a forced reflow on every frame — the cost this whole section is about. The outer node holds the imperative left/top and the inner `motion.div` does the opacity/scale, so framer-motion's transform writes cannot fight the centring.

Its exit animation was the second defect, and the worse one. `AnimatePresence` wrapped the bar and its exit pass never completed: after a deselect the component's own state was already `null`, but the node stayed mounted, fully painted, with `pointer-events: auto` — so a bar nobody had selected anything for went on swallowing clicks over the canvas. Giving the child a key made the exit at least animate (opacity 0, scale 0.95) and it still never unmounted, which is worse again: an invisible click target. `AnimatePresence` is gone — the bar mounts and unmounts on its own `selectedObject` and keeps only an entrance animation. The two-node split is load-bearing for a second reason: a later `.glass-panel` rule sets `position: relative; isolation: isolate`, which beats Tailwind's `.fixed` utility, so the glass-panel node can never be the positioned one.

Verified by driving the real signed-in editor in Safari rather than by reading it: the bar's centre lands on the object's own screen bbox centre with the `GAP` of 14 px above it, follows a pan and a pan back, flips below the object at the top edge, `Lock` is reversible and leaves the object selectable, and a click on empty canvas removes the node. With an image selected — so `place()` runs on every `after:render` — 200 resize steps cost a mean of 16.63 ms, p95 19 ms, max 29 ms, 5 frames over 20 ms, none over 33 ms, with 0 React commits and 0 HUD writes (at a 971 px host; the table above was measured at 1880 px). No uncaught errors across the whole drive.

Two dead controls went with it: a `Move` button that did nothing and a `Scale` one drawn with a balance-scale glyph. `Lock` set `selectable: false, evented: false`, so a locked object could never be clicked again to unlock it — it now locks movement, rotation and scaling only, keeps the object selectable, and the icon reflects the state. `FloatingToolbar.jsx` (290 lines, imported nowhere) is deleted.

## Client diagnostics

Everything known about this app's reliability came from one Chrome on one Mac. `src/lib/client-diagnostics.js` is how a failure on someone else's device becomes visible: `installDiagnostics()` (mounted once by `components/diagnostics-boot.jsx` in the root layout) listens for uncaught errors and unhandled rejections, takes a one-off capability census (WebGL2, OffscreenCanvas), and beacons batches to `/api/diagnostics`. The root error boundary reports and flushes immediately, since a crash that reaches it is the one worth knowing about.

**Privacy is the first constraint, not a later pass.** An error message can trivially contain a `data:` URL of someone's photo, a signed ImageKit URL, a JWT or an email, so `redact()` runs over every field before anything leaves the page: `data:`/`blob:` URLs, query strings, uploaded file names, emails, JWTs (matched on the `eyJ` header shape — a real Clerk header segment is only ~20 chars, so a length-based rule misses the payload) and any 32+ character opaque string. There is no free-text field a caller can abuse, and the server re-clamps everything anyway. The user id is logged as a 4-byte hash so repeat reports correlate without the log becoming a record of who used the app when.

**Volume**: identical faults collapse for 30 s, a session is capped at 25 reports, delivery is `sendBeacon` so it never delays a navigation, and the route is rate-limited (`diagnostics`, 12/min) as a backstop against a forged flood.

Verify with `bun run verify:diagnostics` (29 checks, all of them about what cannot get out — including a repo-wide scan asserting that **no source file contains a credential-shaped literal**. Two fixtures in this project were shaped like real credentials, a Stripe key and a JWT, and each blocked a push: a scanner cannot tell a fixture from a leak, so such values are assembled at runtime rather than written in source).

Reading its own output from a real Safari session found two defects in it: a rejection carrying a plain object reported as literally `[object Object]` (`describeReason` now gives the JSON or the keys, and never that token), and Safari not exposing `navigator.deviceMemory` was logged as `memoryGb: 0` — "this machine has 0 GB" rather than "unknown". Both are the instrument grading itself, which is the point of having one.

## One heavy job at a time

`src/lib/heavy-job-queue.js` serialises the operations whose PEAK allocation is large — a full-resolution export re-render, a pixel-stretch bake (source snapshot + ribbon buffer + PNG encode, each the size of the image), subject detection (SlimSAM plus one full mask per seed candidate). Nothing stopped them overlapping, so their peaks stacked; on the 8 GB machine this project is developed on that is the difference between a smooth editor and one where every pointer event takes seconds (measured: 0.3 GB free, 3.4 GB of swap in use).

`runHeavy(label, fn, { priority, key })` — concurrency 1, ordered by `PRIORITY` (`interactive` < `background` < `prewarm`) then arrival. `finally` returns the slot, so a throwing job cannot wedge everything after it, and a watchdog releases the slot after 45 s rather than letting one stuck upload brick the editor.

**Wrap only true leaves.** A queued function that calls another queued function deadlocks against itself. The wrapped points are `snapshotCanvasToBlob`, `flattenLiveCanvasForAnalysis`, `clientSubjectMask` and `applyStretchToCanvas`; the panel takes the slot around its own bake→encode→upload sequence and fetches its matte BEFORE entering, because subject detection is queued too. `bakeStretchBuffer` is deliberately not wrapped for that reason.

**`key` supersedes a QUEUED job of the same key** — right for a double-clicked Apply button (`stretch-commit-button`) and for the agent's analysis snapshot (only the newest canvas state matters), wrong for anything where two calls are two intents. Subject detection and the shared commit path carry no key, so a queued agent command is never silently dropped. A superseded rejection carries `superseded: true`; `isSuperseded(error)` is how the UI tells "replaced by your newer click" from a real failure.

`window.__phosmith.heavy` exposes `stats` / `onHeavyChange` for diagnosis. Verify with `bun run verify:heavy-queue` (15 checks: never two at once under eight concurrent callers, a throwing job returns the slot, priority and FIFO ordering, supersede semantics including that a RUNNING job is never superseded, a broken listener cannot break the queue).

## User-facing error messages

`src/lib/user-error.js#toUserMessage(error, fallback)` sits in front of every error toast in the editor (~35 call sites). Before it, each catch put the raw `message` in the toast — which reads fine for errors we threw and badly for everything else: a dropped connection makes `fetch` reject with the literal string **"Failed to fetch"**, so on a flaky phone connection that was the message for every feature in the app. A cancelled request gave "The user aborted a request"; a refused canvas gave "IndexSizeError".

It maps the failures that actually happen onto plain sentences — offline, unreachable server, cancelled, 401/413/429/501/5xx — and passes anything we wrote ourselves straight through, since those are already aimed at the user. A thrown plain object can no longer render as `[object Object]`.

Verify with `bun run verify:user-error` (16 checks, including that the word "fetch" can never reach a user).

## Carrying the working context to another device

A `git pull` on a second machine used to deliver the code with none of the context that makes it legible. `CLAUDE.md` and `AGENTS.md` were gitignored, and the project memory lives outside the repo entirely, at `~/.claude/projects/<slug>/memory/`. So the next session over there re-derived the codebase from scratch and re-learned every preference the hard way.

Both files are TRACKED now, and `.gitignore` says why at the line that used to ignore them. `.claude/` is ignored except `.claude/context/`, which holds a mirror of the memory directory — eleven files, 48 KB. What stays out is everything machine-local: 194 MB of session transcripts in the same `~/.claude/projects/` tree, `~/.claude/plans/`, and `settings.local.json`.

`scripts/claude-context.mjs` is the mirror. `sync` runs both directions, `pull` and `push [--stage]` run one, `status` prints what differs; `bun run claude:context <command>`. It is wired into `dev`, so pulling the code and starting the editor is all this device needs — and a failure there is caught and logged rather than thrown, because mirroring notes is never a reason to stop someone starting the editor.

**The local directory is derived, not configured.** Claude Code names a project directory after the absolute repo path with every non-alphanumeric character replaced by `-`, so `projectSlug(repoRoot)` reproduces it from `cwd` and a clone at a different path on another machine resolves to that machine's own directory. Verified by running the mirror against a clone at an unrelated path with an unrelated `HOME`: every memory landed under the new slug.

**The conflict rules are the whole design, because the failure mode is losing a note rather than failing loudly.** A side file records the hash each memory had when the two sides last agreed, which is what tells an edit apart from a stale copy:

- One side changed, the other still matches the agreed hash: the change is carried across.
- Both sides changed: **the local version is kept** and the incoming one is saved beside it, named `<name>.md.remote`. The suffix matters — every `.md` in the memory directory is loaded as a memory, so a rejected remote version ending in `.md` would itself become context.
- A memory absent on one side is a deletion only if the two sides had agreed on that exact content; otherwise it is new work and gets copied. The agreed hash is KEPT when a deletion is recognised, not cleared — clearing it made the pull correctly refuse to resurrect a deleted memory and then left the repo copy in place forever, which `verify:context` caught.

Verify with `bun run verify:context` (43 pure checks in a temp directory: the slug against this machine's real directory, first pull, idempotence, an edit on either side, a two-sided conflict and that its copy is not a `.md`, deletions in both directions, a deletion not resurrected, an upstream deletion losing to a local edit, a corrupt state file, a device with no memory directory yet, non-markdown and directory entries skipped, and a full two-device round trip).

**Not included: a git hook.** Firing the mirror from `post-merge`/`post-checkout` would make the context land on the pull itself rather than on the next `bun run dev`, and it is four small files plus `git config core.hooksPath .githooks`. Installing it is the repo owner's call, not something a tool should write into a working copy on its own.

## Keeping this file honest

`CLAUDE.md` is the context a future session loads instead of re-deriving the codebase, so it is updated in the SAME commit as the code it describes — with the reasoning and the measured numbers, not just what exists. The parts that rot silently are the ones nobody re-reads, so `bun run verify:docs` checks the claims that can be checked mechanically:

- every `verify:*` script in `package.json` appears here
- every directory under `src/app/api/ai` appears in the route table, and the count in the prose matches
- every documented check count matches what that suite actually prints — in both the prose form (`` `bun run verify:cv` (78 pure checks…) ``) and the list form (`bun run verify  # 303 …`)
- `src/lib` has not grown a pile of modules nobody described

It has already caught a route table claiming 17 routes when there were 20, and a list claiming 289 GLSL invariants when there were 303. A count a suite does not print should not be written down at all — it cannot be checked, so it will rot.

## Verification scripts

```bash
bun run verify              # 303 Megashader GLSL invariants (incl. batch + fold pass roles)
bun run verify:chain-fold   # Chain-folding algebra (property tests, no GPU)
bun run verify:fold         # Suffix fold on a real GPU (Chrome on :9222, else Playwright, else skips)
bun run verify:fuzz         # Hostile-input fuzz of the pure mask libs
bun run verify:selection    # Magic Wand flood fill + Select-and-Mask edge refinement
bun run verify:mask-render  # Playwright: EDITOR megashader path (applyMegashaderFilter on real Fabric), incl. persistence + base-grade gates
bun run verify:stretch      # Flow-path pixel stretch engine
bun run verify:stretch-core # Scanline smear + stretch NL parser (pure)
bun run verify:docs         # CLAUDE.md against reality: routes, verify list, check counts
bun run verify:context      # Memory mirror's three-way rules (pure)
bun run verify:user-error   # Error-message humaniser (pure)
bun run verify:heavy-queue  # One-heavy-job-at-a-time scheduler (pure)
bun run verify:diagnostics  # Client error reporting + redaction (pure)
bun run verify:mask         # Magnetic lasso edge-snap (Sobel + snap)
bun run verify:agent        # Agent grade loop
bun run verify:nl-mask      # NL mask parser + CLIPSeg grounding
bun run verify:instances    # YOLO multi-instance detection
bun run verify:cv           # Classical CV core: guided filter, EDT, defocus, CoC
bun run verify:focus        # Focus NL parser + shadow/CoC edge cases (pure)
bun run verify:blur-perf    # Gather-blur frame budget on a real GPU (Chrome :9222)
bun run verify:collage-grid  # Grid collage geometry, fits, arrangement (pure)
bun run verify:collage-render # Collage render/export in a real browser (Chrome :9222)
bun run verify:crop-compose # Analysis-driven auto-crop composition (no service)
bun run verify:auto-crop    # Auto-crop 4-strategy pipeline (service path)
bun run verify:extend       # AI Extend frame validation
bun run verify:inpaint      # LaMa object removal
bun run verify:client-ai    # In-browser RMBG-1.4 (Playwright harness)
bun run verify:segment      # BiRefNet segmentation
bun run verify:semantic     # SAM 3.1 click/box segmentation
bun run verify:depth        # Depth Anything V2
bun run verify:depth:full   # Depth comprehensive (all modes)
bun run verify:subject-cleanup  # Subject mask cleanup pipeline
bun run verify:history      # Change journal + history panel
```
