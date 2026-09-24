from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse

from server.identity import LEGACY_ENGINE_NAME, PRODUCT_NAME, SOUND_MATTER_CONCEPT
from server.registry import settings, storage


router = APIRouter()

AUDIO_EXTENSIONS = {
    ".aif",
    ".aiff",
    ".flac",
    ".m4a",
    ".mp3",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
}
MAX_LIBRARY_ITEMS = 5000
MAX_LIBRARY_METADATA_BYTES = 10_000_000

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
_metadata_item_cache: dict[str, tuple[int, int, dict[str, Any] | None]] = {}


def _reject_nonfinite_json(value: str) -> None:
    raise ValueError(f"non-finite JSON number: {value}")


def _read_metadata_object(path: Path) -> dict[str, Any] | None:
    try:
        if path.stat().st_size > MAX_LIBRARY_METADATA_BYTES:
            return None
        data = json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=_reject_nonfinite_json,
        )
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError, RecursionError):
        return None
    return data if isinstance(data, dict) else None


def _list_or_empty(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _dict_or_empty(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


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
    try:
        top_level_dirs = [
            item for item in root.iterdir() if not item.is_symlink() and item.is_dir()
        ]
    except OSError:
        top_level_dirs = []
    watch_dirs = [
        root,
        *top_level_dirs,
        settings.wavetable_metadata_dir,
        settings.wavetable_data_dir,
        settings.wavetable_preview_dir,
    ]
    seen_dirs: set[Path] = set()
    for path in watch_dirs:
        if (
            path in seen_dirs
            or not path.exists()
            or not storage.is_within(path, root)
        ):
            continue
        seen_dirs.add(path)
        try:
            stat = path.stat()
        except OSError:
            continue
        directories.append((storage.relative_path(path), stat.st_mtime_ns, stat.st_size))
    for external in settings.library_audio_roots:
        if not external.is_dir():
            continue
        for path in [external, *external.rglob("*")]:
            if path.is_symlink() or not storage.is_within(path, external):
                continue
            try:
                if path.is_file() or path.is_dir():
                    stat = path.stat()
                    directories.append((str(path), stat.st_mtime_ns, stat.st_size))
            except OSError:
                continue
    return (storage.library_version, tuple(sorted(directories)))


def _cached_output_signature_unlocked() -> tuple[int, tuple[tuple[str, int, int], ...]]:
    # Stats only the top-level output directories (cheap) on every request, so a
    # file copied into output/ outside the app is noticed immediately. The costly
    # work — parsing metadata in _build_library_items — still runs only when this
    # signature actually changes.
    _library_cache["current_signature"] = _output_signature()
    return _library_cache["current_signature"]


def _audio_target(audio_path: str | None, absolute_audio_path: str | None = None, *, library_root: Path | None = None) -> Path | None:
    if not isinstance(audio_path, str):
        audio_path = None
    if not isinstance(absolute_audio_path, str):
        absolute_audio_path = None
    if not audio_path and not absolute_audio_path:
        return None

    output_root = (library_root or settings.output_root).resolve()

    def candidate(raw_path: Path) -> Path | None:
        target = raw_path.expanduser().resolve()
        try:
            target.relative_to(output_root)
        except ValueError:
            return None
        if target.suffix.lower() not in AUDIO_EXTENSIONS:
            return None
        return target

    relative_target = candidate(settings.project_root / audio_path) if audio_path else None
    absolute_target = candidate(Path(absolute_audio_path)) if absolute_audio_path else None

    # Prefer the current project-relative path. Older metadata can contain stale
    # absolute paths from a previous checkout location.
    if relative_target and relative_target.is_file():
        return relative_target
    if absolute_target and absolute_target.is_file():
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


def _metadata_item(path: Path, *, library_root: Path | None = None) -> dict[str, Any] | None:
    if not storage.is_within(path, library_root / "metadata" if library_root else settings.metadata_dir):
        return None
    data = _read_metadata_object(path)
    if data is None:
        return None
    if path.name.endswith(".earworm.session.json") or (
        "session_id" in data and isinstance(data.get("events"), list)
    ):
        # Earworm context-chain sessions persist beside organism metadata but
        # are exports, not library organisms.
        return None

    audio_path = data.get("output_audio_path")
    absolute_audio_path = data.get("absolute_output_audio_path")
    target = _audio_target(audio_path, absolute_audio_path, library_root=library_root)
    target_stat = None
    if target:
        try:
            target_stat = target.stat()
        except OSError:
            target_stat = None
    exists = target_stat is not None
    resolved_audio_path = (
        storage.relative_path(target)
        if target and exists
        else audio_path
        if isinstance(audio_path, str)
        else None
    )
    lineage = _dict_or_empty(data.get("lineage"))
    source_data = _dict_or_empty(data.get("source"))
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
        "tags": _list_or_empty(data.get("tags")),
        "notes": data.get("notes"),
        "ratings": _dict_or_empty(data.get("ratings")),
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
        "generation_receipt": _dict_or_empty(data.get("research")) or _dict_or_empty(data.get("ace_step")) or _dict_or_empty(data.get("synthesis")),
        "init_noise_level": data.get("init_noise_level"),
        "morph_depth": data.get("morph_depth"),
        "inpaint_ranges": _list_or_empty(data.get("inpaint_ranges")),
        "lora": _list_or_empty(data.get("lora")),
        "lora_strains": _list_or_empty(data.get("lora_strains"))
        or _list_or_empty(data.get("lora")),
        "strain_stack": _list_or_empty(data.get("strain_stack"))
        or _list_or_empty(data.get("lora_strains"))
        or _list_or_empty(data.get("lora")),
        "sound_id": data.get("sound_id") or lineage.get("id") or resolved_audio_path or path.stem,
        "parents": _list_or_empty(data.get("parents"))
        or _list_or_empty(lineage.get("parents")),
        "children": _list_or_empty(data.get("children"))
        or _list_or_empty(lineage.get("children")),
        "operation": data.get("operation") or lineage.get("operation") or data.get("germinator_mode"),
        "operation_params": _dict_or_empty(data.get("operation_params"))
        or _dict_or_empty(lineage.get("operation_params")),
        "parent_branch": data.get("parent_branch") or lineage.get("parent_branch"),
        "source_region": data.get("source_region") or lineage.get("region"),
        "generation_context": data.get("generation_context") or (lineage.get("operation_params") or {}).get("generation_context") or {},
        "lineage": lineage,
        "source_type": source_type,
        "source": source_data or "metadata",
        "file_size": target_stat.st_size if target_stat else None,
    }


def _wavetable_item(path: Path) -> dict[str, Any] | None:
    if not storage.is_within(path, settings.wavetable_metadata_dir):
        return None
    data = _read_metadata_object(path)
    if data is None or data.get("type") != "germ_wavetable":
        return None

    data_file = data.get("data_path")
    data_target = None
    if isinstance(data_file, str) and data_file:
        candidate = (settings.project_root / data_file).resolve()
        try:
            candidate.relative_to(settings.wavetable_data_dir.resolve())
        except ValueError:
            pass
        else:
            if candidate.name.endswith(".gwt.bin"):
                data_target = candidate
    data_stat = None
    if data_target:
        try:
            data_stat = data_target.stat()
        except OSError:
            pass
    data_exists = data_stat is not None
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
        "tags": _list_or_empty(data.get("tags")),
        "metadata_file": metadata_file,
        "data_file": data_file,
        "audio_file": None,
        "audio_exists": False,
        "data_exists": data_exists,
        "operation": data.get("operation") or lineage.get("operation"),
        "operation_params": _dict_or_empty(data.get("operation_params"))
        or _dict_or_empty(lineage.get("operation_params")),
        "parents": _list_or_empty(data.get("parents"))
        or _list_or_empty(lineage.get("parents")),
        "children": _list_or_empty(data.get("children"))
        or _list_or_empty(lineage.get("children")),
        "lineage": lineage,
        "runtime": data.get("runtime"),
        "created_at": data.get("created_at"),
        "source_audio_path": data.get("source_audio_path"),
        "source_metadata_path": data.get("source_metadata_path"),
        "source_type": "wavetable",
        "source": data.get("source") or "wavetable",
        "table_classification": data.get("table_classification"),
        "warnings": _list_or_empty(data.get("warnings")),
        "descriptors": data.get("descriptors") if isinstance(data.get("descriptors"), dict) else {},
        "file_size": data_stat.st_size if data_stat else None,
    }


