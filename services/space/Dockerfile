# Phosmith's Hugging Face Space: services/segment (LaMa, /shape/fill) and
# services/masking (Depth Anything V2, SlimSAM) in one container — see main.py.
# Assembled and uploaded by `bun run space:deploy`.
FROM python:3.11-slim

WORKDIR /app

# OpenCV runtime libs (used by /shape/fill).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

# Install deps first so this layer caches unless requirements change.
# CPU wheels for torch: the Space has no GPU, and the default CUDA build pulls
# ~4 GB of nvidia-* libraries into the image.
COPY requirements.txt .
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple -r requirements.txt

# ── Model pre-download ────────────────────────────────────────────────────────
# Every model baked into the image so the container starts with its weights:
# LaMa under /root/.cache (torch hub), Depth and SlimSAM under /app/model_cache (HF_HOME).
ARG DEPTH_MODEL_ID=depth-anything/Depth-Anything-V2-Small-hf
ARG SAM_MODEL_ID=nielsr/slimsam-77-uniform
COPY preload_lama.py preload_depth.py ./
RUN python preload_lama.py && DEPTH_MODEL_ID=$DEPTH_MODEL_ID SAM_MODEL_ID=$SAM_MODEL_ID python preload_depth.py

# Copy source AFTER the model layer so edits don't bust the cache.
COPY . .

ENV MODEL_CACHE_DIR=/app/model_cache

# Hugging Face Spaces serves on port 7860.
ENV PORT=7860
EXPOSE 7860

CMD ["python", "main.py"]
