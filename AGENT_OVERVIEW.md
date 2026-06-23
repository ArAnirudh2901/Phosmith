# Pixxel — Project Overview for Agents

Welcome! This document provides an architectural overview of the **Pixxel** codebase to help AI agents understand the stack, folder structure, key paradigms, and layout constraints.

## Tech Stack

- **Framework**: [Next.js](https://nextjs.org/) (App Router, React 19)
- **Authentication**: [Clerk](https://clerk.com/) (`@clerk/nextjs`)
- **Primary Database**: [Neon](https://neon.com/) Postgres through [Prisma](https://www.prisma.io/)
- **Temporary Cache**: Redis or Upstash Redis, with an in-memory development fallback.
- **Styling**: Tailwind CSS v4, Framer Motion, and custom CSS (`animations.css`, `globals.css`)
- **Canvas/Image Editor**: [Fabric.js](http://fabricjs.com/) (`fabric`) for the main editor canvas, [ImageKit](https://imagekit.io/) for transformations.
- **Masking Engine**: A custom **megashader** — a single WebGL2 fragment shader that evaluates a chain of 7 mask kinds (linear, radial, luminance, color, smart-brush, semantic AI, depth) and boolean compositions (replace/add/subtract/intersect). Lives in `src/lib/megashader/`.
- **AI Selection Service**: A local Python FastAPI service in `services/segment/` running BiRefNet (`rembg`), SAM 2, Depth Anything V2, YOLO (multi-instance detection), CLIPSeg (text grounding), and LaMa (inpainting). Reached via `MASK_SERVICE_URL=http://127.0.0.1:8001`.
- **In-Browser AI**: RMBG-1.4 via `@huggingface/transformers` (WebGPU → WASM fallback) for client-side background removal.
- **AI Planning**: Gemini (edit plans, mask plans, judge) with deterministic heuristic fallbacks.
- **Generative AI**: FLUX.1 via HuggingFace Inference API for background and collage background generation.
- **3D/Effects**: `@react-three/fiber`, Lenis (smooth scrolling).
- **UI Components**: Shadcn UI (`src/components/ui`) & Radix UI.

## Directory Structure

- `/src/app`: Next.js App Router root.
  - `/(auth)`: Clerk authentication pages.
  - `/(main)/dashboard`: User dashboard for managing projects.
  - `/(main)/editor`: The main Fabric.js canvas and AI image editor workspace.
  - `/api/ai/{segment,sam2,depth,background,inpaint,extend,edit-plan,mask-plan,auto-crop,ground,segment-instances}`: AI route proxies.
  - `/api/canvas/*`: Canvas presence and snapshot routes.
  - `/api/neon/*`: Database query/mutation routes.
- `/src/components`: React components.
  - `phosmith-wordmark.jsx`: Pure inline SVG brand mark (cyan 4-point spark + "Pixxel" text). Import `PIXXEL_SPARK` for the path data.
  - `header.jsx`: App header — hidden in the editor, shows wordmark + auth controls on marketing/dashboard pages.
  - `/ui`: Shadcn UI primitives.
  - `/neo`: Neo-brutalist design system components (NeoButton, ShortcutsGuide, Marquee, etc.).
- `/src/lib`: Core library modules.
  - `megashader/`: GLSL megashader engine — compiler, renderer, Fabric filter, mask-kind registry, GLSL fragment templates.
  - `agent/`: Agent command system.
    - `command-registry.js`: `registerDomain(domain, defs)` → `runCommand(id, args)`. Exposes `window.__pixxel.agent`.
    - `collage-commands.js`: `createCollageCommands({ getCanvas, getProject })` factory — `collage.*` domain (createTemplate, fromDescription, autoTemplate, generateBackground, setBackground, listLayouts, listStyles).
    - `mask-commands.js`: `mask.*` domain (selectSubject, clickSelect, addSubjectBox, detectSubjects, selectSubjects, fromDescription, expandLayer).
    - `crop-commands.js`: `crop.*` domain (auto, subjectAware, fitAspect, contentFill, applyBox).
    - `grade-loop.js`: AI color-grading grade loop (validate → execute → Gemini judge → critic → corrective re-plan, max 3 iterations).
    - `nl-mask.js`: NL mask executor — resolves plan steps to mask layers using subjects/CLIPSeg/depth/luminance/colorRange.
    - `nl-mask-parser.js`: Deterministic heuristic NL mask plan parser (keyless Gemini fallback).
  - `collage-layout.js`: Pure geometry engine — `LAYOUTS` (14 layouts), `buildLayoutCells`, `computeCollageCells`, `generateTemplateRecipes`, `fitImageToCell`, `cellFromClipPath`, `clampToCell`, `pickLayoutForCount`. No React. Shared by the collage tool UI and agent commands.
  - `collage-styles.js`: Collage presets — `COLLAGE_STYLES` (10 style presets), `COLLAGE_BACKDROPS` (12 swatches), `AI_BG_THEMES` (6 themes), `TEMPLATE_LOOKS` (12 curated looks). Builders: `buildCellClipPath`, `buildCellShadow`, `applyCollageBackground`, `buildAiBackgroundPrompt`.
  - `ai-routing.js`: Per-capability `auto|client|server` routing policy. `resolveOrder(cap)` returns the ordered attempt list.
  - `canvas-state.js`, `canvas-sync.js`, `canvas-history.js`: Canvas persistence, real-time sync, and undo/redo.
  - `change-journal.js`: Per-project sessionStorage change log with `source: 'user' | 'agent'`. Refcounted agent attribution via `beginAgentAction/endAgentAction`.
  - `extend-poller.js`: Module-scoped poller for AI Extend's async genfill — swaps the soft preview for the real result when the job completes.
  - `mask-grow.js` / `mask-grow-core.js`: Morphological mask boundary grow/shrink (absolute px from pristine `baseTextureKey`).
  - `client-ai.js`: In-browser AI engines (RMBG-1.4, CLIPSeg, Depth Anything V2) with WebGPU → WASM fallback, golden-input calibration gate, and sticky device demotion.
- `/src/app/(main)/editor/[projectId]/_components/tools/`: One file per editor tool panel.
  - `collage.jsx`: Collage tool UI — layout preview thumbnails, stylish template gallery, per-cell Replace/Edit, AI background generation, auto-template generator.
  - `imagekit-agent.jsx`: AI agent chat — routes collage intents via `COLLAGE_INTENT_RE`, edit intents via grade loop, mask intents via `mask.fromDescription`.
  - `mask.jsx`: Mask tool UI — "Detect All Subjects" button, per-layer boundary slider, AI routing toggles.
  - `crop.jsx`: Crop tool UI — AI Auto-Crop with 4-strategy preview buttons.
  - `erase.jsx`: Erase tool — AI Object Remover (click → SAM 2 → LaMa inpaint → ImageKit upload → `setSrc`).
- `/services/segment`: Local Python FastAPI mask service. Started with `bun run mask:dev`.
- `/prisma`: Prisma schema — users, projects, revisions, agent edit sets, AI caches (edit plan, judge, canvas target), ImageKit docs, agent runs.
- `/scripts`: Verification scripts (`verify-*.mjs`) for every AI endpoint and the grade loop.

## Key Paradigms & Patterns

1. **Agent Command Registry**:
   - All editor capabilities are registered as named commands via `registerDomain(domain, defs)` in `command-registry.js`.
   - Commands are invoked by the agent chat, verify scripts, and keyboard shortcuts through a unified `runCommand(id, args)` interface.
   - The registry is exposed on `window.__pixxel.agent` — call `listCommands()` to enumerate all registered commands at runtime.
   - Every `runCommand` call is wrapped in refcounted `beginAgentAction/endAgentAction` and logged to the change journal with `source: 'agent'`.

2. **Collage Engine**:
   - The collage geometry is a pure, React-free module (`collage-layout.js`) shared by both the tool UI and agent commands.
   - Cell framing uses Fabric `absolutePositioned` clipPaths (Rect with `rx/ry` for rounded, Ellipse for circle) so the cell geometry serializes natively with the canvas state.
   - Drop shadows are Fabric `Shadow` objects, also serialized. `cellFromClipPath(image)` recovers the cell bounds on canvas reload.
   - AI backgrounds are generated via `buildAiBackgroundPrompt(theme, colors)` which seeds the prompt with dominant colors sampled from the collage photos using `fast-average-color`.
   - `generateTemplateRecipes(photoCount, count)` shuffles usable LAYOUTS × TEMPLATE_LOOKS to produce themed template suggestions shown in the gallery.

3. **Neon/Postgres Backend**:
   - Prisma models are the source of truth for users, projects, canvas state, revisions, agent edit sets, AI caches, RAG documentation, and agent telemetry.
   - Never bypass the lazy database helpers in `src/lib/prisma.js`.

4. **Canvas State & Write-Behind Caching**:
   - The Fabric.js canvas state is serialized into JSON and stored in Postgres under the `projects` table (`canvasState` field).
   - State updates are batched/debounced in Redis and flushed asynchronously to the database. A `visibilitychange→hidden` normal flush (not beaconUnload) advances `baseRevision` to avoid spurious "edited on another device" conflicts.

5. **AI Caching & Deterministic Planning**:
   - The AI implementation caches identical requests (same image hash + prompt) in Postgres using perceptual hashing (dHash).
   - The Gemini AI planner runs with a fixed `seed` (42) and structured `responseSchema` for reproducibility.
   - Bump `JUDGE_VERSION` in the judge route when axes/prompt change; bump `PLANNER_VERSION` when planner output changes.

6. **Undo/Redo & Object Identity**:
   - `loadFromJSON` recreates all Fabric objects from scratch on undo/redo — object references go stale. Always match canvas objects by `src`/props, never by identity.
   - Never commit a `blob:` URL into a Fabric image. Upload to ImageKit first (data:-URL fallback). Blob URLs are page-scoped and revoke on navigation, breaking persistence and undo.

7. **AI Routing**:
   - `src/lib/ai-routing.js` — per-capability `auto|client|server` policy, `resolveOrder()` gives preferred-side-first with runtime fallback.
   - In-browser engines are verified by `bun run verify:client-ai` (Playwright Chromium, standalone bun-build bundle, model cache in `.cache/playwright-client-ai`).
   - RMBG-1.4 via the MANUAL recipe (`AutoModel model_type:'custom'` + explicit processor config) is the only matting engine that works in this onnxruntime-web build. Do not substitute BiRefNet-lite or MODNet via `pipeline()`.

8. **Canvas UX and Zoom Constraints**:
   - Zoom range: **5% to 300%**, in precise **1% increments**.
   - Canvas fitting: **92% safe-zone fit**, reduced padding threshold (**32px**) on small screens.

9. **Neo-Brutalist Theming**:
   - "Void Dark" theme: pitch-black cards/headers, offset borders with bright color shadows (cyan `#06B8D4`, green, coral, amber), uppercase monospaced typography.
   - Brand accent: `#06B8D4` (cyan). Background void: `#0B0D12`. Text primary: `#F4F4F5`.
   - Sonner toaster alerts are styled neo-brutalist and pinned to top-center (`top: 76px`).

10. **Brush Latency**:
    - In-stroke feedback is composited on Fabric's `contextTop` canvas (never `requestRenderAll` mid-stroke — that triggers full scene redraw + `after:render` DOM sync per frame, causing cursor lag).
    - Pointer input uses `getCoalescedEvents()` for smooth curves on high-Hz mice.

When working on this project, respect the Prisma-backed data model, caching layers, command registry patterns, and the strict neo-brutalist design guidelines.
