"""Phosmith depth + selection service.

Monocular depth (Depth Anything V2) for the editor's Depth Range layer and
depth of field, and SlimSAM (`/sam/*`) for devices too weak to run selection in
the browser. Selection normally runs on device on the same SlimSAM (an ONNX
export of these weights); the editor's "Selection engine" card picks the side.
Deploys to its own Hugging Face Space, separate from the erase/inpaint service
in `services/segment` (or merged with it by `services/space`).

No GPU required; auto-uses CUDA (NVIDIA) or MPS (Apple Silicon) when present.
"""

from __future__ import annotations

import base64
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
from pydantic import BaseModel, Field
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
# SlimSAM-77: the same distilled SAM the browser runs, as PyTorch weights.
SAM_MODEL_ID = os.getenv("SAM_MODEL_ID", "nielsr/slimsam-77-uniform").strip()
# One 256x64x64 float32 embedding is 4 MB.
SAM_CACHE_MAX = int(os.getenv("SAM_CACHE_MAX", "16").strip())
# The browser sends its own model input (long side <= 1024), not the photo.
SAM_MAX_SIDE = 1024
SAM_MAX_PROMPTS = 64
SAM_MAX_POINTS = 16
# Full-size masks cost 12 MB of float per prompt while post-processing.
SAM_MAX_FULL_PROMPTS = 16
# CPU by default: on an M2, MPS encoded at 1.5 s against CPU's 0.8 s and stalled
# ~5 s on every new prompt count while it compiled. The Space has no GPU.
SAM_DEVICE = os.getenv("SAM_DEVICE", "cpu").strip()
PORT = int(os.getenv("PORT", "8002").strip())
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "24").strip())
SEGMENT_EAGER_MODELS = os.getenv("SEGMENT_EAGER_MODELS", "0").strip() not in ("0", "false", "False", "")

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
    if o.strip()
]

_DEPTH_LOCK = threading.Lock()
_SAM_LOCK = threading.Lock()


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


# ─── SlimSAM ─────────────────────────────────────────────────────────────────

SAM_CACHE: "OrderedDict[str, dict]" = OrderedDict()


def _load_sam(app: FastAPI) -> bool:
    """Load SlimSAM into app.state (blocking; caller holds _SAM_LOCK)."""
    try:
        import torch  # type: ignore
        from transformers import SamModel, SamProcessor  # type: ignore

        device, device_label = detect_torch_device()
        if device is None:
            raise ImportError("torch not available")
        if SAM_DEVICE != "auto":
            device, device_label = torch.device(SAM_DEVICE), SAM_DEVICE
        log.info("loading SlimSAM %r onto %s ...", SAM_MODEL_ID, device_label)
        t0 = time.perf_counter()
        app.state.sam_processor = SamProcessor.from_pretrained(SAM_MODEL_ID)
        app.state.sam_model = SamModel.from_pretrained(SAM_MODEL_ID).to(device).eval()
        app.state.sam_device = device
        app.state.sam_available = True
        log.info("SlimSAM ready in %.1fs on %s", time.perf_counter() - t0, device_label)
        return True
    except ImportError:
        log.warning("torch / transformers not installed; /sam disabled.")
        app.state.sam_load_failed = True
        return False
    except Exception as e:  # pragma: no cover - defensive
        log.exception("failed to load SlimSAM: %s", e)
        app.state.sam_load_failed = True
        return False


def _ensure_sam(app: FastAPI):
    """Lazily load SlimSAM; True/'cold' when ready, False when it cannot load."""
    if app.state.sam_available:
        return True
    if getattr(app.state, "sam_load_failed", False):
        return False
    with _SAM_LOCK:
        if app.state.sam_available:
            return True
        if getattr(app.state, "sam_load_failed", False):
            return False
        return "cold" if _load_sam(app) else False


def _sam_embed(app: FastAPI, img: Image.Image) -> tuple[str, bool]:
    """Image embedding, cached by pixel hash. Returns (key, was_cached)."""
    key = hashlib.sha256(f"{img.width}x{img.height}".encode() + img.tobytes()).hexdigest()[:24]
    if key in SAM_CACHE:
        SAM_CACHE.move_to_end(key)
        return key, True
    import torch  # type: ignore
    with _SAM_LOCK:
        inputs = app.state.sam_processor(images=img, return_tensors="pt")
        with torch.inference_mode():
            emb = app.state.sam_model.get_image_embeddings(inputs["pixel_values"].to(app.state.sam_device))
    SAM_CACHE[key] = {
        "emb": emb,
        "original": [int(v) for v in inputs["original_sizes"][0]],
        "reshaped": [int(v) for v in inputs["reshaped_input_sizes"][0]],
    }
    while len(SAM_CACHE) > SAM_CACHE_MAX:
        SAM_CACHE.popitem(last=False)
    return key, False


