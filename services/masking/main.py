"""Phosmith depth service.

Monocular depth (Depth Anything V2) for the editor's Depth Range layer and
depth of field. Selection — click, box, subject, text and every-subject — runs
in the browser on SlimSAM (with CLIPSeg for text), so this service carries one
small model. Deploys to its own Hugging Face Space, separate from the
erase/inpaint service in `services/segment`.

No GPU required; auto-uses CUDA (NVIDIA) or MPS (Apple Silicon) when present.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import logging
import os
import threading
import time
from collections import OrderedDict
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("masking-service")

# Load services/masking/.env (if present) before reading config.
try:
    from dotenv import load_dotenv  # type: ignore

    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except Exception:  # pragma: no cover - optional
    pass

# ─── Config ──────────────────────────────────────────────────────────────────

# Persistent model cache (HF_HOME). Set to a dir that survives restarts
# (HF Spaces persistent storage /data/models, Docker volume).
MODEL_CACHE_DIR = os.getenv("MODEL_CACHE_DIR", "").strip() or None
if MODEL_CACHE_DIR:
    os.makedirs(MODEL_CACHE_DIR, exist_ok=True)
    os.environ.setdefault("HF_HOME", MODEL_CACHE_DIR)
    log.info("model cache pinned to %r (HF_HOME)", MODEL_CACHE_DIR)

DEPTH_MODEL_ID = os.getenv("DEPTH_MODEL_ID", "depth-anything/Depth-Anything-V2-Small-hf").strip()
DEPTH_CACHE_MAX = int(os.getenv("DEPTH_CACHE_MAX", "20").strip())
DEPTH_CACHE_MAX_PIXELS = int(os.getenv("DEPTH_CACHE_MAX_PIXELS", str(2048 * 2048)).strip())
DEPTH_MAX_SIDE = int(os.getenv("DEPTH_MAX_SIDE", "2048").strip())
PORT = int(os.getenv("PORT", "8002").strip())
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "24").strip())
SEGMENT_EAGER_MODELS = os.getenv("SEGMENT_EAGER_MODELS", "0").strip() not in ("0", "false", "False", "")

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
    if o.strip()
]

_DEPTH_LOCK = threading.Lock()


# ─── Torch device ────────────────────────────────────────────────────────────

def detect_torch_device():
    """Best torch device: CUDA > MPS > CPU. Returns (device, label)."""
    try:
        import torch  # type: ignore
    except ImportError:
        return None, "torch-missing"
    if torch.cuda.is_available():
        return torch.device("cuda"), "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps"), "mps"
    return torch.device("cpu"), "cpu"


# ─── Depth Anything V2 ───────────────────────────────────────────────────────

DEPTH_CACHE: "OrderedDict[str, np.ndarray]" = OrderedDict()


def _image_hash(img: Image.Image) -> str:
    """Stable 64-bit hash of pixel data for the depth cache key."""
    return hashlib.sha256(img.tobytes()).hexdigest()[:16]


def _depth_predict(app, img: Image.Image) -> np.ndarray:
    """Depth Anything V2 → uint8 HxW (white=near). Cached by image hash."""
    key = _image_hash(img)
    cached = DEPTH_CACHE.get(key)
    if cached is not None:
        DEPTH_CACHE.move_to_end(key)
        return cached

    import torch  # type: ignore
    processor = app.state.depth_processor
    model = app.state.depth_model
    device = app.state.depth_device

    inputs = processor(images=img, return_tensors="pt").to(device)
    with torch.inference_mode():
        outputs = model(pixel_values=inputs.pixel_values)
    depth = outputs.predicted_depth.squeeze(0).cpu().numpy()
    d_min, d_max = float(depth.min()), float(depth.max())
    if d_max - d_min < 1e-6:
        normalised = np.zeros_like(depth, dtype=np.uint8)
    else:
        normalised = ((depth - d_min) / (d_max - d_min) * 255.0).astype(np.uint8)

    if normalised.size <= DEPTH_CACHE_MAX_PIXELS:
        DEPTH_CACHE[key] = normalised
        while len(DEPTH_CACHE) > DEPTH_CACHE_MAX:
            DEPTH_CACHE.popitem(last=False)
    return normalised


def _torch_stack_loadable() -> bool:
    try:
        return bool(importlib.util.find_spec("torch") and importlib.util.find_spec("transformers"))
    except Exception:  # pragma: no cover
        return False


def _load_depth(app: FastAPI) -> bool:
    """Load Depth Anything V2 into app.state (blocking; caller holds _DEPTH_LOCK)."""
    try:
        import torch  # type: ignore  # noqa: F401
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation  # type: ignore

        device, device_label = detect_torch_device()
        if device is None:
            raise ImportError("torch not available")
        log.info("loading Depth model %r onto %s ...", DEPTH_MODEL_ID, device_label)
        t0 = time.perf_counter()
        app.state.depth_processor = AutoImageProcessor.from_pretrained(DEPTH_MODEL_ID)
        app.state.depth_model = AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL_ID).to(device)
        app.state.depth_model.eval()
        app.state.depth_device = device
        app.state.depth_model_id = DEPTH_MODEL_ID
        app.state.depth_available = True
        log.info("Depth ready in %.1fs on %s", time.perf_counter() - t0, device_label)
        return True
    except ImportError:
        log.warning("torch / transformers not installed; /depth disabled.")
        app.state.depth_load_failed = True
        return False
    except Exception as e:  # pragma: no cover - defensive
        log.exception("failed to load Depth model: %s", e)
        app.state.depth_load_failed = True
        return False


def _ensure_depth(app: FastAPI):
    """Lazily load Depth; return True/'cold' if ready, False if failed."""
    if app.state.depth_available:
        return True
    if getattr(app.state, "depth_load_failed", False):
        return False
    with _DEPTH_LOCK:
        if app.state.depth_available:
            return True
        if getattr(app.state, "depth_load_failed", False):
            return False
        ok = _load_depth(app)
        return "cold" if ok else False


# ─── App ─────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.depth_available = False
    app.state.depth_load_failed = False
    app.state.depth_model_id = DEPTH_MODEL_ID
    if SEGMENT_EAGER_MODELS:
        await run_in_threadpool(_ensure_depth, app)
    else:
        log.info("Depth loads lazily on first use (SEGMENT_EAGER_MODELS=1 to preload).")
    yield
    DEPTH_CACHE.clear()
    log.info("shutting down masking service")


app = FastAPI(
    title="Phosmith Masking Service",
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
    """Reject oversize POSTs by Content-Length before the body is read."""
    if request.method == "POST":
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > MAX_UPLOAD_BYTES:
            return Response(content=f"file too large (> {MAX_UPLOAD_MB}MB)", status_code=413)
    return await call_next(request)


async def _read_limited(image: UploadFile) -> bytes:
    """Stream an UploadFile into memory, aborting past the upload cap (defends
    against chunked uploads that bypass the Content-Length middleware)."""
    contents = bytearray()
    while True:
        chunk = await run_in_threadpool(image.file.read, 64 * 1024)
        if not chunk:
            break
        contents.extend(chunk)
        if len(contents) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"file too large (> {MAX_UPLOAD_MB}MB)")
    return bytes(contents)


def _decode_image(contents: bytes, *, max_side: int, rgb_only: bool = False) -> Image.Image:
    """Decode + validate an upload into a PIL image, enforcing the side cap."""
    if not contents:
        raise HTTPException(400, "empty upload")
    try:
        img = Image.open(io.BytesIO(contents))
        img.load()
        # Camera JPEGs store the rotation in EXIF; every model here works on the
        # raw pixels, so without this the mask comes back rotated relative to
        # what any EXIF-aware viewer (or the browser) shows. No-op without EXIF.
        img = ImageOps.exif_transpose(img)
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as e:
        raise HTTPException(400, f"could not decode image: {e}")
    if img.mode in ("I", "I;16", "I;16B", "I;16L", "I;16N"):
        # 16/32-bit greyscale: PIL's convert("RGB") truncates instead of
        # rescaling, which blacks the frame out and every model sees nothing.
        arr = np.asarray(img, dtype=np.float32)
        img = Image.fromarray(np.clip(arr / 257.0, 0, 255).astype(np.uint8), "L")
    if rgb_only:
        if img.mode != "RGB":
            img = img.convert("RGB")
    elif img.mode not in ("RGB", "RGBA", "L"):
        img = img.convert("RGB")
    if max(img.width, img.height) > max_side:
        raise HTTPException(
            413, f"image too large ({img.width}x{img.height}); max longest side is {max_side}px"
        )
    return img


def _require_image_ct(image: UploadFile) -> None:
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(415, f"unsupported content-type: {image.content_type}")


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.get("/")
async def root() -> dict:
    return {"status": "ok", "message": "Phosmith Masking Service is running"}


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "max_upload_mb": MAX_UPLOAD_MB,
        "lazy_models": not SEGMENT_EAGER_MODELS,
        "depth_available": app.state.depth_available
        or (_torch_stack_loadable() and not app.state.depth_load_failed),
        "depth_loaded": app.state.depth_available,
        "depth_model": app.state.depth_model_id,
        "models": {"depth": app.state.depth_available},
    }


@app.post("/warmup")
async def warmup() -> dict:
    """Pre-load Depth so the first real request is fast."""
    was = app.state.depth_available
    status = await run_in_threadpool(_ensure_depth, app)
    results = {"depth": "already_loaded" if was else "loaded" if status else "failed"}
    log.info("warmup results: %s", results)
    return {"status": "ok", "models": results}


@app.post("/depth")
async def depth(image: UploadFile = File(..., alias="image")) -> Response:
    """Monocular depth (Depth Anything V2) → greyscale PNG at input resolution
    (white=near). Per-image min-max normalised; LRU-cached by image hash."""
    _depth_status = await run_in_threadpool(_ensure_depth, app)
    if not _depth_status:
        raise HTTPException(501, "Depth Anything V2 not available. Install torch + transformers and restart.")
    _depth_cold = _depth_status == "cold"
    _require_image_ct(image)
    contents = await _read_limited(image)
    img = _decode_image(contents, max_side=DEPTH_MAX_SIDE, rgb_only=True)

    t0 = time.perf_counter()
    try:
        depth_arr = _depth_predict(app, img)
    except Exception as e:
        log.exception("depth predict failed")
        raise HTTPException(500, f"depth inference failed: {e}")
    elapsed = time.perf_counter() - t0

    # The model runs at ~518² internally; resize back to input resolution (Lanczos
    # preserves depth edges) so the map drops onto the canvas 1:1.
    if depth_arr.shape != (img.height, img.width):
        depth_resized = Image.fromarray(depth_arr, mode="L").resize((img.width, img.height), Image.LANCZOS)
        depth_arr = np.array(depth_resized, dtype=np.uint8)
    log.info("Depth %dx%d in %.2fs", img.width, img.height, elapsed)

    buf = io.BytesIO()
    Image.fromarray(depth_arr, mode="L").save(buf, format="PNG", optimize=True)
    resp_headers = {
        "Cache-Control": "no-store", "X-Model": app.state.depth_model_id or "depth",
        "X-Width": str(img.width), "X-Height": str(img.height),
        "X-Elapsed-Ms": str(int(elapsed * 1000)),
    }
    if _depth_cold:
        resp_headers["X-Cold-Load"] = "true"
    return Response(content=buf.getvalue(), media_type="image/png", headers=resp_headers)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=False)
