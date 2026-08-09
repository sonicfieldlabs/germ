from __future__ import annotations

import json
import platform
import re
import subprocess
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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


def _remembered_in_akousmata(metadata: dict[str, Any]) -> bool:
    state = metadata.get("akousmata")
    if bool(metadata.get("akousma_id")):
        return True
    if not isinstance(state, dict):
        return False
    status = state.get("status")
    return status == "remembered" or (
        status == "pending" and state.get("requested") is True
    )


def _load_metadata_object(path: Path, *, label: str = "metadata") -> dict[str, Any]:
    try:
        if path.stat().st_size > MAX_METADATA_FILE_BYTES:
            raise HTTPException(status_code=413, detail=f"{label} exceeds the 10 MB limit.")
        data = json.loads(path.read_text(encoding="utf-8"))
    except HTTPException:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise HTTPException(status_code=422, detail=f"{label} is not valid JSON.") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read {label}: {exc}") from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=422, detail=f"{label} JSON must contain an object.")
    try:
        validate_json_compatible(data, label=label)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return data


def _metadata_path_can_companion(audio_path: Path, metadata_path: Path) -> bool:
    return storage.is_within(metadata_path, settings.metadata_dir) or (
        metadata_path.parent.resolve() == audio_path.parent.resolve()
    )


def _metadata_references_audio(
    metadata_path: Path,
    metadata: dict[str, Any],
    audio_path: Path,
) -> bool:
    references: list[str] = []
    for value in (
        metadata.get("output_audio_path"),
        metadata.get("absolute_output_audio_path"),
    ):
        if isinstance(value, str) and value.strip():
            references.append(value)
    for key in ("audio", "lineage", "waveform_preview"):
        state = metadata.get(key)
        if not isinstance(state, dict):
            continue
        for field in ("path", "absolute_path", "audio_path"):
            value = state.get(field)
            if isinstance(value, str) and value.strip():
                references.append(value)

    if references:
        for value in references:
            try:
                if storage.resolve_path(value) == audio_path.resolve():
                    return True
            except (OSError, RuntimeError):
                continue
        return False
    return (
        metadata_path.stem == audio_path.stem
        and _metadata_path_can_companion(audio_path, metadata_path)
    )


def _resolve_metadata_companion(
    audio_path: Path,
    requested_path: str | None,
    *,
    require_explicit: bool,
) -> tuple[Path | None, dict[str, Any] | None]:
    """Resolve the actual metadata companion instead of trusting a caller pair."""

    requested: Path | None = None
    requested_data: dict[str, Any] | None = None
    if requested_path:
        requested = _resolve_output_file(requested_path)
        if requested.suffix.lower() != ".json":
            raise HTTPException(status_code=422, detail="Metadata path must point to a JSON file.")
        if not _metadata_path_can_companion(audio_path, requested):
            raise HTTPException(
                status_code=422,
                detail="Metadata must be inside output/metadata or beside its audio file.",
            )
        requested_data = _load_metadata_object(requested)
        if not _metadata_references_audio(requested, requested_data, audio_path):
            raise HTTPException(
                status_code=422,
                detail="Metadata path is not the companion of the requested audio file.",
            )

    candidates: list[Path] = []
    for candidate in (
        settings.metadata_dir / f"{audio_path.stem}.json",
        audio_path.with_suffix(".json"),
    ):
        try:
            resolved = candidate.resolve()
        except (OSError, RuntimeError):
            continue
        if resolved == requested or resolved in candidates or not resolved.is_file():
            continue
        candidates.append(resolved)

    discovered: list[tuple[Path, dict[str, Any]]] = []
    for candidate in candidates:
        data = _load_metadata_object(candidate)
        if not _metadata_references_audio(candidate, data, audio_path):
            raise HTTPException(
                status_code=409,
                detail=(
                    "A same-name metadata file does not identify the requested audio; "
                    "repair the companion relationship before changing files."
                ),
            )
        discovered.append((candidate, data))

    if requested is not None and discovered:
        raise HTTPException(
            status_code=409,
            detail="Multiple metadata files claim this audio; resolve the ambiguity first.",
        )
    if len(discovered) > 1:
        raise HTTPException(
            status_code=409,
            detail="Multiple metadata files claim this audio; resolve the ambiguity first.",
        )

    companion_path = requested or (discovered[0][0] if discovered else None)
    companion_data = (
        requested_data
        if requested_data is not None
        else (discovered[0][1] if discovered else None)
    )
    if require_explicit and companion_path is not None and requested is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "This audio has companion metadata. Supply its exact metadata_path to "
                "delete the sound and its verified local companions together."
            ),
        )
    return companion_path, companion_data


