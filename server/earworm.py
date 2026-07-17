from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any
from uuid import uuid4

from server.identity import PRODUCT_NAME
from server.schemas import validate_json_compatible
from server.storage import utc_now_iso


def metadata_to_earworm_session(metadata: dict[str, Any]) -> dict[str, Any]:
    """Map one germ organism metadata record to an Earworm context session."""
    validate_json_compatible(metadata, label="Earworm metadata")
    sound_id = str(metadata.get("sound_id") or metadata.get("id") or "sound_unknown")
    asset_id = f"asset_{sound_id}"
    provenance_id = f"prov_{sound_id}"
    session_id = f"sess_{sound_id}"
    created_at = str(metadata.get("created_at") or utc_now_iso())
    output_audio_path = metadata.get("output_audio_path") or metadata.get("audio_path")
    duration = _number_or_none(metadata.get("duration"))
    sample_rate = _int_or_none(metadata.get("sample_rate"))
    tags = _string_list(metadata.get("tags"))
    lineage = metadata.get("lineage") if isinstance(metadata.get("lineage"), dict) else {}
    operation = str(
        lineage.get("operation")
        or metadata.get("operation")
        or metadata.get("germinator_mode")
        or metadata.get("mode")
        or "germinate"
    )
    prompt = str(metadata.get("prompt") or "")
    request_hash = _hash_json(
        {
            "prompt": prompt,
            "negative_prompt": metadata.get("negative_prompt"),
            "operation": operation,
            "model": metadata.get("model"),
            "provider": metadata.get("provider"),
            "seed": metadata.get("seed"),
        }
    )
    asset_hash = _hash_text(str(output_audio_path or sound_id))

    events = [
        _event(
            "prompt",
            session_id,
            "prompt.ingested",
            created_at,
            "user",
            "germ.prompt",
            {
                "prompt": prompt,
                "negative_prompt": metadata.get("negative_prompt"),
                "base_prompt": metadata.get("base_prompt"),
                "modulated_prompt": metadata.get("modulated_prompt"),
                "cultivation": {
                    "operation": operation,
                    "parents": lineage.get("parents") or metadata.get("parents") or [],
                    "tags": tags,
                },
            },
            parent_event_ids=[],
        ),
        _event(
            "generation_request",
            session_id,
            "generation.requested",
            created_at,
            "system",
            "germ.cultivator",
            {
                "provider": metadata.get("provider"),
                "model_id": metadata.get("model"),
                "runtime": metadata.get("runtime"),
                "organism_id": sound_id,
                "operation": operation,
                "request_hash": request_hash,
                "operation_params": metadata.get("operation_params") or {},
            },
            parent_event_ids=[f"evt_{_safe_id(sound_id)}_prompt"],
            provenance_id=provenance_id,
        ),
    ]

    if _has_expanded_sensorium(metadata):
        events.append(
            _event(
                "context",
                session_id,
                "signal.packet.ingested",
                created_at,
                "system",
                "germ.metadata",
                {
                    "packet": {
                        "packet_id": f"packet_{_safe_id(sound_id)}_metadata",
                        "signal_type": "control",
                        "asset_ref": asset_id,
                        "time_range": {
                            "start": 0,
                            "end": duration or 0,
                            "unit": "seconds",
                        },
                        "context_refs": [
                            key
                            for key in (
                                "generation_context",
                                "control_routes",
                                "control_snapshots",
                                "control_sources",
                                "semantic_layers",
                                "modulators",
                                "source",
                                "latents",
                            )
                            if metadata.get(key) not in (None, "", [], {})
                        ],
                        "provenance_id": provenance_id,
                        "tags": ["metadata", "expanded_sensorium"],
                    },
                    "context": {
                        "generation_context": metadata.get("generation_context") or {},
                        "control_routes": metadata.get("control_routes") or [],
                        "control_snapshots": metadata.get("control_snapshots") or [],
                        "control_sources": metadata.get("control_sources") or [],
                        "semantic_layers": metadata.get("semantic_layers") or [],
                        "modulators": metadata.get("modulators") or [],
                        "source": metadata.get("source") or {},
                        "latents": metadata.get("latents") or {},
                    },
                },
                parent_event_ids=[f"evt_{_safe_id(sound_id)}_generation_request"],
                provenance_id=provenance_id,
            )
        )

    audio_parent = (
        f"evt_{_safe_id(sound_id)}_context"
        if _has_expanded_sensorium(metadata)
        else f"evt_{_safe_id(sound_id)}_generation_request"
    )
    events.append(
        _event(
            "audio",
            session_id,
            "audio.generated",
            created_at,
            "provider",
            "germ.generator",
            {
                "asset_id": asset_id,
                "duration_seconds": duration,
                "sample_rate": sample_rate,
                "response_metadata": {
                    "organism_id": sound_id,
                    "status": metadata.get("status"),
                    "generation": _generation_index(metadata),
                    "lineage": lineage,
                },
            },
            parent_event_ids=[audio_parent],
            provenance_id=provenance_id,
        )
    )

    if metadata.get("ratings") or metadata.get("listener") or metadata.get("features"):
        events.append(
            _event(
                "analysis",
                session_id,
                "analysis.frame",
                created_at,
                "system",
                "germ.listen",
                {
                    "asset_id": asset_id,
                    "frames": [
                        {
                            "frame_id": f"frame_{_safe_id(sound_id)}_summary",
                            "asset_ref": asset_id,
                            "time_range": {
                                "start": 0,
                                "end": duration or 0,
                                "unit": "seconds",
                            },
                            "features": {
                                "ratings": metadata.get("ratings") or {},
                                "listener": metadata.get("listener") or {},
                                "features": metadata.get("features") or {},
                            },
                            "confidence": 0.75,
                        }
                    ],
                },
                confidence=0.75,
                parent_event_ids=[f"evt_{_safe_id(sound_id)}_audio"],
                provenance_id=provenance_id,
            )
        )

    harvest_parent_ids = [f"evt_{_safe_id(sound_id)}_audio"]
    if any(event["event_id"].endswith("_analysis") for event in events):
        harvest_parent_ids.append(f"evt_{_safe_id(sound_id)}_analysis")
    events.append(
        _event(
            "harvest",
            session_id,
            "render.created",
            created_at,
            "system",
            "germ.harvest",
            {
                "render_id": f"render_{_safe_id(sound_id)}",
                "asset_id": asset_id,
                "organism_id": sound_id,
                "output_uri": output_audio_path,
                "asset_hash": asset_hash,
                "metadata_path": metadata.get("metadata_path"),
            },
            parent_event_ids=harvest_parent_ids,
            provenance_id=provenance_id,
        )
    )

    provenance = {
        "provenance_id": provenance_id,
        "source_type": _earworm_source_type(metadata),
        "provider": str(metadata.get("provider") or "unknown"),
        "model_id": str(metadata.get("model") or "unknown"),
        "request_hash": request_hash,
        "asset_hash": asset_hash,
        "consent_status": _consent_status(metadata),
        "usage_constraints": _usage_constraints(metadata),
        "created_at": created_at,
    }
    seed = _int_or_none(metadata.get("seed"))
    if seed is not None:
        provenance["seed"] = seed

    return {
        "session_id": session_id,
        "app_id": PRODUCT_NAME,
        "created_at": created_at,
        "policy": {
            "mode": "project_lifetime",
            "local_only": True,
            "redaction": {
                "sensitive_fields": [],
                "agent_safe_omissions": ["absolute_output_audio_path", "absolute_metadata_path"],
            },
        },
        "assets": [
            {
                "asset_id": asset_id,
                "type": "audio",
                "uri": str(output_audio_path or ""),
                "duration_seconds": duration or 0,
                "sample_rate": sample_rate or 0,
                "channels": _int_or_none(metadata.get("channels")) or 2,
                "provenance_id": provenance_id,
                "organism_id": sound_id,
                "operation": operation,
                "tags": tags,
            }
        ],
        "events": events,
        "provenance": [provenance],
        "views": {
            "current_state": {
                "active_asset_id": asset_id,
                "latest_render_id": f"render_{_safe_id(sound_id)}",
            },
            "summaries": [
                {
                    "summary_id": f"summary_{_safe_id(sound_id)}",
                    "kind": "compact",
                    "text": (
                        f"{operation} organism {sound_id}, mapped from germ metadata "
                        "to an Earworm context chain."
                    ),
                }
            ],
        },
        "indexes": {
            "by_time": True,
            "by_asset": True,
            "by_node": True,
            "by_text": True,
        },
    }


