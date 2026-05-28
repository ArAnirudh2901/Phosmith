# Pixxel GPT - Project Overview for Agents

Welcome! This document provides an architectural overview of the **Pixxel GPT** codebase to help AI agents understand the stack, folder structure, key paradigms, and layout constraints.

## Tech Stack

- **Framework**: [Next.js](https://nextjs.org/) (App Router, React 19)
- **Authentication**: [Clerk](https://clerk.com/) (`@clerk/nextjs`)
- **Primary Backend (Realtime/Serverless)**: [Convex](https://convex.dev/)
  - *Note: See `AGENTS.md` and `CLAUDE.md` for Convex-specific AI agent guidelines.*
- **Secondary Database**: [Prisma](https://www.prisma.io/) with PostgreSQL (Used for ImageKit Docs, Agent Runs)
- **Styling**: Tailwind CSS v4, Framer Motion, and custom CSS (`animations.css`, `globals.css`)
- **Canvas/Image Editor**: [Fabric.js](http://fabricjs.com/) (`fabric`) for the main editor canvas, [ImageKit](https://imagekit.io/) for transformations.
- **3D/Effects**: `@react-three/fiber`, Lenis (smooth scrolling).
- **UI Components**: Shadcn UI (`src/components/ui`) & Radix UI.

## Directory Structure

- `/src/app`: Next.js App Router root.
  - `/(auth)`: Clerk authentication pages.
  - `/(main)/dashboard`: User dashboard for managing projects.
  - `/(main)/editor`: The main Fabric.js canvas and AI image editor workspace.
- `/src/components`: React components.
  - `/editor`: Editor-specific components (toolbar, canvas wrappers, layers).
  - `/ui`: Shadcn UI primitives.
- `/convex`: Convex backend functions, schemas, and queries.
  - `schema.js`: Primary source of truth for Users, Projects, Folders, and AI caches.
  - `projects.js`, `users.js`: Core CRUD operations.
  - `editPlanCache.js`, `canvasTargetCache.js`: Advanced AI caching logic (content-addressable).
- `/prisma`: Prisma schema (`schema.prisma`) defining auxiliary models (`ImageKitDocPage`, `ImageKitAgentRun`).
- `/scripts`: Utility scripts (e.g., `ingest-imagekit-docs.mjs`).

## Key Paradigms & Patterns

1. **Dual Backend**:
   - Convex handles all live application state (Projects, Canvas State, Revisions, Users, AI Caching).
   - Prisma/PostgreSQL handles unstructured or large analytical logs, such as RAG documentation (ImageKit Docs) and AI Agent Run telemetry.
2. **Canvas State & Write-Behind Caching**: 
   - The Fabric.js canvas state is serialized into JSON and stored in Convex under the `projects` table (`canvasState` field).
   - To reduce write load and improve performance, a **Write-Behind Cache** is used: state updates are batched/debounced in memory and flushed asynchronously to Convex, with a `beforeunload` keepalive flush to guarantee persistence.
3. **AI Caching & Deterministic Planning**:
   - The AI implementation relies heavily on caching identical requests (e.g., same image hash + prompt) in Convex (`editPlanCache`, `canvasTargetCache`) using perceptual hashing (dHash) to save LLM tokens and ensure consistent results.
   - The Gemini AI planner runs deterministically using a fixed `seed` (42) and structured `responseSchema` to guarantee reproducibility.
4. **Exposure/Contrast-Aware Gain Bias**:
   - The Gemini AI Retouching engine receives image metadata/features and applies an exposure/contrast-aware gain bias to prevent over-processing.
   - A **No-Change Guard** (idempotency) guarantees that applying the same edit prompt to an already-matching image results in zero modifications.
5. **Canvas UX and Zoom Constraints**:
   - The zoom scale in the editor ranges from **5% to 300%**, moving in precise **1% increments**.
   - Canvas fitting automatically handles responsive viewport sizing: using a **92% safe-zone fit** and a reduced padding threshold (**32px**) on small screens.
   - Re-hydration checks prevent the canvas image from flickering/reloading when sidebar widths change.
6. **Neo-Brutalist Theming & UI styling**:
   - Built on a "Void Dark" theme with neo-brutalist elements: pitch-black cards/headers, offset borders with bright color shadows (cyan, green, coral, amber), and uppercase monospaced typography.
   - Sonner toaster alerts are styled neo-brutalist and pinned to top-center (`top: 76px`) using fixed placement.

When working on this project, ensure you respect the dual-backend architecture, caching layers, and the strict neo-brutalist design guidelines.
