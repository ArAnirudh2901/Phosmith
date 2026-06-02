"""Pixxel mask service.

Wraps `rembg` (BiRefNet default) and Hugging Face `transformers` SAM 2
(Hiera-Small) in a tiny FastAPI HTTP API so the Next.js AI routes can
call SOTA background-removal and click-to-select models locally without
Docker.

Free-tier friendly: no GPU required, but auto-uses CUDA (NVIDIA) or
MPS (Apple Silicon) when available. BiRefNet and SAM 2 Hiera-Small are
both MIT / Apache 2.0 and free for any use.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import math
import os
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from typing import List, Optional

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, UnidentifiedImageError
from rembg import new_session, remove
from starlette.concurrency import run_in_threadpool

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("mask-service")

# ─── Config ──────────────────────────────────────────────────────────────────

MODEL_NAME = os.getenv("SEGMENT_MODEL", "birefnet-general-lite").strip()
SAM2_MODEL_ID = os.getenv("SAM2_MODEL_ID", "facebook/sam2-hiera-small").strip()
SAM2_CACHE_MAX = int(os.getenv("SAM2_CACHE_MAX", "20").strip())
SAM2_MAX_CLICKS = int(os.getenv("SAM2_MAX_CLICKS", "50").strip())
DEPTH_MODEL_ID = os.getenv(
    "DEPTH_MODEL_ID", "depth-anything/Depth-Anything-V2-Small-hf"
).strip()
DEPTH_CACHE_MAX = int(os.getenv("DEPTH_CACHE_MAX", "20").strip())
# Cap the per-entry depth-map size we'll cache. A 2048×2048 uint8 map
# is 4 MB; larger maps get recomputed every time (cheap relative to
# network I/O, and bounds peak memory at ~80 MB even with the full
# 20-entry budget). Defends against pathological inputs that bypass
# the Node route's dimension cap.
DEPTH_CACHE_MAX_PIXELS = int(os.getenv("DEPTH_CACHE_MAX_PIXELS", str(2048 * 2048)).strip())
# Cap the input image's longest side. The model runs internally at
# ~518×518 anyway, and resizing the depth map back to a very large
# output is O(n²) Lanczos work that can OOM the process. The Node
# route (`/api/ai/depth`) applies the same cap; this defends the
# service against direct curls that bypass the route.
DEPTH_MAX_SIDE = int(os.getenv("DEPTH_MAX_SIDE", "2048").strip())
PORT = int(os.getenv("PORT", "8001").strip())
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "24").strip())
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
    if o.strip()
]

# rembg >=2.0.59 model registry.
# Licenses:  birefnet-*, isnet-*, u2net*, silueta = MIT;
#            bria-rmbg = CC BY-NC (non-commercial).
# Sizes and recommended use-cases are documented in README.md.
ALLOWED_MODELS = {
    "birefnet-general",
    "birefnet-general-lite",
    "birefnet-portrait",
    "isnet-general-use",
    "u2net",
    "u2netp",
    "u2net_human_seg",
    "u2net_cloth_seg",
    "silueta",
    "bria-rmbg",
}

if MODEL_NAME not in ALLOWED_MODELS:
    log.warning("unknown SEGMENT_MODEL=%r; falling back to birefnet-general-lite", MODEL_NAME)
    MODEL_NAME = "birefnet-general-lite"


# ─── Execution-provider auto-detect (ONNX / rembg) ──────────────────────────

def detect_providers() -> List[str]:
    """Pick the best ONNX Runtime execution providers for this machine.

    Order of preference: CUDA (NVIDIA) > CoreML (Apple Silicon) > CPU.
    """
    override = os.getenv("SEGMENT_PROVIDERS", "").strip()
    if override:
        return [p.strip() for p in override.split(",") if p.strip()]

    providers: List[str] = ["CPUExecutionProvider"]
    try:
        import onnxruntime as ort  # type: ignore
        available = set(ort.get_available_providers())
        if "CUDAExecutionProvider" in available:
            providers.insert(0, "CUDAExecutionProvider")
            log.info("ONNX CUDA execution provider detected (NVIDIA GPU)")
        elif "CoreMLExecutionProvider" in available:
            providers.insert(0, "CoreMLExecutionProvider")
            log.info("ONNX CoreML execution provider detected (Apple Silicon GPU)")
    except Exception as e:  # pragma: no cover - best effort
        log.debug("onnxruntime provider probe failed: %s", e)
    return providers


# ─── Optional torch / SAM 2 loader ──────────────────────────────────────────

def detect_torch_device():
    """Pick the best torch device on this machine.

    Order of preference: CUDA (NVIDIA) > MPS (Apple Silicon) > CPU.
    Returns the torch.device and a short label.
    """
    try:
        import torch  # type: ignore
    except ImportError:
        return None, "torch-missing"
    if torch.cuda.is_available():
        return torch.device("cuda"), "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps"), "mps"
    return torch.device("cpu"), "cpu"


SAM2_EMBEDDING_CACHE: "OrderedDict[str, tuple]" = OrderedDict()
DEPTH_CACHE: "OrderedDict[str, np.ndarray]" = OrderedDict()


def _image_hash(img: Image.Image) -> str:
    """Stable hash of a PIL image's pixel data for cache keys (SAM 2
    embeddings, depth maps). Collisions on 16 hex chars (64 bits) are
    astronomically unlikely for any image a user will upload."""
    return hashlib.sha256(img.tobytes()).hexdigest()[:16]


def _sam2_encode(app, img: Image.Image):
    """Run the SAM 2 image encoder, caching by image-content hash.

    Returns (image_embeddings, original_sizes) on the model's device.
    """
    key = _image_hash(img)
    cached = SAM2_EMBEDDING_CACHE.get(key)
    if cached is not None:
        SAM2_EMBEDDING_CACHE.move_to_end(key)
        log.info("SAM 2 embedding cache hit (%d entries)", len(SAM2_EMBEDDING_CACHE))
        return cached

    import torch  # type: ignore
    processor = app.state.sam2_processor
    model = app.state.sam2_model
    device = app.state.sam2_device

    t0 = time.perf_counter()
    inputs = processor(images=img, return_tensors="pt").to(device)
    with torch.inference_mode():
        embeddings = model.get_image_embeddings(pixel_values=inputs.pixel_values)

    value = (embeddings, inputs["original_sizes"])
    SAM2_EMBEDDING_CACHE[key] = value
    while len(SAM2_EMBEDDING_CACHE) > SAM2_CACHE_MAX:
        SAM2_EMBEDDING_CACHE.popitem(last=False)

    log.info(
        "SAM 2 embedded %dx%d in %.2fs (cache: %d entries)",
        img.width, img.height,
        time.perf_counter() - t0,
        len(SAM2_EMBEDDING_CACHE),
    )
    return value


def _depth_predict(app, img: Image.Image) -> np.ndarray:
    """Run Depth Anything V2 on `img`, caching the depth map by image hash.

    Returns a `np.ndarray` of shape `(H, W)` with dtype `uint8` (0..255).
    White = near, black = far. The map is at the input image's
    resolution — no resize needed.
    """
    key = _image_hash(img)
    cached = DEPTH_CACHE.get(key)
    if cached is not None:
        DEPTH_CACHE.move_to_end(key)
        log.info("Depth cache hit (%d entries)", len(DEPTH_CACHE))
        return cached

    import torch  # type: ignore
    processor = app.state.depth_processor
    model = app.state.depth_model
    device = app.state.depth_device

    t0 = time.perf_counter()
    inputs = processor(images=img, return_tensors="pt").to(device)
    with torch.inference_mode():
        outputs = model(pixel_values=inputs.pixel_values)
    # `predicted_depth` is (1, H, W). Normalise per-image to 0..255 so
    # the user can pick a meaningful near/far range. Per-image
    # normalisation is the right default — Depth Anything V2 returns
    # relative depth, not metric, so absolute thresholds would be
    # image-dependent anyway.
    depth = outputs.predicted_depth.squeeze(0).cpu().numpy()
    d_min = float(depth.min())
    d_max = float(depth.max())
    if d_max - d_min < 1e-6:
        # Flat depth (extremely rare — uniform-colour images). Avoid
        # division-by-zero by writing 0 (the mask will be empty).
        normalised = np.zeros_like(depth, dtype=np.uint8)
    else:
        normalised = ((depth - d_min) / (d_max - d_min) * 255.0).astype(np.uint8)

    # Skip caching huge depth maps — see DEPTH_CACHE_MAX_PIXELS rationale.
    if normalised.size <= DEPTH_CACHE_MAX_PIXELS:
        DEPTH_CACHE[key] = normalised
        while len(DEPTH_CACHE) > DEPTH_CACHE_MAX:
            DEPTH_CACHE.popitem(last=False)
    else:
        log.info(
            "Depth %s %dx%d — skipping cache (size %d > %d pixels)",
            app.state.depth_model_id, img.width, img.height,
            normalised.size, DEPTH_CACHE_MAX_PIXELS,
        )

    log.info(
        "Depth %s %dx%d in %.2fs (cache: %d entries)",
        app.state.depth_model_id,
        img.width, img.height,
        time.perf_counter() - t0,
        len(DEPTH_CACHE),
    )
    return normalised


# ─── App lifecycle ───────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("loading rembg model %r ...", MODEL_NAME)
    t0 = time.perf_counter()
    providers = detect_providers()
    log.info("execution providers: %s", providers)

    try:
        app.state.session = new_session(MODEL_NAME, providers=providers)
        app.state.model_name = MODEL_NAME
        app.state.providers = providers
        log.info("model %r ready in %.1fs", MODEL_NAME, time.perf_counter() - t0)
    except Exception as e:  # pragma: no cover - defensive
        log.exception("failed to load %r: %s", MODEL_NAME, e)
        log.info("falling back to u2net (CPU only)")
        app.state.session = new_session("u2net", providers=["CPUExecutionProvider"])
        app.state.model_name = "u2net"
        app.state.providers = ["CPUExecutionProvider"]

    # Optional: SAM 2 (Step 5 click-to-select).
    app.state.sam2_available = False
    app.state.sam2_model_id = None
    try:
        import torch  # type: ignore  # noqa: F401
        from transformers import Sam2Model, Sam2Processor  # type: ignore

        device, device_label = detect_torch_device()
        if device is None:
            raise ImportError("torch not available")

        log.info("loading SAM 2 model %r onto %s ...", SAM2_MODEL_ID, device_label)
        t1 = time.perf_counter()
        app.state.sam2_processor = Sam2Processor.from_pretrained(SAM2_MODEL_ID)
        app.state.sam2_model = Sam2Model.from_pretrained(SAM2_MODEL_ID).to(device)
        app.state.sam2_model.eval()
        app.state.sam2_device = device
        app.state.sam2_model_id = SAM2_MODEL_ID
        app.state.sam2_available = True
        log.info(
            "SAM 2 ready in %.1fs on %s",
            time.perf_counter() - t1,
            device_label,
        )
    except ImportError:
        log.warning(
            "torch / transformers not installed; /sam2/click disabled. "
            "Install with: pip install -r requirements.txt"
        )
    except Exception as e:  # pragma: no cover - defensive
        log.exception("failed to load SAM 2: %s", e)

    # Optional: Depth Anything V2 (Step 6 depth-based masking).
    app.state.depth_available = False
    app.state.depth_model_id = None
    try:
        import torch  # type: ignore  # noqa: F401
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation  # type: ignore

        device, device_label = detect_torch_device()
        if device is None:
            raise ImportError("torch not available")

        log.info("loading Depth model %r onto %s ...", DEPTH_MODEL_ID, device_label)
        t2 = time.perf_counter()
        app.state.depth_processor = AutoImageProcessor.from_pretrained(DEPTH_MODEL_ID)
        app.state.depth_model = AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL_ID).to(device)
        app.state.depth_model.eval()
        app.state.depth_device = device
        app.state.depth_model_id = DEPTH_MODEL_ID
        app.state.depth_available = True
        log.info(
            "Depth ready in %.1fs on %s",
            time.perf_counter() - t2,
            device_label,
        )
    except ImportError:
        log.warning(
            "torch / transformers not installed; /depth disabled. "
            "Install with: pip install -r requirements.txt"
        )
    except Exception as e:  # pragma: no cover - defensive
        log.exception("failed to load Depth model: %s", e)

    yield

    SAM2_EMBEDDING_CACHE.clear()
    DEPTH_CACHE.clear()
    log.info("shutting down mask service")


app = FastAPI(
    title="Pixxel Mask Service",
    version="1.1.0",
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


# ─── Hardening middleware ────────────────────────────────────────────────────

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
    in 64 KB chunks via the threadpool so we never block the event loop
    and never buffer the whole body before checking size.
    """
    contents = bytearray()
    while True:
        chunk = await run_in_threadpool(image.file.read, 64 * 1024)
        if not chunk:
            break
        contents.extend(chunk)
        if len(contents) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                413,
                f"file too large (> {MAX_UPLOAD_MB}MB)",
            )
    return bytes(contents)


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "model": app.state.model_name,
        "providers": app.state.providers,
        "max_upload_mb": MAX_UPLOAD_MB,
        "sam2_available": app.state.sam2_available,
        "sam2_model": app.state.sam2_model_id,
        "depth_available": app.state.depth_available,
        "depth_model": app.state.depth_model_id,
    }


