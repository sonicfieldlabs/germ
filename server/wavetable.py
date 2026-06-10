from __future__ import annotations

import array
import json
import math
import re
import sys
import wave
from pathlib import Path
from typing import Any
from uuid import uuid4

from server.registry import storage
from server.schemas import GenerateRequest, WavetableConvertRequest, WavetableImportRequest
from server.storage import safe_stem, utc_now_iso


SUPPORTED_FRAME_SIZES = {512, 1024, 2048, 4096}
WAVETABLE_SAMPLE_RATE = 44100
WAVETABLE_TYPE = "germ_wavetable"


def note_to_frequency(note: str) -> float:
    match = re.fullmatch(r"\s*([A-Ga-g])([#b]?)(-?\d+)\s*", note or "")
    if not match:
        raise ValueError(f"invalid note name: {note}")
    note_name, accidental, octave_text = match.groups()
    semitone = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[note_name.upper()]
    if accidental == "#":
        semitone += 1
    elif accidental == "b":
        semitone -= 1
    midi_note = (int(octave_text) + 1) * 12 + semitone
    return 440.0 * (2.0 ** ((midi_note - 69) / 12.0))


def convert_audio_to_wavetable(request: WavetableConvertRequest) -> dict[str, Any]:
    if request.frame_size not in SUPPORTED_FRAME_SIZES:
        raise ValueError("frame_size must be one of 512, 1024, 2048, or 4096")
    if request.extraction_mode != "simple":
        raise ValueError("only simple wavetable extraction is implemented in this phase")
    source_path = storage.resolve_existing_input_audio_path(
        request.input_audio_path,
        label="input audio",
    )
    if source_path.suffix.lower() != ".wav":
        raise ValueError("wavetable conversion currently requires PCM WAV input")
    source_metadata = _read_source_metadata(request.metadata_path)
    samples, sample_rate = _read_mono_pcm_wav(source_path)
    frames = _extract_simple_frames(
        samples=samples,
        frame_count=request.frame_count,
        frame_size=request.frame_size,
    )
    descriptors = dict(_LAST_DESCRIPTORS)
    name = request.name or request.output_name or source_metadata.get("prompt") or source_path.stem
    metadata = _metadata_for_table(
        name=name,
        frame_size=request.frame_size,
        frame_count=request.frame_count,
        sample_rate=sample_rate,
        root_note=request.root_note,
        source_audio_path=storage.relative_path(source_path),
        source_metadata_path=request.metadata_path,
        source_metadata=source_metadata,
        runtime=str(source_metadata.get("runtime") or "imported"),
        extraction_mode=request.extraction_mode,
        tags=request.tags,
        operation="audio_to_wavetable",
        operation_params={
            **request.operation_params,
            "frame_count": request.frame_count,
            "frame_size": request.frame_size,
            "extraction_mode": request.extraction_mode,
        },
        lineage={
            **request.lineage,
            "parents": _lineage_parents(request.lineage, source_metadata),
        },
    )
    metadata["descriptors"] = descriptors
    return write_wavetable(frames, metadata)