class SamPrompt(BaseModel):
    points: list[list[float]] = Field(default_factory=list)
    labels: list[int] = Field(default_factory=list)
    box: list[float] | None = None


class SamDecodeRequest(BaseModel):
    key: str
    prompts: list[SamPrompt]
    # "masks": all three candidates per prompt at the embedded image's size.
    # "low": only the best-scored candidate, on the decoder's 256 grid.
    output: str = "masks"


def _validate_prompts(prompts: list[SamPrompt], width: int, height: int) -> None:
    if not 1 <= len(prompts) <= SAM_MAX_PROMPTS:
        raise HTTPException(400, f"1..{SAM_MAX_PROMPTS} prompts")
    lim = 4 * max(width, height)  # generous: off-frame points are legal, absurd ones are not
    for p in prompts:
        if len(p.points) > SAM_MAX_POINTS or len(p.points) != len(p.labels):
            raise HTTPException(400, f"each prompt needs matching points/labels (max {SAM_MAX_POINTS})")
        if not p.points and p.box is None:
            raise HTTPException(400, "a prompt needs points or a box")
        coords = [c for pt in p.points for c in pt] + (p.box or [])
        if any(len(pt) != 2 for pt in p.points) or (p.box is not None and len(p.box) != 4):
            raise HTTPException(400, "points are [x, y]; a box is [x0, y0, x1, y1]")
        if any(not np.isfinite(c) or abs(c) > lim for c in coords):
            raise HTTPException(400, "prompt coordinates out of range")
        if any(label not in (0, 1) for label in p.labels):
            raise HTTPException(400, "labels are 0 or 1")


def _png_b64(arr: np.ndarray, mode: str) -> str:
    buf = io.BytesIO()
    # Level 1: optimize=True spent 243 of a 270 ms click on three real masks.
    Image.fromarray(arr, mode=mode).save(buf, format="PNG", compress_level=1)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _sam_decode(app: FastAPI, entry: dict, prompts: list[SamPrompt], output: str) -> dict:
    import torch  # type: ignore

    oh, ow = entry["original"]
    rh, rw = entry["reshaped"]
    sx, sy = rw / ow, rh / oh  # embedded image px → the model's 1024 frame
    device = app.state.sam_device

    # Prompts batch only with others of the same shape (point count, box or not).
    groups: "OrderedDict[tuple, list[int]]" = OrderedDict()
    for i, p in enumerate(prompts):
        groups.setdefault((len(p.points), p.box is not None), []).append(i)

    scores = [None] * len(prompts)
    full = [None] * len(prompts)
    low = [None] * len(prompts)
    for (n_points, has_box), idx in groups.items():
        kw = {}
        if n_points:
            kw["input_points"] = torch.tensor(
                [[[[x * sx, y * sy] for x, y in prompts[i].points] for i in idx]], dtype=torch.float, device=device)
            kw["input_labels"] = torch.tensor([[prompts[i].labels for i in idx]], dtype=torch.long, device=device)
        if has_box:
            kw["input_boxes"] = torch.tensor(
                [[[b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy] for b in (prompts[i].box for i in idx)]],
                dtype=torch.float, device=device)
        with _SAM_LOCK, torch.inference_mode():
            out = app.state.sam_model(image_embeddings=entry["emb"], multimask_output=True, **kw)
        iou = out.iou_scores[0].float().cpu().numpy()  # (P, 3)
        pm = out.pred_masks[0].cpu()                    # (P, 3, 256, 256) logits
        for j, i in enumerate(idx):
            scores[i] = [round(float(v), 4) for v in iou[j]]
        if output == "low":
            grid = pm.shape[-1]
            vw = max(1, min(grid, round(grid * rw / max(rh, rw))))
            vh = max(1, min(grid, round(grid * rh / max(rh, rw))))
            for j, i in enumerate(idx):
                best = int(np.argmax(iou[j]))
                low[i] = (best, (pm[j, best, :vh, :vw].numpy() > 0))
        else:
            masks = app.state.sam_processor.image_processor.post_process_masks(
                pm.unsqueeze(0), torch.tensor([[oh, ow]]), torch.tensor([[rh, rw]]))[0].numpy()  # (P, 3, oh, ow) bool
            for j, i in enumerate(idx):
                full[i] = np.ascontiguousarray(np.moveaxis(masks[j], 0, -1)).astype(np.uint8) * 255

    if output == "low":
        vh, vw = low[0][1].shape
        atlas = np.concatenate([m for _, m in low], axis=0).astype(np.uint8) * 255
        return {
            "width": ow, "height": oh,
            "results": [{"scores": scores[i], "best": low[i][0]} for i in range(len(prompts))],
            "low": {"png": _png_b64(atlas, "L"), "vw": vw, "vh": vh, "grid": 256},
        }
    # One RGB PNG per prompt: channel k is candidate k.
    return {
        "width": ow, "height": oh,
        "results": [{"scores": scores[i], "png": _png_b64(full[i], "RGB")} for i in range(len(prompts))],
    }


