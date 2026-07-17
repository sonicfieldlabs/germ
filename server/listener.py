from __future__ import annotations

import array
import json
import math
import sys
import wave
from collections import deque
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException

from server.registry import settings, storage
from server.schemas import (
    ListenerEnhanceRequest,
    ListenerEnhanceResult,
    ListenerRelistenRequest,
    ListenerRelistenResult,
    ListenerScoreRequest,
    ListenerScoreResult,
)

PCM_HEADER_BYTES = 44
MAX_LISTENER_METADATA_BYTES = 10_000_000

MATERIAL_WORDS = {
    "glass",
    "metal",
    "wood",
    "paper",
    "stone",
    "ceramic",
    "water",
    "rubber",
    "dust",
    "wire",
    "insect",
    "reed",
}

GESTURE_WORDS = {
    "click",
    "scrape",
    "crack",
    "snap",
    "drip",
    "pulse",
    "rattle",
    "flutter",
    "impact",
    "grain",
    "tone",
    "swell",
}


def enhance_prompt(request: ListenerEnhanceRequest) -> ListenerEnhanceResult:
    """Compile an editable prompt without performing machine listening.

    Oída owns audio understanding.  This compatibility endpoint is deliberately
    neutral: it cleans whitespace, applies only explicitly supplied fragments,
    and offers suggestions without injecting SFX/music/voice assumptions.
    """
    prompt = _clean_prompt(request.prompt)
    prompt_was_empty = not prompt
    negative = _clean_prompt(request.negative_prompt)
    explicit_fragments = request.context.get("prompt_fragments")
    if request.context.get("apply_prompt_fragments") and isinstance(explicit_fragments, list):
        prompt = _join_prompt_fragments(prompt, explicit_fragments)
    words = _prompt_words(prompt)
    suggestions: list[str] = []
    if prompt_was_empty:
        suggestions.append(
            "Start with the audible material, gesture, space, and temporal behavior you want."
        )
    else:
        if not words & MATERIAL_WORDS:
            suggestions.append("Consider naming a material or timbral source when it matters.")
        if not words & GESTURE_WORDS:
            suggestions.append("Consider naming the gesture or temporal behavior when it matters.")
        if not any(
            term in words for term in {"close", "distant", "room", "stereo", "mono", "space"}
        ):
            suggestions.append("Consider describing perspective or space when it matters.")
    warnings = ["empty_prompt"] if prompt_was_empty else []
    if request.provider in {"mock", "local", "api"}:
        warnings.append("legacy_provider_alias")
    if request.provider == "oida":
        warnings.append("use_relisten_endpoint_for_oida")
    return ListenerEnhanceResult(
        provider=request.provider,
        model="neutral-compiler",
        task=request.task,
        prompt=request.prompt,
        enhanced_prompt=prompt,
        negative_prompt=negative,
        suggestions=suggestions,
        warnings=warnings,
        repair_proposals=[],
    )


def score_audio(request: ListenerScoreRequest) -> ListenerScoreResult:
    path = _resolve_audio_path(request.audio_path)
    features = _wav_features(path)
    prompt_words = _prompt_words(request.prompt)
    warnings: list[str] = []
    tags: list[str] = []
    repair_proposals: list[dict[str, Any]] = []
    if features["duration"] < 0.15:
        warnings.append("too_short")
    if features["rms"] < 0.005:
        warnings.append("low_signal")
    if features["clip_ratio"] > 0.002:
        warnings.append("clipping")
    if features["zero_crossing_rate"] > 0.22:
        warnings.append("high_noise")
        tags.append("noisy")
    if features["edge_delta"] > 0.12:
        warnings.append("loop_seam")
        repair_proposals.append(
            {
                "type": "inpaint_range",
                "reason": "loop seam energy jump",
                "start_sec": max(0.0, features["duration"] - 0.08),
                "end_sec": features["duration"],
            }
        )
    if prompt_words & MATERIAL_WORDS:
        tags.extend(sorted(prompt_words & MATERIAL_WORDS))
    if prompt_words & GESTURE_WORDS:
        tags.extend(sorted(prompt_words & GESTURE_WORDS))
    score = _score_from_features(features, warnings)
    return ListenerScoreResult(
        provider=request.provider,
        model="local-signal-check",
        prompt=request.prompt,
        audio_path=storage.relative_path(path),
        score=score,
        rating=_rating(score),
        tags=sorted(set(tags)),
        warnings=warnings,
        suggestions=_score_suggestions(warnings),
        repair_proposals=repair_proposals,
        features=features,
    )


