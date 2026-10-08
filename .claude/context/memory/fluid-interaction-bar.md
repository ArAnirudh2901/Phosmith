---
name: fluid-interaction-bar
description: Drag and paint interactions must feel like Apple Photos — measured per frame on a 24 MP photo, no stall after the gesture
metadata:
  type: feedback
---

The user judges editor interactions by feel: "even when i clicking and dragging the ui is lagging a lot… i need a fluid animation like that of apple photos" (2026-10-08, the Erase brush). Lag they notice is usually the work AFTER the gesture (serialisation, full-res readbacks), not the frame itself.

**Why:** the Erase brush showed nothing while dragging and then blocked 1.3 s per stroke on a 24 MP photo; tests were green throughout.

**How to apply:** for any drag/paint/gesture change, drive it on a large photo with a frame recorder + long-task observer (`bun run verify:erase` is the template: real GPU, DPR 1 and 2) and report frame p95/max and long tasks before and after. Show the result live during the gesture; defer and coalesce saves; keep animations on transform/opacity so the compositor carries them. Related: [[verify-by-looking]], [[engineering-bar-next-level]].
