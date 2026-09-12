"""Real A12/A7 validation and owner API, with isolated canonical sources."""

from copy import deepcopy
import json
from pathlib import Path

import pytest
from akousma import AkousmataStore
from fastapi.testclient import TestClient
from server.derivation import build, POLICY
from server.main import app
from server.schemas import GenerateRequest


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.setenv("AKOUSMATA_PATH", str(tmp_path))
    source = json.loads((Path(__file__).parent / "fixtures/derivation-source.json").read_text())
    store = AkousmataStore(tmp_path)
    store.put(source)
    yield store, source
    store.close()


def request(records, template="structured"):
    return dict(
        template=template,
        workflow=dict(
            contract="akouo/record-workflow/v0.1",
            request_id="request:derivation-test",
            actor_ref="actor:owner",
            created_at="2099-01-01T00:00:00Z",
            source_refs=[r["akousma_id"] for r in records],
            permissions=[
                dict(
                    record_ref=r["akousma_id"], status="granted", permission_ref="permission:owner"
                )
                for r in records
            ],
            supported_contracts=["akouo/record-workflow/v0.1"],
            resolved_refs=["actor:owner", "permission:owner", POLICY["id"]],
            policy_ref=POLICY["id"],
            policy_revision=POLICY["revision"],
        ),
    )


def test_structured_no_prose_real_validation_and_generation_fields(library):
    store, source = library
    plan = build(store, request([source]))
    assert "DO NOT USE" not in plan["prompt"]
    assert plan["parameters"] == dict(duration=10, steps=8, cfg_scale=1)
    assert len(plan["mappings"]) == 4
    assert {m["target"] for m in plan["mappings"]} == {"duration", "prompt"}
    assert plan["execution"] == "not_requested" and plan["claim_category"] == "speculative"
    assert plan["parent_refs"] == [source["akousma_id"]]
    assert GenerateRequest(**plan["generation_fields"]).duration == 10
    assert store.get(source["akousma_id"]) == source
    with TestClient(app) as client:
        assert client.get("/akousma/derivation/templates").status_code == 200
        assert client.post("/akousma/derivation/plan", json=request([source])).status_code == 200


def test_multiple_parents_reuse_prompt_and_overrides(library):
    store, source = library
    second = deepcopy(source)
    second["akousma_id"] += "-second"
    store.put(second)
    body = request([source, second], "combine")
    body["parameters"] = dict(duration=12, cfg_scale=2)
    plan = build(store, body)
    assert plan["parameters"]["duration"] == 12
    assert plan["parent_refs"] == [source["akousma_id"], second["akousma_id"]]
    assert len(plan["sources"]) == 2
    assert "DO NOT USE" in plan["prompt"]  # existing prose path only, explicitly selected
    assert store.get(second["akousma_id"]) == second


@pytest.mark.parametrize(
    "change",
    [
        "missing",
        "restricted",
        "permission",
        "policy",
        "bounds",
        "integer",
        "extra",
        "covenant",
        "duplicate",
        "unknown_template",
    ],
)
def test_fail_closed_inputs(library, change):
    store, source = library
    body = request([source])
    if change == "missing":
        body["workflow"]["source_refs"] = ["absent"]
    if change == "restricted":
        source["provenance"]["consent_status"] = "restricted"
        store.put(source)
    if change == "permission":
        body["workflow"]["permissions"][0]["status"] = "withheld"
    if change == "policy":
        body["workflow"]["policy_revision"] = "untrusted"
    if change == "bounds":
        body["parameters"] = {"duration": 61}
    if change == "integer":
        body["parameters"] = {"steps": 1.5}
    if change == "extra":
        body["parameters"] = {"unknown": 4}
    if change == "covenant":
        source["covenant"] = {
            "id": "test",
            "withheld": [{"rule": "do_not_reveal", "subject": "prose", "count": 1}],
        }
        store.put(source)
    if change == "duplicate":
        body["workflow"]["source_refs"] *= 2
    if change == "unknown_template":
        body["template"] = []
    with pytest.raises(ValueError):
        build(store, body)


def test_unknown_features_are_omissions_not_guesses(library):
    store, source = library
    changed = deepcopy(source)
    changed["akousma_id"] += "-withheld"
    report = changed["listening"]["oida.agent-report"]["payload"]
    report["features"][0]["value"] = dict(status="withheld", reason="owner policy")
    report["features"][1]["value"]["unit"] = "kHz"  # no silent unit coercion
    store.put(changed)
    plan = build(store, request([changed]))
    assert len(plan["omitted"]) == 2 and plan["parameters"]["duration"] == 4
    assert len(plan["mappings"]) == 2
    assert "220" not in plan["prompt"]


def test_unbound_report_and_source_change_rejected(library, monkeypatch):
    store, source = library
    original = store.get
    calls = 0

    def changed(ref):
        nonlocal calls
        calls += 1
        record = original(ref)
        if calls > 1:
            record["tags"] = ["changed concurrently"]
        return record

    monkeypatch.setattr(store, "get", changed)
    with pytest.raises(RuntimeError, match="changed during"):
        build(store, request([source]))


@pytest.mark.parametrize("value", [True, float("nan"), float("inf"), -1])
def test_invalid_parameter_numbers(library, value):
    store, source = library
    body = request([source])
    body["parameters"] = {"duration": value}
    with pytest.raises(ValueError):
        build(store, body)


def test_report_binding_and_all_unknown(library, monkeypatch):
    store, source = library
    changed = deepcopy(source)
    changed["listening"]["oida.agent-report"]["payload"]["apparatus_ref"] = "absent"
    monkeypatch.setattr(store, "get", lambda _: deepcopy(changed))
    with pytest.raises(ValueError):
        build(store, request([source]))
    changed = deepcopy(source)
    for feature in changed["listening"]["oida.agent-report"]["payload"]["features"]:
        feature["value"] = dict(status="unknown", reason="fixture absence")
    with pytest.raises(ValueError, match="No supported known"):
        build(store, request([source]))


def test_http_bad_input_and_provenance_handoff(library):
    store, source = library
    with TestClient(app) as client:
        bad = request([source])
        bad["parameters"] = {"duration": 1000}
        assert client.post("/akousma/derivation/plan", json=bad).status_code == 400
        plan = client.post("/akousma/derivation/plan", json=request([source])).json()
        request_model = GenerateRequest(**plan["generation_fields"])
        assert request_model.source["derivation"]["permissions"] == plan["permissions"]
        assert request_model.source["derivation"]["mappings"] == plan["mappings"]


def test_declared_expiry_reuses_earworm_gate(library):
    store, source = library
    changed = deepcopy(source)
    changed["akousma_id"] += "-expired"
    changed["extensions"]["earworm_listening_context"]["claims"][0]["validity"] = dict(
        status="expires", issued_at="2000-01-01T00:00:00Z", expires_at="2001-01-01T00:00:00Z"
    )
    store.put(changed)
    plan = build(store, request([changed]))
    assert plan["omitted"][0]["reason"] == "expired"
    assert plan["parameters"]["duration"] == 4
