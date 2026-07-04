from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import APIRouter, Request, Response

from server.identity import LEGACY_ENGINE_NAME, PRODUCT_NAME, SOUND_MATTER_CONCEPT
from server.registry import settings, storage


router = APIRouter()

AUDIO_EXTENSIONS = {".aif", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".wav", ".webm"}
MAX_LIBRARY_ITEMS = 5000

# Cache the fully built library and rebuild only when the output tree changes.
_library_cache: dict[str, Any] = {
    "built_signature": None,
    "current_signature": None,
    "items": None,
}
_library_cache_lock = Lock()

# Parsed-metadata cache keyed by file path -> (mtime_ns, item). Lets a rebuild
# reuse already-parsed metadata for files that have not changed, instead of
# re-reading and re-parsing every JSON in the tree on every rebuild.
_metadata_item_cache: dict[str, tuple[int, dict[str, Any] | None]] = {}


def _library_etag(
    signature: tuple[int, tuple[tuple[str, int, int], ...]],
    *,
    offset: int,
    limit: int,
    fields: set[str] | None,
) -> str:
    payload = {
        "signature": signature,
        "offset": offset,
        "limit": limit,
        "fields": sorted(fields) if fields else None,
    }
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return f'"{digest}"'


def _parse_fields(value: str | None) -> set[str] | None:
    if not value:
        return None
    fields = {field.strip() for field in value.split(",") if field.strip()}
    return fields or None


def _project_item_fields(item: dict[str, Any], fields: set[str] | None) -> dict[str, Any]:
    if not fields:
        return item
    return {field: item.get(field) for field in fields if field in item}


def _output_signature() -> tuple[int, tuple[tuple[str, int, int], ...]]:
    """Cheap output/ fingerprint.

    Metadata writes explicitly increment storage.library_version. For files
    copied into output/ outside the app, directory mtime/size changes catch new
    archive audio without walking every audio file on every /library request.
    Known accepted trade-off: an in-place edit to an existing file by an
    external tool changes neither the directory stats nor library_version, so
    it is not detected until another change busts the signature.
    """
    root = settings.output_root
    directories: list[tuple[str, int, int]] = []
    if not root.exists():
        return (storage.library_version, tuple())
    watch_dirs = [
        root,
        *(item for item in root.iterdir() if item.is_dir()),
        settings.wavetable_metadata_dir,
        settings.wavetable_data_dir,
        settings.wavetable_preview_dir,
    ]
    seen_dirs: set[Path] = set()
    for path in watch_dirs:
        if path in seen_dirs or not path.exists():
            continue
        seen_dirs.add(path)
        try:
            stat = path.stat()
        except OSError:
            continue
        directories.append((storage.relative_path(path), stat.st_mtime_ns, stat.st_size))
    return (storage.library_version, tuple(sorted(directories)))


def _cached_output_signature_unlocked() -> tuple[int, tuple[tuple[str, int, int], ...]]:
    # Stats only the top-level output directories (cheap) on every request, so a
    # file copied into output/ outside the app is noticed immediately. The costly
    # work — parsing metadata in _build_library_items — still runs only when this
    # signature actually changes.
    _library_cache["current_signature"] = _output_signature()
    return _library_cache["current_signature"]


def _audio_target(audio_path: str | None, absolute_audio_path: str | None = None) -> Path | None:
    if not audio_path and not absolute_audio_path:
        return None

    relative_target = settings.project_root / audio_path if audio_path else None
    absolute_target = Path(absolute_audio_path).expanduser() if absolute_audio_path else None

    # Prefer the current project-relative path. Older metadata can contain stale
    # absolute paths from a previous checkout location.
    if relative_target and relative_target.exists():
        return relative_target
    if absolute_target and absolute_target.exists():
        return absolute_target
    return relative_target or absolute_target


def _audio_source(path: Path) -> str:
    if settings.scratch_dir in path.parents:
        return "scratch"
    if settings.upload_dir in path.parents:
        return "upload"
    if settings.audio_dir in path.parents:
        return "output"
    try:
        return path.relative_to(settings.output_root).parts[0]
    except ValueError:
        return "output"


def _audio_item(path: Path) -> dict[str, Any]:
    stat = path.stat()
    relative = storage.relative_path(path)
    source = _audio_source(path)
    return {
        "id": path.stem,
        "asset_type": "audio",
        "app": PRODUCT_NAME,
        "product": PRODUCT_NAME,
        "legacy_app": LEGACY_ENGINE_NAME,
        "concept": SOUND_MATTER_CONCEPT,
        "provider": "local",
        "runtime": source,
        "model": None,
        "mode": "file",
        "technical_mode": "file",
        "germinator_mode": "archive",
        "prompt": None,
        "negative_prompt": None,
        "duration": None,
        "seed": None,
        "steps": None,
        "cfg_scale": None,
        "status": "done",
        "error": None,
        "created_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        "culture_id": None,
        "tags": [source],
        "notes": None,
        "ratings": {},
        "waveform_preview": None,
        "latents": {},
        "latent_file": None,
        "latent_fingerprint": None,
        "organism": None,
        "image": None,
        "strain_stack": [],
        "source_type": source,
        "audio_file": relative,
        "metadata_file": None,
        "audio_exists": True,
        "sample_rate": None,
        "init_noise_level": None,
        "morph_depth": None,
        "inpaint_ranges": [],
        "lora": [],
        "lora_strains": [],
        "sound_id": relative,
        "parents": [],
        "children": [],
        "operation": "archive",
        "operation_params": {"source": source},
        "parent_branch": None,
        "source_region": None,
        "lineage": {
            "id": relative,
            "parents": [],
            "children": [],
            "operation": "archive",
            "operation_params": {"source": source},
            "audio_path": relative,
            "metadata_path": None,
        },
        "source": source,
        "file_size": stat.st_size,
    }


