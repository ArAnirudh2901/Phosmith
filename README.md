<p align="center">
  <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="7" fill="#0B0D12"/>
    <path d="M16 3 C 16.7 9.6, 22.4 15.3, 29 16 C 22.4 16.7, 16.7 22.4, 16 29 C 15.3 22.4, 9.6 16.7, 3 16 C 9.6 15.3, 15.3 9.6, 16 3 Z" fill="#06B8D4"/>
  </svg>
</p>

<h1 align="center">Phosmith — AI Image Studio</h1>

<p align="center">
  <strong>A professional-grade, AI-powered image editor built for the browser.</strong><br />
  Combines Photoshop-class editing tools with cutting-edge AI models — all running locally in WebGL2 and on-device Python services.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=nextdotjs" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/Bun-1.3-F9F1E1?style=flat-square&logo=bun&logoColor=black" alt="Bun 1.3" />
  <img src="https://img.shields.io/badge/WebGL2-GLSL%20ES%203.0-06B8D4?style=flat-square" alt="WebGL2" />
  <img src="https://img.shields.io/badge/Fabric.js-7-green?style=flat-square" alt="Fabric.js 7" />
  <img src="https://img.shields.io/badge/FastAPI-PyTorch-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License" />
</p>

---

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Phosmith Landing Page — Edit Pixels with Intent" width="100%" />
</p>

---

## Table of Contents

