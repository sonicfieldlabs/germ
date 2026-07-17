from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from server.earworm import metadata_to_earworm_session, write_earworm_session
from server.registry import settings, storage
from server.schemas import validate_json_compatible
from server.storage import safe_stem


router = APIRouter(prefix="/earworm", tags=["earworm"])


class EarwormExportRequest(BaseModel):
    metadata_path: str = Field(min_length=1, max_length=4096)
    persist: bool = True
    output_name: str | None = Field(default=None, max_length=120)


@router.post("/export")
def export_earworm_session(request: EarwormExportRequest) -> dict[str, Any]:
    metadata_path = _resolve_metadata_path(request.metadata_path)
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise HTTPException(status_code=422, detail="metadata_path must contain JSON") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="metadata_path could not be read") from exc
    if not isinstance(metadata, dict):
        raise HTTPException(status_code=422, detail="metadata_path must contain a JSON object")
    try:
        validate_json_compatible(metadata, label="Earworm metadata")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    session = metadata_to_earworm_session(metadata)
    session_file = None
    if request.persist:
        output_stem = safe_stem(
            request.output_name,
            fallback=f"{metadata_path.stem}.earworm.session",
        )
        if not output_stem.endswith(".earworm.session"):
            output_stem = f"{output_stem}.earworm.session"
        session_path = settings.metadata_dir / f"{output_stem}.json"
        write_earworm_session(metadata, session_path)
        session_file = storage.relative_path(session_path)

    return {
        "status": "done",
        "session_id": session["session_id"],
        "session_file": session_file,
        "event_count": len(session["events"]),
        "asset_count": len(session["assets"]),
        "provenance_count": len(session["provenance"]),
        "session": session,
    }


def _resolve_metadata_path(raw_path: str) -> Path:
    if not raw_path:
        raise HTTPException(status_code=422, detail="metadata_path is required")
    path = storage.resolve_path(raw_path)
    try:
        path = path.resolve(strict=True)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"metadata file not found: {raw_path}") from exc
    if path.suffix.lower() != ".json":
        raise HTTPException(status_code=422, detail="metadata_path must point to a JSON file")
    output_root = settings.output_root.resolve()
    if not (path == output_root or output_root in path.parents):
        raise HTTPException(status_code=422, detail="metadata_path must stay inside output/")
    try:
        if path.stat().st_size > 10 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="metadata_path exceeds the 10 MB limit")
    except OSError as exc:
        raise HTTPException(status_code=500, detail="metadata_path could not be inspected") from exc
    return path