def write_earworm_session(metadata: dict[str, Any], destination: str | Path) -> dict[str, Any]:
    session = metadata_to_earworm_session(metadata)
    path = Path(destination)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text(
            json.dumps(session, indent=2, sort_keys=True, allow_nan=False),
            encoding="utf-8",
        )
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return session


def _event(
    suffix: str,
    session_id: str,
    event_type: str,
    wall_clock: str,
    actor: str,
    node_id: str,
    payload: dict[str, Any],
    *,
    parent_event_ids: list[str],
    provenance_id: str | None = None,
    confidence: float = 1.0,
) -> dict[str, Any]:
    safe_session = _safe_id(session_id.removeprefix("sess_"))
    event: dict[str, Any] = {
        "event_id": f"evt_{safe_session}_{suffix}",
        "session_id": session_id,
        "type": event_type,
        "time": {"wall_clock": wall_clock, "project_seconds": 0},
        "source": {"actor": actor, "node_id": node_id},
        "payload": _drop_none(payload),
        "confidence": confidence,
        "reversible": False,
        "parent_event_ids": parent_event_ids,
    }
    if provenance_id:
        event["provenance_id"] = provenance_id
    return event


def _drop_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _drop_none(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_drop_none(item) for item in value]
    return value


def _hash_json(value: Any) -> str:
    return _hash_text(json.dumps(value, sort_keys=True, separators=(",", ":")))


