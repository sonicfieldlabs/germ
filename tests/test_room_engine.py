import copy
from pathlib import Path
from unittest.mock import patch

import pytest
from test_processing_adapter import inputs  # noqa: F401
from server.processing_adapter import digest, execute


@pytest.fixture
def room_inputs(inputs):  # noqa: F811 - shared pytest fixture
    request, record, source, authority, root, validator = inputs
    request.update(
        determinism="require-deterministic",
        operationType="matter.derive",
        engine={"state": "known", "value": "germ:pyroomacoustics"},
        parameters=dict(
            dimensions_m=[4, 5, 3],
            source_m=[1, 1, 1],
            receiver_m=[3, 2, 1.5],
            absorption=0.4,
            max_order=3,
            seed=42,
            directivity="omnidirectional",
            normalization="peak_0.95",
            rir_method="shoebox_image_source",
        ),
    )
    authority["policyEvaluation"]["action"] = "matter.derive"
    authority["requestSha256"] = digest(request)
    return inputs


def test_real_room_receipt_reproduction(room_inputs):
    pytest.importorskip("pyroomacoustics")
    request, record, source, authority, root, validator = room_inputs
    before = source.read_bytes()
    first = execute(*room_inputs)
    assert first["status"] == "completed", first["receipt"]
    receipt = first["receipt"]
    recipe = receipt["extensions"]["germ:processing"]["room"]
    replay = copy.deepcopy(request)
    replay["parameters"] = recipe["parameters"]
    authority = copy.deepcopy(authority)
    authority["requestSha256"] = digest(replay)
    second = execute(replay, record, source, authority, root, validator)
    assert second["status"] == "completed", second["receipt"]
    assert (Path(first["directory"]) / "output.wav").read_bytes() == (
        Path(second["directory"]) / "output.wav"
    ).read_bytes()
    assert source.read_bytes() == before
    assert recipe["frames"] > recipe["source_frames"]
    assert recipe["version"] == "0.10.0"
    assert receipt["determinism"]["state"] == "deterministic"
    assert first["record"]["relations"][-1]["predicate"] == "masa:derived-from"
    assert first["record"]["representations"][-1]["audio"]["levelContext"]["state"] == "unknown"


@pytest.mark.parametrize("change", ["position", "budget", "nan", "denied", "hash", "expired"])
def test_room_refusals_preserve_source(room_inputs, change):
    req, record, source, authority, root, validator = room_inputs
    if change == "position":
        req["parameters"]["source_m"] = [0, 1, 1]
    if change == "budget":
        req["parameters"]["max_order"] = 100
    if change == "nan":
        req["parameters"]["absorption"] = "NaN"
    if change == "denied":
        authority["policyEvaluation"]["result"] = "prohibited"
    if change == "hash":
        authority["sourceSha256"] = "0" * 64
    if change == "expired":
        authority["expiresAt"] = "2000-01-01T00:00:00Z"
    authority["requestSha256"] = digest(req)
    with patch("server.processing_adapter.render_room") as render:
        result = execute(*room_inputs)
        render.assert_not_called()
    assert result["status"] == "refused", result["receipt"]
    assert result["receipt"]["outputs"] == []
    assert result["record"]["representations"] == record["representations"]


def test_optional_engine_failure_and_timeout_have_no_descendant(room_inputs):
    with patch(
        "server.processing_adapter.render_room", side_effect=RuntimeError("optional engine absent")
    ):
        result = execute(*room_inputs)
    assert result["status"] == "failed"
    assert result["receipt"]["outputs"] == []
    result = execute(*room_inputs, timeout=0)
    assert result["status"] == "failed" and result["receipt"]["outputs"] == []
