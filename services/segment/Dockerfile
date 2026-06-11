FROM python:3.11-slim

WORKDIR /app

# Install system dependencies required for OpenCV
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the Python service code
COPY . .

# Hugging Face Spaces expects the app to run on port 7860
ENV PORT=7860
EXPOSE 7860

# Run the FastAPI server
CMD ["python", "main.py"]