def _build_library_items() -> list[dict[str, Any]]:
    metadata_dir = settings.metadata_dir
    items: list[dict[str, Any]] = []
    indexed_audio: set[str] = set()
    seen: set[str] = set()
    if metadata_dir.exists():
        entries: list[tuple[Path, int, int]] = []
        for path in metadata_dir.glob("*.json"):
            try:
                stat = path.stat()
            except OSError:
                continue
            if not storage.is_within(path, metadata_dir):
                continue
            entries.append((path, stat.st_mtime_ns, stat.st_size))
        entries.sort(key=lambda entry: entry[1], reverse=True)
        for path, mtime_ns, size in entries[:MAX_LIBRARY_ITEMS]:
            key = str(path)
            seen.add(key)
            cached = _metadata_item_cache.get(key)
            if cached is not None and cached[:2] == (mtime_ns, size):
                item = cached[2]
            else:
                item = _metadata_item(path)
                _metadata_item_cache[key] = (mtime_ns, size, item)
            if item:
                items.append(item)
                if item.get("audio_file"):
                    indexed_audio.add(item["audio_file"])

    wavetable_metadata_dir = settings.wavetable_metadata_dir
    if wavetable_metadata_dir.exists():
        entries = []
        for path in wavetable_metadata_dir.glob("*.json"):
            try:
                stat = path.stat()
            except OSError:
                continue
            if not storage.is_within(path, wavetable_metadata_dir):
                continue
            entries.append((path, stat.st_mtime_ns, stat.st_size))
        entries.sort(key=lambda entry: entry[1], reverse=True)
        for path, mtime_ns, size in entries[:MAX_LIBRARY_ITEMS]:
            key = str(path)
            seen.add(key)
            cached = _metadata_item_cache.get(key)
            if cached is not None and cached[:2] == (mtime_ns, size):
                item = cached[2]
            else:
                item = _wavetable_item(path)
                _metadata_item_cache[key] = (mtime_ns, size, item)
            if item:
                items.append(item)

    # Drop cache entries for metadata files that no longer exist.
    for stale_key in [key for key in _metadata_item_cache if key not in seen]:
        _metadata_item_cache.pop(stale_key, None)

    if settings.output_root.exists():
        audio_paths: list[tuple[Path, float]] = []
        for path in settings.output_root.rglob("*"):
            if (
                path.suffix.lower() not in AUDIO_EXTENSIONS
                or settings.metadata_dir in path.parents
                or settings.wavetable_dir in path.parents
                or settings.scratch_dir in path.parents
                or not storage.is_within(path, settings.output_root)
            ):
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            if path.is_file():
                audio_paths.append((path, stat.st_mtime))
        audio_paths.sort(key=lambda item: item[1], reverse=True)
        for path, _ in audio_paths:
            relative = storage.relative_path(path)
            if relative in indexed_audio:
                continue
            try:
                items.append(_audio_item(path))
            except OSError:
                continue
            indexed_audio.add(relative)

    for root in settings.library_audio_roots:
        if not root.is_dir():
            continue
        for metadata_path in (root / "metadata").glob("*.json"):
            item = _metadata_item(metadata_path, library_root=root)
            if item and item.get("audio_file"):
                absolute = str((settings.project_root / item["audio_file"]).resolve())
                if absolute not in indexed_audio:
                    item["read_only"] = True
                    items.append(item)
                    indexed_audio.add(absolute)
        for path in root.rglob("*"):
            if (path.suffix.lower() not in AUDIO_EXTENSIONS or not path.is_file()
                    or not storage.is_within(path, root) or str(path.resolve()) in indexed_audio):
                continue
            try:
                item = _audio_item(path)
                # External roots are read-only library entries, never writable output paths.
                sound_id = "library_" + hashlib.sha256(str(path.resolve()).encode()).hexdigest()[:32]
                item.update(id=sound_id, sound_id=sound_id, audio_file=str(path.resolve()),
                            source_type="recording" if path.parent.name == "library-captures" else "upload",
                            title=path.stem, file_size=path.stat().st_size)
                item["lineage"].update(id=sound_id, audio_path=str(path.resolve()))
                sidecar = path.with_suffix(path.suffix + ".json")
                if storage.is_within(sidecar, root) and sidecar.is_file():
                    metadata = _read_metadata_object(sidecar) or {}
                    if metadata.get("contract") == "oida/library-capture/v1":
                        item.update(title=metadata.get("label") or path.stem,
                                    duration=metadata.get("duration_seconds"),
                                    memory_ids=[metadata["record_id"]] if metadata.get("record_id") else [])
                        if metadata.get("parent_sound_id"):
                            item["parents"] = [metadata["parent_sound_id"]]
                            item["lineage"]["parents"] = item["parents"]
                        item["lineage"]["listening_capture"] = metadata
                item["read_only"] = True
                items.append(item)
                indexed_audio.add(str(path.resolve()))
            except OSError:
                continue
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
        _refresh_library_unlocked(signature)

        # Petri's legacy editor uses /files for playback and mutations. Its
        # editable listing stays scoped to this output tree; external roots are
        # exposed through the read-only workspace projection and opaque media route.
        all_items = [item for item in _library_cache["items"] if not item.get("read_only")]
    all_items = _permitted_items(all_items)
    etag = '"' + hashlib.sha256((etag + json.dumps([item.get("id") for item in all_items])).encode()).hexdigest() + '"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "private, must-revalidate"})
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


