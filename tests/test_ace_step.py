from pathlib import Path
import pytest
from server.providers import ace_step_provider as module
from server.registry import storage
from server.schemas import GenerateRequest


def test_ace_is_optional_and_unsupported_modes_fail(monkeypatch):
    monkeypatch.delenv("GERM_ACE_CONFIG", raising=False)
    provider = module.ACEStepProvider(storage)
    assert not provider.is_available() and provider.list_models() == []
    with pytest.raises(ValueError, match="continuation"):
        provider.continue_audio(None)


def test_cancellation_stops_isolated_child_and_releases_lease(monkeypatch):
    worker = Path(module.__file__).parents[1] / "ace/worker.py"
    monkeypatch.setattr(
        module,
        "deployment",
        lambda **kwargs: {
            "files": {str(worker): "test"},
            "python": "unused",
            "checkpoints": "unused",
        },
    )
    processes = []

    class Process:
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
    provider = module.ACEStepProvider(storage)
    job = storage.new_job("text-to-audio", {}, status="running")
    checks = 0

    def cancelled(_):
        nonlocal checks
        checks += 1
        return bool(processes)

    monkeypatch.setattr(provider, "is_job_cancelled", cancelled)
    request = GenerateRequest(
        provider="ace_step",
        model="acestep-v15-turbo",
        prompt="Soft strings",
        duration=10,
        job_id=job,
    )
    with pytest.raises(RuntimeError, match="cancelled"):
        provider.generate(request)
    assert processes and processes[0].terminated
    from akousma.resource_admission import heavy_lease

    with heavy_lease("germ", "after-cancel", timeout=0.1):
        pass


def test_invalid_music_parameters_are_rejected():
    from server.ace.deployment import music_parameters

    with pytest.raises(ValueError):
        music_parameters({"shell": "never"})
    with pytest.raises(ValueError):
        music_parameters({"bpm": float("nan")})
    assert music_parameters({"bpm": 100})["bpm"] == 100
