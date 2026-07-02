FROM python:3.11-slim

WORKDIR /app

# OpenCV runtime libs (used by rembg + clean_matte).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

# Install deps first so this layer caches unless requirements change.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# SAM 3.1 is gated and not on PyPI. Uncomment to bake it in; you must also pass
# a HF token (with accepted facebook/sam3.1 terms) as a build secret. Left off
# by default so the image builds without credentials — SAM 3 loads at runtime.
# RUN pip install --no-cache-dir "git+https://github.com/facebookresearch/sam3.git"

# ── Model pre-download ────────────────────────────────────────────────────────
# Bake rembg + Depth into the image. SAM 3.1 is best-effort (gated) — skipped at
# build time without a token and downloaded on first request instead.
ARG SEGMENT_MODEL=isnet-general-use
ARG DEPTH_MODEL_ID=depth-anything/Depth-Anything-V2-Small-hf
ARG SAM3_MODEL_ID=facebook/sam3.1

COPY preload_models.py .
RUN SEGMENT_MODEL=$SEGMENT_MODEL \
    DEPTH_MODEL_ID=$DEPTH_MODEL_ID \
    SAM3_MODEL_ID=$SAM3_MODEL_ID \
    python preload_models.py

# Copy source AFTER the model layer so edits don't bust the cache.
COPY . .

ENV MODEL_CACHE_DIR=/app/model_cache

# Hugging Face Spaces serves on port 7860.
ENV PORT=7860
EXPOSE 7860

CMD ["python", "main.py"]
