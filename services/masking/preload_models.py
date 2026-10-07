"""Pre-download the depth model into /app/model_cache at Docker build time.

Baked into an image layer so weights are present on container start (no runtime
download). The model ID comes from an ARG-injected env var."""

from __future__ import annotations

import os
import sys

CACHE = "/app/model_cache"
os.makedirs(CACHE, exist_ok=True)
os.environ["HF_HOME"] = CACHE

DEPTH_MODEL_ID = os.getenv("DEPTH_MODEL_ID", "depth-anything/Depth-Anything-V2-Small-hf")

print(f"\n── Depth Anything V2 / {DEPTH_MODEL_ID}", flush=True)
try:
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation  # type: ignore
    AutoImageProcessor.from_pretrained(DEPTH_MODEL_ID)
    AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL_ID)
except Exception as e:
    print(f"  FAILED: {e}", flush=True)
    sys.exit(1)
print("Depth model pre-downloaded.", flush=True)
