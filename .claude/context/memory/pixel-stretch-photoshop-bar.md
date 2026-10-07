---
name: pixel-stretch-photoshop-bar
description: "Pixel Stretch is judged against the Photoshop reference videos in the repo root, not against \"renders without error\""
metadata:
  node_type: memory
  type: feedback
  originSessionId: eebdaeeb-9d07-4851-8205-311aea0469da
  modified: 2026-10-07T15:50:58.734Z
---

The user rejected the Pixel Stretch tool twice as "amateurish" and asked that it replicate Photoshop, using the reference videos (`Video-54.mp4` and the two WhatsApp clips in the repo root), with better computer-vision methods and better usability.

**Why:** the trend look is a specific Photoshop sequence (1px row, Free Transform into stripes off the canvas, Warp, subject masked in front). Anything that deviates — a ribbon ending mid-frame, a band folding through itself, polygon-shaped holes from a loose lasso — reads as fake at a glance.

**How to apply:** before calling stretch work done, render a contact sheet on real photos (`bun scripts/preview-stretch.mjs --specs … --sheet`) and compare it with frames of the reference clips; check the tip leaves the frame, the root sits on the sampled line, the subject sits in front with a clean edge. Time on the real GPU (Metal), never SwiftShader. See [[verify-by-looking]] and [[engineering-bar-next-level]].
