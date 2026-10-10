"""Phosmith erase service.

LaMa inpainting (/inpaint) fills the hole left by the AI Object Remover, and
/shape/fill rasterises a closed editor path into a mask with OpenCV (no model).
Selection runs in the browser on SlimSAM, so this service carries one model.

Free-tier friendly: no GPU required, but auto-uses CUDA (NVIDIA) or MPS
(Apple Silicon) when available.
"""

from __future__ import annotations

import importlib.util
import io
import json
import math
import logging
import os
import threading
import time
from contextlib import asynccontextmanager

import numpy as np

# OpenCV draws /shape/fill's polygon; Pillow is the fallback when it is missing.
try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover - optional accel
    cv2 = None  # type: ignore

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, ImageDraw, ImageFilter, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("mask-service")

# Load a local services/segment/.env (if present) BEFORE reading any config, so
# `bun run mask:dev` can be configured without exporting shell vars. Best-effort:
# python-dotenv is an indirect dep; absence just means env comes from the shell.
try:
    from dotenv import load_dotenv  # type: ignore

    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except Exception:  # pragma: no cover - optional
    pass

# ─── Config ──────────────────────────────────────────────────────────────────

# Persistent model cache directory (HF_HOME / torch hub). Set to a directory
# that survives restarts: HF Spaces persistent storage /data/models, or a Docker
# volume. Leave unset to use the platform defaults.
MODEL_CACHE_DIR = os.getenv("MODEL_CACHE_DIR", "").strip() or None
if MODEL_CACHE_DIR:
    os.makedirs(MODEL_CACHE_DIR, exist_ok=True)
    os.environ.setdefault("HF_HOME", MODEL_CACHE_DIR)
    log.info("model cache pinned to %r (HF_HOME)", MODEL_CACHE_DIR)

PORT = int(os.getenv("PORT", "8001").strip())
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "24").strip())
SHAPE_MASK_MAX_SIDE = int(os.getenv("SHAPE_MASK_MAX_SIDE", "2048").strip())
SHAPE_MASK_MAX_POINTS = int(os.getenv("SHAPE_MASK_MAX_POINTS", "10000").strip())
# LaMa loads lazily on first use; SEGMENT_EAGER_MODELS=1 preloads it at startup.
# Longest side, in pixels, of a hole LaMa is given to fill. Measured on one
# headlight: an 85 px hole comes back clean, 112-160 px hold, 256 px and up turn
# into a dark speckled blob. Past this the image is filled at a scale where the
# hole is this size, and only the fill is scaled back up.
LAMA_WORK_HOLE = int(os.getenv("LAMA_WORK_HOLE", "128").strip())
SEGMENT_EAGER_MODELS = os.getenv("SEGMENT_EAGER_MODELS", "0").strip() not in ("0", "false", "False", "")

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
    if o.strip()
]


# ─── LaMa ────────────────────────────────────────────────────────────────────

_LAMA_LOCK = threading.Lock()


def _lama_loadable() -> bool:
    """Cheap probe: is simple-lama-inpainting importable?"""
    try:
        return bool(importlib.util.find_spec("simple_lama_inpainting"))
    except Exception:
        return False


