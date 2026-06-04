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
import importlib.util
import io
import json
import logging
import math
import os
import threading
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from typing import List, Optional

import numpy as np

# OpenCV + SciPy power the saliency-matte cleanup (hole-fill, speck removal,
# morphological close, distance transform). Both are hard deps of the listed
# requirements, but degrade gracefully: if either is missing, clean_matte()
# returns the matte untouched rather than crashing the request.
try:
    import cv2  # type: ignore
    from scipy import ndimage  # type: ignore
    _MATTE_CLEANUP = True
except Exception:  # pragma: no cover - optional accel
    cv2 = None  # type: ignore
    ndimage = None  # type: ignore
    _MATTE_CLEANUP = False

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, ImageFilter, UnidentifiedImageError
from rembg import new_session, remove
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

MODEL_NAME = os.getenv("SEGMENT_MODEL", "birefnet-general").strip()
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
# Reject /segment inputs whose longest side exceeds this (defense-in-depth vs
# direct curls that bypass the Node route's MAX_MODEL_SIDE cap). BiRefNet runs
# at a fixed 1024² internally, so a 12K image only wastes resize/YOLO work.
# Mirrors the /depth handler's DEPTH_MAX_SIDE.
SEGMENT_MAX_SIDE = int(os.getenv("SEGMENT_MAX_SIDE", "2048").strip())

# By default, SAM 2 and Depth Anything (the heavy torch models behind the
# /sam2 and /depth endpoints) are loaded LAZILY — on first use of their
# endpoint — instead of at startup. This keeps the resident footprint small
# (~500-800 MB: just rembg + YOLO + onnxruntime) so the service fits a small
# free-tier host; the core "Select Subject" (/segment) path never needs them.
# Set SEGMENT_EAGER_MODELS=1 to preload everything at startup (lowest
# first-request latency, ~1.5-2.5 GB resident).
SEGMENT_EAGER_MODELS = os.getenv("SEGMENT_EAGER_MODELS", "0").strip() not in ("0", "false", "False", "")

# ─── Semantic subject detection (/segment "Select Subject") ──────────────────
# YOLO11n-seg (ultralytics) gives tiny (~6 MB) person/animal INSTANCE masks so
# "Select Subject" can semantically isolate the photo's subject(s) —
# differentiating people/animals from background objects, and covering every
# subject in a group photo — then the BiRefNet saliency matte refines the
# union for clean hair/fur edges. Falls back to pure saliency when YOLO is
# unavailable or finds no subject (e.g. a product/object photo).
#
# NOTE: ultralytics is AGPL-3.0. Acceptable here because the project is being
# open-sourced; swap SUBJECT_MODEL / set SUBJECT_DETECT=0 to disable.
# YOLO26n-seg (Jan 2026) is the default: ~6 MB / 2.7M params, NMS-free
# (native end-to-end head), and up to ~43% faster CPU ONNX inference than
# YOLO11n — ideal for free-tier CPU hosts. Because it's NMS-free, the IOU /
# AGNOSTIC_NMS / MAX_DET knobs below are no-ops for it (they still apply if you
# switch SUBJECT_MODEL back to a yolo11*-seg model). Needs ultralytics >= 8.4.
SUBJECT_MODEL = os.getenv("SUBJECT_MODEL", "yolo26n-seg.pt").strip()
SUBJECT_DETECT = os.getenv("SUBJECT_DETECT", "1").strip() not in ("0", "false", "False", "")
# conf=0.20 admits faint/occluded subjects in group photos. We UNION every
# instance and then gate it against the BiRefNet saliency matte, so a low conf
# floods nothing — spurious low-conf boxes that aren't salient are dropped.
SUBJECT_CONF = float(os.getenv("SUBJECT_CONF", "0.20").strip())
# imgsz is the single biggest recall lever for small/distant people in group
# photos (ultralytics letterboxes the input to this size before inference, so
# more pixels land on each far-away face). 1280 costs ~120ms extra on CPU.
SUBJECT_IMGSZ = int(os.getenv("SUBJECT_IMGSZ", "1280").strip())
# NMS IoU. Keep HIGH (0.7) so legitimately-overlapping people in a crowd are
# NOT merged/suppressed into one box. Lowering this loses subjects.
SUBJECT_IOU = float(os.getenv("SUBJECT_IOU", "0.7").strip())
# Cap on detected instances (large group photos can have many people).
SUBJECT_MAX_DET = int(os.getenv("SUBJECT_MAX_DET", "300").strip())
# Class-aware NMS (False) so a person overlapping a dog/horse isn't suppressed.
SUBJECT_AGNOSTIC_NMS = os.getenv("SUBJECT_AGNOSTIC_NMS", "0").strip() not in ("0", "false", "False", "")
# Refine the YOLO union with the BiRefNet matte for soft edges (2 inferences).
SUBJECT_REFINE = os.getenv("SUBJECT_REFINE", "1").strip() not in ("0", "false", "False", "")
# Extend "subject" beyond person/animal to generic multi-subject photos: include
# ANY detected instance whose own mask is mostly salient (per the BiRefNet matte)
# and large enough. Zero extra inference — pure numpy AND/area math per instance.
SUBJECT_SALIENT_INCLUDE = os.getenv("SUBJECT_SALIENT_INCLUDE", "1").strip() not in ("0", "false", "False", "")
# An instance counts as a subject if >= this fraction of ITS OWN pixels are
# salient (matte>127). The denominator is the instance area (not the image), so
# a big background object that merely clips the foreground fails the test.
SUBJECT_SALIENT_OVERLAP = float(os.getenv("SUBJECT_SALIENT_OVERLAP", "0.60").strip())
# ... and its mask must cover at least this fraction of the frame (drops noise).
SUBJECT_SALIENT_AREA_FRAC = float(os.getenv("SUBJECT_SALIENT_AREA_FRAC", "0.005").strip())
# An instance whose mask covers MORE than this fraction of the frame is treated
# as scene/background (a couch/wall the subject sits in front of), not a
# subject, so the salient-include rule won't union it in.
SUBJECT_SALIENT_AREA_MAX_FRAC = float(os.getenv("SUBJECT_SALIENT_AREA_MAX_FRAC", "0.55").strip())

