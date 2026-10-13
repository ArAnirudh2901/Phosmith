"""Phosmith's Hugging Face Space: the erase service and the depth + selection service in one app.

The two services are meant to deploy to a Space each, but Hugging Face no longer
lets a free account create a Docker Space (402: "requires a PRO subscription"),
and the one Space this project already has must serve both. This merges them
without copying either: `scripts/space.mjs` puts `services/segment/main.py`
next to this file as `segment_service.py` and `services/masking/main.py` as
`depth_service.py`, and this app runs both lifespans and serves both sets of
routes. The editor needs no change: the depth route falls back to
MASK_SERVICE_URL when MASKING_SERVICE_URL is unset.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import depth_service as depth
import segment_service as segment

# Each module's handlers read state off their own module's `app`, so each
# lifespan runs against that app, not this one.
@asynccontextmanager
async def lifespan(_app: FastAPI):
    async with segment.lifespan(segment.app), depth.lifespan(depth.app):
        yield


app = FastAPI(title="Phosmith Space", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=segment.ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)
# Both services cap uploads the same way; one copy of the check is enough.
app.middleware("http")(segment.limit_upload_size)

SHARED = {"/", "/health", "/warmup"}
for module in (segment, depth):
    for route in module.app.router.routes:
        path = getattr(route, "path", "")
        if path in SHARED or path.startswith(("/docs", "/redoc", "/openapi")):
            continue
        app.router.routes.append(route)


@app.get("/")
async def root() -> dict:
    return {"status": "ok", "message": "Phosmith Space: LaMa inpainting, shape fill, depth and SlimSAM selection"}


@app.get("/health")
async def health() -> dict:
    # Both services' fields: the inpaint route reads lama_*, the depth and
    # health routes depth_*, the warmup route `models`.
    seg, dep = await segment.health(), await depth.health()
    return {**seg, **dep, "models": {**seg.get("models", {}), **dep.get("models", {})}}


@app.post("/warmup")
async def warmup() -> dict:
    seg, dep = await segment.warmup(), await depth.warmup()
    return {"status": "ok", "models": {**seg.get("models", {}), **dep.get("models", {})}}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "7860")), reload=False)
