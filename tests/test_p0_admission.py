import pytest
from akousma.resource_admission import admission_status
from server.providers.stable_audio_python_provider import StableAudioPythonProvider


def test_direct_provider_load_uses_host_admission(tmp_path, monkeypatch):
    monkeypatch.setenv("LISTENINGSTACK_RESOURCE_DIR", str(tmp_path))
    provider = StableAudioPythonProvider(None)
    observed = []
    provider._load_model_locked = lambda model, device: (
        observed.append((model, device, admission_status()["busy"])) or {"status": "loaded"}
    )
    assert provider.load_model("small-sfx", "existing-device")["status"] == "loaded"
    assert observed == [("small-sfx", "existing-device", True)]
    assert not admission_status()["busy"]


def test_cancelled_render_never_enters_model(tmp_path, monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setenv("LISTENINGSTACK_RESOURCE_DIR", str(tmp_path))
    provider = StableAudioPythonProvider(None)
    provider.is_job_cancelled = lambda identifier: identifier == "cancelled"
    provider._generate_with_model_locked = lambda *args: pytest.fail("must not enter inference")
    with pytest.raises(RuntimeError, match="cancelled"):
        provider._generate_with_model(SimpleNamespace(job_id="cancelled"), "text-to-audio")