- [Overview](#overview)
- [Screenshots](#-screenshots)
- [Key Features](#-key-features)
- [Architecture](#-architecture)
- [Editor Tools](#-editor-tools)
- [AI Capabilities](#-ai-capabilities)
- [The Megashader Engine](#-the-megashader-engine)
- [Dashboard & Project Management](#-dashboard--project-management)
- [Tech Stack](#-tech-stack)
- [Getting Started](#-getting-started)
- [Environment Variables](#-environment-variables)
- [Local AI Services](#-local-ai-services)
- [ImageKit Agent (Agentic Editing)](#-imagekit-agent-agentic-editing)
- [Scripts Reference](#-scripts-reference)
- [Deployment](#-deployment)
- [Learn More](#-learn-more)

---

## Overview

Phosmith is a state-of-the-art web-based image editor that seamlessly blends professional-grade adjustment tools with advanced AI capabilities. It features a custom WebGL2 compositing engine (the **Megashader**), non-destructive mask layers, an AI agentic editing assistant, and support for local large language models (LLMs) and computer vision models.

The editor runs entirely in the browser — image processing is handled by the GPU via WebGL2 shaders, and AI inference is offloaded to a local Python FastAPI service. No cloud GPU required.

This project uses **[Bun](https://bun.sh)** as the sole package manager and runtime. Do not use npm, yarn, or pnpm.

---

## 📸 Screenshots

### Landing Page

The marketing site showcases the neobrutalist design system with a bold hero, scrolling feature ticker, and stats bar.

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Hero Section — Edit Pixels with Intent" width="100%" />
</p>

### Features & Pricing

The toolkit section highlights nine core tools (AI Agent, AI Extend, Upscale, etc.) while the pricing section offers a clear Free vs Pro comparison.

<table>
  <tr>
    <td><img src="docs/screenshots/features.png" alt="Features — Nine Tools, One Canvas, Zero Round-Trips" width="100%" /></td>
    <td><img src="docs/screenshots/pricing.png" alt="Pricing — Two Tiers, No Fluff" width="100%" /></td>
  </tr>
  <tr>
    <td align="center"><em>Features — The Toolkit</em></td>
    <td align="center"><em>Pricing — Free & Pro Tiers</em></td>
  </tr>
</table>

### Dashboard

The project dashboard provides a grid view of all saved projects with live canvas thumbnails, creation timestamps, and bulk selection.

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Dashboard — Project Grid with New Project and Select buttons" width="100%" />
</p>

### Editor

The full-featured editor with a 13-tool topbar, a left-hand property panel (shown: Resize tool), the WebGL2 canvas with selection handles, and a zoom slider at the bottom.

<p align="center">
  <img src="docs/screenshots/editor.png" alt="Editor — Resize tool with canvas, topbar, and property panel" width="100%" />
</p>

---

## ✨ Key Features

| Category | Highlights |
|---|---|
| **Non-Destructive Editing** | 100+ procedural mask layers composited in real-time on the GPU |
| **AI Selection & Masking** | Subject detection (BiRefNet), point-based segmentation (SAM 2), depth estimation (Depth Anything V2) |
| **Professional Adjustments** | 15+ parameters — Exposure, Curves, Temperature, Vibrance, Film Grain, and more |
| **Agentic AI Editor** | Local LLM-powered agent that analyzes images and autonomously applies professional edits |
| **AI Background** | Generate, replace, or remove backgrounds using AI inpainting/outpainting |
| **AI Extender** | Expand canvas boundaries with AI-generated content (outpainting) |
| **Collage Builder** | Multi-image layouts with automatic cell fitting |
| **Rich Text Engine** | Google Fonts integration, text effects, shadows, outlines, curved text |
| **Drawing Tools** | Pressure-sensitive brushes, pens, and shape tools |
| **Export** | PNG / JPEG / WebP at 1×, 2×, or 3× resolution, plus clipboard copy |

---

## 🏛 Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Next.js 16 (App Router)             │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ Dashboard │  │  Editor  │  │   API Routes       │  │
│  │  (React)  │  │ (Fabric  │  │  /api/ai/*         │  │
│  │           │  │  + WebGL) │  │  /api/canvas/*     │  │
│  └──────────┘  └────┬─────┘  │  /api/imagekit/*    │  │
│                     │        │  /api/neon/*         │  │
│                     ▼        │  /api/billing/*      │  │
│            ┌────────────┐    └────────────────────┘  │
│            │ Megashader  │                            │
│            │  (WebGL2    │    ┌────────────────────┐  │
│            │   GLSL)     │    │  Local Mask Service │  │
│            └────────────┘    │  (FastAPI + PyTorch) │  │
│                              │  BiRefNet, SAM2,     │  │
│                              │  Depth Anything V2   │  │
│                              └────────────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │  Clerk   │  │  Neon    │  │  ImageKit CDN      │  │
│  │  (Auth)  │  │ (Postgres│  │  (Image Storage    │  │
│  │          │  │  + Prisma│  │   + Transforms)    │  │
│  └──────────┘  └──────────┘  └────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

---

## 🛠 Editor Tools

The editor topbar exposes **13 tools**, each with its own property panel:

<p align="center">
  <img src="docs/screenshots/editor.png" alt="Editor Interface — 13 tools in the topbar" width="100%" />
</p>

### Core Editing

| Tool | Description |
|---|---|
| **Resize** | Change canvas and image dimensions. Includes Original, 50%, Fit, and Fill presets. Maintains aspect ratio with linked width/height fields. |
| **Crop** | Freeform and preset ratio cropping (1:1, 4:3, 16:9, 3:2, etc.) with a live preview overlay. Includes flip horizontal/vertical. |
| **Images** | Multi-layer image management. Upload, reorder, rename, merge, show/hide, and duplicate layers. Drag-and-drop support. |
| **Adjust** | Professional-grade color and tone adjustments — see [Adjustments](#adjustments) below. |
| **Draw** | Freehand drawing with configurable brush size, color, and opacity. Supports pen/marker styles. |
| **Erase** | Smart eraser with adjustable brush size. Removes pixels from the active layer with undo support. |
| **Mask** | Comprehensive selection and masking system — see [Masking Tools](#masking-tools) below. |
| **Text** | Rich text engine with 50+ Google Fonts, text shadows, outlines, letter spacing, and alignment controls. |

### AI Tools (Pro)

| Tool | Description |
|---|---|
| **AI Background** | Generate new backgrounds from text prompts, remove backgrounds entirely, or replace them with AI-generated scenes. Powered by ImageKit's AI transform pipeline. |
| **AI Extender** | Expand canvas boundaries (outpaint) in any direction. Define the expansion region, and AI fills the new area with contextually coherent content. |
| **AI Edit** | Describe edits in natural language ("make the sky more dramatic", "add warm lighting"). The AI plan engine generates an edit sequence that's applied via ImageKit transforms. |
| **Agent** | A fully autonomous agentic editing assistant — see [ImageKit Agent](#-imagekit-agent-agentic-editing). |
| **Collage** | Multi-image collage layouts. Pick a grid template, assign images to cells, and the engine auto-fits each image with smart cropping. |

---

### Adjustments

The **Adjust** tool provides 15+ parameters, all computed in real-time via WebGL2 shaders:

| Parameter | Range | Description |
|---|---|---|
| Brightness | −100 → +100 | Overall light level |
| Contrast | −100 → +100 | Tonal range expansion/compression |
| Saturation | −100 → +100 | Color intensity |
| Vibrance | −100 → +100 | Selective saturation (protects skin tones) |
| Exposure | −2.0 → +2.0 | Simulated f-stop exposure shift |
| Temperature | −100 → +100 | Warm ↔ Cool white balance |
| Tint | −100 → +100 | Green ↔ Magenta shift |
| Hue | −180° → +180° | Global hue rotation |
| Highlights | −100 → +100 | Recover or boost highlight detail |
| Shadows | −100 → +100 | Recover or crush shadow detail |
| Sharpness | 0 → +100 | Unsharp mask sharpening |
| Blur | 0 → +100 | Gaussian blur |
| Noise | 0 → +100 | Add luminance noise |
| Film Grain | 0 → +100 | Cinematic grain simulation |
| Curves | Per-channel | RGB and per-channel curves with control points |

---

### Masking Tools

The mask system is organized into four categories:

#### AI Tools
- **Select Subject** — One-click subject isolation using **BiRefNet** (Bilateral Reference Network). Falls back to HuggingFace APIs if the local mask service is unavailable.
- **Click to Select** — Point-based semantic segmentation powered by **SAM 2** (Segment Anything Model 2). Click anywhere on the image and SAM 2 predicts the object boundary.
- **Depth Range** — Select objects based on 3D depth estimation using **Depth Anything V2**. Generate a per-pixel depth map, then select a depth range to isolate foreground/background.

#### Draw Selection
- **Selection Brush** — Paint a selection mask with adjustable size and feather. Includes an *Edge Snapping* mode (bilateral filter) that snaps brush strokes to detected edges.
- **Lasso Select** — Three modes: freehand lasso, polygonal lasso, and *Magnetic Lasso* that automatically snaps to edges using gradient-based edge detection.

#### Range Selection
- **Color Range** — Eyedropper-based selection. Pick a color, adjust tolerance, and select all pixels within that range.
- **Luminance Range** — Select pixels based on brightness thresholds (min/max brightness sliders).
- **Linear Gradient** — Create a gradient mask with configurable angle, spread, and falloff.
- **Radial Gradient** — Create a radial gradient mask from a center point with adjustable radius and falloff.

#### Destructive
- **Quick Erase** — One-click background removal that permanently modifies the image layer.

All non-destructive selections are composited as **mask layers** in the Megashader engine, meaning they can be reordered, toggled, inverted, adjusted, and removed at any time without affecting the original image.

---

## 🤖 AI Capabilities

### Computer Vision Models

| Model | Task | Provider |
|---|---|---|
| **BiRefNet** | Subject segmentation (background removal) | Local FastAPI / HuggingFace fallback |
| **SAM 2** | Point-based semantic segmentation | Local FastAPI |
| **Depth Anything V2** | Monocular depth estimation | Local FastAPI |
| **LLaVA** | Vision-language model for image analysis | Local Ollama |

### AI Transform Pipeline

The editor integrates with **ImageKit** for server-side AI transforms:

- **Background generation** — Text-to-image backgrounds via `/api/ai/background`
- **Inpainting** — Fill masked regions with AI-generated content via `/api/ai/inpaint`
- **Outpainting** — Expand canvas boundaries with contextual fill via `/api/ai/outpaint` and `/api/ai/extend`
- **AI Edit planning** — Natural language → edit parameter mapping via `/api/ai/edit-plan`

### Image Analysis

The editor performs local image analysis to guide AI tools:

- **Color extraction** — Dominant color palette extraction using the `fast-average-color` library
- **Histogram analysis** — Per-channel RGB and luminance histograms
- **Image fingerprinting** — Perceptual hashing for duplicate detection
- **Feature extraction** — Edge density, contrast, saturation, and scene analysis for the AI agent

---

## ⚡ The Megashader Engine

At the core of the editing experience is a custom **WebGL2** compositing engine:

- **Non-destructive workflows** — Supports 100+ procedural mask layers with zero lag. Each mask layer is a GLSL program that runs entirely on the GPU.
- **Real-time preview** — All adjustments, masks, and blends are computed per-frame, so the preview always matches the output.
- **Blend modes** — Photoshop-parity blend modes: Normal, Screen, Multiply, Overlay, Soft Light, Hard Light, Darken, Lighten, Color Dodge, Color Burn, Difference, Exclusion, Add, Subtract, Divide.
- **Mask chain composition** — Multiple mask layers compose via union, intersection, subtraction, and XOR operations.
- **230 GLSL invariant tests** — The shader pipeline is validated by `bun run verify` which runs 230 headless tests against known-good reference outputs.

### How It Works

```
Image Layer → [Adjustment Shaders] → [Mask Chain (GLSL)] → [Blend Modes] → Final Composite
                                           ↑
                                    Mask Layers (N):
                                    ├─ Brush strokes
                                    ├─ AI segmentation
                                    ├─ Lasso / Color Range
                                    ├─ Gradient masks
                                    └─ Depth maps
```

Each mask layer stores its parameters (not pixels), so they remain fully editable. The Megashader recompiles and re-renders the entire chain on every parameter change at 60 fps.

---

## 📋 Dashboard & Project Management

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Dashboard — project grid with thumbnails" width="100%" />
</p>

The dashboard provides a grid view of all projects with:

- **Project cards** with live canvas thumbnails (pixel-art disintegration animation on delete)
- **Create new projects** from uploaded images or blank canvases
- **Search, sort, and filter** projects
- **Auto-save** — Projects are automatically saved to Neon/Postgres with debounced writes and a Redis-backed snapshot cache for fast loads
- **Canvas state persistence** — Full Fabric.js canvas state (objects, filters, mask layers, viewport position) is serialized and restored on reload
- **Image storage** via ImageKit CDN with on-the-fly transformations

---

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| **Framework** | Next.js 16 (App Router, React 19, React Compiler) |
| **Runtime** | Bun 1.3 |
| **Canvas** | Fabric.js 7 + custom WebGL2 shaders |
| **GPU Compute** | WebGL2 GLSL ES 3.0 (Megashader engine) |
| **UI** | Tailwind CSS 4, Framer Motion, Radix UI, Lucide Icons |
| **Auth** | Clerk (email, OAuth, org support) |
| **Database** | Neon (serverless Postgres) + Prisma ORM |
| **Caching** | Redis (Upstash) for canvas snapshot caching |
| **Image CDN** | ImageKit (storage, transforms, AI pipeline) |
| **AI Models** | BiRefNet, SAM 2, Depth Anything V2, LLaVA (via Ollama) |
| **AI Service** | Python FastAPI + PyTorch (local inference) |
| **Billing** | Clerk Billing (Pro tier for AI tools) |

---

## 🚀 Getting Started

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- [Node.js](https://nodejs.org/) ≥ 18 (required by some Next.js internals)
- [Python](https://www.python.org/) ≥ 3.10 (for the local AI mask service)
- [Ollama](https://ollama.com/) (optional, for the ImageKit Agent's vision LLM)

### Installation

```bash
# Clone the repo
git clone https://github.com/your-username/phosmith.git
cd phosmith

# Install dependencies
bun install

# Set up environment variables
cp .env.example .env.local
# → Edit .env.local with your keys (see Environment Variables below)

# Generate Prisma client
bun run prisma:generate

# Push database schema
bun run db:push

# Start development server
bun dev
```

Open [http://localhost:3000](http://localhost:3000) to launch the editor.

---

## 🔑 Environment Variables

Create a `.env.local` file in the project root:

```env
# ── Authentication (Clerk) ──
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up

# ── Database (Neon/Postgres) ──
DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...

# ── Image Storage (ImageKit) ──
NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY=public_...
IMAGEKIT_PRIVATE_KEY=private_...
NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT=https://ik.imagekit.io/your-id

# ── Caching (Redis / Upstash — optional) ──
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...

# ── Local AI Mask Service (optional) ──
MASK_SERVICE_URL=http://127.0.0.1:8001

# ── Local LLM (Ollama — optional) ──
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_VISION_MODEL=llava:latest
```

> **Note:** The editor works without the optional services — AI mask tools will fall back to HuggingFace APIs, and the agent will use a local visual-metrics planner instead of the LLM.

---

## 🧠 Local AI Services

### Mask Service (BiRefNet, SAM 2, Depth Anything V2)

The editor's heavy AI tools run via a local **Python FastAPI** service to avoid blocking the Node.js thread.

```bash
# One-time: install Python dependencies (PyTorch, rembg, transformers)
bun run mask:install

# Start the FastAPI service on port 8001
bun run mask:dev
```

Add the service URL to `.env.local`:
```env
MASK_SERVICE_URL=http://127.0.0.1:8001
```

> **Without this service:** SAM 2 and Depth tools will return 501. Select Subject will fall back to HuggingFace APIs (slower, requires internet). See `services/segment/.env.example` for the service's own configuration.

### Verification

Run end-to-end tests for each AI endpoint:

```bash
bun run verify:segment   # BiRefNet subject segmentation
bun run verify:semantic   # SAM 2 point-based segmentation
bun run verify:depth      # Depth Anything V2 depth estimation
bun run verify:depth:full # Comprehensive depth tests
bun run verify:mask       # Mask edge-snap bilateral filter
```

---

## 🤖 ImageKit Agent (Agentic Editing)

The **ImageKit Agent** is a fully autonomous editing assistant that can analyze images and apply professional transformations without manual intervention.

### How It Works

1. **Image Analysis** — The agent captures the current canvas state and sends it to a local vision LLM (LLaVA via Ollama) for scene understanding.
2. **Edit Planning** — Based on the analysis, the agent retrieves ImageKit transformation documentation and generates an optimized edit plan.
3. **Autonomous Execution** — The agent applies the planned transformations (color grading, retouching, upscaling, etc.) and streams progress to the UI in real-time.

### Setup

1. Install and start [Ollama](https://ollama.com/):
   ```bash
   ollama pull llava
   ollama serve
   ```

2. Add to `.env.local`:
   ```env
   OLLAMA_BASE_URL=http://127.0.0.1:11434
   OLLAMA_VISION_MODEL=llava:latest
   ```

> **Without Ollama:** The agent falls back to a local visual-metrics planner that uses histogram analysis, color extraction, and edge detection to generate edit plans — no LLM required.

### Agent Capabilities

| Action | Description |
|---|---|
| Cinematic grading | Apply Hollywood-style color grades |
| Portrait retouching | Skin smoothing, eye enhancement, lighting correction |
| Background cleanup | Remove distractions, blur backgrounds |
| Upscaling | AI-powered resolution enhancement |
| Style transfer | Apply artistic styles (film, vintage, noir, etc.) |
| Auto-enhance | One-click overall improvement |

The agent has a persistent chat interface with conversation history stored per-project.

---

## 📜 Scripts Reference

| Command | Description |
|---|---|
| `bun dev` | Start Next.js dev server with HMR |
| `bun run build` | Production build |
| `bun start` | Start production server |
| `bun run lint` | Run ESLint |
| `bun run prisma:generate` | Generate Prisma Client |
| `bun run prisma:migrate` | Apply database schema migrations |
| `bun run db:push` | Push Prisma schema to Neon/Postgres |
| `bun run imagekit:docs` | Crawl ImageKit docs into a local JSON knowledge base |
| `bun run mask:install` | Install Python deps for the local mask service |
| `bun run mask:dev` | Start the FastAPI mask service on port 8001 |
| `bun run verify` | Run all 230 Megashader GLSL invariant tests |
| `bun run verify:mask` | Test mask edge-snap bilateral filter |
| `bun run verify:segment` | End-to-end test for BiRefNet segmentation |
| `bun run verify:semantic` | End-to-end test for SAM 2 segmentation |
| `bun run verify:depth` | End-to-end test for Depth Anything V2 |
| `bun run verify:depth:full` | Comprehensive depth estimation tests |

---

## ☁️ Deployment

### Vercel (Recommended)

1. Connect your repo to [Vercel](https://vercel.com)
2. Set the **Install Command** to `bun install`
3. Set the **Build Command** to `bun run build`
4. Add all environment variables from `.env.local` to the Vercel dashboard
5. Deploy

> **Note:** The local AI mask service and Ollama must be hosted separately (e.g., on a GPU instance) for production use. Update `MASK_SERVICE_URL` and `OLLAMA_BASE_URL` accordingly.

---

## 📚 Learn More

- [Next.js Documentation](https://nextjs.org/docs) — Framework reference
- [Bun Documentation](https://bun.sh/docs) — Runtime and package manager
- [Fabric.js Documentation](http://fabricjs.com/docs/) — Canvas library
- [Prisma Documentation](https://www.prisma.io/docs) — Database ORM
- [Clerk Documentation](https://clerk.com/docs) — Authentication
- [ImageKit Documentation](https://docs.imagekit.io/) — Image CDN and AI transforms
- [Ollama Documentation](https://github.com/ollama/ollama) — Local LLM runner

---

<p align="center">
  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0B0D12"/><path d="M16 3 C 16.7 9.6, 22.4 15.3, 29 16 C 22.4 16.7, 16.7 22.4, 16 29 C 15.3 22.4, 9.6 16.7, 3 16 C 9.6 15.3, 15.3 9.6, 16 3 Z" fill="#06B8D4"/></svg><br />
  Built with ❤️ using Next.js, Fabric.js, WebGL2, and a lot of GLSL.
</p>

