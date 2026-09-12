"""Optional, bounded shoebox image-source simulation. No measured-room claims."""

from __future__ import annotations

import hashlib
import json
import math
import sys
import wave
from importlib.metadata import version
from pathlib import Path


def parameters(request):
    from server.processing_adapter import Refused

    p = request["parameters"]
    required = {
        "dimensions_m",
        "source_m",
        "receiver_m",
        "absorption",
        "max_order",
        "seed",
        "directivity",
        "normalization",
        "rir_method",
    }
    if set(p) != required or request.get("engine") != {
        "state": "known",
        "value": "germ:pyroomacoustics",
    }:
        raise Refused("Room rendering requires the explicit shoebox parameter contract")
    for key in ("dimensions_m", "source_m", "receiver_m"):
        if (
            not isinstance(p[key], list)
            or len(p[key]) != 3
            or any(type(v) not in (int, float) or not math.isfinite(v) for v in p[key])
        ):
            raise Refused("Room coordinates require three finite metres")
    if any(not 1 <= d <= 30 for d in p["dimensions_m"]):
        raise Refused("Shoebox dimensions must be 1–30 metres")
    for key in ("source_m", "receiver_m"):
        if any(not 0 < x < d for x, d in zip(p[key], p["dimensions_m"])):
            raise Refused("Source and receiver must be strictly inside the shoebox")
    if math.dist(p["source_m"], p["receiver_m"]) < 0.1:
        raise Refused("Source and receiver require at least 0.1 metre separation")
    if (
        type(p["absorption"]) not in (int, float)
        or not math.isfinite(p["absorption"])
        or not 0.05 <= p["absorption"] <= 1
        or type(p["max_order"]) is not int
        or not 0 <= p["max_order"] <= 8
        or type(p["seed"]) is not int
        or not 0 <= p["seed"] <= 0xFFFFFFFF
    ):
        raise Refused("Absorption, image order or seed exceeds room limits")
    if (
        p["directivity"] != "omnidirectional"
        or p["normalization"] != "peak_0.95"
        or p["rir_method"] != "shoebox_image_source"
        or "derivative" not in request["outputContract"]["roles"]
        or "audio/wav" not in request["outputContract"].get("mediaTypes", ["audio/wav"])
    ):
        raise Refused("Only omnidirectional shoebox image-source PCM derivatives are supported")
    return dict(p), p["seed"]


def compute(config):
    import numpy as np
    import pyroomacoustics as pra
    from scipy.signal import fftconvolve

    p, rate = config["params"], config["sampleRate"]
    # Own process: no global RNG/constant mutation in the GERM server.
    np.random.seed(p["seed"])
    pra.constants.set("c", 343.0)
    pra.constants.set("frac_delay_length", 81)
    samples = np.fromfile(config["input"], dtype="<i2").astype(np.float64) / 32768
    room = pra.ShoeBox(
        p["dimensions_m"],
        fs=rate,
        materials=pra.Material(p["absorption"]),
        max_order=p["max_order"],
        air_absorption=False,
        ray_tracing=False,
        use_rand_ism=False,
        min_phase=False,
    )
    room.set_sound_speed(343.0)
    room.add_source(p["source_m"])
    room.add_microphone_array(np.array(p["receiver_m"])[:, None])
    room.compute_rir()
    rir = np.asarray(room.rir[0][0], dtype=np.float64)
    if len(rir) > rate * 5 or not np.isfinite(rir).all():
        raise ValueError("RIR exceeds five-second or finite-value budget")
    output = fftconvolve(samples, rir)
    if len(output) > rate * 35 or not np.isfinite(output).all():
        raise ValueError("Room output exceeds budget")
    peak = float(np.max(abs(output)))
    scale = 0.95 / peak if peak else 1.0
    pcm = np.rint(output * scale * 32767).astype("<i2")
    with wave.open(config["output"], "wb") as wav:
        wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        wav.writeframes(pcm.tobytes())
    receipt = dict(
        engine="pyroomacoustics",
        version=version("pyroomacoustics"),
        numpy_version=np.__version__,
        scipy_version=version("scipy"),
        python_version=sys.version,
        sample_rate_hz=rate,
        seed=p["seed"],
        parameters=p,
        source_frames=len(samples),
        frames=len(pcm),
        rir_frames=len(rir),
        rir_sha256_float64_le=hashlib.sha256(rir.astype("<f8").tobytes()).hexdigest(),
        speed_of_sound_m_s=343.0,
        fractional_delay_length=81,
        air_absorption=False,
        randomized_ism=False,
        ray_tracing=False,
        material_assumption="Uniform frequency-independent energy absorption on all six walls",
        directivity="One omnidirectional source and receiver",
        normalization_scale=scale,
        normalization="Global peak 0.95; PCM16 quantization; no dither",
        tail="Full finite image-source RIR convolution; not measured reverberation",
        semantics="Simulated sonic field; no physical room, capture or audibility validation",
    )
    Path(config["receipt"]).write_text(json.dumps(receipt, allow_nan=False))


if __name__ == "__main__":
    compute(json.loads(Path(sys.argv[1]).read_text()))
