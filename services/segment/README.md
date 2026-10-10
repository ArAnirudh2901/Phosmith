---
title: Phosmith
emoji: 🎨
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# Phosmith Erase Service

A small FastAPI service for the editor's AI Object Remover, deployable as a
**Hugging Face Space (Docker SDK)**. It runs one model:

- **LaMa** (`simple-lama-inpainting`, torch) — `/inpaint` fills the hole left
  when an object is removed. The Next.js `/api/ai/inpaint` route crops to the
  mask bounds first, so LaMa runs on a patch, not the whole photo. A hole
  longer than `LAMA_WORK_HOLE` px (default 128) is filled at a scale where it
  is that long and only the fill is scaled back up: LaMa leaves a dark
  speckled blob in holes of a few hundred pixels, and takes minutes on them.

and one model-free endpoint:

- **`/shape/fill`** — rasterises a closed editor path into a mask with OpenCV
  (Pillow fallback). Called by `/api/ai/shape-mask`.

Selection (click, box, subject, text, every-subject) runs in the browser on
SlimSAM, with CLIPSeg for text. Depth lives in `services/masking`.

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py            # port 8001; or `bun run mask:dev` from the repo root
```

Set `MASK_SERVICE_URL=http://127.0.0.1:8001` in the app's `.env.local`.

## Deploy to a Hugging Face Space

Create a Space with the **Docker** SDK and push this directory (`Dockerfile`,
`requirements.txt`, `main.py`, `preload_models.py`). The image pre-downloads
LaMa at build time and serves on port 7860; point `MASK_SERVICE_URL` at the
Space's URL.

## Endpoints

| Method | Path | |
|---|---|---|
| GET | `/health` | LaMa availability and load state |
| POST | `/warmup` | load LaMa now instead of on first use |
| POST | `/inpaint` | `image` + `mask` (white = fill) → PNG |
| POST | `/shape/fill` | `width`, `height`, `points` (JSON `[[x, y], …]`) → RGBA PNG |
