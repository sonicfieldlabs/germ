from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query

from server.cosmoaudition import (
    COSMOAUDITION_GERM_CONTRACT,
    COSMOAUDITION_MODULATION_CONTRACT,
    CosmoauditionBridge,
    CosmoauditionBridgeError,
    cosmoaudition_modules_manifest,
    execute_cosmoaudition_mapping,
    modulation_routes_from_frame,
)
from server.registry import settings, storage
from server.schemas import (
    CosmoauditionArchiveRequest,
    CosmoauditionMapRequest,
    validate_json_compatible,
)
from server.storage import safe_stem, utc_now_iso


router = APIRouter(prefix="/cosmoaudition", tags=["cosmoaudition"])
MAX_ARCHIVES = 12
MAX_ARCHIVE_BYTES = 1_000_000
LOGGER = logging.getLogger(__name__)


def _bridge() -> CosmoauditionBridge:
    return CosmoauditionBridge(
        base_url=settings.cosmoaudition_url,
        timeout_seconds=settings.cosmoaudition_timeout_seconds,
        max_response_bytes=settings.cosmoaudition_max_response_bytes,
    )


def _bridge_status_from_error(exc: Exception) -> dict[str, Any]:
    LOGGER.warning("Cosmoaudition bridge unavailable: %s", exc)
    return {
        "available": False,
        "contract": COSMOAUDITION_GERM_CONTRACT,
        "baseUrl": settings.cosmoaudition_url,
        "error": "Cosmoaudition bridge unavailable",
    }


def _query_params(
    *,
    mode: Literal["live", "fixture"],
    latitude: float | None,
    longitude: float | None,
    sources: str | None,
) -> dict[str, str]:
    params = {"mode": mode}
    if latitude is not None:
        params["lat"] = str(latitude)
    if longitude is not None:
        params["lon"] = str(longitude)
    if sources:
        values = [item.strip() for item in sources.split(",") if item.strip()]
        if not values or len(values) > 64 or any(len(item) > 128 for item in values):
            raise HTTPException(status_code=422, detail="sources must contain bounded source ids")
        params["sources"] = ",".join(dict.fromkeys(values))
    return params


def _proxy(
    path: str,
    *,
    mode: Literal["live", "fixture"],
    latitude: float | None,
    longitude: float | None,
    sources: str | None,
) -> dict[str, Any]:
    try:
        bridge = _bridge()
        payload = bridge.get_json(
            path,
            params=_query_params(
                mode=mode,
                latitude=latitude,
                longitude=longitude,
                sources=sources,
            ),
        )
        validate_json_compatible(payload, label="Cosmoaudition response")
    except (CosmoauditionBridgeError, ValueError) as exc:
        return _bridge_status_from_error(exc)
    return {
        "available": True,
        "contract": COSMOAUDITION_GERM_CONTRACT,
        "payload": payload,
    }


@router.get("/status")
def bridge_status() -> dict[str, Any]:
    try:
        return _bridge().status()
    except ValueError as exc:
        return _bridge_status_from_error(exc)


@router.get("/modules")
def list_modules() -> dict[str, Any]:
    return {
        "contract": COSMOAUDITION_GERM_CONTRACT,
        "modulationContract": COSMOAUDITION_MODULATION_CONTRACT,
        "modules": cosmoaudition_modules_manifest(),
        "principle": "observations become authored controls; they are not claimed as source voices",
    }


@router.get("/sources")
def list_sources(
    mode: Literal["live", "fixture"] = "fixture",
    lat: float | None = Query(default=None, ge=-90.0, le=90.0),
    lon: float | None = Query(default=None, ge=-180.0, le=180.0),
    sources: str | None = Query(default=None, max_length=2_048),
) -> dict[str, Any]:
    return _proxy(
        "/api/sources",
        mode=mode,
        latitude=lat,
        longitude=lon,
        sources=sources,
    )


@router.get("/snapshot")
def get_snapshot(
    mode: Literal["live", "fixture"] = "fixture",
    lat: float | None = Query(default=None, ge=-90.0, le=90.0),
    lon: float | None = Query(default=None, ge=-180.0, le=180.0),
    sources: str | None = Query(default=None, max_length=2_048),
) -> dict[str, Any]:
    return _proxy(
        "/api/snapshot",
        mode=mode,
        latitude=lat,
        longitude=lon,
        sources=sources,
    )


@router.get("/modulation")
def get_modulation(
    mode: Literal["live", "fixture"] = "fixture",
    lat: float | None = Query(default=None, ge=-90.0, le=90.0),
    lon: float | None = Query(default=None, ge=-180.0, le=180.0),
    sources: str | None = Query(default=None, max_length=2_048),
) -> dict[str, Any]:
    """Proxy Cosmoaudition's normalized modulation view."""

    return _proxy(
        "/api/modulation",
        mode=mode,
        latitude=lat,
        longitude=lon,
        sources=sources,
    )