def _clean_prompt(prompt: str) -> str:
    return " ".join(str(prompt or "").replace("\n", " ").split())


def _prompt_words(prompt: str) -> set[str]:
    cleaned = "".join(ch.lower() if ch.isalnum() else " " for ch in prompt)
    return {word for word in cleaned.split() if word}


def _join_prompt_fragments(prompt: str, fragments: list[Any]) -> str:
    values = [prompt] if prompt else []
    values.extend(_clean_prompt(str(value)) for value in fragments if _clean_prompt(str(value)))
    return ", ".join(dict.fromkeys(values))


def relisten_with_oida(request: ListenerRelistenRequest) -> ListenerRelistenResult:
    """Send generated audio to Oída, then ask Oída for the next editable prompt."""
    audio_path = _resolve_audio_path(request.audio_path)
    metadata_path = _resolve_metadata_path(request.metadata_path)
    source_generation_id = _source_oida_generation_id(metadata_path, request.context)
    listen_payload = {
        "path": str(audio_path),
        "route_preset": request.route_preset,
        "privacy_mode": request.privacy_mode,
        "source_type": "file",
        "source_label": audio_path.name,
        "raw_audio_policy": "external_ref",
        # Shared-memory retention is requested explicitly through Oída's
        # /memory/remember route after listening. This avoids treating a
        # compatibility trace as an Akousmata record.
        "remember": False,
        "tags": ["germ-generation", "relisten"],
        "user_notes": request.context.get("notes"),
    }
    warnings: list[str] = []
    relisten_mode = "gateway_listen"
    try:
        with httpx.Client(timeout=settings.oida_timeout_seconds) as client:
            if source_generation_id:
                listen_response = client.post(
                    f"{settings.oida_url}/generation/relisten",
                    json={
                        "generation_id": source_generation_id,
                        "path": str(audio_path),
                        "route_preset": request.route_preset,
                        "privacy_mode": request.privacy_mode,
                        "remember": False,
                    },
                )
                if listen_response.status_code == 404:
                    warnings.append("oida_generation_context_missing_fell_back_to_gateway")
                    listen_response = client.post(
                        f"{settings.oida_url}/gateway/listen",
                        json=listen_payload,
                    )
                else:
                    relisten_mode = "generation_relisten"
            else:
                listen_response = client.post(
                    f"{settings.oida_url}/gateway/listen",
                    json=listen_payload,
                )
            _raise_oida_error(listen_response, "re-listening")
            listen_body = _response_object(listen_response, "re-listening")
            event = listen_body.get("listening_event")
            if not isinstance(event, dict) or not event.get("id"):
                raise HTTPException(status_code=502, detail="Oída returned no listening event")
            memory_body: dict[str, Any] = {}
            if request.remember and request.privacy_mode != "incognito":
                memory_response = client.post(
                    f"{settings.oida_url}/memory/remember",
                    json={
                        "event": event,
                        "user_notes": request.context.get("notes"),
                        "tags": ["germ-generation", "relisten"],
                    },
                )
                _raise_oida_error(memory_response, "Akousmata retention")
                memory_body = _response_object(memory_response, "Akousmata retention")
                remembered_event = memory_body.get("event")
                if isinstance(remembered_event, dict):
                    event = remembered_event
            prompt_response = client.post(
                f"{settings.oida_url}/generation/prompt",
                json={
                    "event": event,
                    "intent": request.intent,
                    "prompt": request.prompt.strip() or None,
                    "negative_prompt": request.negative_prompt.strip() or None,
                    "adapter": "prompt_only",
                    "duration_s": _event_duration_seconds(event),
                    "generate": False,
                },
            )
            _raise_oida_error(prompt_response, "prompt derivation")
            generation = _response_object(prompt_response, "prompt derivation")
    except HTTPException:
        raise
    except (httpx.HTTPError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Oída is unavailable at {settings.oida_url}: {exc}",
        ) from exc

    compact = _compact_oida_result(event)
    trace = (
        memory_body.get("trace")
        if isinstance(memory_body.get("trace"), dict)
        else listen_body.get("trace")
        if isinstance(listen_body.get("trace"), dict)
        else {}
    )
    raw_route_comparison = listen_body.get("route_comparison")
    route_comparison = (
        _compact_external_json(raw_route_comparison)
        if isinstance(raw_route_comparison, dict)
        else {}
    )
    memory = event.get("memory") if isinstance(event.get("memory"), dict) else {}
    new_akousma_id = (
        str(
            memory_body.get("akousma_id")
            or memory.get("akousma_id")
            or trace.get("akousma_id")
            or ""
        )
        or None
    )
    remembered = bool(new_akousma_id)
    shared_error = str(memory_body.get("shared_error") or "").strip()
    if shared_error:
        warnings.append(f"oida_akousmata_retention_failed:{shared_error}")
    elif request.remember and not remembered:
        warnings.append("oida_akousmata_retention_not_performed")
    if request.remember and request.privacy_mode == "incognito":
        warnings.append("oida_retention_skipped_in_incognito")
    raw_prompt = str(generation.get("prompt") or "")
    raw_negative_prompt = str(generation.get("negative_prompt") or "")
    prompt = raw_prompt[:10_000]
    negative_prompt = raw_negative_prompt[:10_000]
    source_summary = str(generation.get("source_summary") or "")[:2_000]
    if len(raw_prompt) > len(prompt):
        warnings.append("oida_prompt_truncated_to_10000_characters")
    if len(raw_negative_prompt) > len(negative_prompt):
        warnings.append("oida_negative_prompt_truncated_to_10000_characters")
    extension = {
        "contract": "germ.oida-relisten/v0.1",
        "provider": "oida",
        "event_id": str(event["id"]),
        "generation_id": str(generation.get("id") or ""),
        "source_generation_id": source_generation_id,
        "relisten_mode": relisten_mode,
        "route_preset": request.route_preset,
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "source_summary": source_summary,
        "remembered": remembered,
        "akousma_id": new_akousma_id,
        "listening_result": compact,
        "route_comparison": route_comparison,
    }
    existing_akousma_id = _persist_relisten_context(
        metadata_path,
        extension,
        warnings,
        akousma_id_to_update=new_akousma_id if remembered else None,
    )
    return ListenerRelistenResult(
        audio_path=storage.relative_path(audio_path),
        metadata_path=storage.relative_path(metadata_path) if metadata_path else None,
        route_preset=request.route_preset,
        relisten_mode=relisten_mode,
        source_generation_id=source_generation_id,
        listening_event_id=str(event["id"]),
        generation_id=str(generation.get("id") or ""),
        prompt=prompt,
        negative_prompt=negative_prompt,
        source_summary=source_summary,
        listening_result=compact,
        route_comparison=route_comparison,
        remembered=remembered,
        akousma_id=new_akousma_id or existing_akousma_id,
        warnings=warnings,
    )


