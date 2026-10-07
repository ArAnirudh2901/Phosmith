---
name: one-selection-model
description: User wants one small model doing the work — SlimSAM for all selection; extra models only where SlimSAM cannot do the job
metadata:
  type: feedback
---

On 2026-10-07 the user asked to remove Meta SAM 3.1 completely and to drop BiRefNet, then added: "you are using a lot of models which is unnecessary use only one model or other small secondary model it does a job better". Selection now runs on ONE model, SlimSAM, in the browser (click, box, subject, every-subject); the only extras are small models for jobs SlimSAM cannot do: CLIPSeg (text), Depth Anything V2 Small (depth, service), LaMa (inpaint fill, service).

This supersedes the July preference to keep birefnet-general and SAM 3.1 for quality.

**Why:** multi-GB gated downloads and an 8 GB machine; the user values a lean model set over the last increment of mask quality.

**How to apply:** do not add a model to solve a problem SlimSAM (or one of the three helpers) can solve; propose a new model only when it does a job they cannot, and say what it costs to download. State the quality trade when proposing a removal. See [[masking-setup-state]].