@router.get("/frame")
def get_frame(mode: Literal["live", "fixture"] = "fixture") -> dict[str, Any]:
    """Read one modulation frame and resolve it into GERM routes.

    The response keeps executable routes and withheld routes apart, and carries
    the frame's absences and attribution rather than reducing it to numbers.
    """

    try:
        frame = _bridge().frame(mode=mode)
    except (CosmoauditionBridgeError, ValueError) as exc:
        return _bridge_status_from_error(exc)
    try:
        resolved = modulation_routes_from_frame(frame)
    except CosmoauditionBridgeError as exc:
        return _bridge_status_from_error(exc)
    return {
        "available": True,
        "contract": COSMOAUDITION_GERM_CONTRACT,
        "modulation": resolved,
    }


@router.post("/map")
def map_observation(request: CosmoauditionMapRequest) -> dict[str, Any]:
    return execute_cosmoaudition_mapping(request)


def _archive_dir() -> Path:
    path = storage.settings.cosmoaudition_archive_dir
    path.mkdir(parents=True, exist_ok=True)
    return path


def _archive_path(archive_id: str) -> Path:
    safe_id = safe_stem(archive_id, fallback="")
    if not safe_id or safe_id != archive_id:
        raise HTTPException(status_code=404, detail=f"Observation archive not found: {archive_id}")
    return _archive_dir() / f"{safe_id}.json"


def _read_archive(path: Path) -> dict[str, Any]:
    try:
        if (
            path.is_symlink()
            or not path.is_file()
            or path.resolve().parent != _archive_dir().resolve()
            or path.stat().st_size > MAX_ARCHIVE_BYTES + 100_000
        ):
            raise HTTPException(status_code=404, detail=f"Observation archive not found: {path.stem}")
        value = json.loads(path.read_text(encoding="utf-8"))
    except HTTPException:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise HTTPException(status_code=404, detail=f"Observation archive not found: {path.stem}") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="Observation archive must be a JSON object")
    return value


def _archive_entries() -> list[tuple[Path, float]]:
    entries: list[tuple[Path, float]] = []
    for path in _archive_dir().glob("*.json"):
        try:
            if path.is_symlink() or not path.is_file():
                continue
            entries.append((path, path.stat().st_mtime))
        except OSError:
            continue
    entries.sort(key=lambda item: item[1], reverse=True)
    return entries


@router.get("/archives")
def list_archives() -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    for path, _ in _archive_entries()[:MAX_ARCHIVES]:
        try:
            value = _read_archive(path)
        except HTTPException:
            continue
        items.append(
            {
                "id": value.get("id", path.stem),
                "label": value.get("label", path.stem),
                "createdAt": value.get("createdAt"),
                "module": value.get("module"),
                "archiveFile": storage.relative_path(path),
            }
        )
    return {"contract": COSMOAUDITION_GERM_CONTRACT, "archives": items}


@router.post("/archives")
def save_archive(request: CosmoauditionArchiveRequest) -> dict[str, Any]:
    if len(_archive_entries()) >= MAX_ARCHIVES:
        raise HTTPException(status_code=409, detail=f"Observation archive limit reached ({MAX_ARCHIVES})")
    try:
        encoded = json.dumps(request.snapshot, allow_nan=False, separators=(",", ":")).encode(
            "utf-8"
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="snapshot must be finite JSON") from exc
    if len(encoded) > MAX_ARCHIVE_BYTES:
        raise HTTPException(status_code=413, detail="snapshot exceeds the 1 MB archive boundary")
    archive_id = f"observation_{uuid4().hex[:12]}"
    path = _archive_path(archive_id)
    artifact = {
        "type": "cosmoaudition_observation_archive",
        "contract": COSMOAUDITION_GERM_CONTRACT,
        "id": archive_id,
        "label": request.label,
        "module": request.module,
        "notes": request.notes,
        "createdAt": utc_now_iso(),
        "snapshot": request.snapshot,
    }
    storage.write_json_atomic(path, artifact, touch_library=False)
    return {
        "status": "saved",
        "id": archive_id,
        "archiveFile": storage.relative_path(path),
        "artifact": artifact,
    }


@router.get("/archives/{archive_id}")
def get_archive(archive_id: str) -> dict[str, Any]:
    path = _archive_path(archive_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Observation archive not found: {archive_id}")
    return _read_archive(path)


@router.delete("/archives/{archive_id}")
def delete_archive(archive_id: str) -> dict[str, Any]:
    path = _archive_path(archive_id)
    if not path.exists() or path.is_symlink():
        raise HTTPException(status_code=404, detail=f"Observation archive not found: {archive_id}")
    path.unlink()
    return {"status": "deleted", "id": archive_id}
