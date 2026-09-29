---
name: keep-docs-current
description: "Update CLAUDE.md and memory as part of doing the work, in the same commit — never as a separate later pass."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: eebdaeeb-9d07-4851-8205-311aea0469da
  modified: 2026-09-27T08:54:44.058Z
---

Documentation upkeep is part of the task, not a follow-up. Every change that alters how the project behaves updates `CLAUDE.md` in the SAME commit, and anything the user tells me about how to work gets written to memory when they say it.

**Why:** the user asked for this explicitly (2026-09-27) after a long session. CLAUDE.md is the context a future session loads instead of re-deriving the codebase, so drift there costs real time and causes wrong decisions. Memory is the only thing that survives a new session at all.

**How to apply:**
- Update `CLAUDE.md` in the same commit as the code. Record the *reasoning* and the measured numbers, not just what exists — "the clamp is 200 because MIN_BAND is 2%" is worth more than "the clamp is 200".
- When a number is measured (bundle size, ms, MB), put the number in. Replace stale ones rather than adding new ones beside them.
- New module, new verify script, new API route, new agent command → it goes in the relevant section and the verify list.
- **Audit periodically, do not assume.** Counts and tables drift silently: check the documented route table against `ls`, and the documented verify list against `package.json`. This has already caught a table claiming 17 AI routes when there were 20.
- Write a memory the moment the user states a preference or a standing expectation; check for an existing file on that topic and update it rather than creating a near-duplicate.
- A fact the repo already records (code structure, git history) does not belong in memory — only what is not derivable from the code.

Related: [[engineering-bar-next-level]], [[verify-by-looking]], [[comment-style-brief]]
