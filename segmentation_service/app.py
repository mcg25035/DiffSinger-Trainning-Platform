from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pipeline import SegmentationPipeline


CACHE_SCHEMA_VERSION = "red-boundary-cache-v1"


def validated_wav_path(wav_root: Path, filename: str) -> Path:
    if filename != Path(filename).name or Path(filename).suffix.lower() != ".wav":
        raise HTTPException(status_code=400, detail="invalid WAV filename")
    root = wav_root.resolve()
    try:
        candidate = (root / filename).resolve(strict=True)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="WAV not found") from None
    if candidate.parent != root or not candidate.is_file():
        raise HTTPException(status_code=400, detail="invalid WAV path")
    return candidate


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def algorithm_build_id() -> str:
    configured = os.environ.get("BOUNDARY_SERVICE_BUILD_ID")
    if configured:
        return configured
    algorithm_root = Path(os.environ.get("ALGORITHM_ROOT", "/algorithm"))
    digest = hashlib.sha256()
    for filename in ("pipeline.py", "segment_regions.py"):
        path = algorithm_root / filename
        digest.update(filename.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def cache_identity(filename: str, wav_sha256: str, build_id: str, parameters: dict[str, Any]):
    identity = {
        "filename": filename,
        "wav_sha256": wav_sha256,
        "build_id": build_id,
        "parameters": parameters,
    }
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest(), identity


def read_cache(path: Path, identity: dict[str, Any]):
    try:
        envelope = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if envelope.get("schema_version") != CACHE_SCHEMA_VERSION or envelope.get("identity") != identity:
        return None
    return envelope.get("data")


def write_cache(path: Path, envelope: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as handle:
            temporary = Path(handle.name)
            json.dump(envelope, handle, separators=(",", ":"), allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def overlay_data(result: dict[str, Any]):
    height, width = result["stft_image"].shape
    audio = result["audio_metadata"]
    return {
        "schema_version": "red-boundary-overlay-v1",
        "audio": {
            "first_stft_center_seconds": float(audio["first_stft_center_seconds"]),
            "last_stft_center_seconds": float(audio["last_stft_center_seconds"]),
        },
        "image": {"width": int(width), "height": int(height)},
        "boundary_paths": [
            {
                "boundary_id": f"red_{index:02d}",
                "y_start_inclusive": 0,
                "x_by_y": boundary.astype(int).tolist(),
            }
            for index, boundary in enumerate(result["red_boundaries"], start=1)
        ],
    }


def create_app() -> FastAPI:
    wav_root = Path(os.environ.get("WAV_ROOT", "/data/wavs"))
    cache_root = Path(os.environ.get("CACHE_ROOT", "/data/cache"))
    build_id = algorithm_build_id()
    pipeline = SegmentationPipeline(
        stft_params={"n_fft": 4096, "hop_ms": 1.0, "max_frequency_hz": 4000.0}
    )
    parameters = {"detector": pipeline.detector_params, "stft": pipeline.stft_params}
    pipeline_lock = asyncio.Lock()
    file_locks: dict[str, asyncio.Lock] = {}

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await asyncio.to_thread(cache_root.mkdir, parents=True, exist_ok=True)
        yield

    app = FastAPI(title="DiffSinger segmentation service", lifespan=lifespan)

    async def details(filename: str):
        wav_path = validated_wav_path(wav_root, filename)
        wav_sha256 = await asyncio.to_thread(sha256_file, wav_path)
        key, identity = cache_identity(filename, wav_sha256, build_id, parameters)
        return wav_path, cache_root / f"{key}.json", identity

    @app.get("/health")
    async def health():
        return {"status": "ok", "build_id": build_id}

    @app.get("/red-boundaries/manifest")
    async def manifest():
        entries = []
        for path in cache_root.glob("*.json"):
            try:
                envelope = json.loads(path.read_text(encoding="utf-8"))
                identity = envelope["identity"]
                if identity.get("build_id") == build_id and identity.get("parameters") == parameters:
                    entries.append({
                        "filename": identity["filename"],
                        "wav_sha256": identity["wav_sha256"],
                        "created_at": envelope["created_at"],
                    })
            except (KeyError, json.JSONDecodeError, OSError):
                continue
        return {"build_id": build_id, "entries": entries}

    @app.post("/red-boundaries/{filename}")
    async def compute(filename: str):
        lock = file_locks.setdefault(filename, asyncio.Lock())
        async with lock:
            wav_path, cache_path, identity = await details(filename)
            cached = await asyncio.to_thread(read_cache, cache_path, identity)
            if cached is not None:
                return cached
            async with pipeline_lock:
                result = await asyncio.to_thread(pipeline.run, wav_path)
            if await asyncio.to_thread(sha256_file, wav_path) != identity["wav_sha256"]:
                raise HTTPException(status_code=409, detail="WAV changed during processing")
            data = overlay_data(result)
            await asyncio.to_thread(write_cache, cache_path, {
                "schema_version": CACHE_SCHEMA_VERSION,
                "identity": identity,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "data": data,
            })
            return data

    @app.get("/red-boundaries/{filename}")
    async def cached(filename: str):
        lock = file_locks.setdefault(filename, asyncio.Lock())
        async with lock:
            _, cache_path, identity = await details(filename)
            data = await asyncio.to_thread(read_cache, cache_path, identity)
            if data is None:
                raise HTTPException(status_code=404, detail="boundary cache miss")
            return data

    return app


app = create_app()
