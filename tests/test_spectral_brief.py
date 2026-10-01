import contextlib
import hashlib
import io

import numpy as np
import pytest
from server import spectral_brief
from server.spectral_synthesis import render


def test_three_partial_frame_reconstruction_and_changed_retention(monkeypatch):
    derivatives = pytest.importorskip("akousmata_app.derivatives")
    values = np.zeros((1, 513, 3), dtype=np.complex64)
    values[0, [10, 20, 30], 1] = [1, 0.5, 0.25]
    stream = io.BytesIO()
    np.save(stream, values, allow_pickle=False)
    data = stream.getvalue()
    sha = hashlib.sha256(data).hexdigest()
    bundle = dict(
        effective_rate_hz=48000,
        subject_ref="a" * 64,
        views=[
            dict(
                view_id="test",
                kind="complex_stft",
                sha256=sha,
                axis_order=["channel", "frequency", "time"],
                axis_units=["channel", "Hz", "s"],
                settings=dict(scaling="magnitude", fft_length=1024, hop=512),
            )
        ],
    )
    monkeypatch.setattr(spectral_brief, "open_store", lambda: contextlib.nullcontext(object()))
    monkeypatch.setattr(derivatives, "read_derivative", lambda *args: data)
    monkeypatch.setattr(derivatives, "authorized_bundle", lambda *args: bundle)
    selection = dict(
        record_ref="test", view_id="test", view_sha256=sha, frame=1, channel=0, partials=3
    )
    p, receipt = spectral_brief.extract(selection)
    assert p["frequencies"] == [468.75, 937.5, 1406.25]
    assert p["partials"] == [1, 0.5, 0.25]
    assert receipt["frame_time_seconds"] == 512 / 48000
    pcm, _ = render("additive", {**p, "sample_rate": 48000}, 2, 42, lambda: False)
    # A 4096-frame interior measurement has bins exactly aligned with the source partials.
    segment = pcm[10000:14096].astype(float)
    spectrum = abs(np.fft.rfft(segment))
    ratio = spectrum[[40, 80, 120]] / spectrum[40]
    assert np.allclose(ratio, [1, 0.5, 0.25], atol=0.001)
    with pytest.raises(ValueError, match="compatible"):
        spectral_brief.extract({**selection, "view_sha256": "0" * 64})

    def revoked(*_):
        raise ValueError("Derivative grant expired")

    monkeypatch.setattr(derivatives, "read_derivative", revoked)
    with pytest.raises(ValueError, match="expired"):
        spectral_brief.extract(selection)