def _refresh_library_unlocked(signature=None):
    if signature is None:
        signature = _cached_output_signature_unlocked()
    if _library_cache["built_signature"] != signature or _library_cache["items"] is None:
        items = _build_library_items()
        memory_index = {}
        for item in items:
            ids = item.get("memory_ids")
            if (not item.get("audio_exists") or not item.get("audio_file")
                    or not isinstance(ids, list)
                    or not all(isinstance(rid, str) and re.fullmatch(r"[A-Za-z0-9_:-]{1,100}", rid) for rid in ids)):
                continue
            for rid in ids:
                memory_index.setdefault(rid, {
                    "key": library_key(item),
                    "title": str(item.get("title") or "Retained listening audio")[:256],
                    "memory_ids": [rid],
                    "duration": item.get("duration"),
                })
        _library_cache.update(items=items, built_signature=signature, memory_index=memory_index,
                              key_index={library_key(item): item for item in items})


def library_memory_replay(record_id: str) -> list[dict]:
    """Bounded exact-lineage lookup, invalidated with the canonical library index.

    The item it names is checked for permission afresh, as the full listing would,
    so a caller can ask for one record's audio without paying for every item's check.
    """
    with _library_cache_lock:
        _refresh_library_unlocked()
        item = _library_cache.get("memory_index", {}).get(record_id)
        source = _library_cache.get("key_index", {}).get(item["key"]) if item else None
    if item is None or source is None or not _permitted_items([source]):
        return []
    return [{**item, "memory_ids": list(item["memory_ids"])}]


