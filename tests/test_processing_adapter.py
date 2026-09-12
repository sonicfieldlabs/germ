from __future__ import annotations

import copy
import os
import threading
from pathlib import Path
from unittest.mock import patch

import pytest

from server.audio_io import write_sine_wav
from server.masa_bridge import build_generation_record, build_processing_request
from server.processing_adapter import digest, execute, file_digest


@pytest.fixture
def inputs(tmp_path):
    validator = os.environ.get("GERM_TEST_MASA_VALIDATOR")
    if not validator:
        pytest.skip("set GERM_TEST_MASA_VALIDATOR to the installed MASA validator module")
    source = tmp_path / "source.wav"
    write_sine_wav(source, duration=0.6, sample_rate=16000, channels=1)
    record = build_generation_record(
        dict(
            sound_id="synthetic-grain-fixture",
            output_audio_path=str(source),
            created_at="2026-09-01T00:00:00Z",
            provider="germ-fixture-sine",
            model="synthetic",
            prompt="Synthetic PCM fixture; no physical capture or model listening.",
        )
    )
    source_rep = next(r for r in record["representations"] if r["mediaType"] == "audio/wav")
    request = build_processing_request(
        module_id="grain_culture",
        source_id="synthetic-grain-fixture",
        created_at="2026-09-01T00:00:01Z",
        seed=42,
        record_ref=record["id"],
        parameters=dict(
            grain=dict(durationMs=dict(min=30, max=30), envelope="gaussian"),
            emission=dict(mode="synchronous", grainsPerSecond=40),
            selection=dict(order="random"),
        ),
    )
    request["inputs"] = [source_rep["id"]]
    authority = dict(
        expiresAt="2099-01-01T00:00:00Z",
        sourceSha256=file_digest(source),
        requestSha256=digest(request),
        recordSha256=digest(record),
        policyEvaluation=dict(
            action="matter.granulate",
            targets=request["inputs"],
            policyRefs=request["policyRefs"],
            result="permitted",
            evaluatedAt="2026-09-01T00:00:02Z",
            evaluator=record["createdBy"],
            authorityRefs=[record["policies"][0]["rules"][0]["id"]],
            reasons=["Owner-approved synthetic fixture."],
        ),
    )
    return request, record, source, authority, tmp_path / "out", Path(validator)


def test_real_shared_dsp_seeded_rerun_integrity_lineage_and_input_preservation(inputs):
    request, record, source, authority, root, validator = inputs
    original = copy.deepcopy(record)
    before = file_digest(source)
    first = execute(*inputs)
    second = execute(*inputs)
    assert first["status"] == "completed", first["receipt"]
    assert second["status"] == "completed", second["receipt"]
    output = Path(first["directory"]) / "output.wav"
    assert output.read_bytes() == (Path(second["directory"]) / "output.wav").read_bytes()
    assert file_digest(output) != before
    assert len(set(output.read_bytes()[44:])) > 10  # Actual non-silent DSP output.
    assert file_digest(source) == before and record == original
    receipt = first["receipt"]
    assert receipt["parameters"] == request["parameters"]
    assert receipt["outputs"] != second["receipt"]["outputs"]
    assert receipt["extensions"]["germ:processing"]["outputSha256"] == file_digest(output)
    assert first["record"]["relations"][-1]["operationRef"] == receipt["id"]
    assert first["record"]["relations"][-1]["object"] == request["inputs"][0]
    assert not list(root.glob(".processing-*"))


@pytest.mark.parametrize(
    "change", ["seed", "mode", "range", "output", "density", "permission", "hash", "expiry"]
)
def test_refuses_unhonored_requests_without_descendants(inputs, change):
    request, record, _, authority, _, _ = inputs
    if change == "seed":
        request["determinism"] = "require-deterministic"
    if change == "mode":
        request["parameters"]["emission"]["mode"] = "asynchronous"
    if change == "range":
        request["parameters"]["grain"]["durationMs"]["max"] = 31
    if change == "output":
        request["outputContract"]["roles"] = ["preview"]
    if change == "density":
        request["parameters"]["emission"]["grainsPerSecond"] = 1000
    if change == "permission":
        authority["policyEvaluation"]["result"] = "prohibited"
    if change == "hash":
        authority["sourceSha256"] = "0" * 64
    if change == "expiry":
        authority["expiresAt"] = "2000-01-01T00:00:00Z"
    authority["requestSha256"] = digest(request)
    result = execute(*inputs)
    assert result["status"] == "refused", result["receipt"]
    assert result["receipt"]["outputs"] == []
    assert result["record"]["representations"] == record["representations"]
    assert not (Path(result["directory"]) / "output.wav").exists()


