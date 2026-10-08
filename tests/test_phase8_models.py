import pytest
from server.config import Settings
from server.schemas import GenerateRequest


@pytest.mark.parametrize(
    "provider,default",
    [("stable_audio_mlx", "sm-sfx"), ("stable_audio_python", "small-sfx"), ("mock", "mock-sine")],
)
def test_provider_defaults_preserve_explicit_model_ids(monkeypatch, provider, default):
    monkeypatch.setenv("GERM_ACTIVE_PROVIDER", provider)
    monkeypatch.delenv("GERM_DEFAULT_MODEL", raising=False)
    monkeypatch.delenv("GERMINATOR_DEFAULT_MODEL", raising=False)
    assert Settings().default_model == default
    assert GenerateRequest(provider=provider).model == default
    assert GenerateRequest(provider=provider, model="small-sfx").model == "small-sfx"
    monkeypatch.setenv("GERM_DEFAULT_MODEL", "explicit-checkpoint")
    assert Settings().default_model == "explicit-checkpoint"
