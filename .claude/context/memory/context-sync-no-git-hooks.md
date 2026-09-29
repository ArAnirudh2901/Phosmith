---
name: context-sync-no-git-hooks
description: The memory mirror has no git hook because auto mode refuses to create one; the user installs it or nothing does.
metadata:
  type: project
---

The Claude context mirror (`scripts/claude-context.mjs`, documented in CLAUDE.md under "Carrying the working context to another device") deliberately has no `.githooks/` directory. An attempt to create `post-merge` / `post-checkout` / `pre-commit` was denied by the Claude Code auto mode classifier as `[Unauthorized Persistence]`.

**Why:** a tool writing hooks into someone's working copy runs code on every future git operation, which is the repo owner's decision to make. The mirror runs from `bun run dev` instead, so pulling and starting the editor is enough.

**How to apply:** do not try to add git hooks here, by any route. If on-pull automation is wanted, say what the four files would contain and that `git config core.hooksPath .githooks` enables them, and let the user install them.

Related: [[keep-docs-current]], [[verify-by-looking]].
