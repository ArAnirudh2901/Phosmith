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
