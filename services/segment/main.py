"""Phosmith mask service.

Wraps `rembg` (BiRefNet default) and Hugging Face `transformers` SAM 2
(Hiera-Small) in a tiny FastAPI HTTP API so the Next.js AI routes can
call SOTA background-removal and click-to-select models locally without
Docker.

Free-tier friendly: no GPU required, but auto-uses CUDA (NVIDIA) or
MPS (Apple Silicon) when available. BiRefNet and SAM 2 Hiera-Small are
both MIT / Apache 2.0 and free for any use.
"""

from __future__ import annotations

import base64
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
from fastapi.responses import JSONResponse, Response
from PIL import Image, ImageDraw, ImageFilter, UnidentifiedImageError
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
SHAPE_MASK_MAX_SIDE = int(os.getenv("SHAPE_MASK_MAX_SIDE", "2048").strip())
SHAPE_MASK_MAX_POINTS = int(os.getenv("SHAPE_MASK_MAX_POINTS", "10000").strip())

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
# Cap on instances returned by /segment/instances (sorted by area, largest
# first). Each instance carries a full-res base64 PNG mask, so an uncapped
# crowd photo could produce a multi-hundred-MB JSON response.
SUBJECT_INSTANCES_MAX = int(os.getenv("SUBJECT_INSTANCES_MAX", "24").strip())
# Salient-pass duplicate suppression: with `classes=` unset (salient mode) YOLO
# can report the SAME physical object under two labels (e.g. "vase" AND "potted
# plant"). A salient candidate whose mask is at least this contained inside an
# already-accepted instance's mask is treated as a duplicate and dropped.
# Containment (intersection / candidate area), NOT IoU — a small prop fully
# inside a person's mask region still scores low because instance masks rarely
# share pixels, while a relabelled duplicate shares nearly all of them.
SUBJECT_DEDUP_CONTAINMENT = float(os.getenv("SUBJECT_DEDUP_CONTAINMENT", "0.85").strip())

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

# ─── Auto-crop tuning ────────────────────────────────────────────────────────
# Default padding around the union of detected subjects when computing the
# DEPTH-aware crop, expressed as a fraction of the SHORTER box side.
# 0.08 keeps a comfortable breathing room without losing too much frame.
CROP_SUBJECT_PADDING = float(os.getenv("CROP_SUBJECT_PADDING", "0.08").strip())
# Subject-aware crop is a COMPOSITION, not a subject extraction: the crop is
# sized so the subject's longer side spans ~this fraction of the crop, leaving
# deliberate breathing room / context around it. 0.62 ≈ subject fills ~⅔ of the
# frame with ~⅓ context — a natural hero composition. Lower = more context.
CROP_SUBJECT_TARGET_FRAC = float(os.getenv("CROP_SUBJECT_TARGET_FRAC", "0.62").strip())
# When there is NO distinct subject (YOLO found nothing → diffuse BiRefNet
# saliency) and the salient bbox sprawls across at least this fraction of the
# frame, the image is a scene, not a subject. Subject-aware then composes the
# WHOLE scene (max-area aspect fit, gently biased toward the salient region)
# instead of zooming into a saliency blob.
CROP_SCENE_SPREAD = float(os.getenv("CROP_SCENE_SPREAD", "0.45").strip())
# How far a scene crop is biased toward the salient centroid (0 = image centre,
# 1 = fully on the salient region). A gentle pull keeps the composition balanced.
CROP_SCENE_BIAS = float(os.getenv("CROP_SCENE_BIAS", "0.35").strip())
# Content-fill (border trim) considers a pixel "content" when its absolute
# difference from the dominant border colour exceeds this 0..255 threshold.
CROP_CONTENT_TRIM_THRESH = int(os.getenv("CROP_CONTENT_TRIM_THRESH", "16").strip())
# Minimum fraction of the image the content-fill crop must keep — guards
# against accidentally cropping to nothing on a near-solid image.
CROP_CONTENT_MIN_FRAC = float(os.getenv("CROP_CONTENT_MIN_FRAC", "0.20").strip())
# Depth-aware foreground = the N percentile of nearest pixels (largest depth).
# 0.45 typically isolates the foreground plane.
CROP_DEPTH_FOREGROUND_PCT = float(os.getenv("CROP_DEPTH_FOREGROUND_PCT", "0.45").strip())
# Snap-to-rule-of-thirds strength when subject centroid is close to a power
# point (0 = no snap, 1 = always snap).
CROP_THIRDS_SNAP = float(os.getenv("CROP_THIRDS_SNAP", "0.65").strip())
# Cap the longest side accepted by /crop/auto. The endpoint composes results
# from segment + depth, both of which already cap at 2048.
CROP_MAX_SIDE = int(os.getenv("CROP_MAX_SIDE", "2048").strip())

# ─── Text-grounded masking (/ground/text — Step 9: NL mask pipeline) ────────
# CLIPSeg turns a free-text phrase ("the red jacket", "the waterfall") into a
# coarse relevance heatmap; connected components above threshold are then
# refined with SAM 2 box+point prompts for crisp instance-quality edges.
# rd64-refined is ~600 MB and lazy-loads exactly like SAM 2 / Depth.
GROUND_MODEL_ID = os.getenv("GROUND_MODEL_ID", "CIDAS/clipseg-rd64-refined").strip()
GROUND_MAX_SIDE = int(os.getenv("GROUND_MAX_SIDE", "2048").strip())
# CLIPSeg's sigmoid map lives in a compressed range (true positives often
# peak at only 0.35..0.6), so the binarisation threshold is RELATIVE to the
# map's own peak: pixel >= max(GROUND_FLOOR, GROUND_THRESHOLD * peak). An
# absolute cut (the naive 0.4) silently drops weak-but-real targets.
GROUND_THRESHOLD = float(os.getenv("GROUND_THRESHOLD", "0.55").strip())
# Absolute floor under the relative cut — keeps near-zero noise out of the
# mask even when the peak itself is tiny.
GROUND_FLOOR = float(os.getenv("GROUND_FLOOR", "0.10").strip())
# Below this peak probability the phrase is reported as not found at all.
GROUND_MIN_PEAK = float(os.getenv("GROUND_MIN_PEAK", "0.25").strip())
# Ignore components smaller than this fraction of the frame (heatmap noise).
GROUND_MIN_AREA_FRAC = float(os.getenv("GROUND_MIN_AREA_FRAC", "0.001").strip())
GROUND_MAX_PHRASES = int(os.getenv("GROUND_MAX_PHRASES", "4").strip())
GROUND_MAX_COMPONENTS = int(os.getenv("GROUND_MAX_COMPONENTS", "4").strip())
# SAM 2 refinement is the latency hot spot on CPU — cap how many components
# get the treatment; the rest fall back to the (cleaned) CLIPSeg mask.
GROUND_REFINE_TOP = int(os.getenv("GROUND_REFINE_TOP", "2").strip())

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