def _hash_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def _safe_id(value: str) -> str:
    safe = "".join(ch.lower() if ch.isalnum() else "_" for ch in str(value)).strip("_")
    return safe or "unknown"


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [
        str(item).strip()[:500]
        for item in value[:512]
        if isinstance(item, (str, int, float))
        and not isinstance(item, bool)
        and str(item).strip()
    ]


def _number_or_none(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _generation_index(metadata: dict[str, Any]) -> int:
    parents = metadata.get("parents")
    if isinstance(parents, list):
        return len(parents) + 1
    lineage = metadata.get("lineage") if isinstance(metadata.get("lineage"), dict) else {}
    lineage_parents = lineage.get("parents")
    return len(lineage_parents) + 1 if isinstance(lineage_parents, list) else 1


def _earworm_source_type(metadata: dict[str, Any]) -> str:
    source = metadata.get("source")
    source_type = str(
        metadata.get("source_type")
        or (source.get("type") if isinstance(source, dict) else source)
        or ""
    )
    if source_type in {"audio", "recording", "recorded"}:
        return "recorded"
    if source_type in {"import", "imported", "upload"}:
        return "imported"
    if metadata.get("input_audio_path"):
        return "cloned"
    if metadata.get("provider"):
        return "generated"
    return "unknown"


def _consent_status(metadata: dict[str, Any]) -> str:
    consent = metadata.get("consent_status") or metadata.get("rights_status")
    if consent in {"owned", "licensed", "public_domain", "unknown", "restricted"}:
        return str(consent)
    return "owned" if metadata.get("provider") else "unknown"


def _usage_constraints(metadata: dict[str, Any]) -> list[str]:
    constraints = _string_list(metadata.get("usage_constraints"))
    if constraints:
        return constraints
    constraints = ["local_cultivation", "lineage_attached"]
    if metadata.get("source_type") in {"recorded", "audio"} or metadata.get("input_audio_path"):
        constraints.append("source_audio_attached")
    return constraints


def _has_expanded_sensorium(metadata: dict[str, Any]) -> bool:
    keys = (
        "generation_context",
        "control_routes",
        "control_snapshots",
        "control_sources",
        "semantic_layers",
        "modulators",
        "source",
        "latents",
    )
    return any(metadata.get(key) not in (None, "", [], {}) for key in keys)
