"""Structural fixtures only: these tests do not qualify any model runtime."""

import copy
import json
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

from server.ace.deployment import deployment as ace
from server.research.deployment import deployment as research
from server.deployment_validation import __file__ as validator_file


@pytest.fixture
def manifest(tmp_path):
    import server
    root = Path(server.__file__).resolve().parent
    (tmp_path / "evaluation.json").write_text("{}")
    files = {str(Path(sys.executable).resolve()): "a" * 64,
             str(Path(validator_file).resolve()): "b" * 64,
             str(root / "ace/worker.py"): "c" * 64,
             str(root / "research/worker.py"): "d" * 64,
             str(tmp_path / "evaluation.json"): "e" * 64}
    for name in ("ace/deployment.py", "research/deployment.py", "providers/ace_step_provider.py", "providers/research_provider.py"):
        files[str(root / name)] = "b" * 64
    for component in ("acestep-v15-turbo", "vae", "Qwen3-Embedding-0.6B"):
        directory = tmp_path / component
        directory.mkdir()
        artifact = directory / "weights"
        artifact.touch()
        files[str(artifact)] = "f" * 64
    model = tmp_path / "model.onnx"
    model.touch()
    files[str(model)] = "f" * 64
    return dict(status="admitted", model="acestep-v15-turbo", revision="a" * 40,
                runtime_commit="b" * 40, python=sys.executable,
                checkpoints=str(tmp_path), evaluation_sha256="e" * 64,
                limits=dict(max_duration=30, max_job_seconds=300, concurrency=1, planner=False),
                files=files, model_path=str(model), tool="basic-pitch", profile="general",
                license="Apache-2.0")


def configure(monkeypatch, tmp_path, value, kind):
    config = tmp_path / "deployment.json"
    if kind == "research":
        value = {"tools": {"basic-pitch": value}}
    config.write_text(json.dumps(value))
    monkeypatch.setenv("GERM_ACE_CONFIG" if kind == "ace" else "GERM_RESEARCH_CONFIG", str(config))
    return ace if kind == "ace" else lambda **kw: research("basic-pitch", **kw)


@pytest.mark.parametrize("kind", ["ace", "research"])
@pytest.mark.parametrize("missing", [None, "python", "evaluation_sha256", "files", "limits", "revision"])
def test_required_fields(monkeypatch, tmp_path, manifest, kind, missing):
    if kind == "research":
        manifest["limits"] = dict(max_seconds=30, max_job_seconds=180, concurrency=1, offline=True)
    if missing:
        manifest.pop(missing)
    load = configure(monkeypatch, tmp_path, manifest, kind)
    if missing:
        with pytest.raises(ValueError):
            load()
    else:
        assert load()["status"] == "admitted"
        # Structural acceptance explicitly does not imply verified weights.
        with pytest.raises((ValueError, OSError)):
            load(verify=True)


@pytest.mark.parametrize("mutation", ["evaluation", "validator", "digest", "limit", "runtime", "checkpoints"])
def test_unbound_or_invalid_manifest(monkeypatch, tmp_path, manifest, mutation):
    value = copy.deepcopy(manifest)
    if mutation == "evaluation":
        value["evaluation_sha256"] = "0" * 64
    elif mutation == "validator":
        value["files"].pop(str(Path(validator_file).resolve()))
    elif mutation == "digest":
        value["files"][str(Path(sys.executable).resolve())] = "not-a-digest"
    elif mutation == "limit":
        value["limits"]["concurrency"] = True
    else:
        value.pop("runtime_commit" if mutation == "runtime" else "checkpoints")
    with pytest.raises(ValueError):
        configure(monkeypatch, tmp_path, value, "ace")()


@pytest.mark.parametrize("queued", [True, False])
@pytest.mark.parametrize("provider", ["ace_step", "research"])
def test_bad_deployment_never_creates_or_submits_job(monkeypatch, queued, provider):
    from server.routes import jobs, _utils
    from server.schemas import GenerateRequest, JobSubmitRequest

    monkeypatch.delenv("GERM_ACE_CONFIG", raising=False)
    monkeypatch.delenv("GERM_RESEARCH_CONFIG", raising=False)

    def forbidden(*args, **kwargs):
        pytest.fail("Invalid deployment reached job creation or submission")

    monkeypatch.setattr(jobs.storage, "new_job", forbidden)
    monkeypatch.setattr(jobs.job_runner, "submit", forbidden)
    request = GenerateRequest(provider=provider, model="acestep-v15-turbo" if provider == "ace_step" else "basic-pitch", prompt="test")
    with pytest.raises(HTTPException) as error:
        if queued:
            jobs.submit_job(JobSubmitRequest(mode="text-to-audio", request=request.model_dump()))
        else:
            _utils.run_provider_method(request, "text-to-audio", "generate")
    assert error.value.status_code == 422
