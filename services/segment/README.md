# Pixxel mask service

A tiny FastAPI service that runs three SOTA open models locally:

1. **BiRefNet** (`rembg` library, ONNX Runtime) — background-removal
   for the "Select Subject" tool.
2. **SAM 2 Hiera-Small** (`transformers` + `torch`) — click-to-select
   semantic masking for the "Click to Select" tool.
3. **Depth Anything V2 Small** (`transformers` + `torch`) — monocular
   depth estimation for the "Depth" tool.

Called by the Next.js routes at `/api/ai/segment`, `/api/ai/sam2`,
and `/api/ai/depth` over HTTP.

## Why a separate service?

- The current HuggingFace `briaai/RMBG-1.4` model + `segformer` fallback
  misclassifies leaves and plants on ADE20K categories, producing a
  tiny smudge for "Select Subject" on botanical images.
- `BiRefNet` (SOTA, MIT-licensed) is a true background-removal model
  — it returns a subject/background alpha map directly, no
  label-stripping heuristics needed.
- HuggingFace inference API caps model size; running locally is free
  and removes the cap.
- Default is `birefnet-general` (973 MB, Swin-Large) — the most
  COMPLETE matte. The lite (Swin-Tiny) variant under-segments fine /
  translucent / backlit subjects (e.g. a fig leaf), leaving holes and
  dropped lobes; the full model fills them. Every BiRefNet variant in
  rembg runs at a **fixed 1024² input**, so the gain is backbone
  capacity, not resolution. On a low-RAM / CPU-only free tier, set
  `SEGMENT_MODEL=birefnet-general-lite` (~215 MB) for speed.
- The returned saliency matte is then **cleaned** (`clean_matte` in
  `main.py`): interior holes filled, stray specks removed, faint/
  translucent regions recovered — while the soft anti-aliased edges are
  preserved (no hard binarization anywhere in the pipeline).

## Quick start (local dev)

```bash
# 1. Install Python deps (Python 3.10+ recommended)
cd services/segment
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 2. Run the service on http://127.0.0.1:8001
python main.py
# or, with auto-reload:
uvicorn main:app --reload --port 8001
```

In a second terminal, start the Next.js app:

```bash
bun run dev
```

Add this to your `.env.local` (or use the project root defaults):

```env
# Local mask service (services/segment/main.py)
MASK_SERVICE_URL=http://127.0.0.1:8001
```

If the service is down, the Next.js route falls back to the existing
HuggingFace pipeline (`briaai/RMBG-2.0` → `briaai/RMBG-1.4` →
`segformer`/`detr-panoptic`).

## Endpoints

- `GET /health` — `{status, model, providers, max_upload_mb, sam2_available, sam2_model, depth_available, depth_model}`
- `POST /segment` — multipart `image` field, returns PNG with
  transparent background (alpha channel = subject mask)
- `POST /sam2/click` — multipart `image` + form `clicks` (JSON array
  of `[x, y, label]` tuples; `label` is 1 = include, 0 = exclude).
  Returns a greyscale PNG mask. Requires `torch` + `transformers` +
  `torchvision`; returns 501 if not installed.
- `POST /depth` — multipart `image` field, returns a greyscale PNG
  depth map at the input image's resolution. White = near, black = far.
  Per-image min-max normalisation is applied so the user can pick a
  meaningful near/far range on a 0..1 slider. Requires `torch` +
  `transformers`; returns 501 if not installed.

## Hardware support

| Host                    | Backend                          | Notes                                |
| ----------------------- | -------------------------------- | ------------------------------------ |
| Linux + NVIDIA GPU      | `CUDAExecutionProvider`          | `pip install -U "rembg[gpu]"`        |
| macOS Apple Silicon     | `CoreMLExecutionProvider`        | Auto-detected, no extras             |
| Anything else           | `CPUExecutionProvider`           | `pip install -U "rembg[cpu]"` (default) |

Detection is automatic on startup. Force a specific provider chain with
`SEGMENT_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider`.

## Environment variables