def _metadata_item(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if path.name.endswith(".earworm.session.json") or (
        "session_id" in data and isinstance(data.get("events"), list)
    ):
        # Earworm context-chain sessions persist beside organism metadata but
        # are exports, not library organisms.
        return None

    audio_path = data.get("output_audio_path")
    absolute_audio_path = data.get("absolute_output_audio_path")
    target = _audio_target(audio_path, absolute_audio_path)
    target_stat = None
    if target:
        try:
            target_stat = target.stat()
        except OSError:
            target_stat = None
    exists = target_stat is not None
    resolved_audio_path = storage.relative_path(target) if target and exists else audio_path
    lineage = data.get("lineage") if isinstance(data.get("lineage"), dict) else {}
    source_data = data.get("source") if isinstance(data.get("source"), dict) else {}
    source_type = data.get("source_type") or source_data.get("type")

    return {
        "id": path.stem,
        "asset_type": "audio",
        "app": data.get("app"),
        "provider": data.get("provider"),
        "runtime": data.get("runtime"),
        "model": data.get("model"),
        "mode": data.get("mode"),
        "technical_mode": data.get("technical_mode") or data.get("mode"),
        "germinator_mode": data.get("germinator_mode"),
        "prompt": data.get("prompt"),
        "negative_prompt": data.get("negative_prompt"),
        "duration": data.get("duration"),
        "seed": data.get("seed"),
        "steps": data.get("steps"),
        "cfg_scale": data.get("cfg_scale"),
        "status": data.get("status"),
        "error": data.get("error"),
        "created_at": data.get("created_at"),
        "culture_id": data.get("culture_id"),
        "tags": data.get("tags") or [],
        "notes": data.get("notes"),
        "ratings": data.get("ratings") or {},
        "waveform_preview": data.get("waveform_preview"),
        "latents": data.get("latents") if isinstance(data.get("latents"), dict) else {},
        "latent_file": data.get("latent_file"),
        "latent_fingerprint": data.get("latent_fingerprint"),
        "organism": data.get("organism") if isinstance(data.get("organism"), dict) else None,
        "image": data.get("image") if isinstance(data.get("image"), dict) else None,
        "audio_file": resolved_audio_path,
        "metadata_file": storage.relative_path(path),
        "audio_exists": exists,
        "sample_rate": data.get("sample_rate"),
        "init_noise_level": data.get("init_noise_level"),
        "morph_depth": data.get("morph_depth"),
        "inpaint_ranges": data.get("inpaint_ranges") or [],
        "lora": data.get("lora") or [],
        "lora_strains": data.get("lora_strains") or data.get("lora") or [],
        "strain_stack": data.get("strain_stack") or data.get("lora_strains") or data.get("lora") or [],
        "sound_id": data.get("sound_id") or lineage.get("id") or resolved_audio_path or path.stem,
        "parents": data.get("parents") or lineage.get("parents") or [],
        "children": data.get("children") or lineage.get("children") or [],
        "operation": data.get("operation") or lineage.get("operation") or data.get("germinator_mode"),
        "operation_params": data.get("operation_params") or lineage.get("operation_params") or {},
        "parent_branch": data.get("parent_branch") or lineage.get("parent_branch"),
        "source_region": data.get("source_region") or lineage.get("region"),
        "lineage": lineage,
        "source_type": source_type,
        "source": source_data or "metadata",
        "file_size": target_stat.st_size if target_stat else None,
    }


def _wavetable_item(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if data.get("type") != "germ_wavetable":
        return None

    data_file = data.get("data_path")
    data_target = settings.project_root / data_file if data_file else None
    data_exists = bool(data_target and data_target.exists())
    lineage = data.get("lineage") if isinstance(data.get("lineage"), dict) else {}
    prompt = data.get("source_prompt") or data.get("prompt")
    metadata_file = storage.relative_path(path)
    return {
        "asset_type": "wavetable",
        "id": data.get("id") or path.stem,
        "wavetable_id": data.get("id") or path.stem,
        "name": data.get("name") or path.stem,
        "frame_size": data.get("frame_size"),
        "frame_count": data.get("frame_count"),
        "sample_rate": data.get("sample_rate"),
        "root_note": data.get("root_note"),
        "root_frequency": data.get("root_frequency"),
        "prompt": prompt,
        "negative_prompt": data.get("negative_prompt"),
        "tags": data.get("tags") or [],
        "metadata_file": metadata_file,
        "data_file": data_file,
        "audio_file": None,
        "audio_exists": False,
        "data_exists": data_exists,
        "operation": data.get("operation") or lineage.get("operation"),
        "operation_params": data.get("operation_params") or lineage.get("operation_params") or {},
        "parents": data.get("parents") or lineage.get("parents") or [],
        "children": data.get("children") or lineage.get("children") or [],
        "lineage": lineage,
        "runtime": data.get("runtime"),
        "created_at": data.get("created_at"),
        "source_audio_path": data.get("source_audio_path"),
        "source_metadata_path": data.get("source_metadata_path"),
        "source_type": "wavetable",
        "source": data.get("source") or "wavetable",
        "table_classification": data.get("table_classification"),
        "warnings": data.get("warnings") or [],
        "descriptors": data.get("descriptors") if isinstance(data.get("descriptors"), dict) else {},
        "file_size": data_target.stat().st_size if data_exists and data_target else None,
    }


def _build_library_items() -> list[dict[str, Any]]:
    metadata_dir = settings.metadata_dir
    items: list[dict[str, Any]] = []
    indexed_audio: set[str] = set()
    seen: set[str] = set()
    if metadata_dir.exists():
        entries: list[tuple[Path, int]] = []
        for path in metadata_dir.glob("*.json"):
            try:
                mtime_ns = path.stat().st_mtime_ns
            except OSError:
                continue
            entries.append((path, mtime_ns))
        entries.sort(key=lambda entry: entry[1], reverse=True)
        for path, mtime_ns in entries[:MAX_LIBRARY_ITEMS]:
            key = str(path)
            seen.add(key)
            cached = _metadata_item_cache.get(key)
            if cached is not None and cached[0] == mtime_ns:
                item = cached[1]
            else:
                item = _metadata_item(path)
                _metadata_item_cache[key] = (mtime_ns, item)
            if item:
                items.append(item)
                if item.get("audio_file"):
                    indexed_audio.add(item["audio_file"])

    wavetable_metadata_dir = settings.wavetable_metadata_dir
    if wavetable_metadata_dir.exists():
        entries = []
        for path in wavetable_metadata_dir.glob("*.json"):
            try:
                entries.append((path, path.stat().st_mtime_ns))
            except OSError:
                continue
        entries.sort(key=lambda entry: entry[1], reverse=True)
        for path, mtime_ns in entries[:MAX_LIBRARY_ITEMS]:
            key = str(path)
            seen.add(key)
            cached = _metadata_item_cache.get(key)
            if cached is not None and cached[0] == mtime_ns:
                item = cached[1]
            else:
                item = _wavetable_item(path)
                _metadata_item_cache[key] = (mtime_ns, item)
            if item:
                items.append(item)

    # Drop cache entries for metadata files that no longer exist.
    for stale_key in [key for key in _metadata_item_cache if key not in seen]:
        _metadata_item_cache.pop(stale_key, None)

    if settings.output_root.exists():
        audio_paths = (
            path
            for path in settings.output_root.rglob("*")
            if path.is_file()
            and path.suffix.lower() in AUDIO_EXTENSIONS
            and settings.metadata_dir not in path.parents
            and settings.wavetable_dir not in path.parents
            and settings.scratch_dir not in path.parents
        )
        for path in sorted(audio_paths, key=lambda item: item.stat().st_mtime, reverse=True):
            relative = storage.relative_path(path)
            if relative in indexed_audio:
                continue
            items.append(_audio_item(path))
            indexed_audio.add(relative)

    items.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return items[:MAX_LIBRARY_ITEMS]


@router.get("/library", response_model=None)
def list_library(
    request: Request,
    response: Response,
    limit: int = MAX_LIBRARY_ITEMS,
    offset: int = 0,
    fields: str | None = None,
) -> dict[str, Any] | Response:
    effective_limit = MAX_LIBRARY_ITEMS if limit <= 0 else max(1, min(limit, MAX_LIBRARY_ITEMS))
    safe_offset = max(0, offset)
    selected_fields = _parse_fields(fields)

    with _library_cache_lock:
        signature = _cached_output_signature_unlocked()
        etag = _library_etag(
            signature,
            offset=safe_offset,
            limit=effective_limit,
            fields=selected_fields,
        )
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag})
        if _library_cache["built_signature"] != signature or _library_cache["items"] is None:
            _library_cache["items"] = _build_library_items()
            _library_cache["built_signature"] = signature

        all_items = _library_cache["items"]
        items = all_items[safe_offset : safe_offset + effective_limit]
        if selected_fields:
            items = [_project_item_fields(item, selected_fields) for item in items]
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "private, must-revalidate"
    return {
        "count": len(items),
        "total_count": len(all_items),
        "offset": safe_offset,
        "limit": effective_limit,
        "items": items,
        "audio_dir": storage.relative_path(settings.audio_dir),
        "metadata_dir": storage.relative_path(settings.metadata_dir),
        "wavetable_dir": storage.relative_path(settings.wavetable_dir),
    }
