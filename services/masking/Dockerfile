FROM python:3.11-slim

WORKDIR /app

# Install deps first so this layer caches unless requirements change.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Model pre-download ────────────────────────────────────────────────────────
# Bake Depth into the image so the container starts with its weights.
ARG DEPTH_MODEL_ID=depth-anything/Depth-Anything-V2-Small-hf

COPY preload_models.py .
RUN DEPTH_MODEL_ID=$DEPTH_MODEL_ID python preload_models.py

# Copy source AFTER the model layer so edits don't bust the cache.
COPY . .

ENV MODEL_CACHE_DIR=/app/model_cache

# Hugging Face Spaces serves on port 7860.
ENV PORT=7860
EXPOSE 7860

CMD ["python", "main.py"]
