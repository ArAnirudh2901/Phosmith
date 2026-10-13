---
title: Phosmith
emoji: 🎨
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Object removal, depth and SlimSAM selection
models:
  - nielsr/slimsam-77-uniform
  - depth-anything/Depth-Anything-V2-Small-hf
---

# Phosmith Space

The editor's server-side models in one CPU container:

- **SlimSAM** (`/sam/embed`, `/sam/decode`) — click, box, Select Subject and
  Detect All Subjects for devices that cannot run SlimSAM in the browser (the
  editor's *Selection engine: Server*). The same distilled SAM the browser runs
  (`Xenova/slimsam-77-uniform` is the ONNX export of these weights), so the
  masks match whichever side answers. An image is encoded once and named by a
  key; each prompt after that is a small JSON call. Only the encoding is kept,
  in memory.
- **LaMa** (`/inpaint`) and the OpenCV **shape fill** (`/shape/fill`) — from
  `services/segment`.
- **Depth Anything V2 Small** (`/depth`) — from `services/masking`, with SlimSAM.

`/health` and `/warmup` cover all of them.

This Space is assembled from those two services by `bun run space:deploy` in
the Phosmith repo; edit them there, not here.
