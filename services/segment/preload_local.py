"""Dev pre-download: fetch LaMa so the first /inpaint after `bun run mask:dev` is not a download."""

from __future__ import annotations

import sys

print("\n── LaMa inpainting (simple-lama-inpainting)", flush=True)
try:
    import torch  # type: ignore
    # The LaMa checkpoint was saved with CUDA tensors; remap to CPU so it
    # loads on any machine (same patch used in main.py _load_lama).
    _orig = torch.jit.load
    # simple-lama passes map_location itself (keyword); drop it and force "cpu",
    # as main.py's _cpu_jit_load does — forwarding both is a TypeError.
    def _cpu_jit_load(f, *args, **kw):
        kw.pop("map_location", None)
        return _orig(f, map_location="cpu", **kw)
    torch.jit.load = _cpu_jit_load
    try:
        from simple_lama_inpainting import SimpleLama  # type: ignore
        SimpleLama()
    finally:
        torch.jit.load = _orig
except Exception as e:
    print(f"  FAILED: {e}", flush=True)
    sys.exit(1)
print("LaMa pre-downloaded.", flush=True)