@app.post("/segment")
async def segment(image: UploadFile = File(..., alias="image")) -> Response:
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(415, f"unsupported content-type: {image.content_type}")

    contents = await _read_limited(image)
    if not contents:
        raise HTTPException(400, "empty upload")

    t0 = time.perf_counter()
    try:
        img = Image.open(io.BytesIO(contents))
        img.load()
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as e:
        # PIL throws UnidentifiedImageError for "not an image at all" and
        # OSError (Truncated File Read, decode error) for "image header
        # was valid but body is corrupt". SyntaxError covers malformed
        # PNG chunks. All four are user-input problems, not server
        # bugs — return 400, not 500.
        raise HTTPException(400, f"could not decode image: {e}")

    if img.mode not in ("RGB", "RGBA", "L"):
        img = img.convert("RGB")

    try:
        out = remove(img, session=app.state.session, only_mask=False)
    except Exception as e:
        log.exception("rembg.remove failed")
        raise HTTPException(500, f"segmentation failed: {e}")

    if out.mode != "RGBA":
        out = out.convert("RGBA")

    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    elapsed = time.perf_counter() - t0
    log.info(
        "segmented %s (%dx%d, %dKB) in %.2fs -> %dKB",
        image.filename or "<unnamed>",
        img.width,
        img.height,
        len(contents) // 1024,
        elapsed,
        buf.tell() // 1024,
    )

    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Model": app.state.model_name,
            "X-Elapsed-Ms": str(int(elapsed * 1000)),
        },
    )