# ─── Matte-cleanup tuning ────────────────────────────────────────────────────
# Only fill interior holes SMALLER than this fraction of the subject's area —
# those are model drop-outs (a leaf's dropped veins/center). Larger holes are
# GENUINE see-through gaps (a donut/ring, eyeglass lens, the gap between an arm
# and the torso) and must stay transparent.
MATTE_HOLE_FILL_MAX_FRAC = float(os.getenv("MATTE_HOLE_FILL_MAX_FRAC", "0.02").strip())
# Recover (solidify) only DEEP-interior pixels whose alpha is at or below this —
# i.e. regions the model essentially dropped. Genuinely semi-transparent pixels
# above it (frosted glass, smoke, a soft hair gradient) are LEFT soft.
MATTE_FAINT_RECOVER_MAX = int(os.getenv("MATTE_FAINT_RECOVER_MAX", "96").strip())
# ...and only when the subject has a confidently-solid CORE at least this big a
# fraction of its area. A subject that is mostly faint IS translucent — recover
# nothing, keep its alpha as-is.
MATTE_FAINT_MIN_SOLID_FRAC = float(os.getenv("MATTE_FAINT_MIN_SOLID_FRAC", "0.50").strip())
# COCO subject class ids: person(0) + animals(14..23: bird,cat,dog,horse,
# sheep,cow,elephant,bear,zebra,giraffe). Always included regardless of the
# salient-instance gates above. Override with a CSV to broaden.
_DEFAULT_SUBJECT_CLASSES = "0,14,15,16,17,18,19,20,21,22,23"
SUBJECT_CLASSES = {
    int(x) for x in os.getenv("SUBJECT_CLASSES", _DEFAULT_SUBJECT_CLASSES).split(",")
    if x.strip().lstrip("-").isdigit()
}
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

# CoreML reliably JITs the small/lite BiRefNet graphs, but compiling the heavy
# Swin-Large exports (birefnet-general / -massive) can take many minutes on
# first run and has been observed to deadlock the Apple ANE service at session
# init. For those models we skip CoreML and run on CPU (~30 s/inference,
# rock-solid) unless the user opts back in. CUDA is unaffected — it's preferred
# over CoreML and is the fast path for the heavy models in production.
_COREML_UNSTABLE_MODELS = {"birefnet-general", "birefnet-massive"}
SEGMENT_ALLOW_COREML_HEAVY = os.getenv("SEGMENT_ALLOW_COREML_HEAVY", "0").strip() not in ("0", "false", "False", "")