def _load_lama(app: FastAPI) -> bool:
    """Load LaMa into app.state (blocking). Caller holds _LAMA_LOCK."""
    try:
        import torch  # type: ignore
        from simple_lama_inpainting import SimpleLama  # type: ignore

        log.info("loading LaMa inpainting model ...")
        t0 = time.perf_counter()

        # The LaMa checkpoint was saved with CUDA tensors. On machines without
        # CUDA (e.g. Mac / CPU-only Linux) torch.jit.load fails because it
        # tries to deserialise onto the CUDA backend which doesn't exist.
        # Monkey-patch torch.jit.load to force map_location='cpu' so the
        # checkpoint is remapped transparently.
        _orig_jit_load = torch.jit.load
        def _cpu_jit_load(f, *args, **kw):
            # Absorb ANY caller-supplied map_location — positional (args[0],
            # swallowed by *args and not forwarded) or keyword (popped from kw)
            # — then force "cpu". The previous signature only caught a
            # positional value; simple-lama calls `torch.jit.load(path,
            # map_location=device)` with the KEYWORD form, which slipped into
            # **kw and collided with the hardcoded map_location="cpu"
            # ("got multiple values for keyword argument 'map_location'").
            kw.pop("map_location", None)
            return _orig_jit_load(f, map_location="cpu", **kw)
        torch.jit.load = _cpu_jit_load
        try:
            app.state.lama_model = SimpleLama()
        finally:
            torch.jit.load = _orig_jit_load

        app.state.lama_available = True
        log.info("LaMa ready in %.1fs", time.perf_counter() - t0)
        return True
    except ImportError:
        log.warning(
            "simple-lama-inpainting not installed; /inpaint disabled. "
            "Install with: pip install simple-lama-inpainting"
        )
        app.state.lama_load_failed = True
        return False
    except Exception as e:
        log.exception("failed to load LaMa: %s", e)
        app.state.lama_load_failed = True
        return False


def _ensure_lama(app: FastAPI):
    """Lazily load LaMa; return True/'cold' if ready, False if failed.
    Returns 'cold' on first load (model just downloaded/loaded)."""
    if getattr(app.state, "lama_available", False):
        return True
    if getattr(app.state, "lama_load_failed", False):
        return False
    with _LAMA_LOCK:
        if getattr(app.state, "lama_available", False):
            return True
        if getattr(app.state, "lama_load_failed", False):
            return False
        ok = _load_lama(app)
        return "cold" if ok else False


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.lama_available = False
    app.state.lama_load_failed = False
    if SEGMENT_EAGER_MODELS:
        await run_in_threadpool(_ensure_lama, app)
    else:
        log.info("LaMa loads lazily on first use (SEGMENT_EAGER_MODELS=1 to preload).")
    yield
    log.info("shutting down mask service")


app = FastAPI(
    title="Phosmith Mask Service",
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024


@app.middleware("http")
async def limit_upload_size(request: Request, call_next):
    """Reject oversize POSTs before the body is read (defends against
    memory/disk exhaustion: a 10 GB upload would otherwise be spooled
    to disk by Starlette before any size check runs).
    """
    if request.method == "POST":
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > MAX_UPLOAD_BYTES:
            return Response(
                content=(
                    f"file too large (Content-Length: {int(cl) // (1024*1024)}MB"
                    f" > {MAX_UPLOAD_MB}MB)"
                ),
                status_code=413,
            )
    return await call_next(request)


async def _read_limited(image: UploadFile) -> bytes:
    """Stream-read an UploadFile into memory, aborting if it exceeds the
    upload limit (defends against chunked uploads that bypass the
    Content-Length middleware above). Reads the underlying SpooledTemporaryFile
    in 1 MB chunks via the threadpool so we never block the event loop
    and never buffer the whole body before checking size.
    """
    contents = bytearray()
    while True:
        chunk = await run_in_threadpool(image.file.read, 1024 * 1024)
        if not chunk:
            break
        contents.extend(chunk)
        if len(contents) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                413,
                f"file too large (> {MAX_UPLOAD_MB}MB)",
            )
    return bytes(contents)