@app.post("/sam2/click")
async def sam2_click(
    image: UploadFile = File(..., alias="image"),
    clicks: str = Form(...),
) -> Response:
    """Click-to-select semantic masking with SAM 2.

    Form fields:
        image:  image file
        clicks: JSON array of `[x, y, label]` tuples, where `label` is
                1 (positive / include this point) or 0 (negative / exclude).

    Returns a greyscale PNG mask: white = include, black = exclude.
    """
    if not app.state.sam2_available:
        raise HTTPException(
            501,
            "SAM 2 not available on this server. "
            "Install torch + transformers and restart, "
            "or set SAM2_MODEL_ID to a model in your HF cache.",
        )

    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(415, f"unsupported content-type: {image.content_type}")

    contents = await _read_limited(image)
    if not contents:
        raise HTTPException(400, "empty upload")

    try:
        img = Image.open(io.BytesIO(contents))
        img.load()
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as e:
        raise HTTPException(400, f"could not decode image: {e}")

    if img.mode != "RGB":
        img = img.convert("RGB")

    try:
        clicks_data = json.loads(clicks)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"invalid clicks JSON: {e}")

    if not isinstance(clicks_data, list) or not clicks_data:
        raise HTTPException(400, "clicks must be a non-empty array of [x, y, label] tuples")

    if len(clicks_data) > SAM2_MAX_CLICKS:
        raise HTTPException(
            400,
            f"too many clicks: {len(clicks_data)} > {SAM2_MAX_CLICKS}",
        )

    for i, c in enumerate(clicks_data):
        if not (isinstance(c, list) and len(c) == 3):
            raise HTTPException(400, f"click #{i} must be [x, y, label]; got {c!r}")
        x, y, label = c
        # `bool` is a subclass of `int` in Python, so it must be excluded
        # explicitly (otherwise `True in (0, 1)` is `True`).
        if not isinstance(x, (int, float)) or isinstance(x, bool) or not math.isfinite(x):
            raise HTTPException(400, f"click #{i} x must be a finite number; got {x!r}")
        if not isinstance(y, (int, float)) or isinstance(y, bool) or not math.isfinite(y):
            raise HTTPException(400, f"click #{i} y must be a finite number; got {y!r}")
        if not (isinstance(label, int) and not isinstance(label, bool) and label in (0, 1)):
            raise HTTPException(400, f"click #{i} label must be 0 or 1; got {label!r}")
        if not (0 <= x < img.width and 0 <= y < img.height):
            raise HTTPException(
                400,
                f"click #{i} ({x}, {y}) is outside image bounds ({img.width}x{img.height})",
            )

    import torch  # type: ignore
    # SAM 2 input_points format: [image, object, point, [x, y]] = 4 levels.
    points = [[[[c[0], c[1]] for c in clicks_data]]]
    # SAM 2 input_labels format: [image, object, point_label] = 3 levels.
    labels = [[[c[2] for c in clicks_data]]]

    t0 = time.perf_counter()
    try:
        embeddings, original_sizes = _sam2_encode(app, img)
        processor = app.state.sam2_processor
        model = app.state.sam2_model
        device = app.state.sam2_device

        inputs = processor(
            images=img,
            input_points=points,
            input_labels=labels,
            return_tensors="pt",
        ).to(device)
        inputs["image_embeddings"] = embeddings
        inputs.pop("pixel_values", None)

        with torch.inference_mode():
            outputs = model(**inputs)

        masks = processor.image_processor.post_process_masks(
            outputs.pred_masks.cpu(),
            original_sizes.cpu(),
        )
        scores = outputs.iou_scores.cpu().numpy()[0].reshape(-1)
        best_idx = int(scores.argmax())
        best_mask = masks[0][0][best_idx].cpu().numpy().astype(np.uint8) * 255
    except Exception as e:
        log.exception("sam2.click failed")
        raise HTTPException(500, f"sam2 inference failed: {e}")

    elapsed = time.perf_counter() - t0
    log.info(
        "SAM 2 click (%d points) on %dx%d in %.2fs (score=%.3f)",
        len(clicks_data), img.width, img.height, elapsed, float(scores[best_idx]),
    )

    mask_img = Image.fromarray(best_mask, mode="L")
    buf = io.BytesIO()
    mask_img.save(buf, format="PNG", optimize=True)

    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Model": app.state.sam2_model_id or "sam2",
            "X-Score": f"{float(scores[best_idx]):.4f}",
            "X-Elapsed-Ms": str(int(elapsed * 1000)),
        },
    )