def detect_providers() -> List[str]:
    """Pick the best ONNX Runtime execution providers for this machine.

    Order of preference: CUDA (NVIDIA) > CoreML (Apple Silicon) > CPU. CoreML is
    skipped for the heavy Swin-Large models (see `_COREML_UNSTABLE_MODELS`)
    unless `SEGMENT_ALLOW_COREML_HEAVY=1`.
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
            if MODEL_NAME in _COREML_UNSTABLE_MODELS and not SEGMENT_ALLOW_COREML_HEAVY:
                log.info(
                    "CoreML available but skipped for heavy model %r (slow/unstable "
                    "Swin-Large compile); using CPU. Set SEGMENT_ALLOW_COREML_HEAVY=1 "
                    "to force CoreML, or SEGMENT_PROVIDERS to override.",
                    MODEL_NAME,
                )
            else:
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


# ─── Saliency-matte cleanup ──────────────────────────────────────────────────

def clean_matte(matte_u8: np.ndarray, rgb: "np.ndarray | None" = None) -> np.ndarray:
    """Clean a saliency matte into a complete, solid subject mask while
    preserving soft edges.

    This is the fix for under-segmented subjects (e.g. a backlit fig leaf whose
    translucent lobes/veins the model drops, leaving Swiss-cheese holes and
    floating specks). Strategy:

      1. LOW threshold (alpha>24) -> binary capturing faint/semi-opaque regions.
      2. binary_fill_holes -> fill interior translucent holes (veins/center).
      3. small morphological CLOSE -> bridge tiny gaps without swallowing real
         concavities (leaf lobes must stay separated).
      4. connected-component speck removal by ABSOLUTE+RELATIVE area floor —
         keeps legitimately-detached real fragments, drops detection noise.
         (NOT largest-only: a leaf can have separated tip pieces.)
      5. gate the ORIGINAL soft matte by the dilated cleaned binary (WHERE),
         then solidify ONLY genuine interior holes (geometry-exact, from
         fill_holes) and faint DEEP-interior pixels (distance-transform gated)
         to 255 — so anti-aliased edges survive verbatim; the binary decides
         WHERE, the soft matte decides the edge profile.

    HxW uint8 in -> HxW uint8 out. ~240 ms at 2048² on a single CPU core.
    Returns the input untouched if OpenCV/SciPy are unavailable.
    """
    if not _MATTE_CLEANUP:
        return matte_u8
    if matte_u8.ndim != 2:
        matte_u8 = matte_u8[..., 0]
    h, w = matte_u8.shape
    matte = matte_u8  # keep original soft matte untouched

    # Kernel size scales with the image so behaviour is resolution-independent.
    # ~0.35% of the smaller side, clamped to [3, 9] and forced odd. At 1024 ->
    # 5px: bridges 1-2px sampling gaps but is far smaller than a leaf-lobe gap
    # (tens of px), so genuine concavities between lobes survive.
    k = int(round(min(h, w) * 0.0035))
    k = max(3, min(9, k))
    if k % 2 == 0:
        k += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))

    # 1. LOW threshold so faint/semi-opaque halo regions are captured.
    binary = (matte > 24).astype(np.uint8)
    if not binary.any():
        return matte  # nothing salient — leave as-is (empty stays empty)

    # 2. Bridge tiny outline gaps (CLOSE = dilate then erode -> no net growth,
    #    so concave gaps wider than the kernel are NOT bridged). Holes stay open.
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)

    # 3. Connected-component speck removal -> the subject CORE (holes still
    #    open). Floor = max(0.05% of image, 64px): the relative term scales with
    #    resolution, the absolute floor keeps the threshold sane on tiny images.
    num, labels, stats, _ = cv2.connectedComponentsWithStats(closed, connectivity=8)
    min_area = max(int(0.0005 * h * w), 64)
    keep = np.zeros(num, dtype=bool)
    keep[0] = False  # background label 0 is never kept
    areas = stats[:, cv2.CC_STAT_AREA]
    keep[1:] = areas[1:] >= min_area
    core = keep[labels].astype(np.uint8)
    if not core.any():
        # Every component fell below the floor (tiny subject). Fall back to the
        # threshold binary so we never return an empty mask for a real subject.
        core = binary

    # 4. The subject's solid extent = core with interior holes filled. This is
    #    the WHERE region (and the basis for distance/depth). The holes it adds
    #    over `core` are the interior holes — but we only FILL the SMALL ones
    #    (model drop-outs); large holes are GENUINE see-through gaps (donut/ring,
    #    eyeglass lens, the gap between an arm and the torso) and stay transparent.
    clean_bin = ndimage.binary_fill_holes(core).astype(np.uint8)
    subject_area = int(clean_bin.sum()) or 1
    holes = ((clean_bin > 0) & (core == 0)).astype(np.uint8)
    small_holes = np.zeros((h, w), dtype=bool)
    if holes.any():
        hn, hlabels, hstats, _ = cv2.connectedComponentsWithStats(holes, connectivity=8)
        max_hole_area = MATTE_HOLE_FILL_MAX_FRAC * subject_area
        small_ids = [i for i in range(1, hn) if hstats[i, cv2.CC_STAT_AREA] <= max_hole_area]
        if small_ids:
            small_holes = np.isin(hlabels, small_ids)

    # 5. Composite. WHERE from clean_bin; EDGE PROFILE from the soft matte. A
    #    genuine large hole keeps matte~0 (gated below) and is never solidified.
    region = cv2.dilate(clean_bin, kernel, iterations=1)
    gated = np.where(region > 0, matte, 0).astype(np.uint8)
    out = gated.copy()
    out[small_holes] = 255  # fill small model drop-outs only

    # Faint recovery: only when the subject is mostly solid (so a translucent
    # subject is left alone), and only for DEEP near-dropped pixels (alpha in
    # (24, FAINT_MAX]) — so genuine mid/low-alpha translucency is preserved and
    # a fully-zero genuine hole (alpha 0, fails matte>24) is never touched.
    solid_frac = float(((matte >= 128) & (clean_bin > 0)).sum()) / subject_area
    if solid_frac >= MATTE_FAINT_MIN_SOLID_FRAC:
        dist = cv2.distanceTransform(clean_bin, cv2.DIST_L2, 3)
        deep = dist > (3.0 * k)  # covers a Gaussian rim up to sigma~k
        faint_core = deep & (matte > 24) & (matte <= MATTE_FAINT_RECOVER_MAX)
        out[faint_core] = 255
    return out


# ─── App lifecycle ───────────────────────────────────────────────────────────

def _subject_union_mask(app, pil_img: "Image.Image", matte: "np.ndarray | None" = None):
    """Detect person/animal INSTANCES with YOLO-seg and return
    `(union_mask uint8 0/255, instance_count)`, or `(None, 0)` if YOLO is
    unavailable or no subject is found.

    The union of every subject instance handles group photos (all subjects in
    one mask). Person/animal classes (`SUBJECT_CLASSES`) are always included.
    When `matte` (the BiRefNet saliency map) is supplied and
    `SUBJECT_SALIENT_INCLUDE` is on, ANY other detected instance whose own mask
    is mostly salient and large enough is ALSO included — so multi-subject
    photos that aren't people (products, multiple objects) keep every subject —
    while prominent background objects (sky/walls/furniture) score ~0 saliency
    and are excluded.

    Detection recall on small/distant/occluded subjects is driven by
    `SUBJECT_IMGSZ` (letterbox size), `SUBJECT_CONF`, and `SUBJECT_IOU` (kept
    high so overlapping people in a crowd aren't merged). `classes=` filters
    inside NMS rather than post-hoc, so the `max_det` budget isn't spent on
    background classes when only person/animal subjects are wanted.

    Takes the PIL (RGB) image — NOT a raw numpy array — because ultralytics
    treats bare ndarrays as BGR (cv2 convention) and would swap R/B channels,
    degrading detection. PIL input goes through ultralytics' correct RGB path.
    """
    model = getattr(app.state, "yolo", None)
    if model is None:
        return None, 0
    w, h = pil_img.size  # PIL size is (width, height)

    # When salient-instance inclusion is on we must SEE every class (so a
    # non-person subject can be tested against the matte), so we don't pass
    # `classes=` to NMS; the per-instance gate below does the filtering. When
    # it's off, filter inside NMS to save the max_det budget.
    use_salient = SUBJECT_SALIENT_INCLUDE and matte is not None
    predict_kwargs = dict(
        verbose=False,
        imgsz=SUBJECT_IMGSZ,
        conf=SUBJECT_CONF,
        iou=SUBJECT_IOU,
        max_det=SUBJECT_MAX_DET,
        agnostic_nms=SUBJECT_AGNOSTIC_NMS,
        retina_masks=True,  # full-resolution instance masks
    )
    if not use_salient:
        predict_kwargs["classes"] = sorted(SUBJECT_CLASSES) or None
    try:
        results = model.predict(pil_img, **predict_kwargs)
    except Exception:
        log.exception("YOLO predict failed")
        return None, 0
    if not results:
        return None, 0
    r = results[0]
    if getattr(r, "masks", None) is None or getattr(r, "boxes", None) is None:
        return None, 0
    try:
        cls = r.boxes.cls.cpu().numpy().astype(int)
        masks = r.masks.data.cpu().numpy()  # (N, mh, mw) in 0..1
    except Exception:
        log.exception("YOLO mask extraction failed")
        return None, 0

    # Resolve every instance mask to a full-res boolean once.
    instances = []  # (class_id, bool_mask, area)
    for i, c in enumerate(cls):
        m = masks[i]
        if m.shape != (h, w):
            # Resize via PIL (avoids a hard cv2 dependency).
            m_img = Image.fromarray((np.clip(m, 0.0, 1.0) * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)
            m = np.asarray(m_img, dtype=np.float32) / 255.0
        mb = m > 0.5
        instances.append((int(c), mb, int(mb.sum())))

    union = np.zeros((h, w), dtype=np.uint8)
    count = 0

    # Pass 1: person/animal subjects are ALWAYS included. Track the largest so
    # the salient pass can tell props from scenery.
    max_subj_area = 0
    for c, mb, area in instances:
        if c in SUBJECT_CLASSES:
            union[mb] = 255
            count += 1
            max_subj_area = max(max_subj_area, area)

    # Pass 2: generic salient instances (multi-object photos). A salient object
    # whose OWN pixels are mostly salient counts as a subject — UNLESS the scene
    # is person-centric and the object is bigger than the largest person, in
    # which case it's scene/background (a bus, couch, or wall behind the people)
    # and is excluded. With no person/animal present, allow up to the frame cap.
    salient = (matte > 127) if (use_salient and matte is not None) else None
    if salient is not None:
        frame_area = float(w * h)
        min_inst_area = SUBJECT_SALIENT_AREA_FRAC * frame_area
        max_inst_area = SUBJECT_SALIENT_AREA_MAX_FRAC * frame_area
        salient_cap = max_inst_area if max_subj_area == 0 else min(max_inst_area, 1.5 * max_subj_area)
        for c, mb, area in instances:
            if c in SUBJECT_CLASSES:
                continue
            if not (min_inst_area <= area <= salient_cap):
                continue
            overlap = float((mb & salient).sum()) / float(area or 1)
            if overlap >= SUBJECT_SALIENT_OVERLAP:
                union[mb] = 255
                count += 1

    if count == 0:
        return None, 0
    return union, count


def _compose_subject_alpha(matte: np.ndarray, subject: np.ndarray) -> np.ndarray:
    """Combine the semantic subject union with the saliency matte into a final
    alpha: clean matte edges where the subject is salient, full coverage for
    non-salient subjects, and nothing outside the subject region (so prominent
    non-subject objects are excluded).
    """
    subj_img = Image.fromarray(subject, "L")
    # Dilate the subject a little so the matte can supply soft edges just
    # outside the YOLO boundary (hair/fur). MaxFilter kernel must be odd.
    dil = np.asarray(subj_img.filter(ImageFilter.MaxFilter(15)))
    if SUBJECT_REFINE and matte is not None:
        combined = np.where(dil > 0, np.maximum(matte, subject), 0).astype(np.uint8)
    else:
        combined = subject
    # Feather the result for anti-aliased edges.
    combined = np.asarray(Image.fromarray(combined, "L").filter(ImageFilter.GaussianBlur(1.2)), dtype=np.uint8)
    return combined


# ─── Lazy model loaders (SAM 2 / Depth) ──────────────────────────────────────
# These hold the heavy torch models. By default they load on first use so the
# resident footprint stays small. Loads are serialised per-model with a lock so
# two concurrent first-requests don't both load. A permanent failure (e.g. torch
# not installed) is remembered so we don't retry the heavy load on every request.

_SAM2_LOCK = threading.Lock()
_DEPTH_LOCK = threading.Lock()


def _torch_stack_loadable() -> bool:
    """Cheap capability probe: are torch + transformers importable WITHOUT
    actually importing them (the import is the heavy ~200 MB+ cost)?"""
    try:
        return bool(
            importlib.util.find_spec("torch") and importlib.util.find_spec("transformers")
        )
    except Exception:  # pragma: no cover - find_spec on a broken install
        return False


def _load_sam2(app: FastAPI) -> bool:
    """Load SAM 2 into app.state (blocking). Caller holds _SAM2_LOCK."""
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
        log.info("SAM 2 ready in %.1fs on %s", time.perf_counter() - t1, device_label)
        return True
    except ImportError:
        log.warning("torch / transformers not installed; /sam2/click disabled.")
        app.state.sam2_load_failed = True
        return False
    except Exception as e:  # pragma: no cover - defensive
        log.exception("failed to load SAM 2: %s", e)
        app.state.sam2_load_failed = True
        return False


def _ensure_sam2(app: FastAPI) -> bool:
    """Lazily load SAM 2; return True if it's ready to use."""
    if app.state.sam2_available:
        return True
    if getattr(app.state, "sam2_load_failed", False):
        return False
    with _SAM2_LOCK:
        if app.state.sam2_available:
            return True
        if getattr(app.state, "sam2_load_failed", False):
            return False
        return _load_sam2(app)


def _load_depth(app: FastAPI) -> bool:
    """Load Depth Anything V2 into app.state (blocking). Caller holds _DEPTH_LOCK."""
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
        log.info("Depth ready in %.1fs on %s", time.perf_counter() - t2, device_label)
        return True
    except ImportError:
        log.warning("torch / transformers not installed; /depth disabled.")
        app.state.depth_load_failed = True
        return False
    except Exception as e:  # pragma: no cover - defensive
        log.exception("failed to load Depth model: %s", e)
        app.state.depth_load_failed = True
        return False


def _ensure_depth(app: FastAPI) -> bool:
    """Lazily load Depth Anything V2; return True if it's ready to use."""
    if app.state.depth_available:
        return True
    if getattr(app.state, "depth_load_failed", False):
        return False
    with _DEPTH_LOCK:
        if app.state.depth_available:
            return True
        if getattr(app.state, "depth_load_failed", False):
            return False
        return _load_depth(app)


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

    # Optional: YOLO-seg semantic subject detection for /segment. When
    # available, "Select Subject" returns the union of person/animal instances
    # (refined by the matte); otherwise it falls back to pure saliency.
    app.state.yolo = None
    app.state.yolo_available = False
    if SUBJECT_DETECT:
        try:
            from ultralytics import YOLO  # type: ignore

            ty = time.perf_counter()
            app.state.yolo = YOLO(SUBJECT_MODEL)
            app.state.yolo_available = True
            log.info("YOLO subject model %r ready in %.1fs", SUBJECT_MODEL, time.perf_counter() - ty)
        except Exception as e:  # pragma: no cover - defensive
            log.warning(
                "YOLO subject detection unavailable (%s); /segment uses saliency only. "
                "Install with: pip install ultralytics",
                e,
            )

    # SAM 2 (Step 5 click-to-select) + Depth Anything V2 (Step 6) are the heavy
    # torch models. By default they load LAZILY on first use (small footprint);
    # set SEGMENT_EAGER_MODELS=1 to preload them now. The configured model ids
    # are recorded up front so /health and response headers can report them.
    app.state.sam2_available = False
    app.state.sam2_load_failed = False
    app.state.sam2_model_id = SAM2_MODEL_ID
    app.state.depth_available = False
    app.state.depth_load_failed = False
    app.state.depth_model_id = DEPTH_MODEL_ID

    if SEGMENT_EAGER_MODELS:
        await run_in_threadpool(_ensure_sam2, app)
        await run_in_threadpool(_ensure_depth, app)
    else:
        log.info(
            "SAM 2 + Depth will load lazily on first /sam2 or /depth call "
            "(set SEGMENT_EAGER_MODELS=1 to preload at startup)."
        )

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
        "subject_detect": getattr(app.state, "yolo_available", False),
        "subject_model": SUBJECT_MODEL if getattr(app.state, "yolo_available", False) else None,
        "subject_imgsz": SUBJECT_IMGSZ,
        "subject_conf": SUBJECT_CONF,
        "subject_salient_include": SUBJECT_SALIENT_INCLUDE,
        "matte_cleanup": _MATTE_CLEANUP,
        "lazy_models": not SEGMENT_EAGER_MODELS,
        # `*_available` = CAPABLE of serving the endpoint (already loaded, or
        # loadable on first use). `*_loaded` = the heavy model is resident now.
        "sam2_available": app.state.sam2_available
        or (_torch_stack_loadable() and not app.state.sam2_load_failed),
        "sam2_loaded": app.state.sam2_available,
        "sam2_model": app.state.sam2_model_id,
        "depth_available": app.state.depth_available
        or (_torch_stack_loadable() and not app.state.depth_load_failed),
        "depth_loaded": app.state.depth_available,
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

    # Reject pathologically large inputs (defense-in-depth vs direct curls that
    # bypass the Node route's MAX_MODEL_SIDE). BiRefNet runs at a fixed 1024²,
    # so anything past SEGMENT_MAX_SIDE only wastes resize/YOLO work.
    if max(img.width, img.height) > SEGMENT_MAX_SIDE:
        raise HTTPException(
            413,
            f"image too large ({img.width}x{img.height}); "
            f"max longest side is {SEGMENT_MAX_SIDE}px",
        )

    img_rgb = img.convert("RGB")
    np_rgb = np.asarray(img_rgb)

    # 1) Saliency matte (soft 0..255 alpha) from rembg, then clean it: fill
    #    interior holes, drop stray specks, recover faint/translucent regions —
    #    while preserving the model's anti-aliased edges. This is what makes a
    #    backlit leaf (or any under-segmented subject) come back solid and
    #    complete instead of Swiss-cheesed.
    try:
        matte_img = remove(img, session=app.state.session, only_mask=True)
    except Exception as e:
        log.exception("rembg.remove failed")
        raise HTTPException(500, f"segmentation failed: {e}")
    raw_matte = np.asarray(matte_img.convert("L"), dtype=np.uint8)
    matte = await run_in_threadpool(clean_matte, raw_matte)

    # 2) Semantic subject union (person/animal + salient instances) from
    #    YOLO-seg. The cleaned matte is threaded in so YOLO's salient-instance
    #    gate (and edge refinement) work off the completed subject region.
    subject_mode = "saliency"
    subjects = 0
    final_alpha = matte
    if getattr(app.state, "yolo_available", False):
        try:
            subject, subjects = await run_in_threadpool(_subject_union_mask, app, img_rgb, matte)
        except Exception:
            log.exception("subject detection failed; using saliency")
            subject, subjects = None, 0
        if subject is not None and subject.any():
            final_alpha = _compose_subject_alpha(matte, subject)
            subject_mode = "yolo+matte" if SUBJECT_REFINE else "yolo"

    # 3) Compose RGBA: original colours with the computed subject alpha.
    rgba = np.dstack([np_rgb, final_alpha]).astype(np.uint8)
    out = Image.fromarray(rgba, "RGBA")

    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    elapsed = time.perf_counter() - t0
    log.info(
        "segmented %s (%dx%d, %dKB) mode=%s subjects=%d in %.2fs -> %dKB",
        image.filename or "<unnamed>",
        img.width,
        img.height,
        len(contents) // 1024,
        subject_mode,
        subjects,
        elapsed,
        buf.tell() // 1024,
    )

    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Model": app.state.model_name,
            "X-Subject-Mode": subject_mode,
            "X-Subjects": str(subjects),
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
    # Lazily load SAM 2 on first use (no-op once loaded).
    if not await run_in_threadpool(_ensure_sam2, app):
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
    # Lazily load Depth Anything V2 on first use (no-op once loaded).
    if not await run_in_threadpool(_ensure_depth, app):
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
