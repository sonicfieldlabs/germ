import numpy as np
import pytest

from server.registry import storage
from server.routes.simulated import DesignedSignal
from server.routes.simulated import render as submit
from server.spectral_synthesis import admit, render


def test_gaps_clock_seed_and_nyquist():
    p = dict(
        sample_rate=48000,
        frequency=10000,
        clock_ppm=1000,
        gaps=[[0.4, 0.6]],
        envelope_seconds=[0, 0],
    )
    signal, receipt = render("additive", p, 1, 42, lambda: False)
    assert not signal[19200:28800].any()
    assert receipt["intended_band_hz"] == pytest.approx([10010, 10010])
    assert receipt["measured"]["peak_frequency_hz"] == 10010
    a, _ = render("band-noise", p | dict(frequency=220), 1, 42, lambda: False)
    b, _ = render("band-noise", p | dict(frequency=220), 1, 43, lambda: False)
    assert not np.array_equal(a, b)
    for bad in (
        {"gaps": [[0.5, 1.1]]},
        {"clock_ppm": 1001},
        {"envelope_seconds": [-1, 0]},
        {"frequency": 23999, "clock_ppm": 1000},
    ):
        with pytest.raises(ValueError):
            admit("additive", {"sample_rate": 48000, **bad}, 1)


def test_designed_job_provenance_and_tamper(monkeypatch, tmp_path):
    import json
    import time

    from fastapi import HTTPException

    from server.akousma_store import open_store
    from server.routes.simulated import resolve, sources

    monkeypatch.setenv("AKOUSMATA_PATH", str(tmp_path / "memory"))
    job = submit(DesignedSignal(parameters={"sample_rate": 96000, "frequency": 40000}))
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        state = storage.get_job(job.job_id)
        if state.status in {"done", "error", "cancelled"}:
            break
        time.sleep(0.02)
    assert state.status == "done", state.error
    meta = json.loads(storage.resolve_path(state.metadata_files[0]).read_text())
    assert meta["akousmata"]["status"] == "remembered", meta["akousmata"]
    with open_store() as store:
        record = store.get(meta["akousmata"]["akousma_id"])
    assert record["provenance"]["source_type"] == "designed"
    assert record["extensions"]["germ.simulated"]["parameters"]["frequency"] == 40000
    row = next(r for r in sources()["sources"] if r["sound_id"] == meta["sound_id"])
    location = resolve(row["key"])
    from pathlib import Path

    with Path(location["path"]).open("ab") as stream:
        stream.write(b"changed")
    with pytest.raises(HTTPException) as error:
        resolve(row["key"])
    assert error.value.status_code == 409
