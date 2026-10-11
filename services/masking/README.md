---
title: Phosmith Depth
emoji: 🌊
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# Phosmith Depth Service

A small FastAPI service for the editor's Depth Range layer and depth of field,
deployable as a **Hugging Face Space (Docker SDK)**. It runs one model:

- **Depth Anything V2 Small** — `/depth` returns a monocular depth map.

Selection runs in the browser on SlimSAM; the object remover's LaMa lives in
`services/segment`, its own Space.

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py            # port 8002; or `bun run masking:dev` from the repo root
```

Set `MASKING_SERVICE_URL=http://127.0.0.1:8002` in the app's `.env.local`.

## Deploy to a Hugging Face Space

Production runs this service and its sibling in ONE Space (`ArAnirudh/Phosmith`):
Hugging Face no longer lets a free account create a Docker Space, so
`services/space/main.py` serves both. Deploy with `bun run space:deploy` from the
repo root; it assembles the Space from both services and uploads it. On its own,
this directory still builds as a Space (`Dockerfile` serves on port 7860) — point
`MASKING_SERVICE_URL` at it.
