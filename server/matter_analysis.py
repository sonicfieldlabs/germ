from __future__ import annotations

import array
import math
from functools import lru_cache
from statistics import median
from typing import Any


MIN_MORPHOLOGY_DURATION_SECONDS = 0.05
SILENCE_RMS_THRESHOLD = 1e-7
MAX_AMPLITUDE_SAMPLES = 250_000


@lru_cache(maxsize=8)
def _hann_window(fft_size: int) -> tuple[float, ...]:
    denominator = max(1, fft_size - 1)
    return tuple(
        0.5 - (0.5 * math.cos((2.0 * math.pi * offset) / denominator))
        for offset in range(fft_size)
    )


def _frame_value(samples: array.array, channels: int, frame: int) -> float:
    index = frame * channels
    if channels == 1:
        return samples[index] / 32768.0
    return ((samples[index] + samples[index + 1]) * 0.5) / 32768.0


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * fraction)))
    return ordered[position]


def _fft(values: list[float]) -> list[complex]:
    """In-place radix-2 FFT returned as a fresh complex spectrum."""

    size = len(values)
    data = [complex(value, 0.0) for value in values]
    index = 0
    for source in range(1, size):
        bit = size >> 1
        while index & bit:
            index ^= bit
            bit >>= 1
        index ^= bit
        if source < index:
            data[source], data[index] = data[index], data[source]
    length = 2
    while length <= size:
        angle = -2.0 * math.pi / length
        step = complex(math.cos(angle), math.sin(angle))
        half = length // 2
        for start in range(0, size, length):
            weight = 1.0 + 0.0j
            for offset in range(half):
                left = data[start + offset]
                right = data[start + offset + half] * weight
                data[start + offset] = left + right
                data[start + offset + half] = left - right
                weight *= step
        length *= 2
    return data


