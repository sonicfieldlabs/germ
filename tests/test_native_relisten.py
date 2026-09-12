import hashlib
import json
import wave

import httpx
import pytest
from fastapi import HTTPException

from server.listener import relisten_with_oida
from server.registry import settings, storage
from server.schemas import ListenerRelistenRequest


@pytest.mark.parametrize("rate", [96000, 192000])
@pytest.mark.parametrize("changed", [False, True])
def test_native_relisten_binds_original_bytes_without_prompt_or_playback(
    monkeypatch, rate, changed
):
    path = settings.audio_dir / "native.wav"
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        output.writeframes(b"\x00\x00" * (rate // 10))
    expected_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    metadata = settings.metadata_dir / "native.json"
    metadata.write_text(json.dumps({"output_audio_path": storage.relative_path(path)}))
    calls = []

    class Client:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def post(self, url, *, json):
            calls.append((url, json))
            assert url.endswith("/gateway/listen")
            assert json["native_options"]["source_sha256"] == expected_hash
            assert json["path"] == str(path)
            assert json["remember"] is False
            assert json["retain_library_audio"] is False
            if changed:
                path.write_bytes(path.read_bytes() + b"changed")
            return httpx.Response(
                200,
                json={
                    "outcome": "measured",
                    "record": {"akousma_id": "later-native-account"},
                    "report": {"features": []},
                    "aperture": {"sample_rate": rate},
                },
            )

    monkeypatch.setattr("server.listener.httpx.Client", Client)
    result = relisten_with_oida(
        ListenerRelistenRequest(
            audio_path=str(path),
            metadata_path=str(metadata),
            route_preset="agent-native",
            native_options={"permission_ref": "test:explicit-digital-inspection"},
        )
    )
    assert len(calls) == 1
    assert result.relisten_mode == "agent_native"
    assert result.prompt == result.listening_event_id == ""
    assert not result.remembered
    assert result.native_result["aperture"]["sample_rate"] == rate
    latest = json.loads(metadata.read_text())["extensions"]["germ.relisten"]["latest"]
    assert latest["output_sha256"] == (None if changed else expected_hash)
    assert latest["native_result"]["record_ref"] == "later-native-account"


@pytest.mark.parametrize(
    "options,remember,privacy",
    [
        (None, False, "session"),
        ({"permission_ref": "test", "source_sha256": "0" * 64}, False, "session"),
        ({"permission_ref": "test", "memory": "record"}, False, "session"),
        ({"permission_ref": "test", "memory": "record_audio"}, True, "incognito"),
    ],
)
def test_native_relisten_refuses_implicit_permission_and_conflicting_retention(
    options, remember, privacy
):
    path = settings.audio_dir / "native-refusal.wav"
    path.write_bytes(b"source")
    with pytest.raises(HTTPException) as error:
        relisten_with_oida(
            ListenerRelistenRequest(
                audio_path=str(path),
                route_preset="agent-native",
                native_options=options,
                remember=remember,
                privacy_mode=privacy,
            )
        )
    assert error.value.status_code == 422