def _detect_subject_instances(app, pil_img: "Image.Image", matte: "np.ndarray | None" = None):
    """Detect subject INSTANCES with YOLO-seg and return a list of per-instance
    dicts, or `[]` if YOLO is unavailable or nothing qualifies as a subject.

    Each dict: `{class_id, label, confidence, mask (HxW bool), area,
    source ('class'|'salient')}`. The same gating that previously lived inside
    `_subject_union_mask` decides what counts as a subject:

      - Person/animal classes (`SUBJECT_CLASSES`) are ALWAYS subjects.
      - When `matte` (the BiRefNet saliency map) is supplied and
        `SUBJECT_SALIENT_INCLUDE` is on, ANY other detected instance whose own
        mask is mostly salient and large enough is ALSO a subject — so
        multi-subject photos that aren't people (products, multiple objects)
        keep every subject — while prominent background objects
        (sky/walls/furniture) score ~0 saliency and are excluded.

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
        return []
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
        return []
    if not results:
        return []
    r = results[0]
    if getattr(r, "masks", None) is None or getattr(r, "boxes", None) is None:
        return []
    try:
        cls = r.boxes.cls.cpu().numpy().astype(int)
        confs = r.boxes.conf.cpu().numpy().astype(float)
        masks = r.masks.data.cpu().numpy()  # (N, mh, mw) in 0..1
    except Exception:
        log.exception("YOLO mask extraction failed")
        return []
    names = getattr(model, "names", None) or {}

    # Resolve every instance mask to a full-res boolean once.
    instances = []  # (class_id, conf, bool_mask, area)
    for i, c in enumerate(cls):
        m = masks[i]
        if m.shape != (h, w):
            # Resize via PIL (avoids a hard cv2 dependency).
            m_img = Image.fromarray((np.clip(m, 0.0, 1.0) * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)
            m = np.asarray(m_img, dtype=np.float32) / 255.0
        mb = m > 0.5
        instances.append((int(c), float(confs[i]), mb, int(mb.sum())))

    out = []

    # Pass 1: person/animal subjects are ALWAYS included. Track the largest so
    # the salient pass can tell props from scenery.
    max_subj_area = 0
    for c, conf, mb, area in instances:
        if c in SUBJECT_CLASSES and area > 0:
            out.append({
                "class_id": c,
                "label": str(names.get(c, c)),
                "confidence": conf,
                "mask": mb,
                "area": area,
                "source": "class",
            })
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

        def _is_duplicate(mb: np.ndarray, area: int) -> bool:
            # Same object relabelled under a second class shares nearly all of
            # its pixels with an already-accepted instance; genuinely distinct
            # subjects (even touching ones) share very few.
            for prev in out:
                inter = float((mb & prev["mask"]).sum())
                if inter / float(area or 1) >= SUBJECT_DEDUP_CONTAINMENT:
                    return True
            return False

        # Highest-confidence candidates first, so when two salient detections
        # cover the same object the better label is the one that survives.
        candidates = [
            (c, conf, mb, area) for c, conf, mb, area in instances
            if c not in SUBJECT_CLASSES and min_inst_area <= area <= salient_cap
        ]
        candidates.sort(key=lambda t: -t[1])
        for c, conf, mb, area in candidates:
            overlap = float((mb & salient).sum()) / float(area or 1)
            if overlap < SUBJECT_SALIENT_OVERLAP:
                continue
            if _is_duplicate(mb, area):
                continue
            out.append({
                "class_id": c,
                "label": str(names.get(c, c)),
                "confidence": conf,
                "mask": mb,
                "area": area,
                "source": "salient",
            })

    return out


def _subject_union_mask(app, pil_img: "Image.Image", matte: "np.ndarray | None" = None):
    """Union of every subject instance (group photos → one mask). Thin wrapper
    over `_detect_subject_instances`; returns `(union uint8 0/255, count)` or
    `(None, 0)` — the exact contract /segment has always used."""
    instances = _detect_subject_instances(app, pil_img, matte)
    if not instances:
        return None, 0
    h, w = instances[0]["mask"].shape
    union = np.zeros((h, w), dtype=np.uint8)
    for inst in instances:
        union[inst["mask"]] = 255
    return union, len(instances)


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


def _ensure_sam2(app: FastAPI):
    """Lazily load SAM 2; return True/'cold' if ready, False if failed.
    Returns 'cold' on first load (model just downloaded/loaded)."""
    if app.state.sam2_available:
        return True
    if getattr(app.state, "sam2_load_failed", False):
        return False
    with _SAM2_LOCK:
        if app.state.sam2_available:
            return True
        if getattr(app.state, "sam2_load_failed", False):
            return False
        ok = _load_sam2(app)
        return "cold" if ok else False


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


def _ensure_depth(app: FastAPI):
    """Lazily load Depth Anything V2; return True/'cold' if ready, False if failed.
    Returns 'cold' on first load (model just downloaded/loaded)."""
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


_GROUND_LOCK = threading.Lock()


def _load_ground(app: FastAPI) -> bool:
    """Load CLIPSeg into app.state (blocking). Caller holds _GROUND_LOCK."""
    try:
        import torch  # type: ignore  # noqa: F401
        from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor  # type: ignore

        device, device_label = detect_torch_device()
        if device is None:
            raise ImportError("torch not available")

        log.info("loading CLIPSeg model %r onto %s ...", GROUND_MODEL_ID, device_label)
        t = time.perf_counter()
        app.state.ground_processor = CLIPSegProcessor.from_pretrained(GROUND_MODEL_ID)
        app.state.ground_model = CLIPSegForImageSegmentation.from_pretrained(GROUND_MODEL_ID).to(device)
        app.state.ground_model.eval()
        app.state.ground_device = device
        app.state.ground_model_id = GROUND_MODEL_ID
        app.state.ground_available = True
        log.info("CLIPSeg ready in %.1fs on %s", time.perf_counter() - t, device_label)
        return True
    except ImportError:
        log.warning("torch / transformers not installed; /ground/text disabled.")
        app.state.ground_load_failed = True
        return False
    except Exception as e:  # pragma: no cover - defensive
        log.exception("failed to load CLIPSeg: %s", e)
        app.state.ground_load_failed = True
        return False


def _ensure_ground(app: FastAPI):
    """Lazily load CLIPSeg; return True/'cold' if ready, False if failed.
    Returns 'cold' on first load (model just downloaded/loaded)."""
    if getattr(app.state, "ground_available", False):
        return True
    if getattr(app.state, "ground_load_failed", False):
        return False
    with _GROUND_LOCK:
        if getattr(app.state, "ground_available", False):
            return True
        if getattr(app.state, "ground_load_failed", False):
            return False
        ok = _load_ground(app)
        return "cold" if ok else False


# ─── LaMa inpainting ─────────────────────────────────────────────────────────

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
        def _cpu_jit_load(f, _map_location=None, **kw):
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


def _ground_heatmaps(app, img: Image.Image, phrases: "list[str]") -> np.ndarray:
    """CLIPSeg relevance maps for `phrases` against `img`.

    Returns float32 array of shape (len(phrases), H, W) in 0..1 at the
    IMAGE's resolution (the model's 352² logits are bilinearly upsampled).
    """
    import torch  # type: ignore

    processor = app.state.ground_processor
    model = app.state.ground_model
    device = app.state.ground_device

    inputs = processor(
        text=phrases,
        images=[img] * len(phrases),
        padding=True,
        return_tensors="pt",
    ).to(device)
    with torch.inference_mode():
        outputs = model(**inputs)
    logits = outputs.logits  # (N, 352, 352) — or (352, 352) when N == 1
    if logits.dim() == 2:
        logits = logits.unsqueeze(0)
    probs = torch.sigmoid(logits).cpu().numpy().astype(np.float32)

    out = np.empty((len(phrases), img.height, img.width), dtype=np.float32)
    for i in range(probs.shape[0]):
        m = Image.fromarray((probs[i] * 255.0).astype(np.uint8), mode="L")
        m = m.resize((img.width, img.height), Image.BILINEAR)
        out[i] = np.asarray(m, dtype=np.float32) / 255.0
    return out


def _sam2_refine_box(app, img: Image.Image, box: "tuple[int, int, int, int]",
                     point: "tuple[float, float] | None" = None) -> "np.ndarray | None":
    """Refine a coarse region into a crisp SAM 2 mask using a box prompt
    (plus an optional positive point at the region's confidence peak).

    `box` is (x, y, w, h) in image pixels. Returns a bool (H, W) mask or
    None when SAM 2 is unavailable or inference fails — callers fall back
    to the coarse mask.
    """
    if not _ensure_sam2(app):
        return None
    try:
        import torch  # type: ignore

        x, y, w, h = box
        # SAM 2 input_boxes: [image, object, [x0, y0, x1, y1]] = 3 levels.
        boxes = [[[float(x), float(y), float(x + w), float(y + h)]]]
        kwargs = dict(images=img, input_boxes=boxes, return_tensors="pt")
        if point is not None:
            # input_points: [image, object, point, [x, y]] = 4 levels.
            kwargs["input_points"] = [[[[float(point[0]), float(point[1])]]]]
            kwargs["input_labels"] = [[[1]]]

        embeddings, original_sizes = _sam2_encode(app, img)
        processor = app.state.sam2_processor
        model = app.state.sam2_model
        device = app.state.sam2_device

        inputs = processor(**kwargs).to(device)
        inputs["image_embeddings"] = embeddings
        inputs.pop("pixel_values", None)
        with torch.inference_mode():
            outputs = model(**inputs)
        masks = processor.image_processor.post_process_masks(
            outputs.pred_masks.cpu(), original_sizes.cpu(),
        )
        scores = outputs.iou_scores.cpu().numpy()[0].reshape(-1)
        best = int(scores.argmax())
        return masks[0][0][best].cpu().numpy().astype(bool)
    except Exception:
        log.exception("SAM 2 box refinement failed; using coarse mask")
        return None


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
    app.state.ground_available = False
    app.state.ground_load_failed = False
    app.state.ground_model_id = GROUND_MODEL_ID
    app.state.lama_available = False
    app.state.lama_load_failed = False

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
    title="Phosmith Mask Service",
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
    out.save(buf, format="PNG", optimize=True)
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
        "ground_available": app.state.ground_available
        or (_torch_stack_loadable() and not app.state.ground_load_failed),
        "ground_loaded": app.state.ground_available,
        "ground_model": app.state.ground_model_id,
        "shape_mask_engine": "opencv-fillpoly" if cv2 is not None else "pillow-polygon",
        "lama_available": getattr(app.state, "lama_available", False)
        or _lama_loadable(),
        "lama_loaded": getattr(app.state, "lama_available", False),
    }


@app.post("/warmup")
async def warmup() -> dict:
    """Pre-load all lazy models in background so the first real request is fast.

    Call this once after the Space starts to avoid cold-load latency on the
    first user interaction. Returns which models were loaded (vs already warm).
    """
    results = {}

    # SAM 2
    sam2_was_loaded = app.state.sam2_available
    sam2_status = await run_in_threadpool(_ensure_sam2, app)
    results["sam2"] = (
        "already_loaded" if sam2_was_loaded
        else "loaded" if sam2_status else "failed"
    )

    # Depth Anything V2
    depth_was_loaded = app.state.depth_available
    depth_status = await run_in_threadpool(_ensure_depth, app)
    results["depth"] = (
        "already_loaded" if depth_was_loaded
        else "loaded" if depth_status else "failed"
    )

    # CLIPSeg grounding
    ground_was_loaded = getattr(app.state, "ground_available", False)
    ground_status = await run_in_threadpool(_ensure_ground, app)
    results["ground"] = (
        "already_loaded" if ground_was_loaded
        else "loaded" if ground_status else "failed"
    )

    # LaMa inpainting
    lama_was_loaded = getattr(app.state, "lama_available", False)
    lama_status = _ensure_lama(app)
    results["lama"] = (
        "already_loaded" if lama_was_loaded
        else "loaded" if lama_status else "failed"
    )

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

    def _run():
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        msk = Image.open(io.BytesIO(mask_bytes)).convert("L")

        # Resize mask to match image if needed
        if msk.size != img.size:
            msk = msk.resize(img.size, Image.NEAREST)

        # LaMa expects mask > 0 = inpaint region. Threshold to binary.
        msk_np = np.array(msk)
        msk_np = (msk_np > 16).astype(np.uint8) * 255
        msk = Image.fromarray(msk_np, mode="L")

        result = app.state.lama_model(img, msk)
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
        matte_img = await run_in_threadpool(
            remove, img, session=app.state.session, only_mask=True
        )
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


def _instance_alpha(matte: "np.ndarray | None", inst_mask: np.ndarray) -> np.ndarray:
    """Per-instance refined soft alpha: same recipe as `_compose_subject_alpha`
    but scoped to ONE instance. The BiRefNet matte supplies anti-aliased
    hair/fur edges inside a small dilation of the instance boundary; everything
    outside stays 0, so a neighbouring subject's matte never leaks in beyond
    the 15px dilation ring."""
    subject = (inst_mask.astype(np.uint8)) * 255
    subj_img = Image.fromarray(subject, "L")
    dil = np.asarray(subj_img.filter(ImageFilter.MaxFilter(15)))
    if SUBJECT_REFINE and matte is not None:
        combined = np.where(dil > 0, np.maximum(matte, subject), 0).astype(np.uint8)
    else:
        combined = subject
    return np.asarray(
        Image.fromarray(combined, "L").filter(ImageFilter.GaussianBlur(1.2)),
        dtype=np.uint8,
    )


def _bbox_of(mask: np.ndarray) -> "list[int]":
    """Tight [x, y, w, h] bounding box of a boolean mask (mask is non-empty)."""
    ys, xs = np.nonzero(mask)
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    return [x0, y0, x1 - x0 + 1, y1 - y0 + 1]


def _mask_png_b64(alpha: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray(alpha, "L").save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


@app.post("/segment/instances")
async def segment_instances(image: UploadFile = File(..., alias="image")) -> JSONResponse:
    """Multi-subject detection: every subject in the photo as its OWN mask.

    Where /segment unions all subjects into one alpha, this returns one
    refined, soft-edged greyscale mask PER subject instance, with class label,
    confidence, bounding box and area — so a caller (or the agent) can target
    "person 2" or "the dog" individually, or recombine any subset.

    Response JSON:
        {
          "width": int, "height": int,
          "model": str, "subject_model": str,
          "count": int,
          "instances": [
            { "index": 0, "label": "person", "class_id": 0,
              "confidence": 0.94, "source": "class" | "salient",
              "bbox": [x, y, w, h], "area": int, "area_frac": float,
              "centroid": [cx, cy],
              "mask_png": "<base64 greyscale PNG, white=subject>" },
            ...
          ],
          "union_png": "<base64 greyscale PNG of all subjects>"
        }

    Instances are sorted by area (largest first) and capped at
    `SUBJECT_INSTANCES_MAX`. Falls back to a single saliency instance when
    YOLO is unavailable or finds nothing (count=1, source="saliency"), and
    count=0 with an empty list when the image has no salient subject at all.
    """
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
        raise HTTPException(400, f"could not decode image: {e}")

    if img.mode not in ("RGB", "RGBA", "L"):
        img = img.convert("RGB")

    if max(img.width, img.height) > SEGMENT_MAX_SIDE:
        raise HTTPException(
            413,
            f"image too large ({img.width}x{img.height}); "
            f"max longest side is {SEGMENT_MAX_SIDE}px",
        )

    img_rgb = img.convert("RGB")
    w, h = img_rgb.size

    # 1) Saliency matte (same path as /segment) — edge refinement + the
    #    salient-instance gate both need it.
    try:
        matte_img = await run_in_threadpool(
            remove, img, session=app.state.session, only_mask=True
        )
    except Exception as e:
        log.exception("rembg.remove failed")
        raise HTTPException(500, f"segmentation failed: {e}")
    raw_matte = np.asarray(matte_img.convert("L"), dtype=np.uint8)
    matte = await run_in_threadpool(clean_matte, raw_matte)

    # 2) Per-instance detection.
    instances = []
    if getattr(app.state, "yolo_available", False):
        try:
            instances = await run_in_threadpool(_detect_subject_instances, app, img_rgb, matte)
        except Exception:
            log.exception("instance detection failed; falling back to saliency")
            instances = []

    mode = "yolo+matte" if instances else "saliency"
    if not instances and matte.any():
        # No YOLO (or nothing detected) but the image HAS a salient subject:
        # return the whole cleaned matte as a single instance so callers get a
        # uniform shape regardless of which models are resident.
        mb = matte > 127
        if mb.any():
            instances = [{
                "class_id": -1,
                "label": "subject",
                "confidence": 1.0,
                "mask": mb,
                "area": int(mb.sum()),
                "source": "saliency",
            }]

    # Largest first; cap the payload.
    instances.sort(key=lambda i: -i["area"])
    truncated = len(instances) > SUBJECT_INSTANCES_MAX
    instances = instances[:SUBJECT_INSTANCES_MAX]

    def _build_payload():
        frame_area = float(w * h) or 1.0
        union = np.zeros((h, w), dtype=np.uint8)
        items = []
        for idx, inst in enumerate(instances):
            mb = inst["mask"]
            alpha = _instance_alpha(matte, mb)
            union = np.maximum(union, alpha)
            ys, xs = np.nonzero(mb)
            items.append({
                "index": idx,
                "label": inst["label"],
                "class_id": inst["class_id"],
                "confidence": round(float(inst["confidence"]), 4),
                "source": inst["source"],
                "bbox": _bbox_of(mb),
                "area": int(inst["area"]),
                "area_frac": round(inst["area"] / frame_area, 5),
                "centroid": [round(float(xs.mean()), 1), round(float(ys.mean()), 1)],
                "mask_png": _mask_png_b64(alpha),
            })
        return items, (_mask_png_b64(union) if items else None)

    items, union_b64 = await run_in_threadpool(_build_payload)

    elapsed = time.perf_counter() - t0
    log.info(
        "segment/instances %s (%dx%d) mode=%s count=%d%s in %.2fs",
        image.filename or "<unnamed>", w, h, mode, len(items),
        " (truncated)" if truncated else "", elapsed,
    )

    return JSONResponse(
        {
            "width": w,
            "height": h,
            "model": app.state.model_name,
            "subject_model": SUBJECT_MODEL if getattr(app.state, "yolo_available", False) else None,
            "mode": mode,
            "count": len(items),
            "truncated": truncated,
            "instances": items,
            "union_png": union_b64,
            "elapsed_ms": int(elapsed * 1000),
        },
        headers={"Cache-Control": "no-store"},
    )


@app.post("/sam2/click")
async def sam2_click(
    image: UploadFile = File(..., alias="image"),
    clicks: "str | None" = Form(None),
    box: "str | None" = Form(None),
) -> Response:
    """Click- and/or box-prompted semantic masking with SAM 2.

    Form fields:
        image:  image file
        clicks: optional JSON array of `[x, y, label]` tuples, where `label`
                is 1 (positive / include this point) or 0 (negative / exclude).
        box:    optional JSON `[x0, y0, x1, y1]` box prompt — "select the
                object inside this rectangle". Boxes are SAM 2's strongest
                single prompt for whole-object selection; clicks can be
                combined with a box to refine it.

    At least one of `clicks` / `box` is required.
    Returns a greyscale PNG mask: white = include, black = exclude.
    """
    # Lazily load SAM 2 on first use (no-op once loaded).
    _sam2_status = await run_in_threadpool(_ensure_sam2, app)
    if not _sam2_status:
        raise HTTPException(
            501,
            "SAM 2 not available on this server. "
            "Install torch + transformers and restart, "
            "or set SAM2_MODEL_ID to a model in your HF cache.",
        )
    _sam2_cold = _sam2_status == "cold"

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

    clicks_data = []
    if clicks is not None and str(clicks).strip():
        try:
            clicks_data = json.loads(clicks)
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"invalid clicks JSON: {e}")
        if not isinstance(clicks_data, list):
            raise HTTPException(400, "clicks must be an array of [x, y, label] tuples")

    box_data = None
    if box is not None and str(box).strip():
        try:
            box_data = json.loads(box)
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"invalid box JSON: {e}")
        if not (isinstance(box_data, list) and len(box_data) == 4):
            raise HTTPException(400, f"box must be [x0, y0, x1, y1]; got {box_data!r}")
        for i, v in enumerate(box_data):
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
                raise HTTPException(400, f"box[{i}] must be a finite number; got {v!r}")
        x0, y0, x1, y1 = box_data
        if not (0 <= x0 < x1 <= img.width and 0 <= y0 < y1 <= img.height):
            raise HTTPException(
                400,
                f"box {box_data} is degenerate or outside image bounds ({img.width}x{img.height})",
            )

    if not clicks_data and box_data is None:
        raise HTTPException(400, "provide clicks and/or a box prompt")

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
    points = [[[[c[0], c[1]] for c in clicks_data]]] if clicks_data else None
    # SAM 2 input_labels format: [image, object, point_label] = 3 levels.
    labels = [[[c[2] for c in clicks_data]]] if clicks_data else None
    # SAM 2 input_boxes format: [image, object, [x0, y0, x1, y1]] = 3 levels.
    boxes = [[list(map(float, box_data))]] if box_data is not None else None

    t0 = time.perf_counter()
    try:
        embeddings, original_sizes = _sam2_encode(app, img)
        processor = app.state.sam2_processor
        model = app.state.sam2_model
        device = app.state.sam2_device

        prompt_kwargs = {}
        if points is not None:
            prompt_kwargs["input_points"] = points
            prompt_kwargs["input_labels"] = labels
        if boxes is not None:
            prompt_kwargs["input_boxes"] = boxes
        inputs = processor(
            images=img,
            return_tensors="pt",
            **prompt_kwargs,
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

    resp_headers = {
            "Cache-Control": "no-store",
            "X-Model": app.state.sam2_model_id or "sam2",
            "X-Score": f"{float(scores[best_idx]):.4f}",
            "X-Elapsed-Ms": str(int(elapsed * 1000)),
        }
    if _sam2_cold:
        resp_headers["X-Cold-Load"] = "true"
        log.info("SAM 2 cold load — first request after model download")

    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers=resp_headers,
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
    _depth_status = await run_in_threadpool(_ensure_depth, app)
    if not _depth_status:
        raise HTTPException(
            501,
            "Depth Anything V2 not available on this server. "
            "Install torch + transformers and restart, "
            "or set DEPTH_MODEL_ID to a model in your HF cache.",
        )
    _depth_cold = _depth_status == "cold"

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

    resp_headers = {
            "Cache-Control": "no-store",
            "X-Model": app.state.depth_model_id or "depth",
            "X-Width": str(img.width),
            "X-Height": str(img.height),
            "X-Elapsed-Ms": str(int(elapsed * 1000)),
        }
    if _depth_cold:
        resp_headers["X-Cold-Load"] = "true"
        log.info("Depth cold load — first request after model download")

    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers=resp_headers,
    )


# ─── Auto-crop helpers ──────────────────────────────────────────────────────


@app.post("/ground/text")
async def ground_text(
    image: UploadFile = File(..., alias="image"),
    phrases: str = Form(...),
    threshold: "float | None" = Form(None),
    refine: str = Form("1"),
) -> JSONResponse:
    """Text-grounded masking: free-text phrase(s) → soft mask(s).

    Pipeline per phrase: CLIPSeg relevance heatmap → adaptive threshold →
    connected components (small/noise dropped) → SAM 2 box+peak-point
    refinement of the top components (crisp instance edges; falls back to the
    coarse component when SAM 2 is unavailable) → matte cleanup.

    Form fields:
        image:     JPEG/PNG/WebP, max MAX_UPLOAD_MB, longest side GROUND_MAX_SIDE.
        phrases:   JSON array of 1..GROUND_MAX_PHRASES strings.
        threshold: optional float 0..1 overriding GROUND_THRESHOLD — the
                   RELATIVE fraction of the heatmap peak a pixel must reach.
        refine:    "0" to skip SAM 2 refinement (faster, coarser).

    Response:
        {
          "width": int, "height": int, "model": str, "refine": bool,
          "results": [{
              "phrase": str,
              "found": bool,
              "score": float,        # heatmap peak 0..1
              "coverage": float,     # mask area / frame area
              "bbox": [x,y,w,h] | null,
              "components": int,
              "refined": bool,       # SAM 2 actually used
              "maskPng": str | null  # base64 greyscale PNG, white = selected
          }]
        }

    A phrase that doesn't bind (peak < GROUND_MIN_PEAK) returns found=false
    with score — callers decide whether to fall back or surface it.
    """
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(415, f"unsupported content-type: {image.content_type}")

    try:
        phrase_list = json.loads(phrases)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"invalid phrases JSON: {e}")
    if not isinstance(phrase_list, list) or not phrase_list:
        raise HTTPException(400, "phrases must be a non-empty JSON array of strings")
    phrase_list = [str(p).strip() for p in phrase_list if str(p).strip()]
    if not phrase_list:
        raise HTTPException(400, "phrases contained no usable text")
    if len(phrase_list) > GROUND_MAX_PHRASES:
        raise HTTPException(400, f"too many phrases: {len(phrase_list)} > {GROUND_MAX_PHRASES}")

    thr = GROUND_THRESHOLD if threshold is None else max(0.05, min(0.95, float(threshold)))
    do_refine = str(refine).strip() not in ("0", "false", "False")

    if not await run_in_threadpool(_ensure_ground, app):
        raise HTTPException(
            501,
            "Text grounding not available on this server. "
            "Install torch + transformers and restart, or set GROUND_MODEL_ID "
            "to a CLIPSeg model in your HF cache.",
        )

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
    if max(img.width, img.height) > GROUND_MAX_SIDE:
        raise HTTPException(
            413,
            f"image too large ({img.width}x{img.height}); max longest side {GROUND_MAX_SIDE}px",
        )

    from scipy import ndimage  # transitively available via ultralytics

    W, H = img.size
    frame_area = float(W * H)
    rgb = np.asarray(img, dtype=np.uint8)

    t0 = time.perf_counter()
    heatmaps = await run_in_threadpool(_ground_heatmaps, app, img, phrase_list)

    results = []
    any_refined = False
    for pi, phrase in enumerate(phrase_list):
        heat = heatmaps[pi]
        peak = float(heat.max())
        if peak < GROUND_MIN_PEAK:
            results.append({
                "phrase": phrase, "found": False, "score": round(peak, 4),
                "coverage": 0.0, "bbox": None, "components": 0,
                "refined": False, "maskPng": None,
            })
            continue

        # Peak-relative threshold (CLIPSeg sigmoids are range-compressed —
        # see GROUND_THRESHOLD comment), clamped to an absolute noise floor.
        eff_thr = max(GROUND_FLOOR, thr * peak)
        binary = heat >= eff_thr
        labeled, n = ndimage.label(binary)
        comps = []
        for ci in range(1, n + 1):
            comp = labeled == ci
            area = int(comp.sum())
            if area < GROUND_MIN_AREA_FRAC * frame_area:
                continue
            mean_heat = float(heat[comp].mean())
            comps.append((mean_heat * math.sqrt(area), comp, area))
        comps.sort(key=lambda t: -t[0])
        comps = comps[:GROUND_MAX_COMPONENTS]

        if not comps:
            results.append({
                "phrase": phrase, "found": False, "score": round(peak, 4),
                "coverage": 0.0, "bbox": None, "components": 0,
                "refined": False, "maskPng": None,
            })
            continue

        union = np.zeros((H, W), dtype=bool)
        used_refine = False
        for rank, (_, comp, area) in enumerate(comps):
            refined_mask = None
            if do_refine and rank < GROUND_REFINE_TOP:
                bbox = _bbox_from_mask(comp)
                # Positive point at the component's confidence peak.
                comp_heat = np.where(comp, heat, 0.0)
                py_, px_ = np.unravel_index(int(comp_heat.argmax()), comp_heat.shape)
                refined_mask = await run_in_threadpool(
                    _sam2_refine_box, app, img, bbox, (float(px_), float(py_))
                )
                if refined_mask is not None:
                    # Sanity-gate the refinement: a mask that exploded far
                    # beyond the prompt region (>4x area with little overlap)
                    # means SAM grabbed the wrong object — keep the coarse one.
                    r_area = float(refined_mask.sum())
                    inter = float((refined_mask & comp).sum())
                    if r_area > 4.0 * area and inter / float(area or 1) < 0.3:
                        refined_mask = None
            if refined_mask is not None:
                union |= refined_mask
                used_refine = True
            else:
                union |= comp

        alpha = (union.astype(np.uint8)) * 255
        if _MATTE_CLEANUP:
            try:
                alpha = await run_in_threadpool(clean_matte, alpha, rgb)
            except Exception:
                log.exception("clean_matte failed in /ground/text; using raw mask")
        any_refined = any_refined or used_refine

        results.append({
            "phrase": phrase,
            "found": True,
            "score": round(peak, 4),
            "coverage": round(float((alpha > 127).sum()) / frame_area, 4),
            "bbox": list(_bbox_from_mask(alpha > 127) or ()) or None,
            "components": len(comps),
            "refined": used_refine,
            "maskPng": _mask_png_b64(alpha),
        })

    elapsed = time.perf_counter() - t0
    log.info(
        "ground/text %s (%dx%d) phrases=%s refine=%s in %.2fs",
        image.filename or "<unnamed>", W, H,
        [r["phrase"] for r in results], any_refined, elapsed,
    )
    return JSONResponse({
        "width": W,
        "height": H,
        "model": app.state.ground_model_id,
        "refine": any_refined,
        "elapsed_ms": int(elapsed * 1000),
        "results": results,
    }, headers={"Cache-Control": "no-store"})


def _parse_aspect(raw: "str | None") -> "float | None":
    """Parse an aspect ratio from `"W:H"`, `"W/H"`, or a bare float `"1.5"`.

    Returns `None` for falsy / unparseable input (callers treat that as
    "freeform — no aspect constraint"). Tolerates whitespace and the `x`
    separator (e.g. `"16x9"`).
    """
    if not raw:
        return None
    s = str(raw).strip().lower()
    if not s:
        return None
    for sep in (":", "/", "x"):
        if sep in s:
            a, b = s.split(sep, 1)
            try:
                num = float(a.strip())
                den = float(b.strip())
                if den <= 0 or num <= 0:
                    return None
                return num / den
            except ValueError:
                return None
    try:
        v = float(s)
        return v if v > 0 else None
    except ValueError:
        return None


def _clip_box_to_image(
    box: "tuple[float, float, float, float]", W: int, H: int
) -> "tuple[int, int, int, int]":
    """Clip `(x, y, w, h)` to the image bounds and round to ints.

    Always returns a box of at least 1×1 inside the image — callers downstream
    rely on the box being non-degenerate.
    """
    x, y, w, h = box
    x = max(0.0, min(float(W) - 1, x))
    y = max(0.0, min(float(H) - 1, y))
    w = max(1.0, min(float(W) - x, w))
    h = max(1.0, min(float(H) - y, h))
    return int(round(x)), int(round(y)), int(round(w)), int(round(h))


def _bbox_from_mask(mask: np.ndarray) -> "tuple[int, int, int, int] | None":
    """Tight bbox `(x, y, w, h)` of the True pixels in a boolean mask, or
    `None` if the mask is entirely empty."""
    if mask is None or mask.size == 0 or not mask.any():
        return None
    ys, xs = np.nonzero(mask)
    x0 = int(xs.min())
    y0 = int(ys.min())
    x1 = int(xs.max())
    y1 = int(ys.max())
    return (x0, y0, x1 - x0 + 1, y1 - y0 + 1)


def _expand_box(
    box: "tuple[int, int, int, int]",
    W: int,
    H: int,
    pad_frac: float,
) -> "tuple[int, int, int, int]":
    """Expand a box by `pad_frac` of its SHORTER side, then clip to image."""
    x, y, w, h = box
    pad = max(0.0, pad_frac) * float(min(w, h))
    return _clip_box_to_image((x - pad, y - pad, w + 2 * pad, h + 2 * pad), W, H)


def _fit_aspect(
    box: "tuple[int, int, int, int]",
    aspect: float,
    W: int,
    H: int,
    *,
    anchor: "tuple[float, float] | None" = None,
) -> "tuple[int, int, int, int]":
    """Fit a box of the requested aspect ratio around `box`, keeping the box
    fully inside the image. Grows the shorter side (never crops the subject)
    unless we hit an edge — then shifts the box toward `anchor` to maximise
    subject inclusion.

    `anchor` is the (cx, cy) the result should try to centre on. Defaults to
    the input box centre.
    """
    x, y, w, h = box
    cur_aspect = w / float(h)
    if aspect >= cur_aspect:
        # Need wider — grow horizontally.
        new_w = h * aspect
        new_h = h
    else:
        # Need taller — grow vertically.
        new_w = w
        new_h = w / aspect

    # If growth exceeds image dims, shrink uniformly to fit (we ALWAYS prefer
    # the requested aspect over keeping the subject 1:1).
    scale = min(1.0, W / new_w, H / new_h)
    new_w *= scale
    new_h *= scale

    ax = anchor[0] if anchor else x + w / 2.0
    ay = anchor[1] if anchor else y + h / 2.0
    new_x = ax - new_w / 2.0
    new_y = ay - new_h / 2.0

    # Clip to image bounds (this shifts the rect rather than shrinking it).
    if new_x < 0:
        new_x = 0
    if new_y < 0:
        new_y = 0
    if new_x + new_w > W:
        new_x = W - new_w
    if new_y + new_h > H:
        new_y = H - new_h
    return _clip_box_to_image((new_x, new_y, new_w, new_h), W, H)


def _compose_anchor(
    centroid: "tuple[float, float]",
    bbox: "tuple[float, float, float, float]",
    crop_w: float,
    crop_h: float,
    W: int,
    H: int,
    snap_strength: float = CROP_THIRDS_SNAP,
) -> "tuple[float, float]":
    """Where a crop of size `(crop_w, crop_h)` should be CENTRED to compose the
    subject professionally.

    Two ideas a senior photo tool gets right and a naive "nudge to a fixed
    power point" gets wrong:

    1. **Lead room (a.k.a. nose room).** A subject sitting in the left half of
       the frame is almost always facing/moving toward the open space on its
       right, so the crop should leave room on THAT side — i.e. place the
       subject on the left third, not shove it against the right edge. We infer
       facing from the subject's position in the frame (the photographer's
       original placement) and pull it toward the corresponding third.

    2. **Never cut the subject, never trim lopsidedly.** The pull is clamped so
       the whole subject stays inside the crop with a small margin. When the
       crop is simply too small to contain the subject on an axis (a wide group
       forced to 1:1), we centre on the subject bbox on that axis so the
       unavoidable trim is symmetric instead of dropping everyone on one side.
    """
    cx, cy = centroid
    bx, by, bw, bh = bbox
    s = max(0.0, min(1.0, snap_strength))

    def axis(c, b0, bdim, cdim, dim, strength):
        # Lead-room target third, chosen from the subject's side of the frame.
        third = (1.0 / 3.0) if (b0 + bdim / 2.0) < dim / 2.0 else (2.0 / 3.0)
        a = c + (0.5 - third) * cdim * strength
        margin = 0.04 * cdim
        if cdim >= bdim + 2 * margin:
            # Clamp so the subject (plus margin) stays fully inside the crop.
            lo = b0 + bdim + margin - cdim / 2.0
            hi = b0 - margin + cdim / 2.0
            a = min(max(a, lo), hi)
        else:
            # Crop can't hold the subject on this axis → balanced centre cut.
            a = b0 + bdim / 2.0
        # Keep the crop itself inside the image.
        if cdim <= dim:
            a = min(max(a, cdim / 2.0), dim - cdim / 2.0)
        else:
            a = dim / 2.0
        return a

    # Horizontal lead room is the strong cue; vertical gets a gentler pull so we
    # don't shove a standing subject's feet against the bottom edge.
    ax = axis(cx, bx, bw, crop_w, W, s)
    ay = axis(cy, by, bh, crop_h, H, s * 0.5)
    return ax, ay


def _compute_subject_crop(
    subject_mask: "np.ndarray | None",
    W: int,
    H: int,
    *,
    aspect: "float | None" = None,
    target_frac: float = CROP_SUBJECT_TARGET_FRAC,
    centroid: "tuple[float, float] | None" = None,
    has_subject: bool = True,
) -> "dict | None":
    """Subject-aware crop = a COMPOSITION around the subject, not a subject
    extraction.

    Two regimes:

    1. A distinct subject (YOLO instance, or a saliency blob that doesn't sprawl
       across the frame): size the crop so the subject's longer side spans
       ~`target_frac` of it — leaving deliberate breathing room/context — then
       nudge to rule-of-thirds and fit `aspect`. This is the fix for "subject-
       aware shouldn't crop ONLY the subject": the surrounding scene is kept.

    2. No distinct subject (`has_subject=False`) and the salient region sprawls
       across the frame (a landscape/scene): DON'T zoom into the saliency blob.
       Compose the whole scene — a max-area `aspect` fit gently biased toward
       the salient centroid, or the full frame when freeform. This is the fix
       for scenes like a canyon-and-sky where there is no single subject.

    Returns `None` when no usable subject mask is supplied — the caller should
    fall back to content-fill or to the whole frame.
    """
    if subject_mask is None:
        return None
    mask_bool = subject_mask > 127 if subject_mask.dtype == np.uint8 else subject_mask
    bbox = _bbox_from_mask(mask_bool)
    if bbox is None:
        return None

    # Centroid drives both thirds-snap and the scene bias.
    if centroid is None:
        ys, xs = np.nonzero(mask_bool)
        if xs.size == 0:
            return None
        centroid = (float(xs.mean()), float(ys.mean()))
    cx, cy = centroid

    bx, by, bw, bh = bbox
    frame_area = float(W * H) or 1.0
    subj_area = float(mask_bool.sum())
    spread = (bw * bh) / frame_area  # how much of the frame the subject bbox spans

    # ── Regime 2: scene composition (no distinct subject) ───────────────────
    is_scene = (not has_subject) and spread >= CROP_SCENE_SPREAD
    if is_scene:
        if aspect is not None:
            bias = max(0.0, min(1.0, CROP_SCENE_BIAS))
            ax = cx * bias + (W / 2.0) * (1.0 - bias)
            ay = cy * bias + (H / 2.0) * (1.0 - bias)
            x, y, w, h = _compute_aspect_crop(W, H, aspect, centroid=(ax, ay))["box"]
        else:
            x, y, w, h = 0, 0, W, H
        crop_area = float(w * h)
        return {
            "box": [x, y, w, h],
            "score": round(min(1.0, 0.45 + 0.2 * (1.0 - abs(spread - 0.6))), 4),
            "aspect_ratio": round(w / float(h), 4) if h else None,
            "rationale": (
                "scene composition (no distinct subject)"
                + (f", fitted to {aspect:.3f}:1" if aspect else "")
            ),
            "centroid": [round(float(cx), 1), round(float(cy), 1)],
            "subject_coverage": round(subj_area / frame_area, 4),
            "already_tight": (crop_area / frame_area) >= 0.92,
        }

    # ── Regime 1: compose AROUND the subject with breathing room ────────────
    # Size the crop so the subject occupies ~target_frac of it (context kept,
    # not extracted); fit the aspect; then PLACE it for lead room without ever
    # cutting the subject or trimming a group lopsidedly.
    f = max(0.2, min(0.95, target_frac))
    crop_w = min(float(W), bw / f)
    crop_h = min(float(H), bh / f)
    if aspect is not None:
        # Reuse the tested aspect fitter for SIZE only; we re-place below.
        fitted = _fit_aspect(
            _clip_box_to_image((bx, by, crop_w, crop_h), W, H), aspect, W, H
        )
        crop_w, crop_h = float(fitted[2]), float(fitted[3])

    ax, ay = _compose_anchor((cx, cy), (bx, by, bw, bh), crop_w, crop_h, W, H)
    x, y, w, h = _clip_box_to_image(
        (ax - crop_w / 2.0, ay - crop_h / 2.0, crop_w, crop_h), W, H
    )
    crop_area = float(w * h)
    # Score: higher when the subject is well-included AND well-placed (not the
    # whole frame, not a tight zoom). Peak around the target share.
    crop_frame_ratio = crop_area / frame_area if frame_area > 0 else 0.0
    subj_share = subj_area / crop_area if crop_area > 0 else 0.0
    score = round(min(1.0, 0.55 + 0.25 * (1.0 - abs(subj_share - f)) + 0.2 * (1.0 - crop_frame_ratio)), 4)
    # Flag when the crop box essentially IS the full frame — the subject already
    # fills the frame, so there's little to gain. The client still PLACES this
    # box (adjustable) rather than skipping it.
    already_tight = crop_frame_ratio >= 0.92
    return {
        "box": [x, y, w, h],
        "score": score,
        "aspect_ratio": round(w / float(h), 4) if h else None,
        "rationale": (
            f"composed around subject (~{int(f * 100)}% frame share, lead-room placed)"
            + (f", fitted to {aspect:.3f}:1" if aspect else "")
        ),
        "centroid": [round(float(cx), 1), round(float(cy), 1)],
        "subject_coverage": round(subj_area / frame_area, 4),
        "already_tight": already_tight,
    }


def _compute_content_fill_crop(
    rgb: np.ndarray,
    *,
    aspect: "float | None" = None,
    thresh: int = CROP_CONTENT_TRIM_THRESH,
    min_frac: float = CROP_CONTENT_MIN_FRAC,
) -> "dict | None":
    """Trim near-solid borders (white/black mats, sky padding, letterboxes).

    Heuristic: sample the dominant colour from a thin border ring, then find
    the tight bbox of pixels whose max-channel distance from that colour
    exceeds `thresh`. Falls back to None when the trim would remove more than
    `1 - min_frac` of the frame (guard against accidental nuke on near-solid
    images like flatlays).
    """
    if rgb is None or rgb.ndim != 3 or rgb.shape[2] < 3:
        return None
    H, W = rgb.shape[:2]
    if W < 16 or H < 16:
        return None

    # Sample a ~2% border ring for the dominant colour.
    ring = max(2, int(0.02 * min(W, H)))
    border = np.concatenate([
        rgb[:ring].reshape(-1, 3),
        rgb[-ring:].reshape(-1, 3),
        rgb[:, :ring].reshape(-1, 3),
        rgb[:, -ring:].reshape(-1, 3),
    ], axis=0)
    bg = np.median(border, axis=0).astype(np.int32)

    # Channel-wise distance from background.
    diff = np.abs(rgb.astype(np.int32) - bg[None, None, :]).max(axis=2)
    content = diff > int(thresh)

    if not content.any():
        return None

    # Cheap denoise: project onto rows & cols and threshold projection to
    # ignore single-pixel noise speckles in the margins.
    col_any = content.sum(axis=0) > max(2, H // 200)
    row_any = content.sum(axis=1) > max(2, W // 200)
    if not col_any.any() or not row_any.any():
        return None

    x0 = int(np.argmax(col_any))
    x1 = int(W - 1 - np.argmax(col_any[::-1]))
    y0 = int(np.argmax(row_any))
    y1 = int(H - 1 - np.argmax(row_any[::-1]))
    if x1 <= x0 or y1 <= y0:
        return None

    box = (x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    if (box[2] * box[3]) / float(W * H) < float(min_frac):
        return None

    if aspect is not None:
        cx = (x0 + x1) / 2.0
        cy = (y0 + y1) / 2.0
        box = _fit_aspect(box, aspect, W, H, anchor=(cx, cy))

    x, y, w, h = _clip_box_to_image(box, W, H)
    trimmed = 1.0 - (w * h) / float(W * H)
    return {
        "box": [x, y, w, h],
        "score": round(min(1.0, 0.4 + 0.6 * trimmed), 4),
        "aspect_ratio": round(w / float(h), 4) if h else None,
        "rationale": f"trimmed {trimmed * 100:.0f}% near-solid border (Δ>{thresh})",
        "already_tight": trimmed < 0.08,
    }


def _compute_depth_crop(
    depth: "np.ndarray | None",
    W: int,
    H: int,
    *,
    aspect: "float | None" = None,
    pct: float = CROP_DEPTH_FOREGROUND_PCT,
    padding: float = CROP_SUBJECT_PADDING,
) -> "dict | None":
    """Depth-aware foreground crop. Selects the nearest `pct` fraction of
    pixels by depth (white = near in Depth Anything V2), bboxes them and pads.
    """
    if depth is None or depth.size == 0:
        return None
    if depth.shape[0] != H or depth.shape[1] != W:
        # Resize via PIL — depth maps are smooth so bilinear is fine.
        d_img = Image.fromarray(depth, mode="L").resize((W, H), Image.BILINEAR)
        depth = np.asarray(d_img, dtype=np.uint8)

    # Threshold at the top `pct` of depth values.
    flat = depth.reshape(-1)
    if flat.size == 0:
        return None
    cutoff = int(np.quantile(flat, 1.0 - float(pct)))
    fg = depth >= max(1, cutoff)
    bbox = _bbox_from_mask(fg)
    if bbox is None:
        return None

    padded = _expand_box(bbox, W, H, padding)
    if aspect is not None:
        ys, xs = np.nonzero(fg)
        cx = float(xs.mean()) if xs.size else (padded[0] + padded[2] / 2.0)
        cy = float(ys.mean()) if ys.size else (padded[1] + padded[3] / 2.0)
        final = _fit_aspect(padded, aspect, W, H, anchor=(cx, cy))
    else:
        final = padded
    x, y, w, h = final
    frame_area = float(W * H) or 1.0
    crop_area = float(w * h)
    return {
        "box": [x, y, w, h],
        "score": round(min(1.0, 0.45 + 0.55 * (fg.sum() / frame_area)), 4),
        "aspect_ratio": round(w / float(h), 4) if h else None,
        "rationale": f"top {int(pct * 100)}% depth percentile padded {int(padding * 100)}%",
        "already_tight": (crop_area / frame_area) >= 0.92,
    }


def _compute_aspect_crop(
    W: int,
    H: int,
    aspect: float,
    *,
    centroid: "tuple[float, float] | None" = None,
) -> dict:
    """Maximum-area crop at `aspect`, centred on `centroid` (defaults to image
    centre). The cheap "preset" mode — no model required."""
    if W <= 0 or H <= 0 or aspect <= 0:
        raise ValueError("invalid aspect arguments")
    if aspect >= W / float(H):
        new_w = float(W)
        new_h = W / aspect
    else:
        new_h = float(H)
        new_w = H * aspect

    if centroid is None:
        cx, cy = W / 2.0, H / 2.0
    else:
        cx, cy = centroid
    box = (cx - new_w / 2.0, cy - new_h / 2.0, new_w, new_h)
    # Use _fit_aspect's clipping behaviour for free.
    x, y, w, h = _fit_aspect(
        _clip_box_to_image(box, W, H), aspect, W, H, anchor=(cx, cy)
    )
    return {
        "box": [x, y, w, h],
        "score": 0.5,
        "aspect_ratio": round(w / float(h), 4) if h else None,
        "rationale": f"max-area fit to {aspect:.3f}:1 around {'subject' if centroid else 'centre'}",
    }


def _subjects_from_instances(
    instances: "list[dict]", W: int, H: int
) -> "tuple[list[dict], np.ndarray, tuple[float, float] | None]":
    """Reduce YOLO instance dicts to the three things /crop/auto's subject
    strategy needs: the JSON `subjects` payload, a uint8 union mask over the
    top-N instances, and an area-weighted centroid (more stable than a global
    matte centroid for multi-subject photos). Shared by the fast (matte-free)
    path and the BiRefNet fallback so both build identical metadata."""
    top = sorted(instances, key=lambda i: -i["area"])[:SUBJECT_INSTANCES_MAX]
    payload: "list[dict]" = []
    union = np.zeros((H, W), dtype=np.uint8)
    total = sx = sy = 0.0
    for idx, inst in enumerate(top):
        ys, xs = np.nonzero(inst["mask"])
        if xs.size == 0:
            continue
        payload.append({
            "index": idx,
            "label": inst["label"],
            "class_id": inst["class_id"],
            "confidence": round(float(inst["confidence"]), 4),
            "source": inst["source"],
            "bbox": _bbox_of(inst["mask"]),
            "centroid": [round(float(xs.mean()), 1), round(float(ys.mean()), 1)],
        })
        union = np.maximum(union, inst["mask"].astype(np.uint8) * 255)
        a = float(inst["area"])
        sx += xs.mean() * a
        sy += ys.mean() * a
        total += a
    centroid = (sx / total, sy / total) if total > 0 else None
    return payload, union, centroid


@app.post("/crop/auto")
async def crop_auto(
    image: UploadFile = File(..., alias="image"),
    aspect: "str | None" = Form(None),
    mode: str = Form("all"),
    padding: "float | None" = Form(None),
) -> JSONResponse:
    """Production auto-crop. Returns one or more crop boxes computed from the
    input image, all expressed in the input image's ORIGINAL pixel coordinates.

    Form fields:
        image:   JPEG/PNG/WebP, max MAX_UPLOAD_MB.
        aspect:  optional `"W:H"` / `"W/H"` / float. When supplied, every
                 strategy's box is fitted to this ratio.
        mode:    one of `"subject" | "aspect" | "content" | "depth" | "all"`.
                 Default `"all"` runs every strategy that's available
                 (depth-aware needs Depth Anything; subject needs BiRefNet).
        padding: optional float (0..1) overriding `CROP_SUBJECT_PADDING`.

    Response shape:

        {
          "width": int, "height": int,
          "aspect": float | null,
          "ran": ["subject", "aspect", "content", "depth"],
          "crops": {
            "subject": { "box": [x,y,w,h], "score": 0..1,
                         "aspect_ratio": float, "rationale": str,
                         "centroid": [cx,cy] } | null,
            "aspect":  { ... } | null,
            "content": { ... } | null,
            "depth":   { ... } | null
          },
          "subjects": [ { index, label, confidence, bbox } ],
          "recommended": "subject" | "depth" | "content" | "aspect",
          "elapsed_ms": int
        }

    The endpoint NEVER raises on a per-strategy failure — it just emits `null`
    for that strategy and continues. The caller picks whichever box best fits
    its UX; `"recommended"` is the highest-scoring one.
    """
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(415, f"unsupported content-type: {image.content_type}")

    mode = (mode or "all").strip().lower()
    if mode not in {"subject", "aspect", "content", "depth", "all"}:
        raise HTTPException(400, f"invalid mode: {mode}")

    aspect_value = _parse_aspect(aspect)
    if aspect_value is None and mode == "aspect":
        raise HTTPException(400, "mode=aspect requires an `aspect` field (e.g. 16:9)")

    pad = CROP_SUBJECT_PADDING if padding is None else max(0.0, min(1.0, float(padding)))

    contents = await _read_limited(image)
    if not contents:
        raise HTTPException(400, "empty upload")

    t0 = time.perf_counter()
    try:
        img = Image.open(io.BytesIO(contents))
        img.load()
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as e:
        raise HTTPException(400, f"could not decode image: {e}")

    if img.mode not in ("RGB", "RGBA", "L"):
        img = img.convert("RGB")

    if max(img.width, img.height) > CROP_MAX_SIDE:
        raise HTTPException(
            413,
            f"image too large ({img.width}x{img.height}); max longest side {CROP_MAX_SIDE}px",
        )

    rgb_img = img.convert("RGB")
    W, H = rgb_img.size
    rgb = np.asarray(rgb_img, dtype=np.uint8)

    crops: "dict[str, dict | None]" = {}
    ran: list[str] = []
    subjects_payload: list[dict] = []

    # Cheap modes first.
    if mode in ("aspect", "all") and aspect_value is not None:
        try:
            crops["aspect"] = _compute_aspect_crop(W, H, aspect_value)
            ran.append("aspect")
        except Exception:
            log.exception("aspect crop failed")
            crops["aspect"] = None

    if mode in ("content", "all"):
        try:
            crops["content"] = await run_in_threadpool(
                _compute_content_fill_crop, rgb, aspect=aspect_value
            )
            ran.append("content")
        except Exception:
            log.exception("content-fill crop failed")
            crops["content"] = None

    # Subject-aware: YOLO-first. The crop box only needs a subject REGION, not
    # a pixel-perfect alpha — so for the common case (people/pets/objects YOLO
    # recognises) we detect instances WITHOUT the ~25-60s BiRefNet matte and
    # build the region straight from the instance masks. The matte is only
    # computed as a fallback when YOLO finds nothing (a non-COCO subject, or
    # YOLO disabled), which keeps the slow path available without paying for it
    # on every subject crop — and stops one subject-aware request from pinning
    # the worker for a minute while every other mode waits.
    if mode in ("subject", "all"):
        try:
            union_mask: "np.ndarray | None" = None
            subject_centroid: "tuple[float, float] | None" = None

            # Fast path — matte-free YOLO instances.
            if getattr(app.state, "yolo_available", False):
                try:
                    instances = await run_in_threadpool(
                        _detect_subject_instances, app, rgb_img, None
                    )
                except Exception:
                    log.exception("instance detection failed in /crop/auto")
                    instances = []
                if instances:
                    payload, union, subject_centroid = _subjects_from_instances(
                        instances, W, H
                    )
                    subjects_payload.extend(payload)
                    # The YOLO instance union already isolates the subject(s)
                    # from the background, so no matte gating is needed.
                    union_mask = union

            # Fallback — only when the fast path found no subject. Run the
            # BiRefNet saliency matte and gate it to any salient instances
            # (same recipe as /segment's _compose_subject_alpha) so non-COCO
            # subjects still get a sensible crop.
            if union_mask is None:
                matte_img = await run_in_threadpool(
                    remove, img, session=app.state.session, only_mask=True
                )
                raw_matte = np.asarray(matte_img.convert("L"), dtype=np.uint8)
                matte = await run_in_threadpool(clean_matte, raw_matte, rgb)
                union_mask = matte.copy()
                if getattr(app.state, "yolo_available", False):
                    try:
                        instances = await run_in_threadpool(
                            _detect_subject_instances, app, rgb_img, matte
                        )
                    except Exception:
                        log.exception("instance detection failed in /crop/auto")
                        instances = []
                    if instances:
                        payload, union, subject_centroid = _subjects_from_instances(
                            instances, W, H
                        )
                        subjects_payload.extend(payload)
                        union_mask = _compose_subject_alpha(matte, union)

            # `has_subject` is True only when YOLO actually found instances —
            # the fallback BiRefNet matte alone (no instances) means "diffuse
            # saliency", which the subject crop treats as a scene, not a target.
            crops["subject"] = _compute_subject_crop(
                union_mask, W, H,
                aspect=aspect_value, centroid=subject_centroid,
                has_subject=bool(subjects_payload),
            )
            ran.append("subject")
        except Exception:
            log.exception("subject crop failed")
            crops["subject"] = None

    # Depth-aware: only run when explicitly asked or in "all" AND the model
    # is loaded — don't trigger a 500MB lazy load just for an opportunistic
    # alternative.
    if mode == "depth" or (mode == "all" and getattr(app.state, "depth_available", False)):
        try:
            if mode == "depth":
                # User explicitly asked → ensure depth is loaded.
                if not await run_in_threadpool(_ensure_depth, app):
                    raise HTTPException(
                        501,
                        "Depth Anything V2 not available on this server.",
                    )
            if getattr(app.state, "depth_available", False):
                depth_arr = await run_in_threadpool(_depth_predict, app, rgb_img)
                crops["depth"] = await run_in_threadpool(
                    _compute_depth_crop, depth_arr, W, H, aspect=aspect_value, padding=pad
                )
                ran.append("depth")
        except HTTPException:
            raise
        except Exception:
            log.exception("depth crop failed")
            crops["depth"] = None

    # Pick a recommendation: prefer subject > depth > content > aspect, but
    # break ties on score and skip nulls.
    PREFERENCE = ["subject", "depth", "content", "aspect"]
    candidates = [(k, crops[k]) for k in PREFERENCE if crops.get(k)]
    recommended = None
    if candidates:
        recommended = max(
            candidates, key=lambda kv: (kv[1].get("score") or 0.0, -PREFERENCE.index(kv[0]))
        )[0]

    elapsed = time.perf_counter() - t0
    log.info(
        "crop/auto %s (%dx%d) mode=%s ran=%s rec=%s aspect=%s in %.2fs",
        image.filename or "<unnamed>", W, H, mode, ran, recommended,
        f"{aspect_value:.3f}" if aspect_value else "—", elapsed,
    )

    return JSONResponse({
        "width": W,
        "height": H,
        "aspect": round(aspect_value, 6) if aspect_value else None,
        "mode": mode,
        "ran": ran,
        "crops": crops,
        "subjects": subjects_payload,
        "recommended": recommended,
        "elapsed_ms": int(elapsed * 1000),
    }, headers={"Cache-Control": "no-store"})


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=PORT,
        reload=False,
        log_level="info",
    )
