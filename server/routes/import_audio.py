from __future__ import annotations

import json
import math
import wave
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import ValidationError

from server.schemas import GenerateRequest, GenerationResult, validate_json_compatible
from server.registry import settings, storage
from server.storage import safe_stem


router = APIRouter()
MAX_IMPORT_METADATA_BYTES = 1_000_000


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number: {value}")


def _metadata_dict(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        raw_size = len(raw.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise HTTPException(status_code=400, detail="metadata must contain valid Unicode") from exc
    if raw_size > MAX_IMPORT_METADATA_BYTES:
        raise HTTPException(status_code=413, detail="metadata exceeds the 1 MB limit")
    try:
        data = json.loads(raw, parse_constant=_reject_json_constant)
    except (json.JSONDecodeError, ValueError, RecursionError) as exc:
        raise HTTPException(status_code=400, detail="metadata must be valid JSON") from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="metadata must be a JSON object")
    try:
        validate_json_compatible(data, label="import metadata")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return data


def _list_value(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _safe_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(parsed) or not parsed.is_integer():
        return None
    return int(parsed)


def _safe_float(value: Any, fallback: float) -> float:
    if value is None or value == "":
        return fallback
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else fallback
    except (TypeError, ValueError, OverflowError):
        return fallback


def _inspect_uploaded_audio(path: Path, suffix: str) -> tuple[float | None, int | None]:
    try:
        with path.open("rb") as handle:
            header = handle.read(16)
    except OSError as exc:
        raise HTTPException(status_code=422, detail=f"cannot inspect uploaded audio: {exc}") from exc

    signatures = {
        ".aif": header.startswith(b"FORM") and header[8:12] in {b"AIFF", b"AIFC"},
        ".aiff": header.startswith(b"FORM") and header[8:12] in {b"AIFF", b"AIFC"},
        ".flac": header.startswith(b"fLaC"),
        ".m4a": len(header) >= 12 and header[4:8] == b"ftyp",
        ".mp3": header.startswith(b"ID3")
        or (len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xE0) == 0xE0),
        ".ogg": header.startswith(b"OggS"),
        ".opus": header.startswith(b"OggS"),
        ".wav": header.startswith(b"RIFF") and header[8:12] == b"WAVE",
        ".webm": header.startswith(b"\x1aE\xdf\xa3"),
    }
    if not signatures.get(suffix, False):
        raise HTTPException(
            status_code=422,
            detail=f"uploaded content does not match the {suffix} file type",
        )
    if suffix != ".wav":
        return None, None

    try:
        with wave.open(str(path), "rb") as wav:
            if wav.getcomptype() != "NONE":
                raise HTTPException(status_code=422, detail="compressed WAV audio is not supported")
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            frame_count = wav.getnframes()
            if (
                not 1 <= channels <= 32
                or sample_width not in {1, 2, 3, 4}
                or not 1 <= sample_rate <= 768_000
                or frame_count <= 0
            ):
                raise HTTPException(status_code=422, detail="uploaded WAV parameters are invalid")
            duration = frame_count / float(sample_rate)
            if duration > 380.0:
                raise HTTPException(status_code=422, detail="uploaded WAV exceeds 380 seconds")
            remaining = frame_count
            bytes_read = 0
            while remaining:
                chunk_frames = min(remaining, 65_536)
                chunk = wav.readframes(chunk_frames)
                if not chunk:
                    break
                bytes_read += len(chunk)
                remaining -= len(chunk) // (channels * sample_width)
    except HTTPException:
        raise
    except (EOFError, OSError, wave.Error) as exc:
        raise HTTPException(status_code=422, detail=f"uploaded WAV is invalid: {exc}") from exc
    if bytes_read != frame_count * channels * sample_width:
        raise HTTPException(status_code=422, detail="uploaded WAV sample data is truncated")
    return duration, sample_rate


@router.post("/audio/import", response_model=GenerationResult)
async def import_audio(
    file: UploadFile = File(...),
    metadata: str = Form("{}"),
) -> GenerationResult:
    data = _metadata_dict(metadata)
    stem = safe_stem(data.get("output_name") or Path(file.filename or "audio").stem, fallback="import")
    suffix = Path(file.filename or "").suffix.lower() or ".wav"
    if suffix not in {
        ".aif",
        ".aiff",
        ".flac",
        ".m4a",
        ".mp3",
        ".ogg",
        ".opus",
        ".wav",
        ".webm",
    }:
        raise HTTPException(status_code=422, detail=f"unsupported audio file type: {suffix}")

    provider = str(data.get("provider") or "mock")
    model = str(data.get("model") or "browser-import")
    duration = max(0.1, min(380.0, _safe_float(data.get("duration"), 0.1)))
    seed = _safe_int(data.get("seed"))
    seed = seed if seed is not None else -1
    steps = _safe_int(data.get("steps"))
    steps = steps if steps is not None else 1
    cfg_scale = _safe_float(data.get("cfg_scale"), 1.0)
    lineage = data.get("lineage") if isinstance(data.get("lineage"), dict) else {}
    source = data.get("source") if isinstance(data.get("source"), dict) else {}
    source_type = str(data.get("source_type") or lineage.get("source_type") or source.get("type") or "import")
    source = {**source, "type": source_type}

    try:
        request = GenerateRequest(
            provider=provider,
            model=model,
            prompt=str(data.get("prompt") or ""),
            negative_prompt=str(data.get("negative_prompt") or ""),
            duration=duration,
            steps=steps,
            cfg_scale=cfg_scale,
            seed=seed,
            batch_size=1,
            lora=_list_value(data.get("lora")),
            output_name=stem,
            culture_id=data.get("culture_id"),
            tags=[str(item) for item in _list_value(data.get("tags"))],
            notes=data.get("notes"),
            ratings=data.get("ratings") if isinstance(data.get("ratings"), dict) else {},
            waveform_preview=data.get("waveform_preview"),
            source=source,
            latents=data.get("latents") if isinstance(data.get("latents"), dict) else {},
            latent_file=data.get("latent_file"),
            latent_fingerprint=data.get("latent_fingerprint"),
            lineage={**lineage, "source_type": source_type},
        )
    except ValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail=exc.errors(
                include_url=False,
                include_context=False,
                include_input=False,
            ),
        ) from exc
    try:
        uploaded_path, uploaded_size = await storage.save_upload_stream(
            filename=file.filename or f"{stem}{suffix}",
            upload=file,
            max_bytes=settings.max_upload_bytes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    if uploaded_size == 0:
        uploaded_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="uploaded audio is empty")

    try:
        detected_duration, detected_sample_rate = _inspect_uploaded_audio(uploaded_path, suffix)
    except HTTPException:
        uploaded_path.unlink(missing_ok=True)
        raise
    if detected_duration is not None:
        duration = detected_duration
        request = request.model_copy(update={"duration": duration})

    job_id = storage.new_job("audio-import", request.model_dump(exclude={"job_id"}))
    request = request.model_copy(update={"job_id": job_id})
    audio_path, metadata_path = storage.reserve_paths(
        request=request,
        mode="audio-import",
        job_id=job_id,
        extension=suffix,
    )[0]
    sample_rate = detected_sample_rate or _safe_int(data.get("sample_rate"))
    if sample_rate is not None and not 1 <= sample_rate <= 768_000:
        sample_rate = None

    try:
        uploaded_path.replace(audio_path)
        extra = {
            "imported": True,
            "source_type": source_type,
            "source": source,
            "organism": data.get("organism")
            if isinstance(data.get("organism"), dict)
            else None,
            "image": data.get("image") if isinstance(data.get("image"), dict) else None,
        }
        storage.write_metadata(
            metadata_path=metadata_path,
            request=request,
            mode="audio-import",
            provider=provider,
            model=model,
            seed=seed,
            output_audio_path=audio_path,
            sample_rate=sample_rate,
            status="done",
            extra=extra,
        )
    except Exception as exc:
        uploaded_path.unlink(missing_ok=True)
        audio_path.unlink(missing_ok=True)
        metadata_path.unlink(missing_ok=True)
        storage.record_result(
            GenerationResult(
                job_id=job_id,
                status="error",
                error=str(exc),
                provider=provider,
                model=model,
                mode="audio-import",
            )
        )
        raise
    result = GenerationResult(
        job_id=job_id,
        status="done",
        audio_files=[storage.relative_path(audio_path)],
        metadata_files=[storage.relative_path(metadata_path)],
        seed=seed,
        duration=duration,
        sample_rate=sample_rate,
        provider=provider,
        model=model,
        mode="audio-import",
    )
    storage.record_result(result)
    return result
