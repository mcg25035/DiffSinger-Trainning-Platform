FROM python:3.12-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.lock .
RUN pip install --no-cache-dir -r requirements.lock

COPY app.py .
ADD https://raw.githubusercontent.com/mcg25035/Singing-Voice-Segmentation-Algorithm/ac1dd3977bb76f84a6258776a90a3f0bc19f8b01/pipeline.py /algorithm/pipeline.py
ADD https://raw.githubusercontent.com/mcg25035/Singing-Voice-Segmentation-Algorithm/ac1dd3977bb76f84a6258776a90a3f0bc19f8b01/segment_regions.py /algorithm/segment_regions.py

ENV PYTHONPATH=/algorithm \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WAV_ROOT=/data/wavs \
    CACHE_ROOT=/data/cache

EXPOSE 8010

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8010", "--workers", "1"]
