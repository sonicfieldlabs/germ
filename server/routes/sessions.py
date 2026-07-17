"""Chamber sessions: named, server-side snapshots of the module graph.

A session is the full serializable Chamber graph (assets, modules,
connections, candidates, clock state) stored as JSON under
``output/sessions/``. Because the daemon owns them, every surface — the
browser dashboard and the native macOS shell — sees the same list and the
same live "current" session, which is what keeps both fronts on one shared
instance instead of diverging through per-browser localStorage.

``_current.json`` is the autosaved live graph (written by the dashboard on
a debounce); named sessions are explicit user saves, same pattern as the
Microcosmos biomes.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from server.registry import storage
from server.schemas import (
    SessionCurrentRequest,
    SessionResult,
    SessionSaveRequest,
    SessionSummary,
    validate_json_compatible,
)
from server.storage import safe_stem, utc_now_iso


router = APIRouter(prefix="/sessions", tags=["sessions"])

MAX_SESSION_COUNT = 128
MAX_SESSION_GRAPH_BYTES = 4_000_000
CURRENT_SESSION_STEM = "_current"


def _session_dir() -> Path:
    path = storage.settings.session_dir
    path.mkdir(parents=True, exist_ok=True)
    return path


def _graph_counts(graph: dict[str, Any]) -> tuple[int, int, int]:
    nodes = graph.get("nodes") if isinstance(graph.get("nodes"), list) else []
    edges = graph.get("edges") if isinstance(graph.get("edges"), list) else []
    assets = graph.get("assets") if isinstance(graph.get("assets"), list) else []
    return len(nodes), len(edges), len(assets)


def _session_summary(path: Path, data: dict[str, Any]) -> SessionSummary:
    graph = data.get("graph") if isinstance(data.get("graph"), dict) else {}
    node_count, edge_count, asset_count = _graph_counts(graph)
    return SessionSummary(
        id=str(data.get("id") or path.stem)[:256],
        name=str(data.get("name") or path.stem)[:500],
        session_file=storage.relative_path(path),
        created_at=(str(data["created_at"])[:100] if isinstance(data.get("created_at"), str) else None),
        updated_at=(str(data["updated_at"])[:100] if isinstance(data.get("updated_at"), str) else None),
        node_count=node_count,
        edge_count=edge_count,
        asset_count=asset_count,
        client_id=(str(data["client_id"])[:64] if isinstance(data.get("client_id"), str) else None),
    )


def _read_session(path: Path) -> dict[str, Any]:
    try:
        if (
            path.is_symlink()
            or not path.is_file()
            or path.resolve().parent != _session_dir().resolve()
            or path.stat().st_size > MAX_SESSION_GRAPH_BYTES + 100_000
        ):
            raise HTTPException(status_code=404, detail=f"Session not found: {path.stem}")
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f"Session not found: {path.stem}") from exc
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError, OSError, RecursionError) as exc:
        raise HTTPException(status_code=404, detail=f"Session not found: {path.stem}") from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=422, detail="Session file must contain a JSON object")
    try:
        validate_json_compatible(data, label="session")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return data


def _validate_graph_size(graph: dict[str, Any]) -> None:
    try:
        graph_bytes = len(
            json.dumps(graph, separators=(",", ":"), allow_nan=False).encode("utf-8")
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Session graph must be finite JSON") from exc
    if graph_bytes > MAX_SESSION_GRAPH_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Session graph exceeds the {MAX_SESSION_GRAPH_BYTES} byte limit.",
        )


def _write_session(path: Path, *, name: str, graph: dict[str, Any], client_id: str | None = None) -> dict[str, Any]:
    existing = _read_session(path) if path.exists() else {}
    now = utc_now_iso()
    artifact = {
        "type": "germ_session",
        "id": path.stem,
        "name": name,
        "created_at": existing.get("created_at") or now,
        "updated_at": now,
        "client_id": client_id,
        "graph": graph,
    }
    storage.write_json_atomic(path, artifact, touch_library=False)
    return artifact


@router.get("", response_model=list[SessionSummary])
def list_sessions() -> list[SessionSummary]:
    items: list[SessionSummary] = []
    entries: list[tuple[Path, float]] = []
    for path in _session_dir().glob("*.json"):
        try:
            if path.is_symlink() or not path.is_file():
                continue
            entries.append((path, path.stat().st_mtime))
        except OSError:
            continue
    entries.sort(key=lambda item: item[1], reverse=True)
    for path, _ in entries:
        if path.stem == CURRENT_SESSION_STEM:
            continue
        try:
            data = _read_session(path)
        except HTTPException:
            continue
        items.append(_session_summary(path, data))
    return items


@router.post("", response_model=SessionResult)
def save_session(request: SessionSaveRequest) -> SessionResult:
    session_id = safe_stem(request.name, fallback="")
    if not session_id:
        raise HTTPException(status_code=422, detail="Session name must contain a letter or number.")
    path = _session_dir() / f"{session_id}.json"
    named = [item for item in _session_dir().glob("*.json") if item.stem != CURRENT_SESSION_STEM]
    if not path.exists() and len(named) >= MAX_SESSION_COUNT:
        raise HTTPException(status_code=400, detail=f"Session limit reached ({MAX_SESSION_COUNT}).")
    _validate_graph_size(request.graph)
    artifact = _write_session(path, name=request.name, graph=request.graph)
    return SessionResult(status="done", session=_session_summary(path, artifact), graph=request.graph)


@router.get("/current", response_model=SessionResult)
def get_current_session() -> SessionResult:
    path = _session_dir() / f"{CURRENT_SESSION_STEM}.json"
    if not path.exists():
        return SessionResult(status="empty", session=None, graph={})
    data = _read_session(path)
    graph = data.get("graph") if isinstance(data.get("graph"), dict) else {}
    return SessionResult(status="done", session=_session_summary(path, data), graph=graph)


@router.put("/current", response_model=SessionResult)
def put_current_session(request: SessionCurrentRequest) -> SessionResult:
    _validate_graph_size(request.graph)
    path = _session_dir() / f"{CURRENT_SESSION_STEM}.json"
    artifact = _write_session(path, name="current", graph=request.graph, client_id=request.client_id)
    return SessionResult(status="done", session=_session_summary(path, artifact), graph={})


@router.delete("/current", response_model=SessionResult)
def clear_current_session() -> SessionResult:
    path = _session_dir() / f"{CURRENT_SESSION_STEM}.json"
    if path.exists():
        path.unlink()
    return SessionResult(status="deleted", session=None, graph={})


@router.get("/{session_id}", response_model=SessionResult)
def get_session(session_id: str) -> SessionResult:
    safe_id = safe_stem(session_id, fallback="")
    if not safe_id:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    path = _session_dir() / f"{safe_id}.json"
    if not path.exists() or path.stem == CURRENT_SESSION_STEM:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    data = _read_session(path)
    graph = data.get("graph") if isinstance(data.get("graph"), dict) else {}
    return SessionResult(status="done", session=_session_summary(path, data), graph=graph)


@router.delete("/{session_id}", response_model=SessionResult)
def delete_session(session_id: str) -> SessionResult:
    safe_id = safe_stem(session_id, fallback="")
    if not safe_id:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    path = _session_dir() / f"{safe_id}.json"
    if not path.exists() or path.stem == CURRENT_SESSION_STEM:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    data = _read_session(path)
    summary = _session_summary(path, data)
    path.unlink()
    return SessionResult(status="deleted", session=summary, graph={})
