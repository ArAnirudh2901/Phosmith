"""Pre-download LaMa at Docker build time so the container starts with it."""

from __future__ import annotations

import sys

print("\n── LaMa inpainting (simple-lama-inpainting)", flush=True)
try:
    import torch  # type: ignore
    # The LaMa checkpoint was saved with CUDA tensors; remap to CPU so it
    # loads on any machine (same patch used in main.py _load_lama).
    _orig = torch.jit.load
    torch.jit.load = lambda f, _map_location=None, **kw: _orig(f, map_location="cpu", **kw)
    try:
        from simple_lama_inpainting import SimpleLama  # type: ignore
        SimpleLama()
    finally:
        torch.jit.load = _orig
except Exception as e:
    print(f"  FAILED: {e}", flush=True)
    sys.exit(1)
print("LaMa pre-downloaded.", flush=True)
