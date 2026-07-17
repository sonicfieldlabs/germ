from __future__ import annotations

import json
import platform
import re
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from server.registry import settings, storage
from server.schemas import validate_json_compatible


router = APIRouter()

# Only media files are served over the unauthenticated GET file endpoint. This
# keeps the file server from handing metadata JSON (prompts/lineage) or any other
# non-media file under output/ to arbitrary local browser origins. The mutating
# endpoints (rename/delete) still operate on .json via _resolve_output_file.
SERVABLE_EXTENSIONS = {
    ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".webm",
    ".png", ".jpg", ".jpeg", ".gif", ".webp",
}
AUDIO_EXTENSIONS = {
    ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".webm",
}
MAX_METADATA_FILE_BYTES = 10_000_000


class RevealRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)


class MetadataReadRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)


class RenameRequest(BaseModel):
    audio_path: str = Field(min_length=1, max_length=4096)
    metadata_path: str | None = Field(default=None, max_length=4096)
    new_stem: str = Field(min_length=1, max_length=500)


class DeleteRequest(BaseModel):
    audio_path: str = Field(min_length=1, max_length=4096)
    metadata_path: str | None = Field(default=None, max_length=4096)


class BulkDeleteRequest(BaseModel):
    items: list[DeleteRequest]


def sanitize_filename_stem(stem: str) -> str:
    # Allow alphanumeric, underscore, hyphen, space
    sanitized = re.sub(r"[^a-zA-Z0-9_\- ]", "_", stem)
    sanitized = sanitized.strip()
    if not sanitized:
        sanitized = "unnamed"
    return sanitized[:100]


def _resolve_output_file(file_path: str) -> Path:
    root = settings.project_root.resolve()
    try:
        raw = Path(file_path).expanduser()
        target = raw.resolve() if raw.is_absolute() else (root / raw).resolve()
    except (OSError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail="Invalid output file path.") from exc
    output_root = settings.output_root.resolve()

    try:
        target.relative_to(output_root)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Only output files can be accessed.") from exc
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    return target


@router.post("/metadata/read")
def read_output_metadata(request: MetadataReadRequest) -> dict:
    """Read one metadata object without exposing JSON on the public GET route.

    POST is intentional: LocalOriginAndHeadersMiddleware rejects browser requests
    from foreign origins for non-safe methods, while CLI clients without an Origin
    header remain usable.
    """
    target = _resolve_output_file(request.path)
    if target.suffix.lower() != ".json":
        raise HTTPException(status_code=422, detail="Metadata path must point to a JSON file.")
    try:
        if target.stat().st_size > MAX_METADATA_FILE_BYTES:
            raise HTTPException(status_code=413, detail="Metadata file exceeds the 10 MB limit.")
        metadata = json.loads(target.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Metadata is not valid JSON: {request.path}",
        ) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read metadata file: {exc}") from exc
    if not isinstance(metadata, dict):
        raise HTTPException(status_code=422, detail="Metadata JSON must contain an object.")
    try:
        validate_json_compatible(metadata, label="metadata")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return metadata


