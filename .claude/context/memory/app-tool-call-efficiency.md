---
name: app-tool-call-efficiency
description: "Phosmith's in-app AI agent must make tool/command calls efficiently — no redundant model or command round-trips per user request."
metadata: 
  node_type: memory
  type: project
  originSessionId: eebdaeeb-9d07-4851-8205-311aea0469da
  modified: 2026-09-24T13:06:05.918Z
---

Stated 2026-09-24 alongside the collage requirements: the application itself has to be efficient in how it calls tools, not only correct. That covers the agent chat's command sequences (`command-registry.runPlan`, `crop.*` / `mask.*` commands), repeated AI route hits (`/api/ai/*`), duplicate vision passes on the same image, and re-running analysis that is already cached per image element.

**Why:** Every redundant call costs the user latency and API quota, and the agent feeling slow reads as the product being broken even when the output is right.

**How to apply:** Prefer one batched/planned pass over several sequential calls; cache per-image analysis and reuse it; check an existing cache or journal entry before re-requesting; parallelize independent calls. When auditing a feature, count the network/model calls one user action produces and justify each.

Related: [[collage-generator-bar]], [[engineering-bar-next-level]]
