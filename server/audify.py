"""Explicit sonification of retained Cosmo series; snapshots are not audio measurements."""

from datetime import datetime, timezone
import hashlib
import json
import math
import time
import uuid
from pathlib import Path

import numpy as np

from server.akousma_store import open_store
from server.spectral_synthesis import RATES, measure


def digest(value):
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode()
    ).hexdigest()


def resolve(selection):
    if not isinstance(selection, dict) or set(selection) != {
        "record_ref",
        "series_id",
        "series_sha256",
        "mode",
        "input_range",
        "frequency_range",
        "resampling",
        "missing_data",
    }:
        raise ValueError("Choose a retained series, exact hash and explicit mapping policies")
    with open_store() as store:
        record = store.get(selection["record_ref"])
        if (
            not record
            or store.forgotten(selection["record_ref"])
            or record.get("record_kind") != "observation_account"
        ):
            raise ValueError("Observation account is unavailable")
        if record.get("provenance", {}).get("consent_status") in {
            "denied",
            "restricted",
            "revoked",
        }:
            raise ValueError("Observation consent does not admit mapping")
        binding = record["extensions"]["earworm_observation"]
        source = record["listening"][binding["mapping_namespace"]]["payload"]["source_snapshot"]
        series = [
            s
            for s in source.get("extensions", {}).get("cosmo:observation-series", [])
            if s.get("seriesId") == selection["series_id"]
        ]
        if len(series) != 1 or digest(series[0]) != selection["series_sha256"]:
            raise ValueError("Series is absent, ambiguous or changed")
        series = series[0]
        if (
            series.get("contract") != "cosmo/observation-series/v1"
            or series.get("status") != "available"
        ):
            raise ValueError(
                "Select an available observation series; stale values are not substituted"
            )
        observation = next(
            o for o in source["observations"] if o["id"] == binding["observation_ref"]
        )
        source_entity = next(s for s in source["sources"] if s["id"] == observation["sourceRef"])
        if (
            source_entity.get("identification", {}).get("value", {}).get("sourceId")
            != series["sourceId"]
        ):
            raise ValueError("Series does not belong to the selected observation source")
        if observation.get("field") != series["seriesId"] or observation.get("unit", {}).get("value") != series["unit"]:
            raise ValueError("Series field and units must match the retained observation")
        return series, source, observation