def library_items() -> list[dict[str, Any]]:
    """Share Petri's cached index with other local clients."""
    with _library_cache_lock:
        _refresh_library_unlocked()
        items = list(_library_cache["items"])
    return _permitted_items(items)


def _permitted_items(items):
    # Never cache permission. Mid-flight revocation can leave physical artifacts,
    # but those artifacts and their prompts must not become readable results.
    # One request shares one admission session: each record is read once per request.
    from server.memory_policy import AdmissionSession, validate_context
    permitted = []
    def context_of(item):
        return item.get("generation_context") or (item.get("lineage", {}).get("operation_params") or {}).get("generation_context") or {}

    def influence_ids():
        for item in items:
            context = context_of(item)
            influences = context.get("memory_influences") if isinstance(context, dict) else None
            for influence in influences if isinstance(influences, list) else []:
                if isinstance(influence, dict):
                    yield influence.get("record_id")

    with AdmissionSession() as session:
        session.prefetch(influence_ids())
        for item in items:
            context = context_of(item)
            try:
                validate_context(context, session=session)
                permitted.append(item)
            except (HTTPException, KeyError, ValueError):
                continue
    return permitted


def library_key(item: dict) -> str:
    return hashlib.sha256(str(item.get("sound_id") or item["id"]).encode()).hexdigest()


