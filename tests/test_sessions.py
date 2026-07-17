from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.main import app
from server.routes import sessions as session_routes


client = TestClient(app)


def _sample_graph(node_count: int = 2) -> dict:
    return {
        "version": 1,
        "zoom": 1,
        "assets": [{"id": "asset_1", "audioPath": "audio/example.wav"}],
        "nodes": [
            {"id": f"node_{index}", "type": "sound", "assetId": "asset_1", "x": 10 * index, "y": 20}
            for index in range(node_count)
        ],
        "edges": [{"fromNodeId": "node_0", "toNodeId": "node_1", "type": "lineage"}],
        "candidates": [],
        "timeState": {"enabled": False},
    }


def test_sessions_save_list_load_delete() -> None:
    payload = {"name": "pytest chamber session", "graph": _sample_graph()}
    saved = client.post("/sessions", json=payload)
    assert saved.status_code == 200
    body = saved.json()
    session_id = body["session"]["id"]
    assert body["status"] == "done"
    assert body["session"]["node_count"] == 2
    assert body["session"]["edge_count"] == 1
    assert body["session"]["asset_count"] == 1

    listed = client.get("/sessions")
    assert listed.status_code == 200
    assert any(item["id"] == session_id for item in listed.json())

    loaded = client.get(f"/sessions/{session_id}")
    assert loaded.status_code == 200
    assert loaded.json()["graph"]["nodes"][0]["id"] == "node_0"

    deleted = client.delete(f"/sessions/{session_id}")
    assert deleted.status_code == 200
    assert deleted.json()["status"] == "deleted"
    assert client.get(f"/sessions/{session_id}").status_code == 404


def test_sessions_current_roundtrip_and_clear() -> None:
    put = client.put("/sessions/current", json={"graph": _sample_graph(3), "client_id": "pytest-client"})
    assert put.status_code == 200

    current = client.get("/sessions/current")
    assert current.status_code == 200
    body = current.json()
    assert body["status"] == "done"
    assert len(body["graph"]["nodes"]) == 3
    assert body["session"]["client_id"] == "pytest-client"
    # The autosaved current graph must never leak into the named list.
    assert all(item["id"] != "_current" for item in client.get("/sessions").json())

    cleared = client.delete("/sessions/current")
    assert cleared.status_code == 200
    assert client.get("/sessions/current").json()["status"] == "empty"


def test_sessions_reject_oversized_graph(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_routes, "MAX_SESSION_GRAPH_BYTES", 128)
    response = client.post("/sessions", json={"name": "too big", "graph": _sample_graph(10)})
    assert response.status_code == 413
    response = client.put("/sessions/current", json={"graph": _sample_graph(10)})
    assert response.status_code == 413


def test_sessions_update_preserves_created_at() -> None:
    first = client.post("/sessions", json={"name": "evolving patch", "graph": _sample_graph(1)})
    created_at = first.json()["session"]["created_at"]
    second = client.post("/sessions", json={"name": "evolving patch", "graph": _sample_graph(2)})
    body = second.json()
    assert body["session"]["created_at"] == created_at
    assert body["session"]["node_count"] == 2
    client.delete(f"/sessions/{body['session']['id']}")


def test_sessions_do_not_follow_symlinks(tmp_path: Path) -> None:
    external = tmp_path / "external-session.json"
    external.write_text(
        json.dumps(
            {
                "id": "pytest_external_session",
                "name": "outside",
                "graph": _sample_graph(),
            }
        ),
        encoding="utf-8",
    )
    link = session_routes._session_dir() / "pytest_external_session.json"
    link.symlink_to(external)
    try:
        listed = client.get("/sessions")
        loaded = client.get("/sessions/pytest_external_session")
    finally:
        link.unlink(missing_ok=True)

    assert listed.status_code == 200
    assert all(item["id"] != "pytest_external_session" for item in listed.json())
    assert loaded.status_code == 404