| Variable               | Default                                  | Purpose                              |
| ---------------------- | ---------------------------------------- | ------------------------------------ |
| `SEGMENT_MODEL`        | `birefnet-general`                       | rembg model name (most complete matte) |
| `SEGMENT_MAX_SIDE`     | `2048`                                   | Reject /segment inputs longer than this |
| `SEGMENT_EAGER_MODELS` | `0`                                      | Preload SAM 2 + Depth at startup (1) vs lazy (0) |
| `SUBJECT_MODEL`        | `yolo26n-seg.pt`                         | YOLO seg weights (NMS-free; needs ultralytics ≥ 8.4) |
| `SUBJECT_IMGSZ`        | `1280`                                   | YOLO letterbox size (small-subject recall) |
| `SUBJECT_CONF`         | `0.20`                                   | YOLO detection confidence floor      |
| `SUBJECT_IOU`          | `0.7`                                    | YOLO NMS IoU (keep high for crowds)  |
| `SUBJECT_MAX_DET`      | `300`                                    | Max instances per image (group photos) |
| `SUBJECT_SALIENT_INCLUDE` | `1`                                   | Include salient non-person instances |
| `SUBJECT_SALIENT_OVERLAP` | `0.50`                                | Min self-saliency for a salient instance |
| `SUBJECT_SALIENT_AREA_FRAC` | `0.005`                             | Min frame-area for a salient instance |
| `SAM2_MODEL_ID`        | `facebook/sam2-hiera-small`              | HF SAM 2 checkpoint                  |
| `SAM2_CACHE_MAX`       | `20`                                     | LRU image-embedding cache size       |
| `SAM2_MAX_CLICKS`      | `50`                                     | Max clicks per `/sam2/click` request |
| `DEPTH_MODEL_ID`       | `depth-anything/Depth-Anything-V2-Small-hf` | HF Depth Anything V2 checkpoint   |
| `DEPTH_CACHE_MAX`      | `20`                                     | LRU depth-map cache size             |
| `DEPTH_CACHE_MAX_PIXELS` | `4194304` (2048×2048)                | Per-entry pixel cap; larger maps skip the cache |
| `DEPTH_MAX_SIDE`       | `2048`                                   | Reject inputs whose longest side exceeds this |
| `SEGMENT_PROVIDERS`    | (auto)                                   | Comma-separated ONNX provider list   |
| `PORT`                 | `8001`                                   | HTTP port                            |
| `MAX_UPLOAD_MB`        | `24`                                     | Reject larger uploads                |
| `CORS_ORIGINS`         | `http://localhost:3000,...`              | Comma-separated allowed origins      |
| `HF_HOME`              | (system default)                         | Model cache directory                |

## Models

All listed models are bundled in rembg >= 2.0.59. Only the first three
`birefnet-*` entries are recommended for "Select Subject" — the
rest are tuned for narrower use cases.

| Model                    | License  | Size      | Use case                          |
| ------------------------ | -------- | --------- | --------------------------------- |
| `birefnet-general`       | MIT      | ~973 MB   | **Default** — most complete matte |
| `birefnet-general-lite`  | MIT      | ~215 MB   | Fast/low-RAM fallback (under-segments) |
| `birefnet-portrait`      | MIT      | ~215 MB   | Portraits                         |
| `isnet-general-use`      | MIT      | ~168 MB   | Strong edges                      |
| `u2net`                  | MIT      | ~176 MB   | Original rembg default            |
| `u2netp`                 | MIT      | ~4.7 MB   | Tiny, lower quality               |
| `u2net_human_seg`        | MIT      | ~176 MB   | Humans only                       |
| `u2net_cloth_seg`        | MIT      | ~176 MB   | Clothing / fashion                |
| `silueta`                | MIT      | ~43 MB    | Balanced small                    |
| `bria-rmbg`              | CC BY-NC | ~176 MB   | BRIA RMBG-1.4 (non-commercial)    |

## Free-tier / low-RAM deployment

The **matte model dominates RAM** (BiRefNet-general is ~1 GB resident; torch —
pulled in by YOLO — adds ~300 MB). SAM 2 + Depth now load **lazily** on first
use of their endpoint (`SEGMENT_EAGER_MODELS=0`, the default), so the core
"Select Subject" path stays light. To fit a small host:

```env
# ≈512 MB–1 GB host: lite matte + lazy heavy models
SEGMENT_MODEL=birefnet-general-lite   # ~215 MB (vs ~973 MB for -general)
SEGMENT_EAGER_MODELS=0
# Go smaller still by dropping YOLO (also drops the torch import, ~300 MB):
SUBJECT_DETECT=0                       # saliency-only Select Subject
```

