---
title: Phosmith
emoji: 🎨
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# Phosmith Space

The editor's two small services in one container:

- **LaMa** (`/inpaint`) and the OpenCV **shape fill** (`/shape/fill`) — from
  `services/segment`.
- **Depth Anything V2 Small** (`/depth`) — from `services/masking`.

`/health` and `/warmup` cover both. Selection runs in the browser on SlimSAM.

This Space is assembled from those two services by `bun run space:deploy` in
the Phosmith repo; edit them there, not here.