def resolve_library_audio(key: str) -> tuple[dict, Path]:
    if not re.fullmatch(r"[a-f0-9]{64}", key):
        raise HTTPException(400, "Invalid library key")
    with _library_cache_lock:
        _refresh_library_unlocked()
        item = _library_cache.get("key_index", {}).get(key)
    # Validate only the selected item, freshly, outside the index lock.
    if item is not None and not _permitted_items([item]):
        item = None
    if item is None or not item.get("audio_exists") or not item.get("audio_file"):
        raise HTTPException(404, "Sound is no longer available in the library")
    path = (settings.project_root / item["audio_file"]).resolve()
    roots = [settings.output_root, *settings.library_audio_roots]
    if not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS or not any(storage.is_within(path, root) for root in roots):
        raise HTTPException(404, "Library audio is unavailable")
    return item, path


@router.get("/library/audio/{key}/authorization")
def library_audio_authorization(key: str):
    item, path = resolve_library_audio(key)
    if path.stat().st_size > 128 * 1024 * 1024:
        raise HTTPException(413, "Sound exceeds the Station audio limit")
    source_type = item.get("source_type")
    kind = source_type if source_type in {"import", "discovery"} else (
        "generated" if str(item.get("provider", "")).startswith(
            ("stable_audio", "stability", "synthesis", "mock", "ace_step", "research")
        ) else source_type or "audio"
    )
    context = ((item.get("lineage") or {}).get("operation_params") or {}).get("generation_context") or {}
    title = (f"Memory composition · {len(context.get('memory_influences', []))} records"
             if context.get("workspace_mode") == "memory"
             else item.get("title") or item.get("prompt") or path.stem)
    return {"contract": "germ/audio-authorization/v1", "path": str(path), "key": key,
            "sound_id": item["sound_id"], "kind": kind, "title": title,
            "memory_ids": item.get("memory_ids") or []}


@router.get("/library/audio/{key}/resolve")
def library_audio_location(key: str):
    item, path = resolve_library_audio(key)
    # Compute only on explicit resolution, not while painting the library index.
    before = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    import soundfile as sf

    try:
        info = sf.info(str(path))
        duration = info.frames / info.samplerate
    except (OSError, RuntimeError, ValueError, ZeroDivisionError) as exc:
        raise HTTPException(422, "Cannot verify retained audio duration") from exc
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise HTTPException(409, "Library audio changed during resolution")
    return {"path": str(path), "sound_id": item["sound_id"], "sha256": digest.hexdigest(), "duration": duration}


@router.get("/library/audio/{key}")
def library_audio_file(key: str):
    _, path = resolve_library_audio(key)
    return FileResponse(path, headers={"Cache-Control": "private, no-store"})
