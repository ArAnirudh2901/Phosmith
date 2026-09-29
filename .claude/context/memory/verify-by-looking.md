---
name: verify-by-looking
description: "Green tests are not evidence a feature works — render the output, drive the real UI, and look at it before claiming anything."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: eebdaeeb-9d07-4851-8205-311aea0469da
  modified: 2026-09-27T06:31:25.632Z
---

Every serious defect found in phosmith so far was found by LOOKING at rendered output or driving the real product, never by a passing test suite. Examples from one session: horizontal pixel-stretch drew nothing; curved ribbons were translucent and cross-hatched; a warp-handle drag hung the tab; the tool dragged the user's photo off the canvas; the dashboard shipped 19.8 MB per load. All of these had green unit tests alongside them.

**Why:** unit tests pin the maths that was already understood. They cannot see a blank frame, a seam, a 14 s query or a control nobody can grab.

**How to apply:**
- Build a way to SEE the output — a contact-sheet harness, a screenshot, a CDP profile — and read it before reporting.
- Probe with an instrument that makes the defect obvious (e.g. render a ribbon over pure magenta to prove opacity, rather than squinting at a photo).
- Drive the real app with real input for anything interactive; measure with real numbers for anything about speed or memory.
- Distrust a harness that disagrees with the product: two "product bugs" in this project were bugs in the test harness itself.
- When the user reports something, reproduce it before theorising — and when it cannot be reproduced, say so plainly rather than inventing a cause.

Related: [[engineering-bar-next-level]]
