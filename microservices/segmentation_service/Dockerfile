FROM python:3.12-slim

ARG SEGMENTATION_ALGORITHM_REF=ac1dd3977bb76f84a6258776a90a3f0bc19f8b01

RUN apt-get update \
    && apt-get install --no-install-recommends -y git libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.lock .
RUN pip install --no-cache-dir -r requirements.lock

COPY app.py .
RUN git clone https://github.com/mcg25035/Singing-Voice-Segmentation-Algorithm.git /algorithm \
    && git -C /algorithm checkout --detach "$SEGMENTATION_ALGORITHM_REF" \
    && rm -rf /algorithm/.git

ENV PYTHONPATH=/algorithm \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WAV_ROOT=/data/wavs \
    CACHE_ROOT=/data/cache

EXPOSE 8010

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8010", "--workers", "1"]
