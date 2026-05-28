# Pixxel GPT - Project Overview for Agents

Welcome! This document provides an architectural overview of the **Pixxel GPT** codebase to help AI agents understand the stack, folder structure, and key paradigms.

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
2. **Canvas State**: The Fabric.js canvas state is serialized into JSON and stored in Convex under the `projects` table (`canvasState` field).
3. **AI Caching**: The AI implementation relies heavily on caching identical requests (e.g., same image hash + prompt) in Convex (`editPlanCache`, `canvasTargetCache`) to save LLM tokens and ensure consistent results across users.
4. **Theming**: Clerk appearance is deeply customized to match the "Void Dark" theme in `src/app/layout.js`.

When working on this project, ensure you respect the dual-backend architecture and use Convex for real-time app features.