def _parse_shape_points(raw: str, width: int, height: int) -> list[tuple[float, float]]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"invalid points JSON: {e}")

    if not isinstance(data, list) or len(data) < 3:
        raise HTTPException(400, "points must be an array with at least 3 [x, y] pairs")
    if len(data) > SHAPE_MASK_MAX_POINTS:
        raise HTTPException(
            400,
            f"too many points: {len(data)} > {SHAPE_MASK_MAX_POINTS}",
        )

    points: list[tuple[float, float]] = []
    for i, point in enumerate(data):
        if not (isinstance(point, list) and len(point) == 2):
            raise HTTPException(400, f"point #{i} must be [x, y]; got {point!r}")
        x, y = point
        if not isinstance(x, (int, float)) or isinstance(x, bool) or not math.isfinite(x):
            raise HTTPException(400, f"point #{i} x must be a finite number; got {x!r}")
        if not isinstance(y, (int, float)) or isinstance(y, bool) or not math.isfinite(y):
            raise HTTPException(400, f"point #{i} y must be a finite number; got {y!r}")
        if not (-1 <= x <= width + 1 and -1 <= y <= height + 1):
            raise HTTPException(
                400,
                f"point #{i} ({x}, {y}) is outside mask bounds ({width}x{height})",
            )
        points.append((float(x), float(y)))
    return points


def _rasterize_shape_mask(width: int, height: int, points: list[tuple[float, float]]) -> tuple[bytes, str]:
    """Fill a closed path to an RGBA PNG mask.

    White+alpha inside the polygon and transparent outside matches the editor's
    brush texture contract: plain brush layers sample alpha, smart-brush layers
    sample the red channel.
    """
    if cv2 is not None:
        mask = np.zeros((height, width, 4), dtype=np.uint8)
        poly = np.array(
            [[[int(round(x)), int(round(y))] for x, y in points]],
            dtype=np.int32,
        )
        cv2.fillPoly(mask, poly, color=(255, 255, 255, 255), lineType=cv2.LINE_AA)
        out = Image.fromarray(mask, "RGBA")
        engine = "opencv-fillpoly"
    else:
        out = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(out)
        draw.polygon(points, fill=(255, 255, 255, 255))
        engine = "pillow-polygon"

    buf = io.BytesIO()
    out.save(buf, format="PNG", compress_level=1)
    return buf.getvalue(), engine


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.get("/")
async def root() -> dict:
    return {
        "status": "ok",
        "message": "Phosmith Mask Service is running"
    }


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "max_upload_mb": MAX_UPLOAD_MB,
        "lazy_models": not SEGMENT_EAGER_MODELS,
        "shape_mask_engine": "opencv-fillpoly" if cv2 is not None else "pillow-polygon",
        "lama_available": getattr(app.state, "lama_available", False) or _lama_loadable(),
        "lama_loaded": getattr(app.state, "lama_available", False),
        "models": {"lama": getattr(app.state, "lama_available", False)},
    }


@app.post("/warmup")
async def warmup() -> dict:
    """Pre-load LaMa so the first real request is fast."""
    was = getattr(app.state, "lama_available", False)
    status = await run_in_threadpool(_ensure_lama, app)
    results = {"lama": "already_loaded" if was else "loaded" if status else "failed"}
    log.info("warmup results: %s", results)
    return {"status": "ok", "models": results}


