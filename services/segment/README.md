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

# Phosmith Mask Service

A lightweight, production-ready FastAPI service designed to run SOTA computer vision models on CPU/GPU. This service is optimized for deployment as a **Hugging Face Space (Docker SDK)** and connects with your frontend (e.g. Next.js on Vercel).

It hosts three core models:
1. **BiRefNet** (`rembg` library, ONNX Runtime) — high-fidelity background removal for the "Select Subject" tool.
2. **SAM 2 Hiera-Small** (`transformers` + `torch`) — click-to-select semantic masking for interactive segmenting.
3. **Depth Anything V2 Small** (`transformers` + `torch`) — monocular depth estimation for depth-based effects.

---

## 🚀 Quick Deployment to Hugging Face Spaces

This repository contains a [Dockerfile](file:///Users/anirudharavalli/Web_Dev/NextJS/phosmith/services/segment/Dockerfile) pre-configured for Hugging Face Spaces. It automatically binds to port `7860` as required.

### Step-by-Step Space Creation
1. **Create a New Space**:
   - Go to [Hugging Face Spaces](https://huggingface.co/spaces) and click **New Space**.
   - Select **Docker** as the SDK.
   - Choose **Blank** or **Docker** template.
   - Select your hardware (the Free CPU Basic tier with 16 GB RAM is fully sufficient).
   - Set Space visibility to **Public** so that Vercel serverless routes can query it directly.

2. **Upload the Files**:
   Initialize a git repository in this directory or upload these files directly via the Hugging Face web interface:
   - `Dockerfile`
   - `requirements.txt`
   - `main.py`
   - `yolo26n-seg.pt` (optional, YOLO weights will download automatically if not present)

3. **Get your Endpoint**:
   Once built and showing **Running**, your public API base URL is:
   ```text
   https://aranirudh-phosmith.hf.space
   ```

   Provide this URL as the `MASK_SERVICE_URL` environment variable in Vercel.

---

## ⚙️ Environment Variables

Configure these settings under the **Settings ➔ Variables and secrets** section in your Hugging Face Space:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `7860` | Server listening port (do not change for Hugging Face) |
| `SEGMENT_MODEL` | `birefnet-general` | Background removal model. For faster/low-RAM performance, use `birefnet-general-lite` (~215 MB) |
| `SEGMENT_EAGER_MODELS` | `0` | Preload SAM 2 + Depth at startup (`1`) vs lazy load on first request (`0`). Recommended: `0` to keep start times fast. |
| `SUBJECT_MODEL` | `yolo26n-seg.pt` | YOLO segmentation model for subject detection |
| `SAM2_MODEL_ID` | `facebook/sam2-hiera-small` | Hugging Face ID for the SAM 2 checkpoint |
| `DEPTH_MODEL_ID` | `depth-anything/Depth-Anything-V2-Small-hf` | Hugging Face ID for the Depth Anything V2 checkpoint |
| `CORS_ORIGINS` | `*` | Comma-separated list of allowed CORS origins |
| `MAX_UPLOAD_MB` | `24` | Maximum allowable payload size (in MB) |

---

## 📡 API Endpoints

Once running, the service exposes the following REST endpoints:

### 1. Health Probe (`GET /health`)
Verifies the service status, hardware acceleration detection, and model availability.
* **Response**: `200 OK`
* **Payload**:
  ```json
  {
    "status": "healthy",
    "model": "birefnet-general",
    "sam2_available": true,
    "depth_available": true
  }
  ```

### 2. Saliency Segmentation (`POST /segment`)
Removes background and extracts a subject mask.
* **Payload**: Multipart Form-Data with an `image` field.
* **Response**: PNG image with transparent background (alpha channel = subject matte).

### 3. Click-to-Select / SAM 2 (`POST /sam2/click`)
Uses SAM 2 to predict a mask based on positive and negative click coordinates.
* **Payload**: 
  - `image`: Multipart image file.
  - `clicks`: JSON array of `[x, y, label]` tuples (e.g. `[[250, 480, 1], [120, 200, 0]]` where `1` = include, `0` = exclude).
* **Response**: Grayscale PNG mask.

### 4. Depth Estimation (`POST /depth`)
Generates a normalized grayscale depth map.
* **Payload**: Multipart Form-Data with an `image` field.
* **Response**: Grayscale PNG (white = near, black = far).

---

## 💻 Local Development & Testing

If you want to test the service locally before pushing changes:

```bash
# 1. Navigate and build virtual environment
cd services/segment
python -m venv .venv
source .venv/bin/activate  # On Windows use: .venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Start local development server
uvicorn main:app --reload --port 8001
```

Verify your local server works using the verification scripts in the project root:
```bash
bun run verify:segment
bun run verify:semantic
```
