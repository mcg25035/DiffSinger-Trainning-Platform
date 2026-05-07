# Use NVIDIA CUDA base image for GPU support
FROM nvidia/cuda:12.1.0-base-ubuntu22.04

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    UV_HTTP_TIMEOUT=300 \
    UV_SYSTEM_PYTHON=1

# Install Python and system dependencies
RUN apt-get update && apt-get install -y \
    python3-pip \
    python3-dev \
    ffmpeg \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Set working directory
WORKDIR /app

# Install Python packages using uv
# Note: We install torch first to ensure CUDA compatibility
RUN uv pip install --no-cache torch torchaudio --index-url https://download.pytorch.org/whl/cu121
RUN uv pip install --no-cache funasr modelscope huggingface-hub fastapi uvicorn python-multipart pykakasi

# Copy the application code
COPY app.py .
COPY transcribe_to_hiragana.py .

# Expose the port
EXPOSE 8000

# Pre-download the model to the image
RUN python3 -c "from funasr import AutoModel; AutoModel(model='FunAudioLLM/SenseVoiceSmall', hub='hf', trust_remote_code=True)"

# Run the application
CMD ["python3", "app.py"]
