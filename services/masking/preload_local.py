"""Dev pre-download: fetch the masking models into the local cache so the first
request after `bun run masking:dev` isn't a multi-hundred-MB download. SAM 3.1
is gated and best-effort (run `huggingface-cli login` and accept the terms)."""

import os

CACHE = os.getenv("MODEL_CACHE_DIR", os.path.expanduser("~/.cache/model_cache"))
os.makedirs(CACHE, exist_ok=True)
os.makedirs(os.path.join(CACHE, "u2net"), exist_ok=True)
os.environ["HF_HOME"] = CACHE
os.environ["U2NET_HOME"] = os.path.join(CACHE, "u2net")

SEGMENT_MODEL = "isnet-general-use"
DEPTH_MODEL_ID = "depth-anything/Depth-Anything-V2-Small-hf"

print(f"\n── rembg / {SEGMENT_MODEL}", flush=True)
try:
    from rembg import new_session
    new_session(SEGMENT_MODEL)
    print("  done", flush=True)
except Exception as e:
    print(f"  FAILED: {e}", flush=True)

print(f"\n── Depth Anything V2 / {DEPTH_MODEL_ID}", flush=True)
try:
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation
    AutoImageProcessor.from_pretrained(DEPTH_MODEL_ID)
    AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL_ID)
    print("  done", flush=True)
except Exception as e:
    print(f"  FAILED: {e}", flush=True)

print("\n── SAM 3.1 (gated, best-effort)", flush=True)
try:
    from sam3.model_builder import download_ckpt_from_hf
    download_ckpt_from_hf(version="sam3.1")
    print("  done", flush=True)
except ImportError:
    print("  skipped (sam3 package not installed)", flush=True)
except Exception as e:
    print(f"  skipped ({e})", flush=True)

print("\nMasking models pre-downloaded locally.", flush=True)