def _source_oida_generation_id(
    metadata_path: Path | None,
    context: dict[str, Any],
) -> str | None:
    candidates: list[Any] = [
        context.get("source_generation_id"),
        context.get("generation_id"),
    ]
    if metadata_path is not None:
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError, RecursionError):
            metadata = {}
        if isinstance(metadata, dict):
            generation_context = (
                metadata.get("generation_context")
                if isinstance(metadata.get("generation_context"), dict)
                else {}
            )
            listening_context = (
                metadata.get("listening_context")
                if isinstance(metadata.get("listening_context"), dict)
                else {}
            )
            extensions = (
                metadata.get("extensions") if isinstance(metadata.get("extensions"), dict) else {}
            )
            relisten_extension = (
                extensions.get("germ.relisten")
                if isinstance(extensions.get("germ.relisten"), dict)
                else {}
            )
            latest = (
                relisten_extension.get("latest")
                if isinstance(relisten_extension.get("latest"), dict)
                else {}
            )
            for container in (generation_context, listening_context):
                relisten = (
                    container.get("oida_relisten")
                    if isinstance(container.get("oida_relisten"), dict)
                    else {}
                )
                candidates.append(relisten.get("generation_id"))
            candidates.append(latest.get("generation_id"))
    for value in candidates:
        cleaned = str(value or "").strip()
        if cleaned:
            return cleaned[:256]
    return None