@app.post("/inpaint")
async def inpaint(
    image: UploadFile = File(..., alias="image"),
    mask: UploadFile = File(..., alias="mask"),
) -> Response:
    """Inpaint masked regions using LaMa.

    Accepts:
      - image: the source image (JPEG/PNG)
      - mask: a white-on-black mask where white = region to fill

    Returns the inpainted image as PNG.
    """
    _lama_status = _ensure_lama(app)
    if not _lama_status:
        raise HTTPException(
            501,
            "LaMa inpainting is not available. "
            "Install with: pip install simple-lama-inpainting",
        )
    _lama_cold = _lama_status == "cold"

    image_bytes = await _read_limited(image)
    mask_bytes = await _read_limited(mask)
    if not image_bytes or not mask_bytes:
        raise HTTPException(400, "empty upload")
    # Decode defensively — garbage bytes must 400, not 500.
    try:
        # exif_transpose BEFORE convert: camera JPEGs store rotation in EXIF,
        # and inpainting the raw pixels would return a result rotated relative
        # to what the caller (and their mask) sees. No-op without EXIF.
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes))).convert("RGB")
        msk = Image.open(io.BytesIO(mask_bytes)).convert("L")
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as e:
        raise HTTPException(400, f"could not decode image or mask: {e}")

    def _run(img=img, msk=msk):
        # Resize mask to match image if needed
        if msk.size != img.size:
            msk = msk.resize(img.size, Image.NEAREST)

        # LaMa expects mask > 0 = inpaint region. Threshold to binary.
        msk_np = np.array(msk)
        msk_np = (msk_np > 16).astype(np.uint8) * 255
        msk = Image.fromarray(msk_np, mode="L")

        w, h = img.size
        ys, xs = np.nonzero(msk_np)
        hole = max(int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)) if xs.size else 0
        scale = min(1.0, LAMA_WORK_HOLE / hole) if hole else 1.0
        if scale < 1.0:
            # Fill at a scale where the hole is LAMA_WORK_HOLE px, then put only
            # the upscaled fill back; pixels outside the hole stay the original.
            sw, sh = max(8, round(w * scale)), max(8, round(h * scale))
            small = img.resize((sw, sh), Image.LANCZOS)
            # Area-average then any coverage: the small hole covers the whole one.
            smask = msk.resize((sw, sh), Image.BOX).point(lambda v: 255 if v > 0 else 0)
            filled = app.state.lama_model(small, smask).crop((0, 0, sw, sh))
            up = filled.resize((w, h), Image.LANCZOS)
            alpha = Image.fromarray(msk_np, mode="L").filter(ImageFilter.GaussianBlur(1.2))
            result = Image.composite(up, img, alpha)
        else:
            # SimpleLama returns the mod-8-padded size; the caller expects the input's.
            result = app.state.lama_model(img, msk).crop((0, 0, w, h))
        buf = io.BytesIO()
        result.save(buf, format="PNG")
        return buf.getvalue()

    from starlette.concurrency import run_in_threadpool  # type: ignore

    png_bytes = await run_in_threadpool(_run)
    resp_headers = {"Cache-Control": "no-store"}
    if _lama_cold:
        resp_headers["X-Cold-Load"] = "true"
        log.info("LaMa cold load — first request after model download")
    return Response(
        content=png_bytes,
        media_type="image/png",
        headers=resp_headers,
    )


@app.post("/shape/fill")
async def shape_fill(
    width: int = Form(...),
    height: int = Form(...),
    points: str = Form(...),
) -> Response:
    """Rasterize a closed editor path into a filled RGBA mask.

    Form fields:
        width/height: target mask texture dimensions
        points: JSON array of `[x, y]` pairs in target-mask pixel coords

    Returns an RGBA PNG: white+alpha inside the path, transparent outside.
    """
    if width < 1 or height < 1:
        raise HTTPException(400, "width and height must be positive")
    if max(width, height) > SHAPE_MASK_MAX_SIDE:
        raise HTTPException(
            413,
            f"mask too large ({width}x{height}); max longest side is {SHAPE_MASK_MAX_SIDE}px",
        )

    parsed_points = _parse_shape_points(points, width, height)
    t0 = time.perf_counter()
    try:
        png, engine = await run_in_threadpool(_rasterize_shape_mask, width, height, parsed_points)
    except HTTPException:
        raise
    except Exception as e:
        log.exception("shape fill failed")
        raise HTTPException(500, f"shape fill failed: {e}")

    elapsed = time.perf_counter() - t0
    log.info(
        "shape fill %dx%d (%d points) via %s in %.3fs -> %dB",
        width,
        height,
        len(parsed_points),
        engine,
        elapsed,
        len(png),
    )
    return Response(
        content=png,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Model": engine,
            "X-Width": str(width),
            "X-Height": str(height),
            "X-Elapsed-Ms": str(int(elapsed * 1000)),
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=False)
