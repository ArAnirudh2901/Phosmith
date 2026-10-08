---
name: gemini-free-tier-quota
description: The project's Gemini key is free tier — 20 requests/day on gemini-2.5-flash, shared by every Gemini feature; tests can exhaust it
metadata:
  type: reference
---

The `GEMINI_API_KEY` in `.env.local` is on the free tier: 20 `generate_content` requests per day for `gemini-2.5-flash` (error: `Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20`). On 2026-10-08 about twenty Auto Stretch test runs used the whole day, which also starves the edit planner, judge, crop read and collage planner for everyone using the app until it resets.

**How to apply:** when testing a Gemini-backed feature, make at most a handful of live calls, reuse their replies as fixed `hint` specs in the harness, and say how many calls were spent. The user wants Auto Stretch decided by Gemini ([[pixel-stretch-photoshop-bar]]), so a quota fallback must be visible (the route returns `reason: 'quota'`).