def _raise_oida_error(response: httpx.Response, action: str) -> None:
    if response.is_success:
        return
    try:
        body = response.json()
        detail = body.get("detail") if isinstance(body, dict) else body
    except (ValueError, json.JSONDecodeError, RecursionError):
        detail = response.text[:500]
    compact_detail = str(detail)[:1_000]
    raise HTTPException(
        status_code=502,
        detail=f"Oída {action} failed ({response.status_code}): {compact_detail}",
    )


def _response_object(response: httpx.Response, action: str) -> dict[str, Any]:
    try:
        body = response.json()
    except (ValueError, json.JSONDecodeError, RecursionError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Oída {action} returned invalid JSON",
        ) from exc
    if not isinstance(body, dict):
        raise HTTPException(
            status_code=502,
            detail=f"Oída {action} returned a non-object response",
        )
    return body


def _event_duration_seconds(event: dict[str, Any]) -> float | None:
    segment = event.get("segment") if isinstance(event.get("segment"), dict) else {}
    duration_ms = segment.get("duration_ms")
    if (
        isinstance(duration_ms, (int, float))
        and not isinstance(duration_ms, bool)
        and math.isfinite(float(duration_ms))
        and duration_ms > 0
    ):
        return min(380.0, float(duration_ms) / 1000.0)
    return None


def _compact_oida_result(event: dict[str, Any]) -> dict[str, Any]:
    aggregate_source = event.get("aggregate") if isinstance(event.get("aggregate"), dict) else {}
    aggregate = {
        key: str(aggregate_source.get(key) or "")[:limit]
        for key, limit in (("title", 500), ("short_summary", 2_000), ("detailed_summary", 5_000))
        if aggregate_source.get(key) not in (None, "")
    }
    for key in ("primary_tags", "signal_facts", "warnings"):
        values = aggregate_source.get(key)
        if isinstance(values, list):
            aggregate[key] = [str(value)[:500] for value in values[:32] if value not in (None, "")]
    hypotheses = aggregate_source.get("hypotheses")
    if isinstance(hypotheses, list):
        aggregate["hypotheses"] = [
            {
                key: str(item.get(key) or "")[:1_000]
                for key in ("statement", "confidence", "basis")
                if item.get(key) not in (None, "")
            }
            for item in hypotheses[:8]
            if isinstance(item, dict)
        ]
    routes = []
    route_values = event.get("routes")
    if not isinstance(route_values, list):
        route_values = []
    for route in route_values[:64]:
        if not isinstance(route, dict):
            continue
        routes.append(
            {
                key: _compact_external_json(route.get(key), depth=1)
                for key in (
                    "route_id",
                    "route_name",
                    "skill_id",
                    "listening_mode",
                    "summary",
                    "confidence",
                    "evidence_level",
                )
                if route.get(key) not in (None, "", [], {})
            }
        )
        for key in ("skill_ids", "uncertainty", "suggested_next_routes"):
            values = route.get(key)
            if isinstance(values, list):
                routes[-1][key] = [str(value)[:500] for value in values[:32] if value]
    features = event.get("features") if isinstance(event.get("features"), dict) else {}
    scalar_features: dict[str, Any] = {}
    for key, raw_value in list(features.items())[:128]:
        if isinstance(raw_value, float) and not math.isfinite(raw_value):
            continue
        value = raw_value[:1_000] if isinstance(raw_value, str) else raw_value
        if isinstance(value, (str, int, float, bool)) or value is None:
            scalar_features[str(key)[:200]] = value
    raw_tags = event.get("tags")
    tags = (
        [str(tag)[:200] for tag in raw_tags[:64] if tag not in (None, "")]
        if isinstance(raw_tags, list)
        else []
    )
    return {
        "event_id": str(event.get("id") or "")[:256],
        "aggregate": aggregate,
        "routes": routes,
        "features": scalar_features,
        "tags": tags,
        "covenant": _compact_oida_covenant(event.get("covenant")),
    }


