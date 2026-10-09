import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.main import app
from server.providers import research_provider as module
from server.registry import storage
from server.research.deployment import deployment, sha
from server.research.requests import ResearchRequest
from server.schemas import AudioToAudioRequest


def test_optional_and_profile_gate(monkeypatch, tmp_path):
    monkeypatch.delenv("GERM_RESEARCH_CONFIG", raising=False)
    assert module.ResearchProvider(storage).list_models() == []
    p = tmp_path / "config.json"
    p.write_text(
        json.dumps(
            {"tools": {"rave-guitar": {"status": "admitted", "profile": "noncommercial_research"}}}
        )
    )
    monkeypatch.setenv("GERM_RESEARCH_CONFIG", str(p))
    monkeypatch.delenv("GERM_RESEARCH_PROFILE", raising=False)
    with pytest.raises(ValueError):
        deployment("rave-guitar")


def test_options_do_not_expose_deployment_exception(monkeypatch):
    from server.routes import research

    def fail(tool):
        raise OSError("private deployment path and credential details")

    monkeypatch.setattr(research, "deployment", fail)
    result = research.options()
    assert result["tools"]
    for tool in result["tools"]:
        assert not tool["available"]
        assert tool["reason"] == (
            "Research tool is unavailable; check its deployment configuration"
        )


def test_request_bounds():
    base = dict(tool="basic-pitch", key="a" * 64)
    for value in [
        dict(seconds=31),
        dict(seconds=float("nan")),
        dict(start_seconds=-1),
        dict(profile="commercial"),
        dict(shell="never"),
    ]:
        with pytest.raises(ValueError):
            ResearchRequest(**base, **value)


def test_route_uses_existing_library_tuple_and_preserves_parent(monkeypatch):
    from server.routes import research as r

    p = storage.audio_dir / "research-input.wav"
    p.write_bytes(b"audio")
    monkeypatch.setattr(r, "deployment", lambda tool: {"profile": "general"})
    monkeypatch.setattr(r, "resolve_library_audio", lambda key: ({"sound_id": "original"}, p))
    captured = []

    class Result:
        def model_dump(self):
            return {"job_id": "b" * 32}

    monkeypatch.setattr(r, "submit_job", lambda req: captured.append(req) or Result())
    result = r.run(ResearchRequest(tool="basic-pitch", key="a" * 64))
    assert result["job_id"] == "b" * 32
    assert captured[0].request["lineage"]["parents"] == ["original"]
    assert captured[0].request["source"]["sha256"] == sha(p)


def test_artifact_hash_and_path_gate():
    c = TestClient(app)
    identifier = "e" * 32
    root = storage.metadata_dir / "research" / identifier
    root.mkdir(parents=True, exist_ok=True)
    p = root / "notes.json"
    p.write_text("{}")
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "artifacts": [
                    {"file": "notes.json", "sha256": sha(p), "media_type": "application/json"}
                ]
            }
        )
    )
    assert c.get(f"/research/jobs/{identifier}/artifacts/notes.json").status_code == 200
    assert c.get(f"/research/jobs/{identifier}/artifacts/manifest.json").status_code == 404
    p.write_text("changed")
    assert c.get(f"/research/jobs/{identifier}/artifacts/notes.json").status_code == 409


def test_cancellation_terminates_child_and_keeps_original(monkeypatch):
    import numpy as np
    import soundfile as sf

    p = storage.audio_dir / "research-cancel.wav"
    sf.write(p, np.zeros(48000), 48000)
    before = sha(p)
    worker = Path(module.__file__).parents[1] / "research/worker.py"
    monkeypatch.setattr(
        module,
        "deployment",
        lambda *a, **kw: dict(
            profile="general", files={str(worker): "test"}, python="unused", model_path="unused"
        ),
    )
    processes = []

    class Process:
        pid = 424242
        returncode = None

        def __init__(self, *args, **kwargs):
            self.terminated = False
            processes.append(self)

        def poll(self):
            return None if not self.terminated else -15

        def terminate(self):
            self.terminated = True

        def wait(self, timeout=None):
            return -15

    monkeypatch.setattr(module.subprocess, "Popen", Process)

    def kill_group(pid, signal):
        assert pid == 424242
        processes[-1].terminate()

    monkeypatch.setattr(module.os, "killpg", kill_group)
    provider = module.ResearchProvider(storage)
    job = storage.new_job("audio-to-audio", {}, status="running")
    monkeypatch.setattr(provider, "is_job_cancelled", lambda _: bool(processes))
    from server.routes import library

    monkeypatch.setattr(library, "resolve_library_audio", lambda key: ({"sound_id": "source"}, p))
    req = AudioToAudioRequest(
        provider="research",
        model="basic-pitch",
        input_audio_path=str(p),
        duration=1,
        job_id=job,
        source={"sha256": before, "key": "a" * 64, "sound_id": "source"},
    )
    with pytest.raises((InterruptedError, RuntimeError), match="cancelled"):
        provider.audio_to_audio(req)
    assert processes[0].terminated and sha(p) == before
    assert not (storage.metadata_dir / "research" / job / "manifest.json").exists()
    from akousma.resource_admission import heavy_lease

    with heavy_lease("germ", "after-research-cancel", timeout=0.1):
        pass


def test_failed_publication_does_not_leave_completed_sound(monkeypatch):
    import numpy as np
    import soundfile as sf

    from server.routes import library

    p = storage.audio_dir / "publication-input.wav"
    sf.write(p, np.zeros(48000), 48000)
    worker = Path(module.__file__).parents[1] / "research/worker.py"
    monkeypatch.setattr(
        module,
        "deployment",
        lambda *a, **kw: dict(
            profile="noncommercial_research",
            files={str(worker): "test"},
            python="unused",
            model_path="unused",
            license="CC-BY-NC-4.0",
            revision="pinned",
            evaluation_sha256="test",
        ),
    )
    monkeypatch.setattr(library, "resolve_library_audio", lambda key: ({"sound_id": "original"}, p))

    class Process:
        returncode = 0

        def __init__(self, args, **kwargs):
            req = json.loads(Path(args[-1]).read_text())
            out = Path(req["output"])
            sf.write(out / "transform.wav", np.zeros(48000), 48000)
            (out / "result.json").write_text(
                json.dumps(
                    {"artifacts": [{"file": "transform.wav", "sha256": sha(out / "transform.wav")}]}
                )
            )

        def poll(self):
            return 0

    monkeypatch.setattr(module.subprocess, "Popen", Process)
    monkeypatch.setattr(
        storage, "write_metadata", lambda **kw: (_ for _ in ()).throw(OSError("publication failed"))
    )
    before = set(storage.audio_dir.iterdir())
    job = storage.new_job("audio-to-audio", {}, status="running")
    req = AudioToAudioRequest(
        provider="research",
        model="rave-guitar",
        input_audio_path=str(p),
        duration=1,
        job_id=job,
        source={
            "sha256": sha(p),
            "key": "a" * 64,
            "sound_id": "original",
            "research": {"profile": "noncommercial_research"},
        },
    )
    with pytest.raises(OSError, match="publication failed"):
        module.ResearchProvider(storage).audio_to_audio(req)
    assert set(storage.audio_dir.iterdir()) == before
    assert not (storage.metadata_dir / "research" / job).exists()
