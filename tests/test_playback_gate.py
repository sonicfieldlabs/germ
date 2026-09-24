from fastapi import FastAPI
from fastapi.responses import Response
from fastapi.testclient import TestClient
from server.playback import install_playback_gate


def test_all_audio_paths_require_ephemeral_same_origin_grant():
    app = FastAPI()

    @app.get("/sound")
    def sound():
        return Response(b"pcm", media_type="audio/wav")

    @app.get("/page")
    def page():
        return Response("<html/>", media_type="text/html")

    install_playback_gate(app)
    client = TestClient(app)
    assert client.get("/sound").status_code == 403
    assert client.post("/playback-session").status_code == 403
    assert (
        client.post(
            "/playback-session", headers={"origin": "https://elsewhere.example"}
        ).status_code
        == 403
    )
    assert (
        client.post("/playback-session", headers={"origin": "http://testserver"}).status_code == 200
    )
    assert client.get("/sound").status_code == 200
    client.get("/page")
    assert client.get("/sound").status_code == 403
    client.post("/playback-session", headers={"origin": "http://testserver"})
    client.delete("/playback-session", headers={"origin": "http://testserver"})
    assert client.get("/sound").status_code == 403


def test_expiry_and_early_refusal_do_not_open_media(monkeypatch):
    from server import playback

    now = [100.0]
    monkeypatch.setattr(playback, "monotonic", lambda: now[0])
    app = FastAPI()
    opened = []

    @app.get("/library/audio/test")
    def sound():
        opened.append(True)
        return Response(b"pcm", media_type="audio/wav")

    install_playback_gate(app)
    client = TestClient(app)
    assert client.get("/library/audio/test").status_code == 403
    assert not opened
    client.post("/playback-session", headers={"origin": "http://testserver"})
    assert client.get("/library/audio/test").status_code == 200
    now[0] += 901
    assert client.get("/library/audio/test").status_code == 403
    assert len(opened) == 1


def test_station_authorization_metadata_is_not_browser_playback():
    app = FastAPI()
    authorized = []

    @app.get("/library/audio/test/authorization")
    def authorization():
        authorized.append(True)
        return {"contract": "germ/audio-authorization/v1"}

    @app.get("/library/audio/evil/authorization")
    def unexpected_audio():
        return Response(b"pcm", media_type="audio/wav")

    @app.get("/library/audio/test")
    def audio():
        return Response(b"pcm", media_type="audio/wav")

    install_playback_gate(app)
    client = TestClient(app)
    assert client.get("/library/audio/test/authorization").status_code == 200
    assert authorized == [True]
    assert client.get("/library/audio/evil/authorization").status_code == 403
    assert client.get("/library/audio/test").status_code == 403