The `clean_matte` cleanup (hole-fill, speck removal, soft edges) runs regardless
of model, so the lite matte still looks good. Even smaller rembg mattes:
`isnet-general-use` (~168 MB), `silueta` (~43 MB), `u2netp` (~4.7 MB).

**Subject detector:** the default is **YOLO26n-seg** (~6 MB, NMS-free, ~43%
faster CPU ONNX than YOLO11n) — set `SUBJECT_MODEL=yolo11n-seg.pt` to use the
older one. (A lighter/better MIT matte, **BEN2** ~220 MB, is a good future swap
but needs a small custom ONNX backend — not wired in yet.)

**Host:** Hugging Face Spaces (16 GB RAM free) fits the **full** stack as-is.
Render / Google Cloud Run free tiers need the lite recipe above.

## Deployment (free tier)

No Docker needed. Pick any free-tier Python host:

- **Render.com** — Web Service, free plan sleeps after 15 min idle
- **Fly.io** — free 3 shared VMs
- **Railway** — $5 / month credit
- **Hugging Face Spaces** — Docker SDK free CPU; BiRefNet fits the
  16 GB limit comfortably

Set the env vars above and expose port `8001`. Point your deployed
Next.js at the public URL via `MASK_SERVICE_URL`.

### Memory footprint

The service loads three models in memory:

| Asset                                | Approx. RAM |
| ------------------------------------ | ----------- |
| `rembg` model weights (default)      | ~215 MB     |
| `onnxruntime` core                   | ~150–250 MB |
| `torch` (CPU; can be 1–2 GB w/ GPU)  | ~200 MB     |
| `transformers` + `tokenizers`        | ~50 MB      |
| SAM 2 Hiera-Small weights            | ~180 MB     |
| Depth Anything V2 Small weights      | ~100 MB     |
| Image-embedding cache (20 entries)   | ~100–800 MB |
| Depth-map cache (20 entries)         | ~50–400 MB  |

Plan for **~1.5–2.5 GB** of RAM for the full BiRefNet + SAM 2 + Depth
service on CPU. Render's free 512 MB tier is too small; the 2 GB tier
is tight and will swap on large images. Hugging Face Spaces (16 GB) is
comfortable.

## Verifying the install

From the repo root:

```bash
bun run verify:segment    # BiRefNet /segment
bun run verify:semantic   # SAM 2 /sam2/click
```

Both synthesise a coloured circle on a contrasting background, send it
to the running service, and assert the returned mask is a
non-degenerate PNG (alpha covers the expected subject area). The SAM
2 test additionally checks the `X-Score` header for IoU confidence.

## SAM 2 click-to-select

The `/sam2/click` endpoint accepts a JSON array of clicks:

```json
[[x, y, 1], [x, y, 0]]
```

- `x, y` — pixel coordinates in the **original** image (not resized)
- `1` = positive (include this point) — used to define the subject
- `0` = negative (exclude this point) — used to refine the mask

Multiple clicks in one request are batched into a single mask
prediction; the model returns the highest-IoU candidate. Encoded
image embeddings are LRU-cached (`SAM2_CACHE_MAX`, default 20) by
pixel-content hash, so clicking again on the same image is sub-100ms.

Hardware (via `torch`): CUDA > MPS (Apple Silicon) > CPU. The image
encoder takes ~5-10s on CPU; the decoder is sub-100ms.

The "Semantic" tool UI in Pixxel will (Step 5) call this endpoint as
the user clicks, accumulating positive/negative points to refine the
mask in real time.

## Depth Anything V2 (Step 6)

The `/depth` endpoint runs monocular depth estimation on the input
image and returns a per-pixel depth map at the input's resolution:

- **White (255)** = nearest to the camera
- **Black (0)** = farthest
- **Per-image** min-max normalisation is applied so the user's
  near/far range sliders (0..1) line up with the actual depth spread

Hardware (via `torch`): CUDA > MPS (Apple Silicon) > CPU. Inference
takes ~0.5-2s on Apple Silicon (MPS), 1-4s on CPU, ~100-300ms on CUDA
for typical 1-2 MP images. Depth maps are LRU-cached (`DEPTH_CACHE_MAX`,
default 20) by pixel-content hash, so re-asking for the same image is
sub-100ms.

The "Depth" tool UI in Pixxel calls this endpoint once per image (the
depth map is whole-image, not click-driven), then layers a depth-range
mask on top via the megashader. Users pick a near/far range to select
foreground, midground, or background for adjustments.