def test_cancellation_and_backend_failure_keep_receipts_without_output(inputs):
    cancel = threading.Event()
    cancel.set()
    result = execute(*inputs, cancel=cancel)
    assert result["status"] == "cancelled"
    with patch("server.processing_adapter.render", side_effect=RuntimeError("fixture")):
        result = execute(*inputs)
    assert result["status"] == "failed"
    assert result["receipt"]["outputs"] == []
    assert not (Path(result["directory"]) / "output.wav").exists()


def test_active_child_timeout_and_source_mutation(inputs):
    result = execute(*inputs, timeout=0)
    assert result["status"] == "failed"
    from server.processing_adapter import render

    def mutate(*args):
        render(*args)
        inputs[2].write_bytes(inputs[2].read_bytes() + b"changed")

    with patch("server.processing_adapter.render", side_effect=mutate):
        result = execute(*inputs)
    assert result["status"] == "refused"
    assert result["receipt"]["outputs"] == []


def test_invalid_contract_never_executes(inputs):
    inputs[0]["parameters"]["grain"]["envelope"] = "invented"
    with patch("server.processing_adapter.render") as engine:
        with pytest.raises(ValueError, match="MASA validation failed"):
            execute(*inputs)
        engine.assert_not_called()


def test_active_subprocess_cancellation_and_corrupt_output(inputs):
    from server.processing_adapter import render
    import subprocess

    real_popen = subprocess.Popen
    cancel = threading.Event()
    children = []

    def popen(*args, **kwargs):
        child = real_popen(*args, **kwargs)
        if "render" in args[0]:
            children.append(child)
            cancel.set()
        return child

    with patch("server.processing_adapter.subprocess.Popen", side_effect=popen):
        result = execute(*inputs, cancel=cancel)
    assert result["status"] == "cancelled"
    assert children and all(child.poll() is not None for child in children)
    assert result["receipt"]["outputs"] == []

    def corrupt(config, *args):
        render(config, *args)
        Path(config["output"]).write_bytes(b"broken")

    with patch("server.processing_adapter.render", side_effect=corrupt):
        result = execute(*inputs)
    assert result["status"] == "failed"
    assert not (Path(result["directory"]) / "output.wav").exists()


def test_real_stereo_triangular_engine_and_different_seed(inputs):
    request, _, source, authority, _, _ = inputs
    write_sine_wav(source, duration=0.6, sample_rate=96000, channels=2)
    request["parameters"]["grain"]["envelope"] = "triangular"
    authority["sourceSha256"] = file_digest(source)
    authority["requestSha256"] = digest(request)
    first = execute(*inputs)
    request["extensions"]["germ:micro"]["seed"] = 43
    authority["requestSha256"] = digest(request)
    second = execute(*inputs)
    assert first["status"] == second["status"] == "completed"
    assert (
        first["receipt"]["extensions"]["germ:processing"]["outputSha256"]
        != second["receipt"]["extensions"]["germ:processing"]["outputSha256"]
    )


def test_source_duration_limit_and_missing_required_seed(inputs):
    request, _, source, authority, _, _ = inputs
    write_sine_wav(source, duration=30.01, sample_rate=8000, channels=1)
    authority["sourceSha256"] = file_digest(source)
    assert execute(*inputs)["status"] == "refused"
    del request["extensions"]["germ:micro"]["seed"]
    authority["requestSha256"] = digest(request)
    result = execute(*inputs)
    assert result["status"] == "refused"
    assert "require-seeded" in result["receipt"]["errors"][0]


def test_cancel_during_final_validation_discards_late_output(inputs):
    from server.processing_adapter import validate

    cancel = threading.Event()

    def late_cancel(kind, value, *args):
        validate(kind, value, *args)
        if kind == "record" and value["revision"] > inputs[1]["revision"]:
            cancel.set()

    with patch("server.processing_adapter.validate", side_effect=late_cancel):
        result = execute(*inputs, cancel=cancel)
    assert result["status"] == "cancelled"
    assert result["receipt"]["outputs"] == []
    assert result["record"]["representations"] == inputs[1]["representations"]
    assert not (Path(result["directory"]) / "output.wav").exists()