def import_wav_stack(request: WavetableImportRequest) -> dict[str, Any]:
    if request.frame_size not in SUPPORTED_FRAME_SIZES:
        raise ValueError("frame_size must be one of 512, 1024, 2048, or 4096")
    source_path = storage.resolve_existing_input_audio_path(
        request.input_audio_path,
        label="input audio",
    )
    if source_path.suffix.lower() != ".wav":
        raise ValueError("wavetable import currently requires PCM WAV input")
    samples, sample_rate = _read_mono_pcm_wav(source_path)
    samples = _remove_dc(samples)
    samples = _normalize(samples)
    frame_count = max(1, len(samples) // request.frame_size)
    frames: list[float] = []
    frame_rows: list[list[float]] = []
    for index in range(frame_count):
        start = index * request.frame_size
        frame = samples[start : start + request.frame_size]
        if len(frame) < request.frame_size:
            frame = [*frame, *([0.0] * (request.frame_size - len(frame)))]
        frame = _normalize(_remove_dc(frame))
        frame_rows.append(frame)
        frames.extend(frame)
    metadata = _metadata_for_table(
        name=request.name or request.output_name or source_path.stem,
        frame_size=request.frame_size,
        frame_count=frame_count,
        sample_rate=sample_rate,
        root_note=request.root_note,
        source_audio_path=storage.relative_path(source_path),
        source_metadata_path=None,
        source_metadata={},
        runtime="imported",
        extraction_mode="simple",
        tags=request.tags,
        operation="import_wav_stack",
        operation_params={
            "frame_count": frame_count,
            "frame_size": request.frame_size,
            "input_audio_path": storage.relative_path(source_path),
        },
        lineage=request.lineage,
    )
    metadata["descriptors"] = _compute_descriptors(frame_rows)
    return write_wavetable(frames, metadata)


def render_wavetable_to_wav(
    *,
    wavetable_id: str,
    duration: float,
    root_note: str | None,
    note: str,
    scan_start: float,
    scan_end: float,
    gain: float,
    output_name: str | None,
    tags: list[str] | None = None,
    lineage: dict[str, Any] | None = None,
) -> tuple[Path, Path, dict[str, Any]]:
    table = load_wavetable(wavetable_id)
    metadata = table["metadata"]
    frames = table["frames"]
    frame_count = int(metadata["frame_count"])
    frame_size = int(metadata["frame_size"])
    frequency = note_to_frequency(note)
    root = root_note or metadata.get("root_note") or "C3"
    note_to_frequency(root)
    sample_rate = WAVETABLE_SAMPLE_RATE
    total_frames = max(1, int(duration * sample_rate))
    scan_start = max(0.0, min(1.0, scan_start))
    scan_end = max(0.0, min(1.0, scan_end))
    gain = max(0.0, min(2.0, gain))
    pcm = array.array("h")
    phase = 0.0
    for sample_index in range(total_frames):
        t = sample_index / max(1, total_frames - 1)
        table_pos = scan_start + ((scan_end - scan_start) * t)
        frame_pos = max(0.0, min(frame_count - 1, table_pos * (frame_count - 1)))
        lo = int(math.floor(frame_pos))
        hi = min(frame_count - 1, lo + 1)
        mix = frame_pos - lo
        sample_lo = _sample_frame(frames, lo, phase, frame_size)
        sample_hi = _sample_frame(frames, hi, phase, frame_size)
        value = ((sample_lo * (1.0 - mix)) + (sample_hi * mix)) * gain
        pcm_value = _clip_pcm16(value)
        pcm.append(pcm_value)
        pcm.append(pcm_value)
        phase = (phase + (frequency / sample_rate)) % 1.0
    if sys.byteorder != "little":
        pcm.byteswap()

    request = GenerateRequest(
        provider="mock",
        model="wavetable-render",
        prompt=f"Rendered wavetable {metadata.get('name') or wavetable_id}",
        negative_prompt="",
        duration=duration,
        steps=1,
        cfg_scale=1.0,
        seed=-1,
        batch_size=1,
        output_name=output_name or f"{metadata.get('name') or wavetable_id}_render",
        tags=tags or ["wavetable-render"],
        source={
            "type": "wavetable",
            "wavetable_id": wavetable_id,
            "metadata_path": metadata.get("metadata_path"),
            "data_path": metadata.get("data_path"),
        },
        lineage={
            **(lineage or {}),
            "parents": [wavetable_id],
            "operation": "wavetable-render",
            "source_type": "wavetable",
            "operation_params": {
                "wavetable_id": wavetable_id,
                "note": note,
                "root_note": root,
                "scan_start": scan_start,
                "scan_end": scan_end,
                "gain": gain,
            },
        },
    )
    job_id = storage.new_job("wavetable-render", request.model_dump(exclude={"job_id"}))
    request = request.model_copy(update={"job_id": job_id})
    audio_path, metadata_path = storage.reserve_paths(
        request=request,
        mode="wavetable-render",
        job_id=job_id,
        extension=".wav",
    )[0]
    _write_pcm16_wav(
        audio_path,
        pcm.tobytes(),
        channels=2,
        sample_rate=sample_rate,
    )
    audio_metadata = storage.write_metadata(
        metadata_path=metadata_path,
        request=request,
        mode="wavetable-render",
        provider="mock",
        model="wavetable-render",
        seed=-1,
        output_audio_path=audio_path,
        sample_rate=sample_rate,
        status="done",
        extra={
            "wavetable_id": wavetable_id,
            "wavetable_metadata_path": metadata.get("metadata_path"),
            "wavetable_data_path": metadata.get("data_path"),
            "source_type": "wavetable",
            "source": {
                "type": "wavetable",
                "wavetable_id": wavetable_id,
                "metadata_path": metadata.get("metadata_path"),
                "data_path": metadata.get("data_path"),
            },
        },
    )
    result = storage.get_job(job_id)
    if result:
        storage.update_job(
            job_id,
            status="done",
            audio_files=[storage.relative_path(audio_path)],
            metadata_files=[storage.relative_path(metadata_path)],
        )
    return audio_path, metadata_path, audio_metadata


def load_wavetable(wavetable_id: str) -> dict[str, Any]:
    metadata_path = _metadata_path_for_id(wavetable_id)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    data_path = storage.resolve_path(metadata["data_path"])
    if not storage.is_within(data_path, storage.settings.wavetable_data_dir):
        raise PermissionError("wavetable data path is outside the wavetable table directory")
    if not data_path.exists():
        raise FileNotFoundError(f"wavetable data not found: {metadata['data_path']}")
    expected = int(metadata["frame_count"]) * int(metadata["frame_size"])
    data = data_path.read_bytes()
    frames = _float32_values(data)
    if len(frames) != expected:
        raise ValueError("wavetable binary size does not match metadata")
    return {"metadata": metadata, "frames": frames, "metadata_path": metadata_path, "data_path": data_path}


def write_wavetable(frames: list[float], metadata: dict[str, Any]) -> dict[str, Any]:
    frame_size = int(metadata["frame_size"])
    frame_count = int(metadata["frame_count"])
    expected = frame_size * frame_count
    if len(frames) != expected:
        raise ValueError("wavetable frame data length does not match metadata")
    wt_id = metadata.get("id") or f"wt_{uuid4().hex[:12]}"
    name = str(metadata.get("name") or wt_id)
    stem = f"{safe_stem(name, fallback='wavetable')}_{wt_id}"
    metadata_path = storage.settings.wavetable_metadata_dir / f"{stem}.json"
    data_path = storage.settings.wavetable_data_dir / f"{stem}.gwt.bin"
    metadata = {
        **metadata,
        "type": WAVETABLE_TYPE,
        "id": wt_id,
        "name": name,
        "data_path": storage.relative_path(data_path),
        "metadata_path": storage.relative_path(metadata_path),
        "created_at": metadata.get("created_at") or utc_now_iso(),
    }
    lineage = metadata.get("lineage") if isinstance(metadata.get("lineage"), dict) else {}
    metadata["lineage"] = {
        **lineage,
        "id": wt_id,
        "parents": metadata.get("parents", []),
        "children": metadata.get("children", []),
        "operation": metadata.get("operation") or lineage.get("operation"),
        "audio_path": metadata.get("source_audio_path"),
        "metadata_path": storage.relative_path(metadata_path),
    }
    metadata.update(_quality_metadata(metadata, frames))
    _write_float32(data_path, [max(-1.0, min(1.0, float(value))) for value in frames])
    storage.write_json_atomic(metadata_path, metadata, touch_library=True)
    return metadata


def update_wavetable_metadata(wavetable_id: str, updates: dict[str, Any]) -> dict[str, Any]:
    table = load_wavetable(wavetable_id)
    metadata = {**table["metadata"], **updates}
    lineage_update = updates.get("lineage") if isinstance(updates.get("lineage"), dict) else {}
    if lineage_update:
        lineage = metadata.get("lineage") if isinstance(metadata.get("lineage"), dict) else {}
        metadata["lineage"] = {**lineage, **lineage_update}
    storage.write_json_atomic(table["metadata_path"], metadata, touch_library=True)
    return metadata


def append_wavetable_child(parent_id: str, child_id: str) -> None:
    try:
        table = load_wavetable(parent_id)
    except (FileNotFoundError, PermissionError, ValueError):
        return
    metadata = dict(table["metadata"])
    children = _string_list(metadata.get("children"))
    if child_id not in children:
        children.append(child_id)
    metadata["children"] = children
    lineage = metadata.get("lineage") if isinstance(metadata.get("lineage"), dict) else {}
    lineage["children"] = children
    metadata["lineage"] = lineage
    storage.write_json_atomic(table["metadata_path"], metadata, touch_library=True)


def list_wavetables(limit: int = 5000) -> list[dict[str, Any]]:
    root = storage.settings.wavetable_metadata_dir
    if not root.exists():
        return []
    items: list[dict[str, Any]] = []
    entries: list[tuple[Path, int]] = []
    for path in root.glob("*.json"):
        try:
            entries.append((path, path.stat().st_mtime_ns))
        except OSError:
            continue
    entries.sort(key=lambda item: item[1], reverse=True)
    for path, _mtime in entries[: max(1, limit)]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if data.get("type") == WAVETABLE_TYPE:
            items.append(data)
    return items


def export_wavetable(wavetable_id: str, export_format: str) -> Path:
    table = load_wavetable(wavetable_id)
    metadata = table["metadata"]
    if export_format == "metadata":
        return table["metadata_path"]
    if export_format == "gwt":
        return table["data_path"]
    name = safe_stem(metadata.get("name"), fallback=wavetable_id)
    if export_format == "wav-stack":
        path = storage.settings.wavetable_preview_dir / f"{name}_{wavetable_id}_stack.wav"
        _write_wav_frames(path, table["frames"], int(metadata["frame_size"]), int(metadata["frame_count"]))
        return path
    if export_format == "single-cycle":
        path = storage.settings.wavetable_preview_dir / f"{name}_{wavetable_id}_single_cycle.wav"
        frame = table["frames"][: int(metadata["frame_size"])]
        _write_wav_frames(path, frame, int(metadata["frame_size"]), 1)
        return path
    raise ValueError("unsupported wavetable export format")


def wavetable_summary(metadata: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": metadata["id"],
        "name": metadata["name"],
        "frame_size": metadata["frame_size"],
        "frame_count": metadata["frame_count"],
        "sample_rate": metadata["sample_rate"],
        "data_path": metadata["data_path"],
        "metadata_path": metadata["metadata_path"],
        "root_note": metadata["root_note"],
        "root_frequency": metadata["root_frequency"],
        "source_audio_path": metadata.get("source_audio_path"),
        "source_prompt": metadata.get("source_prompt"),
        "runtime": metadata.get("runtime"),
        "operation": metadata.get("operation"),
        "parents": metadata.get("parents") or [],
        "children": metadata.get("children") or [],
        "tags": metadata.get("tags") or [],
        "descriptors": metadata.get("descriptors") or {},
        "table_classification": metadata.get("table_classification"),
        "warnings": metadata.get("warnings") or [],
        "created_at": metadata.get("created_at"),
    }


def _metadata_for_table(
    *,
    name: str,
    frame_size: int,
    frame_count: int,
    sample_rate: int,
    root_note: str,
    source_audio_path: str | None,
    source_metadata_path: str | None,
    source_metadata: dict[str, Any],
    runtime: str,
    extraction_mode: str,
    tags: list[str],
    operation: str,
    operation_params: dict[str, Any],
    lineage: dict[str, Any],
) -> dict[str, Any]:
    root_frequency = note_to_frequency(root_note)
    parents = _string_list(lineage.get("parents"))
    return {
        "type": WAVETABLE_TYPE,
        "id": f"wt_{uuid4().hex[:12]}",
        "name": name,
        "frame_size": frame_size,
        "frame_count": frame_count,
        "sample_rate": sample_rate,
        "data_path": "",
        "metadata_path": "",
        "root_note": root_note,
        "root_frequency": root_frequency,
        "source_audio_path": source_audio_path,
        "source_metadata_path": source_metadata_path,
        "source_prompt": source_metadata.get("prompt"),
        "negative_prompt": source_metadata.get("negative_prompt"),
        "generation_model": source_metadata.get("model"),
        "runtime": runtime,
        "extraction_mode": extraction_mode,
        "parents": parents,
        "children": [],
        "tags": list(dict.fromkeys([*tags, "wavetable", "germ"])),
        "descriptors": {},
        "operation": operation,
        "operation_params": operation_params,
        "lineage": {
            **lineage,
            "parents": parents,
            "children": [],
            "operation": operation,
            "audio_path": source_audio_path,
        },
        "created_at": utc_now_iso(),
    }


def _read_source_metadata(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    target = storage.resolve_existing_path(path, label="source metadata")
    if not storage.is_within(target, storage.settings.metadata_dir):
        raise PermissionError("source metadata must be inside the metadata directory")
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def _read_mono_pcm_wav(path: Path) -> tuple[list[float], int]:
    try:
        with wave.open(str(path), "rb") as wav:
            if wav.getcomptype() != "NONE":
                raise ValueError("compressed WAV files are not supported")
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            frame_count = wav.getnframes()
            raw = wav.readframes(frame_count)
    except wave.Error as exc:
        raise ValueError(f"invalid WAV file: {exc}") from exc
    if channels <= 0 or sample_rate <= 0 or frame_count <= 0:
        raise ValueError("invalid WAV parameters")
    if sample_width != 2:
        raise ValueError("wavetable conversion currently supports 16-bit PCM WAV files")
    ints = array.array("h")
    ints.frombytes(raw)
    if sys.byteorder != "little":
        ints.byteswap()
    samples: list[float] = []
    for frame_index in range(frame_count):
        offset = frame_index * channels
        total = 0.0
        for channel in range(channels):
            total += ints[offset + channel] / 32768.0
        samples.append(total / channels)
    return samples, sample_rate


def _extract_simple_frames(
    *,
    samples: list[float],
    frame_count: int,
    frame_size: int,
) -> list[float]:
    signal = _normalize(_trim_silence(_remove_dc(samples)))
    if not signal:
        signal = [0.0] * frame_size
    source_window = max(16, min(len(signal), frame_size))
    frames: list[list[float]] = []
    max_start = max(0, len(signal) - source_window)
    for index in range(frame_count):
        start = int(round((index / max(1, frame_count - 1)) * max_start))
        window = signal[start : start + source_window]
        frame = _resample_linear(window, frame_size)
        frame = _normalize(_remove_dc(frame))
        if frames and _dot(frames[-1], frame) < 0:
            frame = [-value for value in frame]
        frames.append(frame)
    descriptors = _compute_descriptors(frames)
    flattened = [value for frame in frames for value in frame]
    _LAST_DESCRIPTORS.clear()
    _LAST_DESCRIPTORS.update(descriptors)
    return flattened


_LAST_DESCRIPTORS: dict[str, Any] = {}


def _compute_descriptors(frames: list[list[float]]) -> dict[str, Any]:
    zero_crossing_curve: list[float] = []
    centroid_curve: list[float] = []
    for frame in frames:
        crossings = 0
        previous = frame[0] if frame else 0.0
        for value in frame[1:]:
            if (previous < 0 <= value) or (previous >= 0 > value):
                crossings += 1
            previous = value
        zero_crossing = crossings / max(1, len(frame) - 1)
        zero_crossing_curve.append(round(zero_crossing, 6))
        diffs = [abs(frame[index] - frame[index - 1]) for index in range(1, len(frame))]
        centroid_curve.append(round(min(1.0, sum(diffs) / max(1, len(diffs))), 6))
    brightness = sum(centroid_curve) / max(1, len(centroid_curve))
    noisiness = sum(zero_crossing_curve) / max(1, len(zero_crossing_curve))
    return {
        "brightness": round(brightness, 6),
        "noisiness": round(noisiness, 6),
        "zero_crossing_curve": zero_crossing_curve,
        "centroid_curve": centroid_curve,
    }


def _quality_metadata(metadata: dict[str, Any], frames: list[float]) -> dict[str, Any]:
    descriptors = metadata.get("descriptors") if isinstance(metadata.get("descriptors"), dict) else {}
    brightness = float(descriptors.get("brightness") or 0.0)
    noisiness = float(descriptors.get("noisiness") or 0.0)
    centroid_curve = descriptors.get("centroid_curve") if isinstance(descriptors.get("centroid_curve"), list) else []
    frame_size = int(metadata.get("frame_size") or 1)
    frame_count = int(metadata.get("frame_count") or 1)
    peak = max((abs(float(value)) for value in frames), default=0.0)
    warnings: list[str] = []
    if peak < 0.001:
        warnings.append("low_signal")
    if noisiness >= 0.32:
        warnings.append("high_noise")
    if frame_count < 4:
        warnings.append("too_short")
    if len(centroid_curve) >= 2 and (max(centroid_curve) - min(centroid_curve)) >= 0.45:
        warnings.append("pitch_unstable")
    unique_frames = {
        tuple(round(value, 3) for value in frames[index * frame_size : (index * frame_size) + min(frame_size, 64)])
        for index in range(frame_count)
    }
    if frame_count > 1 and len(unique_frames) <= 1:
        warnings.append("few_unique_frames")

    prompt_text = " ".join(
        str(value or "")
        for value in (
            metadata.get("source_prompt"),
            metadata.get("operation_params", {}).get("prompt")
            if isinstance(metadata.get("operation_params"), dict)
            else "",
        )
    ).lower()
    if any(term in prompt_text for term in ("formant", "vowel", "voice-like", "vocalic")):
        classification = "formant"
    elif peak < 0.001 or "pitch_unstable" in warnings:
        classification = "glitch"
    elif noisiness >= 0.32:
        classification = "noise"
    elif centroid_curve and (max(centroid_curve) - min(centroid_curve)) >= 0.25:
        classification = "texture"
    elif brightness < 0.25 and noisiness < 0.20:
        classification = "tonal"
    else:
        classification = "texture"
    return {
        "table_classification": classification,
        "warnings": list(dict.fromkeys(warnings)),
    }


def _remove_dc(samples: list[float]) -> list[float]:
    if not samples:
        return []
    mean = sum(samples) / len(samples)
    return [sample - mean for sample in samples]


def _trim_silence(samples: list[float]) -> list[float]:
    if not samples:
        return []
    peak = max(abs(sample) for sample in samples)
    if peak <= 1e-9:
        return samples
    threshold = max(1e-4, peak * 0.01)
    start = 0
    while start < len(samples) and abs(samples[start]) < threshold:
        start += 1
    end = len(samples) - 1
    while end > start and abs(samples[end]) < threshold:
        end -= 1
    return samples[start : end + 1]


def _normalize(samples: list[float]) -> list[float]:
    if not samples:
        return []
    peak = max(abs(sample) for sample in samples)
    if peak <= 1e-9:
        return [0.0 for _sample in samples]
    scale = 1.0 / peak
    return [max(-1.0, min(1.0, sample * scale)) for sample in samples]


def _resample_linear(samples: list[float], target_count: int) -> list[float]:
    if target_count <= 0:
        return []
    if not samples:
        return [0.0] * target_count
    if len(samples) == 1:
        return [samples[0]] * target_count
    output: list[float] = []
    scale = (len(samples) - 1) / max(1, target_count - 1)
    for index in range(target_count):
        source_pos = index * scale
        lo = int(math.floor(source_pos))
        hi = min(len(samples) - 1, lo + 1)
        frac = source_pos - lo
        output.append((samples[lo] * (1.0 - frac)) + (samples[hi] * frac))
    return output


def _dot(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=False))


def _write_float32(path: Path, values: list[float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    floats = array.array("f", values)
    if sys.byteorder != "little":
        floats.byteswap()
    path.write_bytes(floats.tobytes())


def _float32_values(data: bytes) -> list[float]:
    if len(data) % 4:
        raise ValueError("wavetable binary length must be divisible by 4")
    floats = array.array("f")
    floats.frombytes(data)
    if sys.byteorder != "little":
        floats.byteswap()
    return [float(value) for value in floats]


def _sample_frame(frames: list[float], frame_index: int, phase: float, frame_size: int) -> float:
    base = frame_index * frame_size
    source_pos = phase * frame_size
    lo = int(math.floor(source_pos)) % frame_size
    hi = (lo + 1) % frame_size
    frac = source_pos - math.floor(source_pos)
    return (frames[base + lo] * (1.0 - frac)) + (frames[base + hi] * frac)


def _clip_pcm16(value: float) -> int:
    return int(max(-32767, min(32767, round(value * 32767.0))))


def _write_pcm16_wav(path: Path, frames: bytes, *, channels: int, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(frames)


def _write_wav_frames(path: Path, frames: list[float], frame_size: int, frame_count: int) -> None:
    pcm = array.array("h")
    total = frame_size * frame_count
    for value in frames[:total]:
        pcm.append(_clip_pcm16(value))
    if sys.byteorder != "little":
        pcm.byteswap()
    _write_pcm16_wav(path, pcm.tobytes(), channels=1, sample_rate=WAVETABLE_SAMPLE_RATE)


def _metadata_path_for_id(wavetable_id: str) -> Path:
    root = storage.settings.wavetable_metadata_dir
    if not re.fullmatch(r"wt_[A-Za-z0-9]+", wavetable_id or ""):
        raise ValueError("invalid wavetable id")
    for path in root.glob(f"*_{wavetable_id}.json"):
        return path
    raise FileNotFoundError(f"wavetable not found: {wavetable_id}")


def _lineage_parents(lineage: dict[str, Any], source_metadata: dict[str, Any]) -> list[str]:
    parents = _string_list(lineage.get("parents"))
    sound_id = source_metadata.get("sound_id")
    if isinstance(sound_id, str) and sound_id and sound_id not in parents:
        parents.append(sound_id)
    return parents


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if item not in (None, "")]
