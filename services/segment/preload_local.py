import os
import sys

# Ensure local cache dir is used instead of /app
CACHE = os.getenv("MODEL_CACHE_DIR", os.path.expanduser("~/.cache/model_cache"))
os.makedirs(CACHE, exist_ok=True)
os.makedirs(os.path.join(CACHE, "u2net"), exist_ok=True)

os.environ["HF_HOME"] = CACHE
os.environ["U2NET_HOME"] = os.path.join(CACHE, "u2net")

SEGMENT_MODEL = "isnet-general-use"
SAM2_MODEL_ID = "facebook/sam2-hiera-small"
DEPTH_MODEL_ID = "depth-anything/Depth-Anything-V2-Small-hf"
GROUND_MODEL_ID = "CIDAS/clipseg-rd64-refined"

print(f"\n── rembg / {SEGMENT_MODEL}", flush=True)
try:
    from rembg import new_session
    new_session(SEGMENT_MODEL)
    print("  done", flush=True)
except Exception as e:
    print(f"  FAILED: {e}", flush=True)

print(f"\n── SAM 2 / {SAM2_MODEL_ID}", flush=True)
try:
    from transformers import Sam2Model, Sam2Processor
    Sam2Processor.from_pretrained(SAM2_MODEL_ID)
    Sam2Model.from_pretrained(SAM2_MODEL_ID)
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

print(f"\n── CLIPSeg / {GROUND_MODEL_ID}", flush=True)
try:
    from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor
    CLIPSegProcessor.from_pretrained(GROUND_MODEL_ID)
    CLIPSegForImageSegmentation.from_pretrained(GROUND_MODEL_ID)
    print("  done", flush=True)
except Exception as e:
    print(f"  FAILED: {e}", flush=True)

print("\n── LaMa inpainting", flush=True)
try:
    import torch
    _orig = torch.jit.load
    torch.jit.load = lambda f, _map_location=None, **kw: _orig(f, map_location="cpu", **kw)
    try:
        from simple_lama_inpainting import SimpleLama
        SimpleLama()
    finally:
        torch.jit.load = _orig
    print("  done", flush=True)
except Exception as e:
    print(f"  FAILED: {e}", flush=True)

print("\nAll models pre-downloaded locally.", flush=True)
