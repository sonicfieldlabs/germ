"""Bounded digital oscillators. Declared components are distinct from measured WAV energy."""

from __future__ import annotations

import math
import time

import numpy as np

MODELS = {"additive", "chirp", "band-noise", "fm", "pulse"}
RATES = (44100, 48000, 96000, 192000)


def admit(model, parameters, duration):
    if model not in MODELS or not isinstance(parameters, dict):
        raise ValueError("Unknown spectral oscillator")
    common = {"sample_rate", "frequency", "gain"}
    specific = {
        "additive": {"partials", "frequencies"},
        "chirp": {"end_frequency"},
        "band-noise": {"low_frequency", "high_frequency", "components"},
        "fm": {"mod_frequency", "mod_index", "sidebands"},
        "pulse": {"harmonics", "duty"},
    }
    if set(parameters) - common - specific[model]:
        raise ValueError("Unsupported synthesis parameter")
    p = dict(parameters)
    rate = p.setdefault("sample_rate", 44100)
    if type(rate) is not int or rate not in RATES:
        raise ValueError("Select 44100, 48000, 96000 or 192000 Hz")
    if not math.isfinite(duration) or not 0.1 <= duration <= 30:
        raise ValueError("Synthesis duration must be 0.1–30 seconds")

    def number(key, default, low, high, integer=False):
        value = p.setdefault(key, default)
        if (
            type(value) not in ((int,) if integer else (int, float))
            or not math.isfinite(value)
            or not low <= value <= high
        ):
            raise ValueError("Invalid spectral parameter: " + key)
        return value

    f = number("frequency", 220, 0.1, 90000)
    number("gain", 0.2, 0, 1)
    if model == "additive":
        amplitudes = p.setdefault("partials", [1])
        if (
            not isinstance(amplitudes, list)
            or not 1 <= len(amplitudes) <= 32
            or any(
                type(a) not in (int, float) or not math.isfinite(a) or not 0 <= a <= 1
                for a in amplitudes
            )
        ):
            raise ValueError("Supply 1–32 finite partial amplitudes in [0,1]")
        frequencies = p.setdefault("frequencies", [f * (i + 1) for i in range(len(amplitudes))])
        if (
            not isinstance(frequencies, list)
            or len(frequencies) != len(amplitudes)
            or any(
                type(v) not in (int, float) or not math.isfinite(v) or not 0.1 <= v <= 90000
                for v in frequencies
            )
        ):
            raise ValueError("Partial frequencies must match amplitudes and lie in 0.1–90000 Hz")
        bounds = min(frequencies), max(frequencies)
    elif model == "chirp":
        end = number("end_frequency", 440, 0.1, 90000)
        bounds = min(f, end), max(f, end)
    elif model == "band-noise":
        low = number("low_frequency", 100, 0.1, 90000)
        high = number("high_frequency", 1000, 0.1, 90000)
        number("components", 64, 2, 256, True)
        if low >= high:
            raise ValueError("Noise band must have positive width")
        bounds = low, high
    elif model == "fm":
        mod = number("mod_frequency", 1, 0.1, 90000)
        index = number("mod_index", 1, 0, 8)
        count = number("sidebands", 16, 1, 32, True)
        if count < math.ceil(index) + 8:
            raise ValueError("FM needs at least ceil(index)+8 declared sidebands")
        bounds = f - count * mod, f + count * mod
    else:
        count = number("harmonics", 16, 1, 128, True)
        number("duty", 0.5, 0.01, 0.99)
        bounds = f, f * count
    if bounds[0] <= 0 or bounds[1] >= rate / 2 or bounds[1] > 90000:
        raise ValueError("Declared components cross zero, Nyquist or the 90 kHz ceiling")
    return p, bounds


def _bessel(n, x):
    # Bounded order/index; finite series evaluated in float64.
    return sum(
        (-1) ** k * (x / 2) ** (2 * k + n) / (math.factorial(k) * math.factorial(k + n))
        for k in range(48)
    )


