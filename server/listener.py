from __future__ import annotations

import array
import json
import math
import os
import urllib.error
import urllib.request
import wave
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from server.registry import settings, storage
from server.schemas import (
    ListenerEnhanceRequest,
    ListenerEnhanceResult,
    ListenerScoreRequest,
    ListenerScoreResult,
)


DEFAULT_NEGATIVE = [
    "speech",
    "vocals",
    "singing",
    "melody phrase",
    "chord progression",
    "full song",
    "long ambience",
    "harsh clipping",
    "muddy background",
]

PCM_HEADER_BYTES = 44

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
    if request.provider == "local":
        local = _try_local_ollama(request)
        if local:
            return local
    prompt = _clean_prompt(request.prompt)
    negative = _merge_negative(request.negative_prompt)
    words = _prompt_words(prompt)
    suggestions: list[str] = []
    if not words & MATERIAL_WORDS:
        suggestions.append("Add a material word such as glass, metal, paper, water, or ceramic.")
    if not words & GESTURE_WORDS:
        suggestions.append("Add a gesture word such as scrape, snap, drip, pulse, or rattle.")
    if "close microphone" not in prompt.lower():
        suggestions.append("Use close microphone language for cleaner source material.")
    if not prompt:
        prompt = "small tactile sound organism"
    enhanced = (
        "TrackType: SFX, close microphone, controllable microsound source, "
        f"{prompt}, clear foreground event, useful for mutation and layering, "
        "no voice, no music, no full song."
    )
    if request.task == "negative_prompt":
        enhanced = prompt
    return ListenerEnhanceResult(
        provider=request.provider,
        model=request.model or "heuristic-listener",
        task=request.task,
        prompt=request.prompt,
        enhanced_prompt=enhanced,
        negative_prompt=negative,
        suggestions=suggestions,
        warnings=[] if prompt else ["empty_prompt"],
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
        model=request.model or "heuristic-listener",
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


def _merge_negative(negative: str) -> str:
    existing = [part.strip() for part in str(negative or "").split(",") if part.strip()]
    seen = {part.lower() for part in existing}
    merged = existing[:]
    for item in DEFAULT_NEGATIVE:
        if item.lower() not in seen:
            merged.append(item)
    return ", ".join(merged)


def _try_local_ollama(request: ListenerEnhanceRequest) -> ListenerEnhanceResult | None:
    base_url = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
    model = request.model if request.model and request.model != "heuristic-listener" else os.getenv("OLLAMA_MODEL", "llama3.2")
    payload = {
        "model": model,
        "stream": False,
        "prompt": (
            "Enhance this sound-generation prompt for a short foreground microsound. "
            "Keep the user's idea intact. Return one concise prompt only.\n\n"
            f"User prompt: {request.prompt}"
        ),
    }
    try:
        http_request = urllib.request.Request(
            f"{base_url}/api/generate",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(http_request, timeout=2.5) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (OSError, TimeoutError, urllib.error.URLError, json.JSONDecodeError):
        return None
    text = _clean_prompt(str(data.get("response") or ""))
    if not text:
        return None
    return ListenerEnhanceResult(
        provider="local",
        model=model,
        task=request.task,
        prompt=request.prompt,
        enhanced_prompt=text,
        negative_prompt=_merge_negative(request.negative_prompt),
        suggestions=["local_ollama"],
        warnings=[],
        repair_proposals=[],
    )


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
    try:
        with wave.open(str(path), "rb") as wav:
            channels = wav.getnchannels()
            sample_rate = wav.getframerate()
            sample_width = wav.getsampwidth()
            frames = wav.getnframes()
            duration = frames / float(sample_rate) if sample_rate else 0.0
            pcm_bytes = frames * max(1, channels) * max(1, sample_width)
            if duration > settings.listener_score_max_duration_seconds:
                raise HTTPException(
                    status_code=413,
                    detail=(
                        "listener scoring is capped at "
                        f"{settings.listener_score_max_duration_seconds:.0f} seconds"
                    ),
                )
            if max(path.stat().st_size, pcm_bytes + PCM_HEADER_BYTES) > settings.listener_score_max_bytes:
                limit_mb = settings.listener_score_max_bytes / (1024 * 1024)
                raise HTTPException(
                    status_code=413,
                    detail=f"listener scoring is capped at {limit_mb:.0f} MB WAV files",
                )
            raw = wav.readframes(frames)
    except wave.Error as exc:
        raise HTTPException(status_code=422, detail="Listener scoring currently supports PCM WAV input") from exc
    if channels <= 0 or sample_rate <= 0 or frames <= 0:
        raise HTTPException(status_code=422, detail="audio file is empty")
    samples = _decode_pcm(raw, sample_width)
    if channels > 1:
        mono = array.array("f")
        for index in range(0, len(samples), channels):
            mono.append(sum(samples[index : index + channels]) / channels)
        samples = mono
    if not samples:
        raise HTTPException(status_code=422, detail="audio file has no samples")
    mean_square = sum(sample * sample for sample in samples) / len(samples)
    rms = math.sqrt(mean_square)
    peak = max(abs(sample) for sample in samples)
    zero_crossings = sum(1 for prev, cur in zip(samples, samples[1:]) if (prev < 0 <= cur) or (prev >= 0 > cur))
    clip_count = sum(1 for sample in samples if abs(sample) >= 0.995)
    edge_count = min(len(samples) // 4, max(1, int(sample_rate * 0.02)))
    start_edge = samples[:edge_count]
    end_edge = samples[-edge_count:]
    edge_delta = math.sqrt(sum((a - b) * (a - b) for a, b in zip(start_edge, end_edge)) / edge_count)
    return {
        "duration": round(len(samples) / sample_rate, 6),
        "sample_rate": sample_rate,
        "channels": channels,
        "rms": round(rms, 6),
        "peak": round(peak, 6),
        "zero_crossing_rate": round(zero_crossings / max(1, len(samples) - 1), 6),
        "clip_ratio": round(clip_count / len(samples), 6),
        "edge_delta": round(edge_delta, 6),
    }


def _decode_pcm(raw: bytes, sample_width: int) -> array.array:
    if sample_width == 1:
        return array.array("f", ((byte - 128) / 128.0 for byte in raw))
    if sample_width == 2:
        ints = array.array("h")
        ints.frombytes(raw)
        return array.array("f", (sample / 32768.0 for sample in ints))
    if sample_width == 4:
        ints = array.array("i")
        ints.frombytes(raw)
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
