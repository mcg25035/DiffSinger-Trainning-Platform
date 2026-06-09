FROM pytorch/pytorch:2.1.2-cuda11.8-cudnn8-runtime

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir fastapi uvicorn python-multipart numpy
# Install matching torchaudio version
RUN pip install --no-cache-dir torchaudio==2.1.2 --index-url https://download.pytorch.org/whl/cu118

# Pre-cache/download MMS_FA model files during docker build
RUN python -c "import torchaudio; torchaudio.pipelines.MMS_FA.get_model()"

COPY ./app /app

EXPOSE 8002

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8002"]
