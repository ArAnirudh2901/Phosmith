FROM python:3.11-slim

WORKDIR /app

# OpenCV runtime libs (used by /shape/fill).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

# Install deps first so this layer caches unless requirements change.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Model pre-download ────────────────────────────────────────────────────────
# Bake LaMa into the image so the container starts with its weights
# (simple-lama-inpainting keeps them under /root/.cache).
COPY preload_models.py .
RUN python preload_models.py

# Copy source AFTER the model layer so edits don't bust the cache.
COPY . .

ENV MODEL_CACHE_DIR=/app/model_cache

# Hugging Face Spaces expects the app to run on port 7860.
ENV PORT=7860
EXPOSE 7860

CMD ["python", "main.py"]
