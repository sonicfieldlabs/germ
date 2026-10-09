import json
import wave

import numpy as np
import pytest

from server.spectral_synthesis import admit, render
from server.registry import storage
from test_synthesis_provider import run


@pytest.mark.parametrize("rate", [44100, 48000, 96000, 192000])
def test_rate_chain(rate, tmp_path, monkeypatch):
    monkeypatch.setenv("AKOUSMATA_PATH", str(tmp_path / "memory"))
    frequency = 40000 if rate >= 96000 else 1000
    result = run("additive", dict(sample_rate=rate, frequency=frequency), duration=1)
    assert result.status == "done", result.error
    assert result.sample_rate == rate
    with wave.open(str(storage.resolve_path(result.audio_files[0]))) as wav:
        assert wav.getframerate() == rate
        pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
        peak = np.fft.rfftfreq(len(pcm), 1 / rate)[np.argmax(abs(np.fft.rfft(pcm)))]
        assert peak == frequency
    metadata = json.loads(storage.resolve_path(result.metadata_files[0]).read_text())
    assert metadata["synthesis"]["spectral"]["measured"]["peak_frequency_hz"] == frequency


@pytest.mark.parametrize(
    "model,p",
    [
        ("additive", {"frequency": 40000, "sample_rate": 48000}),
        ("additive", {"frequency": 40000, "sample_rate": 192000, "partials": [1, 1, 1]}),
        ("pulse", {"frequency": 10000, "harmonics": 16}),
        ("fm", {"frequency": 20000, "mod_frequency": 1000}),
        ("fm", {"mod_index": 8, "sidebands": 1}),
        ("chirp", {"end_frequency": 24000, "sample_rate": 48000}),
        ("band-noise", {"low_frequency": 1000, "high_frequency": 100}),
        ("additive", {"sample_rate": True}),
        ("additive", {"gain": float("nan")}),
    ],
)
def test_reject_aliasing_and_invalid(model, p):
    with pytest.raises(ValueError):
        admit(model, p, 1)


@pytest.mark.parametrize(
    "model,p",
    [
        ("additive", {}),
        ("chirp", {}),
        ("band-noise", {}),
        ("fm", {"frequency": 1000}),
        ("pulse", {}),
    ],
)
def test_bounded_repeatable(model, p):
    a, receipt = render(model, p, 0.2, 42, lambda: False)
    b, _ = render(model, p, 0.2, 42, lambda: False)
    assert np.array_equal(a, b)
    assert receipt["measured"]["peak"] <= 0.2
    assert abs(receipt["measured"]["dc"]) < 0.02
    silence, r = render(model, {**p, "gain": 0}, 0.2, 42, lambda: False)
    assert not silence.any() and r["measured"]["silence"]
    with pytest.raises(InterruptedError):
        render(model, p, 30, 42, lambda: True)


def test_filtered_conversion_does_not_preserve_40khz():
    from server.rate_conversion import filtered_convert

    rate = 192000
    tone = 0.2 * np.sin(2 * np.pi * 40000 * np.arange(rate) / rate)
    converted, receipt = filtered_convert(tone, rate, 48000)
    assert len(converted) == 48000
    assert np.sqrt(np.mean(converted**2)) < 1e-5
    assert receipt["transition_band_hz"] == [21600, 24000]
    assert "removed" in receipt["losses"]


def test_maximum_render_and_low_frequency_uncertainty_are_bounded():
    import tracemalloc

    tracemalloc.start()
    try:
        pcm, receipt = render(
            "additive", {"frequency": 0.1, "sample_rate": 192000}, 30, 42, lambda: False
        )
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert pcm.nbytes == 11520000
    assert peak < 192 * 1024 * 1024
    assert receipt["render_cycles_at_declared_low_edge"] == 3
    assert receipt["measurement_cycles_at_declared_low_edge"] == 0.1
    assert receipt["measured"]["resolution_hz"] == 1
