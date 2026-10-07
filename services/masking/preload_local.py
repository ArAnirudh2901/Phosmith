"""Dev pre-download: fetch the depth model into the local cache so the first
/depth request after `bun run masking:dev` isn't a download."""

import os

CACHE = os.getenv("MODEL_CACHE_DIR", os.path.expanduser("~/.cache/model_cache"))
os.makedirs(CACHE, exist_ok=True)
os.environ["HF_HOME"] = CACHE

DEPTH_MODEL_ID = "depth-anything/Depth-Anything-V2-Small-hf"

print(f"\n── Depth Anything V2 / {DEPTH_MODEL_ID}", flush=True)
try:
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation
    AutoImageProcessor.from_pretrained(DEPTH_MODEL_ID)
    AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL_ID)
    print("  done", flush=True)
except Exception as e:
    print(f"  FAILED: {e}", flush=True)

print("\nDepth model pre-downloaded locally.", flush=True)