def _compact_external_json(value: Any, *, depth: int = 0) -> Any:
    """Bound untrusted integration payloads before persisting or returning them."""
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        return value[:2_000]
    if depth >= 4:
        return None
    if isinstance(value, list):
        return [_compact_external_json(item, depth=depth + 1) for item in value[:64]]
    if isinstance(value, dict):
        return {
            str(key)[:200]: _compact_external_json(item, depth=depth + 1)
            for key, item in list(value.items())[:64]
        }
    return str(value)[:2_000]


def _compact_oida_covenant(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    compact: dict[str, Any] = {}
    for key in ("id", "name", "version", "contract", "sha256", "extends", "note"):
        if value.get(key) not in (None, ""):
            compact[key] = str(value[key])[:2_000]
    for key in ("rules_applied", "withheld", "commitments"):
        items = value.get(key)
        if isinstance(items, list):
            compact[key] = [
                {
                    str(item_key)[:100]: (
                        str(item_value)[:1_000]
                        if not isinstance(item_value, (int, float, bool))
                        else item_value
                    )
                    for item_key, item_value in list(item.items())[:16]
                }
                if isinstance(item, dict)
                else str(item)[:1_000]
                for item in items[:32]
            ]
    return compact


def _resolve_metadata_path(raw_path: str | None) -> Path | None:
    if not raw_path:
        return None
    try:
        path = storage.resolve_existing_metadata_path(raw_path, label="listener metadata")
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if path.suffix.lower() != ".json":
        raise HTTPException(status_code=422, detail="listener metadata must be JSON")
    try:
        if path.stat().st_size > MAX_LISTENER_METADATA_BYTES:
            raise HTTPException(status_code=413, detail="listener metadata exceeds the 10 MB limit")
    except OSError as exc:
        raise HTTPException(status_code=422, detail="listener metadata could not be inspected") from exc
    return path


def _persist_relisten_context(
    metadata_path: Path | None,
    extension: dict[str, Any],
    warnings: list[str],
    *,
    akousma_id_to_update: str | None = None,
) -> str | None:
    if metadata_path is None:
        return None
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        warnings.append(f"metadata_update_failed:{str(exc)[:500]}")
        return None
    if not isinstance(metadata, dict):
        warnings.append("metadata_update_failed:not_an_object")
        return None
    extensions = metadata.setdefault("extensions", {})
    if not isinstance(extensions, dict):
        extensions = {}
        metadata["extensions"] = extensions
    previous = extensions.get("germ.relisten")
    previous_history = previous.get("history") if isinstance(previous, dict) else []
    history = list(previous_history) if isinstance(previous_history, list) else []
    history.append(extension)
    extensions["germ.relisten"] = {"latest": extension, "history": history[-12:]}
    try:
        storage.write_json_atomic(metadata_path, metadata, touch_library=True)
    except (OSError, TypeError, ValueError) as exc:
        warnings.append(f"metadata_update_failed:{str(exc)[:500]}")

    akousmata = metadata.get("akousmata") if isinstance(metadata.get("akousmata"), dict) else {}
    akousma_id = str(metadata.get("akousma_id") or akousmata.get("akousma_id") or "") or None
    if not akousma_id_to_update:
        return akousma_id
    try:
        from server.akousma_store import open_store

        with open_store() as store:
            record = store.get(akousma_id_to_update)
            if not isinstance(record, dict):
                warnings.append("akousma_relisten_update_failed:record_missing")
                return akousma_id
            record_extensions = record.get("extensions")
            if not isinstance(record_extensions, dict):
                record_extensions = {}
                record["extensions"] = record_extensions
            old = record_extensions.get("germ.relisten")
            old_history = old.get("history") if isinstance(old, dict) else []
            record_history = list(old_history) if isinstance(old_history, list) else []
            record_history.append(extension)
            record_extensions["germ.relisten"] = {
                "latest": extension,
                "history": record_history[-12:],
            }
            store.put(record)
    except Exception as exc:  # Akousmata is optional; the re-listen remains valid.
        warnings.append(f"akousma_relisten_update_failed:{str(exc)[:500]}")
    return akousma_id


def _resolve_audio_path(raw_path: str) -> Path:
    if not raw_path:
        raise HTTPException(status_code=422, detail="audio_path is required")
    try:
        return storage.resolve_existing_input_audio_path(raw_path, label="listener audio")
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"audio file not found: {raw_path}") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _wav_features(path: Path) -> dict[str, Any]:
    total_frames = 0
    sum_squares = 0.0
    peak = 0.0
    zero_crossings = 0
    clip_count = 0
    previous_sample: float | None = None
    try:
        with wave.open(str(path), "rb") as wav:
            channels = wav.getnchannels()
            sample_rate = wav.getframerate()
            sample_width = wav.getsampwidth()
            frames = wav.getnframes()
            compression = wav.getcomptype()
            if compression != "NONE":
                raise HTTPException(status_code=422, detail="compressed WAV audio is not supported")
            if channels <= 0 or channels > 8:
                raise HTTPException(status_code=422, detail="audio must have between 1 and 8 channels")
            if sample_rate <= 0 or sample_rate > 768_000:
                raise HTTPException(status_code=422, detail="audio sample rate is invalid")
            if sample_width not in {1, 2, 3, 4}:
                raise HTTPException(status_code=422, detail="unsupported PCM sample width")
            if frames <= 0:
                raise HTTPException(status_code=422, detail="audio file is empty")
            duration = frames / float(sample_rate) if sample_rate else 0.0
            pcm_bytes = frames * channels * sample_width
            if duration > settings.listener_score_max_duration_seconds:
                raise HTTPException(
                    status_code=413,
                    detail=(
                        "listener scoring is capped at "
                        f"{settings.listener_score_max_duration_seconds:.0f} seconds"
                    ),
                )
            if (
                max(path.stat().st_size, pcm_bytes + PCM_HEADER_BYTES)
                > settings.listener_score_max_bytes
            ):
                limit_mb = settings.listener_score_max_bytes / (1024 * 1024)
                raise HTTPException(
                    status_code=413,
                    detail=f"listener scoring is capped at {limit_mb:.0f} MB WAV files",
                )
            edge_count = min(max(1, frames // 4), max(1, int(sample_rate * 0.02)))
            start_edge: list[float] = []
            end_edge: deque[float] = deque(maxlen=edge_count)
            while total_frames < frames:
                requested_frames = min(65_536, frames - total_frames)
                raw = wav.readframes(requested_frames)
                expected_bytes = requested_frames * channels * sample_width
                if len(raw) != expected_bytes:
                    raise HTTPException(
                        status_code=422,
                        detail="audio file has truncated sample data",
                    )
                samples = _decode_pcm(raw, sample_width)
                if len(samples) != requested_frames * channels:
                    raise HTTPException(
                        status_code=422,
                        detail="audio file has malformed sample data",
                    )
                for index in range(0, len(samples), channels):
                    sample = sum(samples[index : index + channels]) / channels
                    sum_squares += sample * sample
                    peak = max(peak, abs(sample))
                    if abs(sample) >= 0.995:
                        clip_count += 1
                    if previous_sample is not None and (
                        (previous_sample < 0 <= sample) or (previous_sample >= 0 > sample)
                    ):
                        zero_crossings += 1
                    previous_sample = sample
                    if len(start_edge) < edge_count:
                        start_edge.append(sample)
                    end_edge.append(sample)
                total_frames += requested_frames
    except (EOFError, OSError, wave.Error) as exc:
        raise HTTPException(
            status_code=422, detail="Listener scoring currently supports PCM WAV input"
        ) from exc
    if total_frames != frames:
        raise HTTPException(status_code=422, detail="audio file has truncated sample data")
    rms = math.sqrt(sum_squares / total_frames)
    end_values = list(end_edge)
    edge_delta = math.sqrt(
        sum((a - b) * (a - b) for a, b in zip(start_edge, end_values, strict=True))
        / edge_count
    )
    return {
        "duration": round(total_frames / sample_rate, 6),
        "sample_rate": sample_rate,
        "channels": channels,
        "rms": round(rms, 6),
        "peak": round(peak, 6),
        "zero_crossing_rate": round(zero_crossings / max(1, total_frames - 1), 6),
        "clip_ratio": round(clip_count / total_frames, 6),
        "edge_delta": round(edge_delta, 6),
    }


def _decode_pcm(raw: bytes, sample_width: int) -> array.array:
    if sample_width == 1:
        return array.array("f", ((byte - 128) / 128.0 for byte in raw))
    if sample_width == 2:
        ints = array.array("h")
        ints.frombytes(raw)
        if sys.byteorder != "little":
            ints.byteswap()
        return array.array("f", (sample / 32768.0 for sample in ints))
    if sample_width == 3:
        decoded = array.array("f")
        view = memoryview(raw)
        for index in range(0, len(raw), 3):
            sample = view[index] | (view[index + 1] << 8) | (view[index + 2] << 16)
            if sample & 0x800000:
                sample -= 0x1000000
            decoded.append(sample / 8388608.0)
        return decoded
    if sample_width == 4:
        ints = array.array("i")
        ints.frombytes(raw)
        if sys.byteorder != "little":
            ints.byteswap()
        return array.array("f", (sample / 2147483648.0 for sample in ints))
    raise HTTPException(status_code=422, detail="unsupported PCM sample width")


def _score_from_features(features: dict[str, Any], warnings: list[str]) -> float:
    score = 0.78
    score -= min(0.25, abs(features["rms"] - 0.12) * 0.8)
    score -= min(0.20, features["zero_crossing_rate"] * 0.45)
    score -= min(0.18, features["edge_delta"] * 0.75)
    score -= 0.08 * len(warnings)
    return round(max(0.0, min(1.0, score)), 4)


def _rating(score: float) -> str:
    if score >= 0.82:
        return "excellent"
    if score >= 0.64:
        return "good"
    if score >= 0.42:
        return "fair"
    return "weak"


def _score_suggestions(warnings: list[str]) -> list[str]:
    suggestions = []
    if "low_signal" in warnings:
        suggestions.append("Regenerate or normalize before using as a parent.")
    if "high_noise" in warnings:
        suggestions.append("Try a tighter prompt or lower mutation amount.")
    if "loop_seam" in warnings:
        suggestions.append("Use inpainting across the loop boundary.")
    if "clipping" in warnings:
        suggestions.append("Reduce gain or regenerate with less transient density.")
    return suggestions
