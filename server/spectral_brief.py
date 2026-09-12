"""Reconstruct an explicitly selected retained STFT frame, never a rendered image."""

import hashlib
import io
import json
from pathlib import Path

import numpy as np

from server.akousma_store import open_store


def extract(selection):
    from akousmata_app.derivatives import authorized_bundle, read_derivative

    allowed = {"record_ref", "view_id", "view_sha256", "frame", "channel", "partials"}
    if not isinstance(selection, dict) or set(selection) != allowed:
        raise ValueError("Select record, view hash, frame, channel and partial count")
    frame, channel, count = (selection[k] for k in ("frame", "channel", "partials"))
    if any(type(n) is not int or n < 0 for n in (frame, channel, count)) or not 1 <= count <= 32:
        raise ValueError("Invalid frame, channel or partial count")
    with open_store() as store:
        data = read_derivative(store, selection["record_ref"], selection["view_id"])
        bundle = authorized_bundle(store, selection["record_ref"])
        view = next(v for v in bundle["views"] if v["view_id"] == selection["view_id"])
        if (
            view["kind"] != "complex_stft"
            or view["sha256"] != selection["view_sha256"]
            or view.get("axis_order") != ["channel", "frequency", "time"]
            or view.get("axis_units") != ["channel", "Hz", "s"]
            or view["settings"].get("scaling") != "magnitude"
        ):
            raise ValueError("Select a compatible retained magnitude-scaled complex STFT")
        values = np.load(io.BytesIO(data), allow_pickle=False)
        if channel >= values.shape[0] or frame >= values.shape[2]:
            raise ValueError("Frame or channel outside retained view")
        magnitudes = abs(values[channel, :, frame])
        # Local peaks avoid treating neighboring Hann bins as separate partials.
        peaks = (
            np.flatnonzero(
                (magnitudes[1:-1] > magnitudes[:-2]) & (magnitudes[1:-1] >= magnitudes[2:])
            )
            + 1
        )
        ranked = sorted(peaks.tolist(), key=lambda i: (-float(magnitudes[i]), i))[:count]
        if not ranked or max(magnitudes[ranked]) == 0:
            raise ValueError("Selected frame has no nonzero spectral peaks")
        ranked.sort()
        rate, fft = bundle["effective_rate_hz"], view["settings"]["fft_length"]
        amplitudes = magnitudes[ranked] / max(magnitudes[ranked])
        parameters = dict(
            frequencies=[i * rate / fft for i in ranked], partials=amplitudes.tolist()
        )
        receipt = dict(
            contract="germ/spectral-frame-brief/v1",
            selection=selection,
            implementation_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            source_sha256=bundle["subject_ref"],
            view_sha256=hashlib.sha256(data).hexdigest(),
            bundle_sha256=hashlib.sha256(
                json.dumps(bundle, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest(),
            frame_time_seconds=view.get("time_origin_s", 0)
            + frame * view["settings"]["hop"] / rate,
            units={"frequency": "Hz", "amplitude": "relative peak magnitude"},
            recipe="local maxima excluding DC/Nyquist; amplitude descending, bin index tie-break; no sub-bin interpolation",
            frequency_resolution_hz=rate / fft,
            losses=[
                "Source phase discarded; zero-phase oscillators",
                "Magnitudes normalized; original amplitude and temporal evolution not preserved",
                "Finite Hann-bin resolution and leakage; not source identity",
            ],
        )
        return parameters, receipt
