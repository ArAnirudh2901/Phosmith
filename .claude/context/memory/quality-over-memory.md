---
name: quality-over-memory
description: User chose mask quality over RAM — keep birefnet-general on the masking service despite the 8 GB machine
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ec3b4c95-33d6-478c-b132-68b20762e634
---

On 2026-07-04 I downgraded the masking service to `birefnet-general-lite` to stop memory-pressure kills on the 8 GB Mac; the user reverted this: output quality must match mask-studio's ("no compromise in quality"), which means `SEGMENT_MODEL=birefnet-general` on services/masking/.env even at ~2.7 GB resident.

**Why:** the user benchmarks phosmith's mask output against what they saw in `../mask-studio`, and that came from birefnet-general + (server) Meta SAM 3.1. See [[masking-setup-state]].

**How to apply:** never trade mask/matte quality for RAM without asking. Memory savings must come from elsewhere (lazy loading, caches, the segment service's crop-only saliency model — `silueta` there was accepted). "SAM 3" always means Meta SAM 3.1; no SAM 2 anywhere, including in comments/labels ("/sam2/*" wire paths are legacy names kept for compat).
