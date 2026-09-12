import numpy as np
import pytest
from server import audify


@pytest.fixture
def retained(monkeypatch):
    series = dict(
        contract="cosmo/observation-series/v1",
        seriesId="fixture",
        sourceId="fixture",
        status="available",
        unit="index",
        mode="fixture",
        coverage="synthetic test",
        attribution="fixture",
        points=[
            dict(
                timestamp=f"2026-01-01T00:00:0{i}+00:00",
                intervalEnd=None,
                value=v,
                status="reported",
                quality="fixture",
            )
            for i, v in enumerate([0, 1, 0.5])
        ],
    )
    source = dict(
        id="urn:fixture:source-record",
        createdBy="urn:fixture:actor",
        createdAt="2026-01-01T00:00:00Z",
    )
    observation = dict(id="urn:fixture:observation", field="test", sourceRef="urn:fixture:source")
    monkeypatch.setattr(audify, "resolve", lambda _: (series, source, observation))
    return series, dict(
        record_ref="test",
        series_id="fixture",
        series_sha256=audify.digest(series),
        mode="parameter_mapping",
        input_range=[0, 1],
        frequency_range=[100, 1000],
        resampling="linear",
        missing_data="reject",
    )


def test_parameter_mapping_and_receipt(retained):
    series, selection = retained
    pcm, spectral, receipt = audify.render(selection, 192000, 1, 0.2, lambda: False)
    assert len(pcm) == 192000 and spectral["measured"]["peak"] <= 0.2
    assert receipt["original_clock"] == [p["timestamp"] for p in series["points"]]
    assert receipt["time_compression"] == 2
    assert receipt["source_series_sha256"] == audify.digest(series)
    assert receipt["mapping"]["type"] == "masa:Mapping"
    assert np.array_equal(pcm, audify.render(selection, 192000, 1, 0.2, lambda: False)[0])


def test_single_snapshot_can_control_but_not_direct(retained):
    series, selection = retained
    series["points"] = series["points"][:1]
    assert audify.render(selection, 44100, 0.1, 0.2, lambda: False)[2]["time_compression"] is None
    selection["mode"] = "direct_audification"
    with pytest.raises(ValueError, match="snapshot"):
        audify.render(selection, 44100, 0.1, 0.2, lambda: False)


def test_irregular_direct_requires_declared_resampling(retained):
    series, selection = retained
    series["points"][2]["timestamp"] = "2026-01-01T00:01:00Z"
    selection.update(mode="direct_audification", resampling="none")
    with pytest.raises(ValueError, match="uniform"):
        audify.render(selection, 44100, 0.1, 0.2, lambda: False)
    selection["resampling"] = "linear"
    assert audify.render(selection, 44100, 0.1, 0.2, lambda: False)[0].size == 4410


@pytest.mark.parametrize("mutation", ["missing", "nonfinite", "clock", "range", "alias", "cancel"])
def test_refusals(retained, mutation):
    series, selection = retained
    if mutation == "missing":
        series["points"][1]["value"] = None
    if mutation == "nonfinite":
        series["points"][1]["value"] = float("nan")
    if mutation == "clock":
        series["points"][1]["timestamp"] = series["points"][0]["timestamp"]
    if mutation == "range":
        selection["input_range"] = [1, 0]
    if mutation == "alias":
        selection["frequency_range"] = [20000, 40000]
    with pytest.raises((ValueError, InterruptedError)):
        audify.render(selection, 44100, 0.1, 0.2, lambda: mutation == "cancel")


def test_retained_binding_and_mapping_sidecar(monkeypatch, tmp_path):
    import contextlib
    import json
    import os
    from pathlib import Path
    from server.registry import storage
    from server.routes._utils import run_provider_method
    from server.schemas import GenerateRequest

    source = json.loads(
        (Path(__file__).parent / "fixtures/phase5-observation-source.json").read_text()
    )
    source["sources"][0]["identification"]["value"] = {"sourceId": "fixture"}
    source["observations"][0]["field"] = "fixture-series"
    source["observations"][0]["unit"] = {"state":"known", "value":"index"}
    series = dict(
        contract="cosmo/observation-series/v1",
        seriesId="fixture-series",
        sourceId="fixture",
        status="available",
        unit="index",
        mode="fixture",
        coverage="Synthetic unit fixture",
        attribution="Synthetic test",
        points=[
            dict(
                timestamp="2026-01-01T00:00:00Z",
                intervalEnd=None,
                value=0.5,
                status="reported",
                quality="fixture",
            )
        ],
    )
    source.setdefault("extensions", {})["cosmo:observation-series"] = [series]
    record = dict(
        record_kind="observation_account",
        provenance={"consent_status": "granted"},
        extensions={
            "earworm_observation": {
                "mapping_namespace": "mapping",
                "observation_ref": source["observations"][0]["id"],
            }
        },
        listening={"mapping": {"payload": {"source_snapshot": source}}},
    )

    class Store:
        forgotten_now = False

        def get(self, _):
            return record

        def forgotten(self, _):
            return self.forgotten_now

    store = Store()
    monkeypatch.setattr(audify, "open_store", lambda: contextlib.nullcontext(store))
    selection = dict(
        record_ref="fixture-record",
        series_id="fixture-series",
        series_sha256=audify.digest(series),
        mode="parameter_mapping",
        input_range=[0, 1],
        frequency_range=[100, 1000],
        resampling="none",
        missing_data="reject",
    )
    assert audify.resolve(selection)[0] == series
    with pytest.raises(ValueError, match="changed"):
        audify.resolve({**selection, "series_sha256": "0" * 64})
    store.forgotten_now = True
    with pytest.raises(ValueError, match="unavailable"):
        audify.resolve(selection)
    store.forgotten_now = False
    record["provenance"]["consent_status"] = "revoked"
    with pytest.raises(ValueError, match="consent"):
        audify.resolve(selection)
    record["provenance"]["consent_status"] = "granted"
    result = run_provider_method(
        GenerateRequest(
            provider="synthesis",
            model="audification",
            prompt="Synthetic observation mapping",
            duration=0.1,
            seed=42,
            source={"audification": selection, "synthesis": {"sample_rate": 192000, "gain": 0.2}},
        ),
        "text-to-audio",
        "generate",
    )
    assert result.status == "done", result.error
    metadata = json.loads(storage.resolve_path(result.metadata_files[0]).read_text())
    assert metadata["masa"]["status"] == "written", metadata["masa"]
    sidecar = json.loads(storage.resolve_path(metadata["masa"]["sidecar_path"]).read_text())
    assert sidecar["mappings"][-1]["sourceObservationRefs"] == [source["observations"][0]["id"]]
    assert metadata["masa"]["representation_id"] == sidecar["history"]["events"][-1]["outputs"][-1]
    assert (
        sidecar["history"]["events"][-1]["extensions"]["germ:synthesis"]["audification"][
            "source_graph"
        ]["policies"]
        == source["policies"]
    )
    if os.environ.get("GERM_TEST_MASA_VALIDATOR"):
        from akousma.masa_runtime import masa_validator

        assert not masa_validator(os.environ["GERM_TEST_MASA_VALIDATOR"])(sidecar)
