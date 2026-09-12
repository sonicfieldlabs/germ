"""Real local mock PCM, shared-store linkage and offline MASA profile validation."""

import json
import os
from copy import deepcopy
from pathlib import Path
from hashlib import sha256
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from server.main import app
from server.generation_workflow import execute
from server.registry import storage, registry
from server.schemas import GenerateRequest
from server.processing_adapter import validate
from test_derivation import request


@pytest.fixture
def library(tmp_path, monkeypatch):
    from akousma import AkousmataStore

    monkeypatch.setenv("AKOUSMATA_PATH", str(tmp_path))
    source = json.loads((Path(__file__).parent / "fixtures/derivation-source.json").read_text())
    with AkousmataStore(tmp_path) as store:
        store.put(source)
        yield store, source


def payload(source):
    body = request([source])
    body["parameters"] = {"duration": 0.1}
    return dict(
        derivation=body,
        execution=dict(
            provider="mock",
            model="mock-sine",
            seed=42,
            masa_contracts=["masa/0.2.0"],
            record_contract="earworm/akousma/v1.6",
        ),
    )


def test_actual_output_parent_hash_receipt_and_masa_profile(library, tmp_path):
    store, source = library
    response = execute(payload(source))
    assert response["generation"]["status"] == "done", response
    assert response["linkage_status"] == "complete", response
    link = response["outputs"][0]
    record = store.get(link["akousma_id"])
    assert record["lineage"]["parent_akousma_ids"] == [source["akousma_id"]]
    assert store.get(source["akousma_id"]) == source
    audio = storage.resolve_path(link["audio_file"])
    assert sha256(audio.read_bytes()).hexdigest() == link["output_sha256"]
    sidecar = json.loads(storage.resolve_path(link["masa"]["sidecar_path"]).read_text())
    from server.masa_bridge import build_generation_record

    metadata = json.loads(storage.resolve_path(link["metadata_file"]).read_text())
    regenerated = build_generation_record(metadata)
    assert regenerated == sidecar
    receipt = sidecar["history"]["events"][-1]
    assert receipt["id"] == link["masa"]["receipt_id"]
    assert receipt["outputs"] == [link["masa"]["representation_id"]]
    assert receipt["extensions"]["germ:derivation"]["sources"] == response["plan"]["sources"]
    output = next(r for r in sidecar["representations"] if r["id"] == receipt["outputs"][0])
    assert output["integrity"]["value"]["digest"] == link["output_sha256"]
    validator = os.environ.get("GERM_TEST_MASA_VALIDATOR")
    if validator:
        validate("record", sidecar, Path(validator), tmp_path)
        validate("receipt", receipt, Path(validator), tmp_path)


@pytest.mark.parametrize("change", ["contracts", "missing", "provider", "options", "restricted"])
def test_refused_before_provider(library, change):
    store, source = library
    body = payload(source)
    if change == "contracts":
        body["execution"]["masa_contracts"] = ["masa/99"]
    if change == "missing":
        body["derivation"]["workflow"]["source_refs"] = ["missing"]
    if change == "provider":
        body["execution"].pop("provider")
    if change == "options":
        body["execution"]["prompt"] = "bypass"
    if change == "restricted":
        changed = deepcopy(source)
        changed["provenance"]["consent_status"] = "restricted"
        store.put(changed)
    with patch("server.generation_workflow.run_provider_method") as run:
        with TestClient(app) as client:
            assert client.post("/akousma/derivation/generate", json=body).status_code == 400
        run.assert_not_called()


def test_restriction_during_provider_leaves_audio_but_no_false_link(library):
    store, source = library
    provider = registry.get("mock")
    original = provider.generate

    def revoke(request):
        changed = deepcopy(source)
        changed["provenance"]["consent_status"] = "restricted"
        from akousma import AkousmataStore

        with AkousmataStore(store.root) as worker_store:
            worker_store.put(changed)
        return original(request)

    with patch.object(provider, "generate", revoke):
        response = execute(payload(source))
    assert response["generation"]["status"] == "done"
    assert response["linkage_status"] == "incomplete" and response["gaps"]
    assert not response["outputs"]
    assert storage.resolve_path(response["generation"]["audio_files"][0]).is_file()


def test_optional_relisten_reuses_bridge_and_reports_failure_separately(library):
    _, source = library
    body = payload(source)
    body["execution"]["relisten"] = True
    with patch("server.listener.relisten_with_oida", side_effect=RuntimeError("offline")) as listen:
        response = execute(body)
    assert response["linkage_status"] == "complete"
    assert response["subsequent_listening"][0]["status"] == "error"
    assert listen.call_args.args[0].audio_path == response["outputs"][0]["audio_file"]
    assert listen.call_args.args[0].remember is False


def test_no_negotiation_marks_sidecar_gap_without_destroying_output(library):
    from server.routes._utils import run_provider_method

    result = run_provider_method(
        GenerateRequest(provider="mock", model="mock-sine", duration=0.1, masa_contracts=[]),
        "text-to-audio",
        "generate",
    )
    assert result.status == "done"
    metadata = json.loads(storage.resolve_path(result.metadata_files[0]).read_text())
    assert metadata["masa"]["status"] == "not_negotiated"
    assert storage.resolve_path(result.audio_files[0]).is_file()


def test_optional_relisten_reports_an_independent_pass(library):
    from server.schemas import ListenerRelistenResult

    _, source = library
    body = payload(source)
    body["execution"]["relisten"] = True

    def listen(request):
        return ListenerRelistenResult(
            audio_path=request.audio_path,
            route_preset="generative",
            listening_event_id="fixture:independent-pass",
            generation_id="fixture:prompt-plan",
            prompt="Fixture proposal",
            negative_prompt="",
            remembered=False,
        )

    with patch("server.listener.relisten_with_oida", side_effect=listen):
        response = execute(body)
    assert (
        response["subsequent_listening"][0]["result"]["listening_event_id"]
        == "fixture:independent-pass"
    )
    assert (
        response["subsequent_listening"][0]["generation_akousma_id"]
        == response["outputs"][0]["akousma_id"]
    )


def test_output_tamper_detected_and_provider_error_has_no_completed_receipt(library):
    from server.routes._utils import run_provider_method

    _, source = library

    def tampered(*args):
        result = run_provider_method(*args)
        with storage.resolve_path(result.audio_files[0]).open("ab") as stream:
            stream.write(b"tampered")
        return result

    with patch("server.generation_workflow.run_provider_method", side_effect=tampered):
        response = execute(payload(source))
    assert response["linkage_status"] == "incomplete" and not response["outputs"]
    with patch.object(
        registry.get("mock"), "generate", side_effect=RuntimeError("fixture failure")
    ):
        response = execute(payload(source))
    assert response["generation"]["status"] == "error" and not response["outputs"]


def test_unknown_record_contract_refused(library):
    _, source = library
    body = payload(source)
    body["execution"]["record_contract"] = "earworm/akousma/v99"
    with pytest.raises(ValueError, match="output negotiation"):
        execute(body)