def render(selection, rate, duration, gain, cancelled):
    series, source, observation = resolve(selection)
    if (
        type(rate) is not int
        or rate not in RATES
        or not 0.1 <= duration <= 30
        or not 0 <= gain <= 1
    ):
        raise ValueError("Invalid audification output bounds")
    points = series["points"]
    if not isinstance(points, list) or not 1 <= len(points) <= 10000:
        raise ValueError("Series requires 1–10000 points")
    if selection["missing_data"] != "reject":
        raise ValueError("This implementation requires explicit rejection of missing values")
    values, times = [], []
    for point in points:
        value = point.get("value")
        if (
            point.get("status") != "reported"
            or type(value) not in (int, float)
            or not math.isfinite(value)
        ):
            raise ValueError("Missing or nonfinite observations cannot be sonified")
        instant = datetime.fromisoformat(point["timestamp"].replace("Z", "+00:00"))
        if instant.tzinfo is None:
            raise ValueError("Observation timestamps require a timezone")
        times.append(instant.timestamp())
        values.append(value)
    intervals = np.diff(times)
    if len(intervals) and np.any(intervals <= 0):
        raise ValueError("Observation timestamps must strictly increase")
    input_range = selection["input_range"]
    if (
        not isinstance(input_range, list)
        or len(input_range) != 2
        or any(type(v) not in (int, float) or not math.isfinite(v) for v in input_range)
        or input_range[0] >= input_range[1]
    ):
        raise ValueError("Declare an increasing finite input range")
    normalized = np.clip(
        (np.asarray(values) - input_range[0]) / (input_range[1] - input_range[0]), 0, 1
    )
    mode, resampling = selection["mode"], selection["resampling"]
    if resampling not in {"none", "linear"} or mode not in {
        "parameter_mapping",
        "direct_audification",
    }:
        raise ValueError("Unknown mapping or resampling operation")
    uniform = len(intervals) > 0 and np.allclose(intervals, intervals[0], rtol=1e-6, atol=1e-6)
    if mode == "direct_audification" and (
        len(points) < 2 or (not uniform and resampling != "linear")
    ):
        raise ValueError(
            "Direct audification requires a uniform series or declared linear resampling; a snapshot is not a time series"
        )
    total = int(rate * duration)
    if mode == "direct_audification" and total < len(points):
        raise ValueError(
            "Direct downsampling requires a filtered conversion not implemented by this mapping"
        )
    if mode == "direct_audification" and resampling == "none" and total != len(points):
        raise ValueError("Without resampling, output frames must equal observation count")
    if mode == "parameter_mapping":
        frequencies = selection["frequency_range"]
        if (
            not isinstance(frequencies, list)
            or len(frequencies) != 2
            or any(type(v) not in (int, float) or not math.isfinite(v) for v in frequencies)
            or not 0.1 <= frequencies[0] <= frequencies[1] < min(rate / 2, 90000.0001)
        ):
            raise ValueError("Mapping frequencies cross admitted spectral bounds")
    else:
        frequencies = [0, rate / 2]
    output = np.empty(total, dtype=np.int16)
    time_positions = (
        (np.asarray(times) - times[0]) / (times[-1] - times[0])
        if len(points) > 1
        else np.array([0.0])
    )
    phase, deadline = 0.0, time.monotonic() + 30
    for start in range(0, total, 8192):
        if cancelled():
            raise InterruptedError("Audification cancelled")
        if time.monotonic() > deadline:
            raise TimeoutError("Audification exceeded 30 seconds")
        indices = np.arange(start, min(total, start + 8192))
        positions = indices / max(1, total - 1)
        if mode == "parameter_mapping" and resampling == "none":
            mapped = normalized[
                np.maximum(0, np.searchsorted(time_positions, positions, side="right") - 1)
            ]
        else:
            mapped = np.interp(positions, time_positions, normalized)
        if mode == "parameter_mapping":
            instantaneous = frequencies[0] + mapped * (frequencies[1] - frequencies[0])
            angles = phase + np.cumsum(2 * np.pi * instantaneous / rate)
            phase = float(angles[-1] % (2 * np.pi))
            waveform = np.sin(angles)
        else:
            waveform = 2 * mapped - 1
        ramp = np.minimum(
            1, np.minimum(indices / (0.006 * rate), (total - 1 - indices) / (0.045 * rate))
        )
        output[start : start + len(indices)] = np.rint(
            waveform * gain * (0.5 - 0.5 * np.cos(np.pi * ramp)) * 32767
        ).astype(np.int16)
    mapping = dict(
        id="urn:uuid:" + str(uuid.uuid4()),
        type="masa:Mapping",
        sourceObservationRefs=[observation["id"]],
        sourceField=observation["field"],
        sourceUnit=series["unit"],
        inputRange=input_range,
        normalization={"method": "linear", "clipping": "clamp", "parameters": {}},
        target="germ.frequency" if mode == "parameter_mapping" else "germ.pcm-amplitude",
        outputRange=frequencies if mode == "parameter_mapping" else [-gain, gain],
        curve="linear",
        smoothingMs=0,
        cadence="explicit retained observation-series render",
        missingData="refuse",
        epistemicNote="Authored sonification; not acoustic capture, source voice or subsequent listening.",
        actors=["urn:germ:audification:author"],
        createdAt=datetime.now(timezone.utc).isoformat(),
        extensions={},
    )
    receipt = dict(
        contract="germ/audification/v1",
        selection=selection,
        source_series_sha256=digest(series),
        source_record_sha256=digest(source),
        original_unit=series["unit"],
        original_clock=[p["timestamp"] for p in points],
        intervals=[p.get("intervalEnd") for p in points],
        quality=[p.get("quality") for p in points],
        source_mode=series["mode"],
        source_coverage=series["coverage"],
        attribution=series["attribution"],
        normalization={"range": input_range, "clipping": "clamp"},
        missing_data="reject",
        resampling=resampling,
        interpolation="linear"
        if resampling == "linear"
        else "step-held parameter"
        if mode == "parameter_mapping"
        else "none",
        filtering="No antialias filter; direct reduction in point count is refused",
        time_compression=(times[-1] - times[0]) / duration if len(points) > 1 else None,
        output_rate_hz=rate,
        output_duration_seconds=duration,
        gain=gain,
        mapping=mapping,
        implementation_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        source_record_ref=source["id"],
        source_series=series,
        source_graph=dict(
            actors=[
                *source.get("actors", []),
                dict(
                    id="urn:germ:audification:author",
                    type="masa:Actor",
                    actorKind="software",
                    roles=["mapping-author"],
                    name={"state": "known", "value": "GERM explicit mapping"},
                    disclosure="private",
                    extensions={},
                ),
            ],
            sources=[
                item for item in source.get("sources", []) if item["id"] == observation["sourceRef"]
            ],
            observations=[observation],
            representations=[
                item
                for item in source.get("representations", [])
                if item["id"] == observation.get("extensions", {}).get("cosmo:representationRef")
            ],
            policies=source.get("policies", []),
        ),
    )
    spectral = dict(
        contract="germ/spectral-synthesis/v1",
        sample_rate_hz=rate,
        intended_band_hz=frequencies,
        measured=measure(output, rate),
        scope="unknown",
        effective_parameters={"sample_rate": rate, "gain": gain},
        limitations=[
            "An authored mapping is not a measured acoustic series",
            "Parameter transitions, finite windows and quantization spread spectral energy",
        ],
        numpy_version=np.__version__,
    )
    return output, spectral, receipt
