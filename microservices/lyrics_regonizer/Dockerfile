ARG BASE_IMAGE=nvidia/cuda:11.0.3-base-ubuntu20.04
FROM ${BASE_IMAGE}

ENV PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    UV_HTTP_TIMEOUT=600

RUN apt-get update && apt-get install -y \
    python3-pip python3-dev ffmpeg git curl && \
    rm -rf /var/lib/apt/lists/*

# 安裝 uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# --- 核心優化：建立 pip 轉發器 ---
RUN echo '#!/bin/bash\nuv pip "$@"' > /usr/local/bin/pip && \
    chmod +x /usr/local/bin/pip && \
    ln -sf /usr/local/bin/pip /usr/local/bin/pip3

WORKDIR /app

# 接收來自 .env 的版本參數
ARG PYTORCH_INDEX=https://download.pytorch.org/whl/cu110
ARG TORCH_VERSION=1.7.1+cu110
ARG TORCHAUDIO_VERSION=0.7.2

# 1. 使用參數化安裝核心架構
RUN uv pip install --system --no-cache \
    torch==${TORCH_VERSION} \
    torchaudio==${TORCHAUDIO_VERSION} \
    -f https://download.pytorch.org/whl/torch_stable.html

# 2. 安裝其他組件，並強制鎖定 torch 版本避免被其他庫升級
RUN uv pip install --system --no-cache \
    "torch==${TORCH_VERSION}" \
    funasr \
    modelscope \
    huggingface-hub \
    fastapi \
    uvicorn \
    python-multipart \
    pykakasi \
    librosa \
    soundfile \
    scipy \
    tensorboardX \
    sentencepiece \
    sacremoses \
    rotary_embedding_torch \
    einops \
    -f https://download.pytorch.org/whl/torch_stable.html

# 3. 預下載模型
RUN python3 -c "from funasr import AutoModel; AutoModel(model='FunAudioLLM/SenseVoiceSmall', hub='hf', trust_remote_code=True)"

COPY app.py .
COPY transcribe_to_hiragana.py .

EXPOSE 8000
CMD ["python3", "app.py"]