def _replace_matching_audio_locator(
    state: dict[str, Any],
    key: str,
    *,
    old_audio_path: Path,
    new_audio_path: Path,
) -> None:
    value = state.get(key)
    if not isinstance(value, str) or not value.strip():
        return
    try:
        if storage.resolve_path(value) != old_audio_path.resolve():
            return
    except (OSError, RuntimeError):
        return
    state[key] = (
        storage.absolute_path(new_audio_path)
        if Path(value).expanduser().is_absolute()
        else storage.relative_path(new_audio_path)
    )


@dataclass(frozen=True)
class _MasaSidecarUpdate:
    path: Path
    previous: dict[str, Any]
    record: dict[str, Any]
    state: dict[str, Any]


def _prepare_written_masa_sidecar(
    metadata: dict[str, Any],
    *,
    previous_audio_path: Path,
) -> _MasaSidecarUpdate | None:
    """Validate and build a MASA refresh without mutating any file.

    MASA remains a companion to the canonical GERM record. A broken or
    untrusted sidecar reference must not redirect a mutation into another
    sound's record. A rename is rolled back if its verified companion cannot be
    committed, leaving the pre-existing sound and account intact.
    """

    state = metadata.get("masa")
    if not isinstance(state, dict) or state.get("status") != "written":
        return None

    sidecar_value = state.get("sidecar_path")
    if not isinstance(sidecar_value, str) or not sidecar_value.strip():
        raise ValueError("written MASA state is missing sidecar_path")
    sidecar_path = storage.resolve_existing_path(sidecar_value, label="MASA sidecar")
    if (
        not sidecar_path.is_file()
        or not storage.is_within(sidecar_path, settings.masa_dir)
        or not sidecar_path.name.endswith(".masa.json")
    ):
        raise ValueError("MASA sidecar must be a .masa.json file under output/masa")

    from server.masa_bridge import MASA_VERSION, build_generation_record

    previous = _load_metadata_object(sidecar_path, label="MASA sidecar")
    record = build_generation_record(metadata)
    validate_json_compatible(record, label="MASA sidecar")
    representations = record.get("representations")
    if not isinstance(representations, list):
        raise ValueError("MASA sidecar refresh did not produce representations")
    output = next(
        (
            item
            for item in representations
            if isinstance(item, dict) and item.get("role") == "model-output"
        ),
        None,
    )
    if not isinstance(output, dict) or not isinstance(output.get("id"), str):
        raise ValueError("MASA sidecar refresh did not produce a model-output identity")
    expected_record_id = record["id"]
    if previous.get("id") != expected_record_id:
        raise ValueError("MASA sidecar identity does not match this sound")
    if state.get("record_id") not in (None, expected_record_id):
        raise ValueError("MASA metadata record_id does not match this sound")
    if state.get("representation_id") not in (None, output["id"]):
        raise ValueError("MASA metadata representation_id does not match this sound")
    previous_representations = previous.get("representations")
    previous_output = next(
        (
            item
            for item in previous_representations
            if isinstance(item, dict) and item.get("id") == output["id"]
        ),
        None,
    ) if isinstance(previous_representations, list) else None
    if not isinstance(previous_output, dict):
        raise ValueError("MASA sidecar representation does not match this sound")
    locator = previous_output.get("locator")
    locator_value = locator.get("value") if isinstance(locator, dict) else None
    if not isinstance(locator_value, str) or not locator_value.strip():
        raise ValueError("MASA sidecar is missing its audio locator")
    try:
        locator_matches = storage.resolve_path(locator_value) == previous_audio_path.resolve()
    except (OSError, RuntimeError):
        locator_matches = False
    if not locator_matches:
        raise ValueError("MASA sidecar locator does not match this sound")

    refreshed = {
        **state,
        "status": "written",
        "requested": True,
        "version": MASA_VERSION,
        "record_id": expected_record_id,
        "representation_id": output["id"],
        "sidecar_path": storage.relative_path(sidecar_path),
        "canonical_identity": "sound_id",
    }
    refreshed.pop("error", None)
    return _MasaSidecarUpdate(
        path=sidecar_path,
        previous=previous,
        record=record,
        state=refreshed,
    )


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
    metadata_path, metadata_data = _resolve_metadata_companion(
        audio_path,
        request.metadata_path,
        require_explicit=False,
    )
    if metadata_data is not None and _remembered_in_akousmata(metadata_data):
        raise HTTPException(
            status_code=409,
            detail=(
                "This sound is remembered or still unresolved in Akousmata. Renaming "
                "it could break the stored file locator; preserve the filename or "
                "create a new sound."
            ),
        )

    sanitized_stem = sanitize_filename_stem(request.new_stem)

    new_audio_path = audio_path.parent / f"{sanitized_stem}{audio_path.suffix}"
    if new_audio_path.exists() and new_audio_path.resolve() != audio_path.resolve():
        raise HTTPException(status_code=400, detail=f"Target file already exists: {new_audio_path.name}")

    new_metadata_path_str = ""
    new_metadata_path = None
    if metadata_path:
        new_metadata_path = metadata_path.parent / f"{sanitized_stem}{metadata_path.suffix}"
        if new_metadata_path.exists() and new_metadata_path.resolve() != metadata_path.resolve():
            raise HTTPException(status_code=400, detail=f"Target metadata file already exists: {new_metadata_path.name}")

    updated_metadata: dict[str, Any] | None = None
    masa_update: _MasaSidecarUpdate | None = None
    if metadata_path and new_metadata_path and metadata_data is not None:
        updated_metadata = deepcopy(metadata_data)
        new_metadata_path_str = storage.relative_path(new_metadata_path)
        new_audio_path_str = storage.relative_path(new_audio_path)

        updated_metadata["output_audio_path"] = new_audio_path_str
        updated_metadata["absolute_output_audio_path"] = storage.absolute_path(new_audio_path)
        updated_metadata["metadata_path"] = new_metadata_path_str
        updated_metadata["absolute_metadata_path"] = storage.absolute_path(new_metadata_path)
        if isinstance(updated_metadata.get("audio"), dict):
            updated_metadata["audio"]["path"] = new_audio_path_str
            updated_metadata["audio"]["absolute_path"] = storage.absolute_path(new_audio_path)
        if (
            isinstance(updated_metadata.get("waveform_preview"), dict)
            and "audio_path" in updated_metadata["waveform_preview"]
        ):
            updated_metadata["waveform_preview"]["audio_path"] = new_audio_path_str
        if isinstance(updated_metadata.get("latents"), dict):
            _replace_matching_audio_locator(
                updated_metadata["latents"],
                "source_audio_path",
                old_audio_path=audio_path,
                new_audio_path=new_audio_path,
            )

        if isinstance(updated_metadata.get("lineage"), dict):
            lineage = updated_metadata["lineage"]
            lineage["audio_path"] = new_audio_path_str
            lineage["metadata_path"] = new_metadata_path_str

        # Filenames are mutable storage labels. ``sound_id`` and the matching
        # lineage/earworm identifiers are durable identity and never change.
        try:
            masa_update = _prepare_written_masa_sidecar(
                updated_metadata,
                previous_audio_path=audio_path,
            )
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=409,
                detail=f"MASA sidecar refresh failed before rename: {str(exc)[:1_900]}",
            ) from exc
        if masa_update is not None:
            updated_metadata["masa"] = masa_update.state

    try:
        audio_path.rename(new_audio_path)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to rename audio file: {exc}") from exc

    if metadata_path and new_metadata_path and metadata_data is not None and updated_metadata is not None:
        try:
            metadata_path.rename(new_metadata_path)
        except OSError as exc:
            try:
                new_audio_path.rename(audio_path)
            except OSError:
                pass
            raise HTTPException(status_code=500, detail=f"Failed to rename metadata file: {exc}") from exc

        sidecar_write_attempted = False
        try:
            metadata_commit = updated_metadata
            if masa_update is not None:
                metadata_commit = deepcopy(updated_metadata)
                metadata_commit["masa"] = {
                    **masa_update.state,
                    "status": "pending",
                    "reason": "filename_refresh",
                }
            # Commit the new local locators first, but keep a sidecar refresh
            # explicitly pending across the multi-file transaction. A process
            # interruption therefore cannot make old sidecar evidence look
            # current merely because the filenames already moved.
            storage.write_json_atomic(
                new_metadata_path,
                metadata_commit,
                touch_library=False,
            )
            if masa_update is not None:
                sidecar_write_attempted = True
                storage.write_json_atomic(
                    masa_update.path,
                    masa_update.record,
                    touch_library=False,
                )
                storage.write_json_atomic(
                    new_metadata_path,
                    updated_metadata,
                    touch_library=False,
                )
        except Exception as exc:
            rollback_errors: list[str] = []
            if sidecar_write_attempted and masa_update is not None:
                try:
                    storage.write_json_atomic(
                        masa_update.path,
                        masa_update.previous,
                        touch_library=False,
                    )
                except Exception as rollback_exc:
                    rollback_errors.append(f"MASA sidecar: {rollback_exc}")
            try:
                storage.write_json_atomic(
                    new_metadata_path,
                    metadata_data,
                    touch_library=False,
                )
            except Exception as rollback_exc:
                rollback_errors.append(f"metadata content: {rollback_exc}")
            try:
                if new_metadata_path.resolve() != metadata_path.resolve():
                    new_metadata_path.rename(metadata_path)
            except OSError as rollback_exc:
                rollback_errors.append(f"metadata filename: {rollback_exc}")
            try:
                if new_audio_path.resolve() != audio_path.resolve():
                    new_audio_path.rename(audio_path)
            except OSError as rollback_exc:
                rollback_errors.append(f"audio filename: {rollback_exc}")
            rollback_note = (
                f" Rollback incomplete ({'; '.join(rollback_errors)})."
                if rollback_errors
                else ""
            )
            raise HTTPException(
                status_code=500,
                detail=f"Failed to update renamed companions: {exc}.{rollback_note}",
            ) from exc

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
    resolved_items: list[tuple[Path, Path | None, Path | None]] = []
    for item in request.items:
        audio_path = _resolve_output_file(item.audio_path)
        if audio_path.suffix.lower() not in AUDIO_EXTENSIONS:
            raise HTTPException(status_code=422, detail="Audio path must point to an audio file.")
        metadata_path, metadata = _resolve_metadata_companion(
            audio_path,
            item.metadata_path,
            require_explicit=True,
        )
        masa_sidecar: Path | None = None
        if metadata is not None:
            if _remembered_in_akousmata(metadata):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "This sound is remembered or still unresolved in Akousmata. "
                        "Deleting it could break the stored file locator; preserve the "
                        "sound or create a new record."
                    ),
                )
            masa_state = metadata.get("masa")
            if isinstance(masa_state, dict) and masa_state.get("sidecar_path"):
                if masa_state.get("status") != "written":
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            "This sound retains non-written MASA sidecar evidence. "
                            "Repair or preserve it before deleting the sound."
                        ),
                    )
                try:
                    masa_update = _prepare_written_masa_sidecar(
                        metadata,
                        previous_audio_path=audio_path,
                    )
                except HTTPException:
                    raise
                except Exception as exc:
                    raise HTTPException(
                        status_code=409,
                        detail=f"MASA companion cannot be deleted safely: {str(exc)[:1_900]}",
                    ) from exc
                if masa_update is None:
                    raise HTTPException(
                        status_code=409,
                        detail="MASA companion state is inconsistent.",
                    )
                masa_sidecar = masa_update.path
        resolved_items.append((audio_path, metadata_path, masa_sidecar))

    deleted_audio: set[Path] = set()
    deleted_paths: set[Path] = set()
    try:
        for audio_path, metadata_path, masa_sidecar in resolved_items:
            # Delete the audio first. If a later companion unlink fails, the
            # remaining metadata/sidecar still preserves evidence of what was
            # requested and which locator became unavailable.
            for target in (audio_path, metadata_path, masa_sidecar):
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