# ─── App ─────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.depth_available = False
    app.state.depth_load_failed = False
    app.state.depth_model_id = DEPTH_MODEL_ID
    app.state.sam_available = False
    app.state.sam_load_failed = False
    if SEGMENT_EAGER_MODELS:
        await run_in_threadpool(_ensure_depth, app)
        await run_in_threadpool(_ensure_sam, app)
    else:
        log.info("Depth and SlimSAM load lazily on first use (SEGMENT_EAGER_MODELS=1 to preload).")
    yield
    DEPTH_CACHE.clear()
    SAM_CACHE.clear()
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
    return {"status": "ok", "message": "Phosmith Masking Service is running (depth, SlimSAM)"}


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
        "sam_available": app.state.sam_available
        or (_torch_stack_loadable() and not app.state.sam_load_failed),
        "sam_loaded": app.state.sam_available,
        "sam_model": SAM_MODEL_ID,
        "models": {"depth": app.state.depth_available, "sam": app.state.sam_available},
    }


@app.post("/warmup")
async def warmup() -> dict:
    """Pre-load Depth and SlimSAM so the first real request is fast."""
    results = {}
    for name, ensure, flag in (("depth", _ensure_depth, "depth_available"), ("sam", _ensure_sam, "sam_available")):
        was = getattr(app.state, flag)
        status = await run_in_threadpool(ensure, app)
        results[name] = "already_loaded" if was else "loaded" if status else "failed"
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


@app.post("/sam/embed")
async def sam_embed(image: UploadFile = File(..., alias="image")) -> dict:
    """Encode an image once (the slow ViT pass); prompts then name it by `key`.
    The browser sends SlimSAM's input (long side <= 1024), not the photo."""
    status = await run_in_threadpool(_ensure_sam, app)
    if not status:
        raise HTTPException(501, "SlimSAM not available. Install torch + transformers and restart.")
    _require_image_ct(image)
    img = _decode_image(await _read_limited(image), max_side=SAM_MAX_SIDE, rgb_only=True)
    t0 = time.perf_counter()
    try:
        key, cached = await run_in_threadpool(_sam_embed, app, img)
    except Exception as e:
        log.exception("SlimSAM embed failed")
        raise HTTPException(500, f"SlimSAM embed failed: {e}")
    elapsed = int((time.perf_counter() - t0) * 1000)
    log.info("SlimSAM embed %dx%d in %dms%s", img.width, img.height, elapsed, " (cached)" if cached else "")
    return {"key": key, "width": img.width, "height": img.height, "elapsed_ms": elapsed,
            "cached": cached, "cold": status == "cold", "model": SAM_MODEL_ID}


@app.post("/sam/decode")
async def sam_decode(req: SamDecodeRequest) -> dict:
    """Masks for prompts on an embedded image. 404 when the key was evicted or
    the service restarted: the caller embeds again and retries."""
    if not app.state.sam_available:
        raise HTTPException(404, "unknown image key")
    entry = SAM_CACHE.get(req.key)
    if entry is None:
        raise HTTPException(404, "unknown image key")
    if req.output not in ("masks", "low"):
        raise HTTPException(400, 'output is "masks" or "low"')
    oh, ow = entry["original"]
    _validate_prompts(req.prompts, ow, oh)
    if req.output == "masks" and len(req.prompts) > SAM_MAX_FULL_PROMPTS:
        raise HTTPException(400, f'at most {SAM_MAX_FULL_PROMPTS} prompts with output "masks"')
    SAM_CACHE.move_to_end(req.key)
    t0 = time.perf_counter()
    try:
        out = await run_in_threadpool(_sam_decode, app, entry, req.prompts, req.output)
    except Exception as e:
        log.exception("SlimSAM decode failed")
        raise HTTPException(500, f"SlimSAM decode failed: {e}")
    out["elapsed_ms"] = int((time.perf_counter() - t0) * 1000)
    return out


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=False)
