"""Pre-download masking model weights into /app/model_cache at Docker build time.

Baked into an image layer so weights are present on container start (no runtime
download). Model IDs come from ARG-injected env vars. SAM 3.1 is gated: it only
downloads when a HF token with accepted facebook/sam3.1 terms is present, and is
best-effort (a failure here just defers the download to first use)."""

from __future__ import annotations

import os
import sys

CACHE = "/app/model_cache"
os.makedirs(CACHE, exist_ok=True)
os.makedirs(os.path.join(CACHE, "u2net"), exist_ok=True)
os.environ["HF_HOME"] = CACHE
os.environ["U2NET_HOME"] = os.path.join(CACHE, "u2net")

SEGMENT_MODEL = os.getenv("SEGMENT_MODEL", "isnet-general-use")
DEPTH_MODEL_ID = os.getenv("DEPTH_MODEL_ID", "depth-anything/Depth-Anything-V2-Small-hf")
SAM3_MODEL_ID = os.getenv("SAM3_MODEL_ID", "facebook/sam3.1")

errors: list[str] = []


def _step(label: str) -> None:
    print(f"\n── {label}", flush=True)


# ── rembg ONNX checkpoint ─────────────────────────────────────────────────
_step(f"rembg / {SEGMENT_MODEL}")
try:
    from rembg import new_session  # type: ignore
    new_session(SEGMENT_MODEL)
    print("  done", flush=True)
except Exception as e:
    print(f"  FAILED: {e}", flush=True)
    errors.append(f"rembg/{SEGMENT_MODEL}: {e}")


# ── Depth Anything V2 ─────────────────────────────────────────────────────
_step(f"Depth Anything V2 / {DEPTH_MODEL_ID}")
try:
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation  # type: ignore
    AutoImageProcessor.from_pretrained(DEPTH_MODEL_ID)
    AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL_ID)
    print("  done", flush=True)
except Exception as e:
    print(f"  FAILED: {e}", flush=True)
    errors.append(f"depth/{DEPTH_MODEL_ID}: {e}")


# ── SAM 3.1 (gated, best-effort) ──────────────────────────────────────────
_step(f"SAM 3.1 / {SAM3_MODEL_ID}")
try:
    from sam3.model_builder import download_ckpt_from_hf  # type: ignore
    download_ckpt_from_hf(version="sam3.1")
    print("  done", flush=True)
except ImportError:
    print("  skipped (sam3 package not installed)", flush=True)
except Exception as e:
    # Gated/no-token at build time → defer to first request; don't fail the build.
    print(f"  skipped ({e})", flush=True)


# ── Summary ───────────────────────────────────────────────────────────────
print("\n" + "─" * 60, flush=True)
if errors:
    print(f"Pre-download finished with {len(errors)} error(s):", flush=True)
    for err in errors:
        print(f"  • {err}", flush=True)
    sys.exit(1)
print("Masking models pre-downloaded.", flush=True)
