This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

This repo uses [Bun](https://bun.sh) as the only package manager. Do not use npm, yarn, or pnpm here.

## Getting Started

Install dependencies:

```bash
bun install
```

Run the development server:

```bash
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

### Neon/Postgres (backend)

Configure `DATABASE_URL` and `DIRECT_URL`, then create the schema:

```bash
bun run prisma:generate
bun run db:push
```

### Local mask service (AI selection tools)

The editor's **Select Subject** (BiRefNet), **SAM 2 click-to-select**, and **Depth Anything V2** tools depend on a local Python service. Add `MASK_SERVICE_URL` to `.env.local`:

```env
MASK_SERVICE_URL=http://127.0.0.1:8001
```

Then start the service in a second terminal:

```bash
bun run mask:install    # one-time: install rembg + transformers + torch
bun run mask:dev        # run the FastAPI service on :8001
```

Without it, SAM 2 and Depth return 501 and the corresponding tools in the editor are non-functional. The Select Subject tool still works (falls back to HuggingFace). See `services/segment/.env.example` for the service's own env template and model choices.

## Scripts

| Command | Description |
|---------|-------------|
| `bun dev` | Start Next.js dev server |
| `bun run build` | Production build |
| `bun start` | Start production server |
| `bun run lint` | Run ESLint |
| `bun run imagekit:docs` | Crawl ImageKit docs into a local JSON knowledge base |
| `bun run prisma:generate` | Generate Prisma Client |
| `bun run prisma:migrate` | Apply Postgres schema changes with Prisma |
| `bun run db:push` | Push the Prisma schema to Neon/Postgres |
| `bun run mask:install` | Install Python deps for the local mask service |
| `bun run mask:dev` | Start the FastAPI mask service on :8001 |
| `bun run verify` | Run all 230 megashader GLSL invariants |
| `bun run verify:segment` | End-to-end test for `/api/ai/segment` |
| `bun run verify:semantic` | End-to-end test for `/api/ai/sam2` |
| `bun run verify:depth` | End-to-end test for `/api/ai/depth` |

## ImageKit Agent

The editor includes a free local ImageKit Agent tool. It retrieves ImageKit documentation, analyzes the active canvas image, generates a professional ImageKit transformation chain, and applies local Fabric color-grade filters for edits like "make it better", cinematic grading, portrait retouching, product polish, background cleanup, sharpening, and upscaling.

Optional free local vision LLM:

```bash
ollama pull llava
```

Environment variables:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_VISION_MODEL=llava:latest
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pixxel_gpt?schema=public
```

If Ollama is not running, the agent falls back to the local visual-metrics planner. Saved projects and user data require `DATABASE_URL`.

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Bun Documentation](https://bun.sh/docs)
- [Prisma Documentation](https://www.prisma.io/docs)
- [Neon Documentation](https://neon.com/docs)

## Deploy on Vercel

Set the install command to `bun install` and the build command to `bun run build` in your Vercel project settings.
