---
name: comment-style-brief
description: "Write short, sweet code comments going forward; never retroactively shorten existing comments"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 83cdfe87-a9f1-4067-82fe-377edb349f2b
---

When writing NEW code comments, keep them brief ("short and sweet"). Do NOT go back and shorten comments that already exist in the codebase — the user rejected an edit that trimmed an existing comment block.

**Why:** Token/verbosity control on new work, but existing prose (often bug-history documentation this codebase values, e.g. megashader "Bug history" notes) must be preserved.

**How to apply:** New comments: 1-3 lines max unless documenting a non-obvious invariant. Existing comments: leave untouched unless factually wrong.