@app.post("/depth")
async def depth(image: UploadFile = File(..., alias="image")) -> Response:
    """Monocular depth estimation with Depth Anything V2.

    Form fields:
        image:  image file (JPEG/PNG/WebP)

    Returns a greyscale PNG depth map at the input image's resolution.
    White (255) = nearest to the camera, black (0) = farthest. Per-image
    min-max normalisation is applied so the user can pick a meaningful
    near/far range on the resulting 0..1 slider.

    The map is cached by image-content hash (LRU, max `DEPTH_CACHE_MAX`
    entries); repeats against the same image return the cached result
    in milliseconds.
    """
    if not app.state.depth_available:
        raise HTTPException(
            501,
            "Depth Anything V2 not available on this server. "
            "Install torch + transformers and restart, "
            "or set DEPTH_MODEL_ID to a model in your HF cache.",
        )

    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(415, f"unsupported content-type: {image.content_type}")

    contents = await _read_limited(image)
    if not contents:
        raise HTTPException(400, "empty upload")

    try:
        img = Image.open(io.BytesIO(contents))
        img.load()
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as e:
        raise HTTPException(400, f"could not decode image: {e}")

    if img.mode != "RGB":
        img = img.convert("RGB")

    # Reject inputs whose longest side exceeds DEPTH_MAX_SIDE. The model
    # runs internally at ~518×518, and the route (or this handler)
    # resizes the depth map back to the input's dimensions — a 12K
    # image would trigger a 144M-op Lanczos resize and a 144 MB array.
    # The Node route applies the same cap; this is defense-in-depth.
    if max(img.width, img.height) > DEPTH_MAX_SIDE:
        raise HTTPException(
            413,
            f"image too large ({img.width}x{img.height}); "
            f"max longest side is {DEPTH_MAX_SIDE}px",
        )

    t0 = time.perf_counter()
    try:
        depth_arr = _depth_predict(app, img)
    except Exception as e:
        log.exception("depth predict failed")
        raise HTTPException(500, f"depth inference failed: {e}")
    elapsed = time.perf_counter() - t0

    # Depth Anything V2 runs at a fixed internal resolution (~518×518) and
    # returns the depth map at that size. We resize to the input image's
    # resolution so the user can drop it straight onto the original
    # canvas at 1:1. Lanczos is the right kernel for greyscale maps:
    # smooth in flat areas, preserves sharp depth edges better than
    # nearest-neighbour and avoids the blocky artefacts from bilinear.
    if depth_arr.shape != (img.height, img.width):
        depth_native = Image.fromarray(depth_arr, mode="L")
        depth_resized = depth_native.resize(
            (img.width, img.height), resample=Image.LANCZOS
        )
        depth_arr = np.array(depth_resized, dtype=np.uint8)

    log.info(
        "Depth %s on %dx%d in %.2fs",
        app.state.depth_model_id, img.width, img.height, elapsed,
    )

    depth_img = Image.fromarray(depth_arr, mode="L")
    buf = io.BytesIO()
    depth_img.save(buf, format="PNG", optimize=True)

    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Model": app.state.depth_model_id or "depth",
            "X-Width": str(img.width),
            "X-Height": str(img.height),
            "X-Elapsed-Ms": str(int(elapsed * 1000)),
        },
    )


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=PORT,
        reload=False,
        log_level="info",
    )