def _spectral_frame(
    samples: array.array,
    *,
    channels: int,
    frame_count: int,
    sample_rate: int,
    start: int,
    fft_size: int,
) -> dict[str, Any] | None:
    windowed: list[float] = []
    window = _hann_window(fft_size)
    for offset, hann in enumerate(window):
        frame = start + offset
        value = _frame_value(samples, channels, frame) if frame < frame_count else 0.0
        windowed.append(value * hann)
    spectrum = _fft(windowed)
    magnitudes = [abs(value) for value in spectrum[: fft_size // 2 + 1]]
    total = sum(magnitudes)
    if total <= 1e-12:
        return None
    bin_hz = sample_rate / fft_size
    centroid = sum(index * bin_hz * value for index, value in enumerate(magnitudes)) / total
    bandwidth = math.sqrt(
        sum((((index * bin_hz) - centroid) ** 2) * value for index, value in enumerate(magnitudes))
        / total
    )
    rolloff_target = total * 0.85
    cumulative = 0.0
    rolloff = 0.0
    for index, value in enumerate(magnitudes):
        cumulative += value
        if cumulative >= rolloff_target:
            rolloff = index * bin_hz
            break
    epsilon = 1e-12
    geometric = math.exp(sum(math.log(value + epsilon) for value in magnitudes) / len(magnitudes))
    arithmetic = total / len(magnitudes)
    flatness = geometric / max(arithmetic, epsilon)
    normalized = [value / total for value in magnitudes]
    bands = {
        "subBass": (20.0, 80.0),
        "bass": (80.0, 250.0),
        "lowMid": (250.0, 1_000.0),
        "highMid": (1_000.0, 5_000.0),
        "high": (5_000.0, sample_rate / 2.0),
    }
    band_ratios = {
        name: sum(
            value
            for index, value in enumerate(magnitudes)
            if lower <= index * bin_hz < upper
        )
        / total
        for name, (lower, upper) in bands.items()
    }
    return {
        "centroidHz": centroid,
        "bandwidthHz": bandwidth,
        "rolloff85Hz": rolloff,
        "flatness": flatness,
        "normalizedMagnitudes": normalized,
        "bandRatios": band_ratios,
    }


def _spectral_analysis(
    samples: array.array,
    *,
    channels: int,
    frame_count: int,
    sample_rate: int,
    fft_size: int,
    max_frames: int,
) -> dict[str, Any]:
    available_starts = max(1, frame_count - fft_size + 1)
    frame_total = min(max_frames, available_starts)
    if frame_total <= 1:
        starts = [0]
    else:
        starts = [
            round(index * (available_starts - 1) / (frame_total - 1))
            for index in range(frame_total)
        ]
    scalar_names = ("centroidHz", "bandwidthHz", "rolloff85Hz", "flatness")
    scalar_totals = {name: 0.0 for name in scalar_names}
    band_totals: dict[str, float] = {}
    previous_magnitudes: list[float] | None = None
    flux_total = 0.0
    flux_count = 0
    valid_frames = 0
    for start in starts:
        frame = _spectral_frame(
            samples,
            channels=channels,
            frame_count=frame_count,
            sample_rate=sample_rate,
            start=start,
            fft_size=fft_size,
        )
        if frame is None:
            continue
        magnitudes = frame["normalizedMagnitudes"]
        if previous_magnitudes is not None:
            flux_total += sum(
                max(0.0, right - left)
                for left, right in zip(previous_magnitudes, magnitudes)
            )
            flux_count += 1
        previous_magnitudes = magnitudes
        for name in scalar_names:
            scalar_totals[name] += frame[name]
        for name, value in frame["bandRatios"].items():
            band_totals[name] = band_totals.get(name, 0.0) + value
        valid_frames += 1
    if not valid_frames:
        return {"state": "unavailable", "reason": "No non-silent spectral frame was available."}
    return {
        "state": "measured",
        "fftSize": fft_size,
        "frameCount": valid_frames,
        "centroidHz": scalar_totals["centroidHz"] / valid_frames,
        "bandwidthHz": scalar_totals["bandwidthHz"] / valid_frames,
        "rolloff85Hz": scalar_totals["rolloff85Hz"] / valid_frames,
        "flatness": scalar_totals["flatness"] / valid_frames,
        "flux": flux_total / flux_count if flux_count else 0.0,
        "bandRatios": {
            name: value / valid_frames
            for name, value in band_totals.items()
        },
    }


def _temporal_analysis(values: list[float], duration: float, sample_stride: int, sample_rate: int) -> dict[str, Any]:
    if not values:
        return {"state": "unavailable", "reason": "No samples were available."}
    envelope_bins = min(256, max(8, len(values) // 32))
    bin_size = max(1, math.ceil(len(values) / envelope_bins))
    envelope = [
        math.sqrt(sum(value * value for value in values[start : start + bin_size]) / len(values[start : start + bin_size]))
        for start in range(0, len(values), bin_size)
        if values[start : start + bin_size]
    ]
    positive_flux = [max(0.0, right - left) for left, right in zip(envelope, envelope[1:])]
    threshold = median(positive_flux) * 2.5 if positive_flux else 0.0
    onsets = [
        index
        for index, value in enumerate(positive_flux)
        if value > threshold and value > 1e-5
    ]
    peak = max(envelope, default=0.0)
    attack_seconds: float | None = None
    if peak > SILENCE_RMS_THRESHOLD:
        ten = next((index for index, value in enumerate(envelope) if value >= peak * 0.1), None)
        ninety = next((index for index, value in enumerate(envelope) if value >= peak * 0.9), None)
        if ten is not None and ninety is not None and ninety >= ten:
            attack_seconds = ((ninety - ten) / max(1, len(envelope) - 1)) * duration
    effective_rate = sample_rate / sample_stride
    zero_crossings = sum(
        1 for left, right in zip(values, values[1:]) if (left <= 0 < right) or (left >= 0 > right)
    )
    return {
        "state": "measured",
        "onsetCount": len(onsets),
        "onsetDensityHz": len(onsets) / max(duration, 1e-9),
        "attackSeconds": attack_seconds,
        "zeroCrossingRate": zero_crossings / max(1.0, len(values) / effective_rate),
        "envelopePoints": [round(value, 8) for value in envelope],
    }


def _loopability(
    samples: array.array,
    *,
    channels: int,
    frame_count: int,
    sample_rate: int,
    rms: float,
) -> dict[str, Any]:
    compare_frames = min(frame_count // 2, max(64, round(sample_rate * 0.02)))
    if compare_frames < 16 or rms <= SILENCE_RMS_THRESHOLD:
        return {"state": "unavailable", "reason": "A non-silent boundary window is required."}
    seam = sum(
        abs(
            _frame_value(samples, channels, index)
            - _frame_value(samples, channels, frame_count - compare_frames + index)
        )
        for index in range(compare_frames)
    ) / compare_frames
    score = max(0.0, min(1.0, 1.0 - (seam / max(2.0 * rms, 1e-9))))
    return {
        "state": "inferred",
        "score": score,
        "seamMeanAbsoluteError": seam,
        "windowSeconds": compare_frames / sample_rate,
        "uncertainty": "Boundary similarity is not a perceptual guarantee of a seamless loop.",
    }


def analyze_sound_matter(
    *,
    samples: array.array,
    channels: int,
    sample_rate: int,
    frame_count: int,
    fft_size: int,
    max_frames: int,
) -> dict[str, Any]:
    duration = frame_count / sample_rate
    sample_stride = max(1, math.ceil(frame_count / MAX_AMPLITUDE_SAMPLES))
    values = [
        _frame_value(samples, channels, frame)
        for frame in range(0, frame_count, sample_stride)
    ]
    absolute = [abs(value) for value in values]
    square_mean = sum(value * value for value in values) / max(1, len(values))
    rms = math.sqrt(square_mean)
    peak = max(absolute, default=0.0)
    p10 = _percentile(absolute, 0.10)
    p95 = _percentile(absolute, 0.95)
    dynamic_range_db = 20.0 * math.log10(max(p95, 1e-9) / max(p10, 1e-9))
    amplitude = {
        "state": "measured",
        "sampleStride": sample_stride,
        "rms": rms,
        "peak": peak,
        "crestFactor": peak / max(rms, 1e-12),
        "dcOffset": sum(values) / max(1, len(values)),
        "dynamicRangeDb": dynamic_range_db,
    }
    temporal = _temporal_analysis(values, duration, sample_stride, sample_rate)
    warnings: list[str] = []
    if sample_stride > 1:
        warnings.append(
            f"Amplitude and temporal summaries use a bounded 1:{sample_stride} sample stride."
        )

    if duration < MIN_MORPHOLOGY_DURATION_SECONDS:
        spectral: dict[str, Any] = {
            "state": "unavailable",
            "reason": "Material shorter than 50 ms is not assigned stable spectral morphology.",
        }
        morphology: dict[str, Any] = {
            "state": "unavailable",
            "reason": "At least 50 ms is required for this bounded morphological inference.",
        }
        warnings.append("Short material remains available for amplitude inspection only.")
    elif rms <= SILENCE_RMS_THRESHOLD:
        spectral = {
            "state": "unavailable",
            "reason": "Spectral descriptors are not asserted for digital silence.",
        }
        morphology = {
            "state": "unavailable",
            "reason": "Silence is not assigned fabricated material morphology.",
        }
        warnings.append("The source is effectively silent at the configured threshold.")
    else:
        spectral = _spectral_analysis(
            samples,
            channels=channels,
            frame_count=frame_count,
            sample_rate=sample_rate,
            fft_size=fft_size,
            max_frames=max_frames,
        )
        if spectral.get("state") == "measured":
            brightness = spectral["centroidHz"] / max(1.0, sample_rate / 2.0)
            density_value = min(
                1.0,
                (temporal.get("onsetDensityHz", 0.0) / 20.0) * 0.55
                + spectral.get("flux", 0.0) * 0.45,
            )
            morphology = {
                "state": "inferred",
                "basis": ["spectral centroid", "spectral flux", "onset density"],
                "brightness": "dark" if brightness < 0.12 else "bright" if brightness > 0.32 else "mid",
                "density": "sparse" if density_value < 0.25 else "dense" if density_value > 0.62 else "balanced",
                "granularity": "particulate" if spectral.get("flux", 0.0) > 0.22 else "continuous",
                "spectralStability": "evolving" if spectral.get("flux", 0.0) > 0.18 else "stable",
                "confidence": "medium",
                "uncertainty": (
                    "These morphology labels are bounded computational inferences, not heard claims."
                ),
            }
        else:
            morphology = {
                "state": "unavailable",
                "reason": "Morphology requires available spectral measurements.",
            }

    stereo_width: dict[str, Any]
    if channels == 2:
        mid_total = 0.0
        side_total = 0.0
        count = 0
        for frame in range(0, frame_count, sample_stride):
            left = samples[frame * 2] / 32768.0
            right = samples[(frame * 2) + 1] / 32768.0
            mid_total += abs((left + right) * 0.5)
            side_total += abs((left - right) * 0.5)
            count += 1
        stereo_width = {
            "state": "measured",
            "sideToMidRatio": (side_total / max(1, count)) / max(mid_total / max(1, count), 1e-12),
        }
    else:
        stereo_width = {"state": "not_applicable", "reason": "The source is mono."}

    return {
        "analysisState": "partial" if warnings else "complete",
        "durationSeconds": duration,
        "sampleRateHz": sample_rate,
        "channels": channels,
        "amplitude": amplitude,
        "temporal": temporal,
        "spectral": spectral,
        "spatial": stereo_width,
        "loopability": _loopability(
            samples,
            channels=channels,
            frame_count=frame_count,
            sample_rate=sample_rate,
            rms=rms,
        ),
        "morphology": morphology,
        "warnings": warnings,
        "epistemicLegend": {
            "measured": "Computed from the supplied PCM frames within declared bounds.",
            "inferred": "A reversible interpretation derived from measured descriptors.",
            "unavailable": "No value was invented when the method lacked adequate material.",
        },
    }