@router.post("/files/reveal")
def reveal_output_file(request: RevealRequest) -> dict[str, str]:
    target = _resolve_output_file(request.path)
    if platform.system() != "Darwin":
        raise HTTPException(status_code=400, detail="Reveal is only supported on macOS.")
    try:
        subprocess.Popen(
            ["/usr/bin/open", "-R", str(target)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to reveal output file: {exc}") from exc
    return {"status": "ok", "path": str(target)}


@router.get("/files/{file_path:path}")
def serve_output_file(file_path: str) -> FileResponse:
    target = _resolve_output_file(file_path)
    if target.suffix.lower() not in SERVABLE_EXTENSIONS:
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    return FileResponse(target)


@router.post("/files/rename")
def rename_output_file(request: RenameRequest) -> dict[str, str]:
    audio_path = _resolve_output_file(request.audio_path)
    if audio_path.suffix.lower() not in AUDIO_EXTENSIONS:
        raise HTTPException(status_code=422, detail="Audio path must point to an audio file.")
    metadata_path = None
    if request.metadata_path:
        metadata_path = _resolve_output_file(request.metadata_path)
        if metadata_path.suffix.lower() != ".json":
            raise HTTPException(status_code=422, detail="Metadata path must point to a JSON file.")
        if metadata_path.stat().st_size > MAX_METADATA_FILE_BYTES:
            raise HTTPException(status_code=413, detail="Metadata file exceeds the 10 MB limit.")

    sanitized_stem = sanitize_filename_stem(request.new_stem)

    new_audio_path = audio_path.parent / f"{sanitized_stem}{audio_path.suffix}"
    if new_audio_path.exists() and new_audio_path.resolve() != audio_path.resolve():
        raise HTTPException(status_code=400, detail=f"Target file already exists: {new_audio_path.name}")

    new_metadata_path_str = ""
    metadata_data: dict | None = None
    new_metadata_path = None
    if metadata_path:
        new_metadata_path = metadata_path.parent / f"{sanitized_stem}{metadata_path.suffix}"
        if new_metadata_path.exists() and new_metadata_path.resolve() != metadata_path.resolve():
            raise HTTPException(status_code=400, detail=f"Target metadata file already exists: {new_metadata_path.name}")
        try:
            metadata_data = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
            raise HTTPException(status_code=422, detail=f"Metadata is not valid JSON: {request.metadata_path}") from exc
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Failed to read metadata file: {exc}") from exc
        if not isinstance(metadata_data, dict):
            raise HTTPException(status_code=422, detail="Metadata JSON must contain an object.")
        try:
            validate_json_compatible(metadata_data, label="metadata")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        audio_path.rename(new_audio_path)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to rename audio file: {exc}") from exc

    if metadata_path and new_metadata_path and metadata_data is not None:
        try:
            metadata_path.rename(new_metadata_path)
        except OSError as exc:
            try:
                new_audio_path.rename(audio_path)
            except OSError:
                pass
            raise HTTPException(status_code=500, detail=f"Failed to rename metadata file: {exc}") from exc

        try:
            new_metadata_path_str = storage.relative_path(new_metadata_path)
            new_audio_path_str = storage.relative_path(new_audio_path)

            data = metadata_data
            data["output_audio_path"] = new_audio_path_str
            data["absolute_output_audio_path"] = storage.absolute_path(new_audio_path)
            data["metadata_path"] = new_metadata_path_str
            data["absolute_metadata_path"] = storage.absolute_path(new_metadata_path)
            if isinstance(data.get("audio"), dict):
                data["audio"]["path"] = new_audio_path_str
                data["audio"]["absolute_path"] = storage.absolute_path(new_audio_path)
            if isinstance(data.get("waveform_preview"), dict) and "audio_path" in data["waveform_preview"]:
                data["waveform_preview"]["audio_path"] = new_audio_path_str

            old_stem = audio_path.stem
            if "sound_id" in data:
                if data["sound_id"] == f"sound_{old_stem}":
                    data["sound_id"] = f"sound_{sanitized_stem}"
                elif data["sound_id"] == old_stem:
                    data["sound_id"] = sanitized_stem

            if isinstance(data.get("lineage"), dict):
                lineage = data["lineage"]
                if lineage.get("id") == f"sound_{old_stem}":
                    lineage["id"] = f"sound_{sanitized_stem}"
                elif lineage.get("id") == old_stem:
                    lineage["id"] = sanitized_stem
                lineage["audio_path"] = new_audio_path_str
                lineage["metadata_path"] = new_metadata_path_str

            storage.write_json_atomic(new_metadata_path, data, touch_library=False)
        except Exception as exc:
            try:
                new_metadata_path.rename(metadata_path)
                new_audio_path.rename(audio_path)
            except OSError:
                pass
            raise HTTPException(status_code=500, detail=f"Failed to update metadata file: {exc}") from exc

    storage.touch_library()

    return {
        "status": "ok",
        "audio_path": storage.relative_path(new_audio_path),
        "metadata_path": new_metadata_path_str,
    }


@router.post("/files/delete")
def delete_output_files(request: BulkDeleteRequest) -> dict[str, str | int]:
    if len(request.items) > 500:
        raise HTTPException(status_code=400, detail="Too many items in one delete request (max 500).")
    resolved_items: list[tuple[Path, Path | None]] = []
    for item in request.items:
        audio_path = _resolve_output_file(item.audio_path)
        metadata_path = None
        if item.metadata_path:
            metadata_path = _resolve_output_file(item.metadata_path)
            if metadata_path.suffix.lower() != ".json":
                raise HTTPException(
                    status_code=422,
                    detail="Metadata path must point to a JSON file.",
                )
        resolved_items.append((audio_path, metadata_path))

    deleted_audio: set[Path] = set()
    deleted_paths: set[Path] = set()
    try:
        for audio_path, metadata_path in resolved_items:
            for target in (audio_path, metadata_path):
                if target is None or target in deleted_paths:
                    continue
                target.unlink()
                deleted_paths.add(target)
            deleted_audio.add(audio_path)
    except OSError as exc:
        storage.touch_library()
        raise HTTPException(status_code=500, detail=f"Failed to delete output file: {exc}") from exc

    storage.touch_library()
    return {"status": "ok", "deleted_count": len(deleted_audio)}