def render(model, parameters, duration, seed, cancelled):
    p, bounds = admit(model, parameters, duration)
    rate, gain, f = p["sample_rate"], p["gain"], p["frequency"]
    total = int(duration * rate)
    output = np.empty(total, dtype=np.int16)
    rng = np.random.default_rng(seed)
    phases = None
    if model == "additive":
        frequencies, amplitudes = p["frequencies"], p["partials"]
    elif model == "band-noise":
        frequencies = rng.uniform(*bounds, p["components"])
        amplitudes = np.ones(p["components"])
        phases = rng.uniform(0, 2 * math.pi, p["components"])
    elif model == "pulse":
        frequencies = [f * h for h in range(1, p["harmonics"] + 1)]
        amplitudes = [
            2 * math.sin(math.pi * h * p["duty"]) / (math.pi * h)
            for h in range(1, p["harmonics"] + 1)
        ]
    elif model == "fm":
        orders = range(-p["sidebands"], p["sidebands"] + 1)
        frequencies = [f + n * p["mod_frequency"] for n in orders]
        amplitudes = [
            (-1 if n < 0 and abs(n) % 2 else 1) * _bessel(abs(n), p["mod_index"]) for n in orders
        ]
    deadline = time.monotonic() + 30
    for start in range(0, total, 8192):
        if cancelled():
            raise InterruptedError("Spectral synthesis cancelled")
        if time.monotonic() > deadline:
            raise TimeoutError("Spectral synthesis exceeded 30 seconds")
        indices = np.arange(start, min(start + 8192, total))
        t = indices / rate
        if model == "chirp":
            value = np.sin(
                2 * math.pi * (f * t + 0.5 * (p["end_frequency"] - f) / duration * t * t)
            )
        else:
            value = np.zeros(len(t))
            for j, (frequency, amplitude) in enumerate(zip(frequencies, amplitudes)):
                value += amplitude * np.sin(
                    2 * math.pi * frequency * t + (phases[j] if phases is not None else 0)
                )
            value /= max(1, sum(abs(a) for a in amplitudes))
        # Rate-aware 6 ms / 45 ms raised-cosine transitions; finite windows leak energy.
        ramp = np.minimum(
            1, np.minimum(indices / (0.006 * rate), (total - 1 - indices) / (0.045 * rate))
        )
        envelope = 0.5 - 0.5 * np.cos(math.pi * ramp)
        output[start : start + len(t)] = np.rint(value * gain * envelope * 32767).astype(np.int16)
    measured = measure(output, rate)
    return output, dict(
        contract="germ/spectral-synthesis/v1",
        sample_rate_hz=rate,
        intended_band_hz=list(bounds),
        measured=measured,
        scope="beyond_reference" if bounds[0] < 20 or bounds[1] > 20000 else "human_reference",
        render_cycles_at_declared_low_edge=duration * bounds[0],
        measurement_cycles_at_declared_low_edge=measured["window_frames"] / rate * bounds[0],
        limitations=[
            "Finite windows and PCM quantization introduce out-of-band energy; declarations are not strict band limits.",
            "Cycle count limits low-frequency resolution; no physical emission or audibility evidence.",
            "Noise is a seeded finite random multisine; FM is a truncated Bessel expansion; pulses omit DC and higher harmonics.",
        ],
        effective_parameters=p,
        numpy_version=np.__version__,
    )


def measure(pcm, rate):
    samples = np.asarray(pcm, dtype=np.float64) / 32768
    # Bounded one-second measurement window; disclose its resolution and position.
    segment = samples[:rate]
    power = abs(np.fft.rfft(segment)) ** 2
    frequencies = np.fft.rfftfreq(len(segment), 1 / rate)
    energy = float(power.sum())
    return dict(
        peak=float(np.max(abs(samples))),
        dc=float(samples.mean()),
        silence=not bool(np.any(pcm)),
        window_start_seconds=0,
        window_frames=len(segment),
        resolution_hz=rate / len(segment),
        peak_frequency_hz=float(frequencies[int(np.argmax(power))]) if energy else None,
        beyond_reference_energy_fraction=float(
            power[(frequencies < 20) | (frequencies > 20000)].sum() / energy
        )
        if energy
        else 0,
    )
