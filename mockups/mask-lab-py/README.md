# Phosmith · Mask Lab (Python)

A **basic Python tool that actually masks images** — the Executive-Summary pipeline,
running on models you already have installed, before any of it is wired into the editor.

```
image + prompt ─▶ COARSE MASK ─▶ TRIMAP ─▶ FINE MATTE ─▶ REFINE ─▶ DECONTAMINATE ─▶ CUT-OUT
                  rembg/GrabCut   OpenCV     PyMatting     hole-fill   PyMatting FG     RGBA
                                  erode/dil  closed-form   despeckle   colour-unmix
```

Everything is **real** — no stubbed AI. The only simulated thing is which *coarse*
segmenter stands in for SAM 3.1 (you pick `rembg`, `grabcut`, or `saliency`).

## Run it

Use the segment-service venv (it already has numpy / opencv / scipy / **pymatting** / **rembg**):

```bash
cd mockups/mask-lab-py
PY=../../services/segment/.venv/bin/python

# CLI — writes 5 stage PNGs to out/
$PY mask_lab.py /path/to/photo.jpg --out out/

# tune the edge band + matting model
$PY mask_lab.py photo.jpg --coarse auto --matte pymatting_cf --erode 8 --dilate 14 --feather 1

# basic Gradio UI (one extra install)
$PY -m pip install gradio
$PY mask_lab.py --ui
```

| flag | meaning |
|------|---------|
| `--coarse` | `auto` (rembg→grabcut), `rembg`, `grabcut`, `saliency` |
| `--matte`  | `pymatting_cf` (closed-form), `pymatting_knn`, `guided` (fast, no deps) |
| `--erode/--dilate` | trimap band width (px) — wider = more hair recovered, slower |
| `--smooth/--feather/--contrast/--shift` | global refinements (Photoshop *Select & Mask* parity) |
| `--no-decon` | skip PyMatting foreground colour estimation |

**Coarse tips:** `rembg` is best on real photos (it's the model the FastAPI service ships);
`grabcut` is best when the subject sits in the centre with clear contrast. The fine-matte
stage recovers hair/fur regardless — that's where closed-form matting earns its keep.

## Stage → production model (upgrade path)

| Mask Lab stage | Today | Drop-in upgrade (from the doc) |
|----------------|-------|--------------------------------|
| 1 · coarse | rembg / GrabCut | **SAM 3.1** point/box/text prompt — `services/segment/main.py` already has `_load_sam3` |
| 2 · trimap | OpenCV erode/dilate | unchanged — identical to Matte-Anything `generate_trimap` |
| 3 · fine matte | **PyMatting** closed-form | **ZIM** (`zim_vit_l`) or **ViTMatte** for hair/glass; PyMatting becomes the polish pass |
| 4 · refine | hole-fill + despeckle | unchanged |
| 5 · decontaminate | **PyMatting** `estimate_foreground_ml` | unchanged |

To upgrade stage 3, replace `fine_matte()` with the ZIM call from the Executive Summary:

```python
from zim_anything import zim_model_registry, ZimPredictor
model = zim_model_registry["vit_l"](checkpoint="zim_vit_l")
pred  = ZimPredictor(model); pred.set_image(rgb)
alpha = pred.predict([{"mask_input": trimap, "has_mask": True}])[0]
```

…and replace `coarse_mask()` with SAM 3.1 (text/click prompt). Same trimap + refine + decontaminate around it.

## Files
- `mask_lab.py` — pipeline + CLI + optional Gradio UI (single file, ~300 lines)
- `requirements.txt` — deps (all but gradio already in the service venv)

> A richer in-browser UX reference (Photoshop-style View modes, Refine-Edge brush) lives in
> `../mask-lab/index.html` — kept as a design reference; this Python tool is the functional core.
