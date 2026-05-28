# Neon Setup

This app stores application data in Neon/Postgres through Prisma.

## Environment

Set `DATABASE_URL` to the pooled Neon connection string used by the app.
Set `DIRECT_URL` to the direct Neon connection string used by Prisma schema
operations.

For temporary cache durability across server instances, set one of:

- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
- `REDIS_URL`

Without Redis variables, the app uses the local in-memory cache. That is fine
for development, but it is not durable and does not coordinate between multiple
server instances.

## Schema

```bash
bun run prisma:generate
bun run db:push
```

Use Prisma migrations instead of `db:push` for a production-controlled rollout:

```bash
bun run prisma:migrate
```
