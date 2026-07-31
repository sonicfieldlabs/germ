from __future__ import annotations

import array
import importlib.util
import ipaddress
import json
import math
import socket
import struct
import sys
import wave
from collections import OrderedDict
from itertools import pairwise
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException

from server.identity import LEGACY_ENGINE_NAME, PRODUCT_NAME, SOUND_MATTER_CONCEPT
from server.registry import control_registry, settings, storage, strain_registry
from server.schemas import (
    ControlAnalysisFeature,
    ControlAnalysisResult,
    ControlAudioAnalysisRequest,
    ControlBridgeStatus,
    ControlCVArmRequest,
    ControlCVProfile,
    ControlCVProfilesResponse,
    ControlCVRenderRequest,
    ControlCVRenderResult,
    ControlEvent,
    ControlEventsResponse,
    ControlFeatureSummary,
    ControlGeneticGraphResponse,
    ControlMIDIMessage,
    ControlMIDIResult,
    ControlNornsBridgeRequest,
    ControlNornsBridgeResult,
    ControlOSCMessage,
    ControlOSCResult,
    ControlPortsResponse,
    ControlRoute,
    ControlRouteEnableRequest,
    ControlRoutesResponse,
    validate_json_compatible,
)
from server.storage import safe_stem, utc_now_iso


router = APIRouter(prefix="/control", tags=["control"])

MAX_CONTROL_POINTS_PER_FEATURE = 20000
MAX_OSC_PACKET_BYTES = 8192
MICRO_MODULE_TYPES = {
    "grain_culture",
    "particle_engine",
    "cell_splitter",
    "swarm",
    "colony",
    "membrane",
    "metabolism",
    "spectral_tissue",
    "quanta",
    "microscope",
    "matter_analysis",
    "incubator",
    "cosmo_matter_modulator",
}

CONTROL_GRAPH_JSON_CACHE_LIMIT = 600
CONTROL_GRAPH_JSON_MAX_BYTES = 10_000_000
_CONTROL_GRAPH_JSON_CACHE_LOCK = Lock()
_CONTROL_GRAPH_JSON_CACHE: OrderedDict[str, tuple[int, dict[str, Any] | None]] = OrderedDict()


@router.get("/ports", response_model=ControlPortsResponse)
def list_ports() -> ControlPortsResponse:
    return ControlPortsResponse(ports=control_registry.ports())


@router.get("/routes", response_model=ControlRoutesResponse)
def list_routes() -> ControlRoutesResponse:
    return ControlRoutesResponse(routes=control_registry.list_routes())


@router.post("/routes", response_model=ControlRoute)
def save_route(route: ControlRoute) -> ControlRoute:
    try:
        return control_registry.save_route(route)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/routes/{route_id}/enable", response_model=ControlRoute)
def enable_route(route_id: str, request: ControlRouteEnableRequest) -> ControlRoute:
    try:
        return control_registry.set_route_enabled(route_id, request.enabled)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"control route not found: {route_id}") from exc


@router.delete("/routes/{route_id}")
def delete_route(route_id: str) -> dict[str, str]:
    try:
        control_registry.delete_route(route_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"control route not found: {route_id}") from exc
    return {"status": "deleted", "route_id": route_id}


@router.get("/events", response_model=ControlEventsResponse)
@router.get("/monitor", response_model=ControlEventsResponse)
def list_events() -> ControlEventsResponse:
    return ControlEventsResponse(events=control_registry.events())


@router.post("/events", response_model=ControlEvent)
def post_event(event: ControlEvent) -> ControlEvent:
    return control_registry.add_event(event)


@router.post("/panic", response_model=ControlEvent)
def panic() -> ControlEvent:
    return control_registry.panic()


@router.get("/bridge/status", response_model=ControlBridgeStatus)
def bridge_status() -> ControlBridgeStatus:
    profiles = control_registry.list_cv_profiles()
    native_midi = importlib.util.find_spec("mido") is not None
    return ControlBridgeStatus(
        osc_udp_send=True,
        osc_udp_receive=False,
        midi_browser=True,
        midi_native=native_midi,
        cv_hardware_output=False,
        cv_profiles=len(profiles),
        armed_cv_outputs=sum(1 for profile in profiles if profile.armed),
        detail={
            "osc_receive": "Use /control/osc/receive to ingest messages from an explicit local bridge.",
            "midi_native": "Optional mido backend is available." if native_midi else "Install/configure a native MIDI bridge to send outside Web MIDI.",
            "cv_hardware_output": "Physical CV output remains disabled; profiles only gate future bridge use.",
        },
    )


def _osc_padded(value: bytes) -> bytes:
    return value + (b"\0" * ((4 - (len(value) % 4)) % 4))


def _osc_packet(message: ControlOSCMessage) -> bytes:
    address = _osc_padded(message.address.encode("utf-8") + b"\0")
    tags = ","
    payload = b""
    for value in message.values:
        if isinstance(value, int) and not isinstance(value, bool):
            tags += "i"
            payload += struct.pack(">i", value)
        elif isinstance(value, float):
            tags += "f"
            payload += struct.pack(">f", value)
        else:
            tags += "s"
            payload += _osc_padded(str(value).encode("utf-8") + b"\0")
    return address + _osc_padded(tags.encode("ascii") + b"\0") + payload


def _safe_osc_target(host: str) -> str:
    try:
        resolved = socket.gethostbyname(host)
        ip = ipaddress.ip_address(resolved)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"invalid OSC host: {host}") from exc
    if not (ip.is_loopback or ip.is_private or ip.is_link_local):
        raise HTTPException(
            status_code=422,
            detail="OSC UDP send is restricted to loopback/private/link-local targets",
        )
    return resolved


@router.post("/osc/send", response_model=ControlOSCResult)
def send_osc(message: ControlOSCMessage) -> ControlOSCResult:
    target = _safe_osc_target(message.host)
    packet = _osc_packet(message)
    if len(packet) > MAX_OSC_PACKET_BYTES:
        raise HTTPException(
            status_code=422,
            detail=f"OSC packet exceeds {MAX_OSC_PACKET_BYTES} bytes",
        )
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(0.5)
            byte_count = sock.sendto(packet, (target, message.port))
    except OSError as exc:
        control_registry.add_event(
            ControlEvent(
                kind="osc",
                source="osc_udp_send",
                value={"host": message.host, "port": message.port, "address": message.address},
                metadata={"sent": False, "error": str(exc), **message.metadata},
            )
        )
        return ControlOSCResult(
            status="error",
            host=message.host,
            port=message.port,
            address=message.address,
            error=str(exc),
        )
    control_registry.add_event(
        ControlEvent(
            kind="osc",
            source="osc_udp_send",
            value={"host": message.host, "port": message.port, "address": message.address, "values": message.values},
            metadata={"sent": True, "byte_count": byte_count, **message.metadata},
        )
    )
    return ControlOSCResult(
        status="sent",
        host=message.host,
        port=message.port,
        address=message.address,
        byte_count=byte_count,
        sent=True,
    )


@router.post("/osc/receive", response_model=ControlOSCResult)
def receive_osc(message: ControlOSCMessage) -> ControlOSCResult:
    control_registry.add_event(
        ControlEvent(
            kind="osc",
            source="osc_bridge_receive",
            value={"host": message.host, "port": message.port, "address": message.address, "values": message.values},
            metadata={"ingested": True, **message.metadata},
        )
    )
    return ControlOSCResult(
        status="recorded",
        host=message.host,
        port=message.port,
        address=message.address,
        byte_count=0,
        sent=False,
    )


@router.get("/osc/norns/profile")
def norns_profile() -> dict[str, Any]:
    return {
        "id": "fates",
        "label": "norns/Fates OSC",
        "default_host": "127.0.0.1",
        "default_port": 10111,
        "mappings": [
            {"address": "/germ/dish/gravity", "range": [0, 1], "target": "dish.gravity"},
            {"address": "/germ/dish/viscosity", "range": [0, 1], "target": "dish.viscosity"},
            {"address": "/germ/dish/energy", "range": [0, 1], "target": "dish.energy"},
            {"address": "/germ/dish/spawn", "range": [0, 1], "target": "dish.spawn"},
        ],
    }


@router.post("/osc/norns/send", response_model=ControlNornsBridgeResult)
def send_norns_bridge(request: ControlNornsBridgeRequest) -> ControlNornsBridgeResult:
    messages: list[ControlOSCResult] = []
    values: list[tuple[str, float | int]] = []
    if request.gravity is not None:
        values.append(("/germ/dish/gravity", request.gravity))
    if request.viscosity is not None:
        values.append(("/germ/dish/viscosity", request.viscosity))
    if request.energy is not None:
        values.append(("/germ/dish/energy", request.energy))
    if request.spawn:
        values.append(("/germ/dish/spawn", 1))
    if not values:
        values.append(("/germ/dish/ping", 1))
    try:
        for address, value in values:
            messages.append(
                send_osc(
                    ControlOSCMessage(
                        host=request.host,
                        port=request.port,
                        address=address,
                        values=[value],
                        metadata={
                            **request.metadata,
                            "bridge_profile": request.profile,
                            "bridge": "norns",
                        },
                    )
                )
            )
    except HTTPException as exc:
        return ControlNornsBridgeResult(
            status="error",
            host=request.host,
            port=request.port,
            profile=request.profile,
            sent=False,
            messages=messages,
            error=str(exc.detail),
        )
    sent = all(message.sent for message in messages)
    return ControlNornsBridgeResult(
        status="sent" if sent else "error",
        host=request.host,
        port=request.port,
        profile=request.profile,
        sent=sent,
        messages=messages,
        error=None if sent else "one or more OSC messages failed",
    )


def _midi_status_byte(message: ControlMIDIMessage) -> int:
    channel = max(0, min(15, message.channel - 1))
    return {
        "note_off": 0x80,
        "note_on": 0x90,
        "cc": 0xB0,
    }.get(message.type, 0xB0) + channel


def _midi_bytes(message: ControlMIDIMessage) -> list[int]:
    if message.type == "clock":
        return [0xF8]
    if message.type == "transport":
        return [0xFA if message.value > 0 else 0xFC]
    if message.type in {"note_on", "note_off"}:
        note = message.note if message.note is not None else 60
        return [_midi_status_byte(message), int(note), int(message.velocity)]
    cc = message.cc if message.cc is not None else 1
    return [_midi_status_byte(message), int(cc), int(message.value)]


@router.post("/midi/send", response_model=ControlMIDIResult)
def send_midi(message: ControlMIDIMessage) -> ControlMIDIResult:
    if message.backend == "event" or message.backend == "browser":
        control_registry.add_event(
            ControlEvent(
                kind="midi",
                source=f"midi_{message.backend}",
                value={"bytes": _midi_bytes(message), "type": message.type, "device": message.device},
                metadata={
                    **message.metadata,
                    "sent": False,
                    "browser_intent": message.backend == "browser",
                },
            )
        )
        return ControlMIDIResult(
            status="recorded",
            sent=False,
            backend=message.backend,
            detail="Use browser Web MIDI for live device output; server recorded the intent.",
        )
    if importlib.util.find_spec("mido") is None:
        control_registry.add_event(
            ControlEvent(
                kind="midi",
                source="midi_native_optional",
                value={"bytes": _midi_bytes(message), "type": message.type, "device": message.device},
                metadata={**message.metadata, "sent": False, "missing": "mido"},
            )
        )
        return ControlMIDIResult(
            status="unsupported",
            sent=False,
            backend="native_optional",
            detail="Native MIDI requires an installed/configured mido backend.",
        )
    try:
        import mido  # type: ignore[import-not-found]

        if message.type == "clock":
            mido_message = mido.Message("clock")
        elif message.type == "transport":
            mido_message = mido.Message("start" if message.value > 0 else "stop")
        else:
            midi_type = "control_change" if message.type == "cc" else message.type
            kwargs: dict[str, Any] = {"channel": message.channel - 1}
            if message.type == "cc":
                control = message.cc if message.cc is not None else 1
                kwargs.update({"control": control, "value": message.value})
            else:
                note = message.note if message.note is not None else 60
                kwargs.update({"note": note, "velocity": message.velocity})
            mido_message = mido.Message(midi_type, **kwargs)
        with mido.open_output(message.device) as output:
            output.send(mido_message)
    except Exception as exc:
        control_registry.add_event(
            ControlEvent(
                kind="midi",
                source="midi_native_optional",
                value={
                    "bytes": _midi_bytes(message),
                    "type": message.type,
                    "device": message.device,
                },
                metadata={**message.metadata, "sent": False, "error": str(exc)},
            )
        )
        return ControlMIDIResult(status="error", sent=False, backend="native_optional", detail=str(exc))
    control_registry.add_event(
        ControlEvent(
            kind="midi",
            source="midi_native_optional",
            value={"bytes": _midi_bytes(message), "type": message.type, "device": message.device},
            metadata={**message.metadata, "sent": True},
        )
    )
    return ControlMIDIResult(status="sent", sent=True, backend="native_optional")


@router.get("/cv/profiles", response_model=ControlCVProfilesResponse)
def list_cv_profiles() -> ControlCVProfilesResponse:
    return ControlCVProfilesResponse(profiles=control_registry.list_cv_profiles())


@router.post("/cv/profiles", response_model=ControlCVProfile)
def save_cv_profile(profile: ControlCVProfile) -> ControlCVProfile:
    try:
        return control_registry.save_cv_profile(profile)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/cv/profiles/{profile_id}/arm", response_model=ControlCVProfile)
def arm_cv_profile(profile_id: str, request: ControlCVArmRequest) -> ControlCVProfile:
    try:
        return control_registry.set_cv_profile_armed(
            profile_id,
            request.armed,
            confirm=request.confirm,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"CV profile not found: {profile_id}") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _metadata_items_for_control_graph(limit: int = 300) -> list[dict[str, Any]]:
    return _cached_json_items_for_control_graph(
        root=storage.metadata_dir,
        limit=limit,
        marker_key="_metadata_path",
    )


def _wavetable_items_for_control_graph(limit: int = 300) -> list[dict[str, Any]]:
    return _cached_json_items_for_control_graph(
        root=settings.wavetable_metadata_dir,
        limit=limit,
        marker_key="_metadata_path",
    )


def _micro_profile_items_for_control_graph(limit: int = 300) -> list[dict[str, Any]]:
    micro_dir = settings.output_root / "micro"
    return _cached_json_items_for_control_graph(
        root=micro_dir,
        limit=limit,
        marker_key="_profile_file",
    )


def _cached_json_items_for_control_graph(
    *,
    root: Path,
    limit: int,
    marker_key: str,
) -> list[dict[str, Any]]:
    if not root.exists():
        return []
    entries: list[tuple[Path, int]] = []
    root_resolved = root.resolve()
    for path in root.glob("*.json"):
        try:
            if (
                path.is_symlink()
                or not path.is_file()
                or path.resolve().parent != root_resolved
            ):
                continue
            stat = path.stat()
            if stat.st_size > CONTROL_GRAPH_JSON_MAX_BYTES:
                continue
            entries.append((path, stat.st_mtime_ns))
        except OSError:
            continue
    entries.sort(key=lambda item: item[1], reverse=True)
    items: list[dict[str, Any]] = []
    for path, mtime_ns in entries[: max(1, limit)]:
        cache_key = path.resolve().as_posix()
        with _CONTROL_GRAPH_JSON_CACHE_LOCK:
            cached = _CONTROL_GRAPH_JSON_CACHE.get(cache_key)
        if cached and cached[0] == mtime_ns:
            with _CONTROL_GRAPH_JSON_CACHE_LOCK:
                _CONTROL_GRAPH_JSON_CACHE.move_to_end(cache_key)
            data = cached[1]
        else:
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                data = loaded if isinstance(loaded, dict) else None
                if data is not None:
                    validate_json_compatible(data, label="control graph metadata")
            except (UnicodeError, json.JSONDecodeError, OSError, RecursionError, ValueError):
                data = None
            with _CONTROL_GRAPH_JSON_CACHE_LOCK:
                _CONTROL_GRAPH_JSON_CACHE[cache_key] = (mtime_ns, data)
                _CONTROL_GRAPH_JSON_CACHE.move_to_end(cache_key)
                while len(_CONTROL_GRAPH_JSON_CACHE) > CONTROL_GRAPH_JSON_CACHE_LIMIT:
                    _CONTROL_GRAPH_JSON_CACHE.popitem(last=False)
        if data is None:
            continue
        item = dict(data)
        item[marker_key] = storage.relative_path(path)
        items.append(item)
    return items


def _strain_node_id(strain: dict[str, Any]) -> str:
    key = strain.get("id") or strain.get("name") or strain.get("path") or "unknown"
    return f"strain:{safe_stem(str(key), fallback='unknown')}"


def _strain_records(item: dict[str, Any], lineage: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for key in ("strain_stack", "lora_strains", "lora"):
        value = item.get(key)
        if isinstance(value, list):
            records.extend(record for record in value if isinstance(record, dict))
    lineage_records = lineage.get("lora_strains")
    if isinstance(lineage_records, list):
        records.extend(record for record in lineage_records if isinstance(record, dict))
    unique: dict[str, dict[str, Any]] = {}
    for record in records:
        node_id = _strain_node_id(record)
        unique[node_id] = record
    return list(unique.values())


def _metadata_path_keys(*values: Any) -> set[str]:
    return {str(value) for value in values if value not in (None, "")}


@router.get("/genetic/control-graph", response_model=ControlGeneticGraphResponse)
def control_genetic_graph(limit: int = 300) -> ControlGeneticGraphResponse:
    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    metadata_limit = max(1, min(limit, 1000))
    metadata_items = _metadata_items_for_control_graph(metadata_limit)
    wavetable_items = _wavetable_items_for_control_graph(metadata_limit)
    metadata_path_to_sound: dict[str, str] = {}
    audio_path_to_sound: dict[str, str] = {}

    for strain in strain_registry.list_strains():
        strain_data = strain.model_dump(mode="json")
        node_id = _strain_node_id(strain_data)
        nodes[node_id] = {
            "id": node_id,
            "type": "strain",
            "label": strain.name,
            "path": strain.path,
            "tags": strain.tags,
            "enabled": strain.enabled,
        }

    for item in metadata_items:
        lineage = item.get("lineage") if isinstance(item.get("lineage"), dict) else {}
        sound_id = str(item.get("sound_id") or lineage.get("id") or item.get("_metadata_path"))
        nodes[sound_id] = {
            "id": sound_id,
            "type": "sound",
            "label": item.get("prompt") or Path(str(item.get("output_audio_path") or sound_id)).stem,
            "metadata_path": item.get("_metadata_path"),
            "mode": item.get("mode") or item.get("germinator_mode"),
            "created_at": item.get("created_at"),
        }
        for key in _metadata_path_keys(
            item.get("_metadata_path"),
            item.get("metadata_path"),
            item.get("absolute_metadata_path"),
        ):
            metadata_path_to_sound[key] = sound_id
        for key in _metadata_path_keys(
            item.get("output_audio_path"),
            item.get("absolute_output_audio_path"),
            lineage.get("audio_path"),
        ):
            audio_path_to_sound[key] = sound_id

        operation = str(item.get("operation") or lineage.get("operation") or "")
        parents = item.get("parents") if isinstance(item.get("parents"), list) else lineage.get("parents", [])
        for parent in parents or []:
            parent_id = str(parent)
            parent_type = "wavetable" if parent_id.startswith("wt_") else "sound"
            nodes.setdefault(parent_id, {"id": parent_id, "type": parent_type, "label": parent_id})
            edge_type = "parent"
            if parent_type == "wavetable":
                if "render" in operation:
                    edge_type = "wavetable-render"
                elif "mutation" in operation:
                    edge_type = "wavetable-mutation"
                else:
                    edge_type = "wavetable-child"
            edges.append({"from": parent_id, "to": sound_id, "type": edge_type})

        for strain in _strain_records(item, lineage):
            node_id = _strain_node_id(strain)
            nodes.setdefault(
                node_id,
                {
                    "id": node_id,
                    "type": "strain",
                    "label": strain.get("name") or Path(str(strain.get("path") or node_id)).stem,
                    "path": strain.get("path"),
                    "tags": strain.get("tags", []),
                },
            )
            edges.append({"from": node_id, "to": sound_id, "type": "strain-applied"})

        semantic_effects = item.get("semantic_effects")
        if not isinstance(semantic_effects, list):
            semantic_effects = lineage.get("semantic_effects") if isinstance(lineage.get("semantic_effects"), list) else []
        for effect in semantic_effects:
            if not isinstance(effect, dict):
                continue
            fx_type = str(effect.get("fx_type") or effect.get("type") or "")
            if fx_type not in MICRO_MODULE_TYPES:
                continue
            module_id = str(effect.get("module_id") or effect.get("id") or fx_type)
            node_id = f"micro_module:{safe_stem(module_id, fallback=fx_type)}"
            nodes[node_id] = {
                "id": node_id,
                "type": "micro_module",
                "label": fx_type.replace("_", " "),
                "fx_type": fx_type,
                "module_id": module_id,
                "amount": effect.get("amount"),
            }
            edges.append({"from": node_id, "to": sound_id, "type": "micro-shape"})

        control_routes = item.get("control_routes")
        if not isinstance(control_routes, list):
            control_routes = lineage.get("control_routes") if isinstance(lineage.get("control_routes"), list) else []
        for route in control_routes:
            if not isinstance(route, dict):
                continue
            route_id = str(route.get("id") or f"control_route_{len(nodes)}")
            nodes[route_id] = {
                "id": route_id,
                "type": "control_route",
                "label": route.get("target_label") or route.get("target_path") or route_id,
                "source_type": route.get("source_type"),
                "target_path": route.get("target_path"),
            }
            source_id = str(route.get("source_node_id") or route.get("source_port_id") or "control_source")
            nodes.setdefault(
                source_id,
                {
                    "id": source_id,
                    "type": "control_source",
                    "label": route.get("source_label") or route.get("source_type") or source_id,
                },
            )
            edges.append(
                {
                    "from": source_id,
                    "to": route_id,
                    "type": route.get("lineage_role") or "control-parent",
                }
            )
            edges.append({"from": route_id, "to": sound_id, "type": "controlled-result"})

    for table in wavetable_items:
        if table.get("type") != "germ_wavetable":
            continue
        lineage = table.get("lineage") if isinstance(table.get("lineage"), dict) else {}
        operation_params = table.get("operation_params") if isinstance(table.get("operation_params"), dict) else {}
        operation = str(table.get("operation") or lineage.get("operation") or "")
        table_id = str(table.get("id") or lineage.get("id") or table.get("_metadata_path"))
        nodes[table_id] = {
            "id": table_id,
            "type": "wavetable",
            "label": table.get("name") or table_id,
            "metadata_path": table.get("_metadata_path"),
            "data_path": table.get("data_path"),
            "frame_count": table.get("frame_count"),
            "frame_size": table.get("frame_size"),
            "root_note": table.get("root_note"),
            "operation": operation,
            "created_at": table.get("created_at"),
            "table_classification": table.get("table_classification"),
        }
        for key in _metadata_path_keys(table.get("_metadata_path"), table.get("metadata_path")):
            metadata_path_to_sound[key] = table_id

        source_sound = None
        for key in _metadata_path_keys(table.get("source_metadata_path"), operation_params.get("source_metadata_path")):
            source_sound = source_sound or metadata_path_to_sound.get(key)
        for key in _metadata_path_keys(table.get("source_audio_path"), lineage.get("audio_path"), operation_params.get("source_audio_path")):
            source_sound = source_sound or audio_path_to_sound.get(key)
        if source_sound:
            edge_type = "prompt-to-wavetable" if operation == "prompt_to_wavetable" else "audio-to-wavetable"
            edges.append({"from": source_sound, "to": table_id, "type": edge_type})

        prompt_contract = operation_params.get("prompt_contract") if isinstance(operation_params.get("prompt_contract"), dict) else {}
        prompt_text = table.get("source_prompt") or prompt_contract.get("user_prompt")
        if prompt_text and operation == "prompt_to_wavetable":
            prompt_id = f"prompt:{safe_stem(str(prompt_text)[:80], fallback='wavetable_prompt')}"
            nodes.setdefault(
                prompt_id,
                {
                    "id": prompt_id,
                    "type": "prompt",
                    "label": str(prompt_text)[:80],
                },
            )
            edges.append({"from": prompt_id, "to": table_id, "type": "prompt-to-wavetable"})

        parents = table.get("parents") if isinstance(table.get("parents"), list) else lineage.get("parents", [])
        for parent in parents or []:
            parent_id = str(parent)
            parent_type = "wavetable" if parent_id.startswith("wt_") else "sound"
            nodes.setdefault(parent_id, {"id": parent_id, "type": parent_type, "label": parent_id})
            if parent_type == "wavetable":
                edge_type = "wavetable-mutation" if operation == "wavetable_mutation" else "wavetable-child"
            else:
                if source_sound and parent_id == source_sound:
                    continue
                edge_type = "prompt-to-wavetable" if operation == "prompt_to_wavetable" else "audio-to-wavetable"
            edges.append({"from": parent_id, "to": table_id, "type": edge_type})

        children = table.get("children") if isinstance(table.get("children"), list) else lineage.get("children", [])
        for child in children or []:
            child_id = str(child)
            nodes.setdefault(child_id, {"id": child_id, "type": "wavetable", "label": child_id})
            edges.append({"from": table_id, "to": child_id, "type": "wavetable-child"})

        render_audio_id = table.get("render_audio_id") or operation_params.get("render_audio_id")
        if render_audio_id and str(render_audio_id) in nodes:
            edges.append({"from": str(render_audio_id), "to": table_id, "type": "wavetable-mutation-source"})

    for event in control_registry.events():
        event_id = event.id or f"event_{len(nodes)}"
        nodes[event_id] = {
            "id": event_id,
            "type": "control_event",
            "label": event.source,
            "kind": event.kind,
            "timestamp": event.timestamp,
        }
        route_id = event.route_id
        if route_id and route_id in nodes:
            edges.append({"from": route_id, "to": event_id, "type": "emitted-event"})

    micro_profiles = _micro_profile_items_for_control_graph(metadata_limit)
    for profile in micro_profiles:
        profile_id = str(profile.get("id") or profile.get("_profile_file"))
        node_id = f"micro_profile:{safe_stem(profile_id, fallback='profile')}"
        nodes[node_id] = {
            "id": node_id,
            "type": "micro_profile",
            "label": profile.get("module") or "micro profile",
            "profile_file": profile.get("_profile_file"),
            "input_audio_path": profile.get("input_audio_path"),
            "descriptors": profile.get("descriptors", {}),
            "created_at": profile.get("created_at"),
        }
        source_id = str(profile.get("source_id") or "")
        source_sound = None
        if source_id and source_id in nodes:
            source_sound = source_id
        for key in _metadata_path_keys(profile.get("metadata_path")):
            source_sound = source_sound or metadata_path_to_sound.get(key)
        for key in _metadata_path_keys(profile.get("input_audio_path")):
            source_sound = source_sound or audio_path_to_sound.get(key)
        if source_sound:
            edges.append({"from": source_sound, "to": node_id, "type": "micro-profiled"})

    return ControlGeneticGraphResponse(
        nodes=list(nodes.values()),
        edges=edges,
        source={
            "metadata_count": len(metadata_items),
            "node_count": len(nodes),
            "event_count": len(control_registry.events()),
            "strain_count": sum(1 for node in nodes.values() if node.get("type") == "strain"),
            "micro_profile_count": len(micro_profiles),
            "wavetable_count": len(wavetable_items),
            "limit": limit,
        },
    )


def _resolve_output_wav(path: str) -> Path:
    try:
        target = storage.resolve_existing_path(path, label="audio")
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        target.relative_to(settings.output_root.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Only germ output audio can be analyzed.") from exc
    if target.suffix.lower() != ".wav":
        raise HTTPException(status_code=422, detail="Control analysis currently requires WAV source files.")
    return target


def _read_pcm16_wav(path: Path) -> tuple[array.array, int, int, int]:
    try:
        file_size = path.stat().st_size
    except OSError as exc:
        raise HTTPException(status_code=422, detail=f"Cannot inspect WAV file: {exc}") from exc
    if file_size > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="WAV file exceeds the configured size limit")
    try:
        with wave.open(str(path), "rb") as wav:
            if wav.getcomptype() != "NONE":
                raise HTTPException(status_code=422, detail="Compressed WAV files are not supported.")
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            frame_count = wav.getnframes()
            raw = wav.readframes(frame_count)
    except (EOFError, wave.Error) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid WAV file: {exc}") from exc
    if sample_width != 2:
        raise HTTPException(status_code=422, detail="Control analysis requires 16-bit PCM WAV audio.")
    if channels not in {1, 2}:
        raise HTTPException(status_code=422, detail="Control analysis supports mono or stereo WAV audio.")
    if sample_rate <= 0 or frame_count <= 0:
        raise HTTPException(status_code=422, detail="Control analysis requires non-empty WAV audio.")
    if frame_count > sample_rate * 380:
        raise HTTPException(status_code=422, detail="Control analysis supports at most 380 seconds.")
    expected_bytes = frame_count * channels * sample_width
    if len(raw) != expected_bytes:
        raise HTTPException(status_code=422, detail="WAV sample data is truncated.")
    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples, channels, sample_rate, frame_count


def _frame_value(samples: array.array, channels: int, frame: int) -> float:
    index = frame * channels
    if channels == 1:
        return samples[index] / 32768.0
    return ((samples[index] + samples[index + 1]) * 0.5) / 32768.0


def _smooth_values(values: list[float], smooth: float) -> list[float]:
    if not values or smooth <= 0:
        return values
    alpha = max(0.001, min(1.0, 1.0 - smooth))
    current = values[0]
    output = []
    for value in values:
        current = current + (value - current) * alpha
        output.append(current)
    return output


def _normalize_values(values: list[float]) -> list[float]:
    peak = max((abs(value) for value in values), default=0.0)
    if peak <= 0:
        return values
    return [max(0.0, min(1.0, value / peak)) for value in values]


def _estimated_pitch_hz(samples: array.array, channels: int, start: int, end: int, sample_rate: int) -> float:
    previous = _frame_value(samples, channels, start)
    crossings = 0
    for frame in range(start + 1, end):
        value = _frame_value(samples, channels, frame)
        if (previous <= 0 < value) or (previous >= 0 > value):
            crossings += 1
        previous = value
    duration = max(1e-9, (end - start) / sample_rate)
    frequency = crossings / (2.0 * duration)
    if frequency < 20.0 or frequency > 5000.0:
        return 0.0
    return frequency


def _chroma_unit(frequency: float) -> float:
    if frequency <= 0:
        return 0.0
    midi = round(69 + 12 * math.log2(frequency / 440.0))
    return (midi % 12) / 11.0


def _decimate_points(
    points: list[dict[str, float]],
    max_points: int = MAX_CONTROL_POINTS_PER_FEATURE,
) -> list[dict[str, float]]:
    if len(points) <= max_points:
        return points
    stride = math.ceil(len(points) / max_points)
    return points[::stride]


def _feature_summary(
    feature: ControlAnalysisFeature,
    points: list[dict[str, float]],
) -> ControlFeatureSummary:
    values = [point["value"] for point in points]
    if not values:
        return ControlFeatureSummary(feature=feature, point_count=0, min=0, max=0, mean=0)
    max_value = max(values)
    peak_index = values.index(max_value)
    event_count = 0
    if feature == "transient":
        event_count = sum(1 for value in values if value >= 0.5)
    return ControlFeatureSummary(
        feature=feature,
        point_count=len(points),
        min=min(values),
        max=max_value,
        mean=sum(values) / len(values),
        peak_time_sec=points[peak_index]["t"],
        event_count=event_count,
    )


def _analyze_features(
    *,
    samples: array.array,
    channels: int,
    sample_rate: int,
    frame_count: int,
    request: ControlAudioAnalysisRequest,
    max_points: int = MAX_CONTROL_POINTS_PER_FEATURE,
) -> tuple[dict[str, list[dict[str, float]]], list[ControlFeatureSummary]]:
    window_frames = max(1, round((request.window_ms / 1000.0) * sample_rate))
    hop_frames = max(1, round((request.hop_ms / 1000.0) * sample_rate))
    max_points = max(1, min(max_points, MAX_CONTROL_POINTS_PER_FEATURE))
    hop_frames = max(hop_frames, math.ceil(frame_count / max_points))
    raw_values: dict[str, list[float]] = {feature: [] for feature in request.features}
    transient_values: list[float] = []
    times: list[float] = []
    previous_rms = 0.0
    frame = 0
    while frame < frame_count:
        end = min(frame_count, frame + window_frames)
        count = max(1, end - frame)
        peak = 0.0
        total = 0.0
        square_total = 0.0
        diff_total = 0.0
        previous_value = _frame_value(samples, channels, frame)
        for item_frame in range(frame, end):
            value = _frame_value(samples, channels, item_frame)
            absolute = abs(value)
            peak = max(peak, absolute)
            total += absolute
            square_total += value * value
            diff_total += abs(value - previous_value)
            previous_value = value
        rms = math.sqrt(square_total / count)
        envelope = peak
        transient = max(0.0, rms - previous_rms)
        previous_rms = rms
        spectral_proxy = min(1.0, diff_total / max(total, 1e-9))
        pitch_hz = (
            _estimated_pitch_hz(samples, channels, frame, end, sample_rate)
            if "pitch" in request.features or "chroma" in request.features
            else 0.0
        )
        feature_values = {
            "envelope": envelope,
            "rms": rms,
            "transient": transient,
            "spectral_centroid": spectral_proxy,
            "pitch": min(1.0, pitch_hz / 2000.0),
            "chroma": _chroma_unit(pitch_hz),
            "onset_density": 0.0,
            "tempo": 0.0,
            "timbre": min(1.0, (spectral_proxy * 0.7) + (rms * 0.3)),
        }
        times.append(frame / sample_rate)
        transient_values.append(transient)
        for feature in request.features:
            raw_values[feature].append(feature_values[feature])
        frame += hop_frames

    if "onset_density" in request.features or "tempo" in request.features:
        transient_peak = max(transient_values, default=0.0)
        threshold = transient_peak * 0.45 if transient_peak > 0 else 1.0
        onset_flags = [1 if value >= threshold and value > 0 else 0 for value in transient_values]
        if "onset_density" in request.features:
            radius = 4
            density_values = []
            for index in range(len(onset_flags)):
                start = max(0, index - radius)
                end = min(len(onset_flags), index + radius + 1)
                density_values.append(sum(onset_flags[start:end]) / max(1, end - start))
            raw_values["onset_density"] = density_values
        if "tempo" in request.features:
            onset_times = [times[index] for index, flag in enumerate(onset_flags) if flag]
            intervals = [
                right - left
                for left, right in pairwise(onset_times)
                if 0.05 <= right - left <= 4.0
            ]
            if intervals:
                mean_interval = sum(intervals) / len(intervals)
                bpm = max(20.0, min(300.0, 60.0 / mean_interval))
                tempo_unit = bpm / 300.0
            else:
                tempo_unit = 0.0
            raw_values["tempo"] = [tempo_unit for _ in times]

    feature_points: dict[str, list[dict[str, float]]] = {}
    summaries: list[ControlFeatureSummary] = []
    for feature in request.features:
        values = _smooth_values(raw_values[feature], request.smooth)
        if request.normalize:
            values = _normalize_values(values)
        points = [
            {"t": round(times[index], 6), "value": round(max(0.0, min(1.0, value)), 6)}
            for index, value in enumerate(values)
        ]
        points = _decimate_points(points, max_points)
        feature_points[feature] = points
        summaries.append(_feature_summary(feature, points))
    return feature_points, summaries


def _route_suggestions(features: list[ControlFeatureSummary]) -> list[dict[str, Any]]:
    suggestions: list[dict[str, Any]] = []
    for summary in features:
        if summary.feature == "transient":
            suggestions.append(
                {
                    "source_port_id": "mod:audio_to_control",
                    "target_port_id": "time:event_probability",
                    "label": "Transients -> event probability",
                    "feature": summary.feature,
                    "target_kind": "control",
                }
            )
        elif summary.feature == "spectral_centroid":
            suggestions.append(
                {
                    "source_port_id": "mod:audio_to_control",
                    "target_port_id": "generation:brightness_language",
                    "label": "Brightness -> generation language",
                    "feature": summary.feature,
                    "target_kind": "control",
                }
            )
        elif summary.feature in {"pitch", "chroma", "tempo", "onset_density"}:
            suggestions.append(
                {
                    "source_port_id": "mod:audio_to_control",
                    "target_port_id": "time:event_velocity",
                    "label": f"{summary.feature.replace('_', ' ').title()} -> time velocity",
                    "feature": summary.feature,
                    "target_kind": "control",
                }
            )
        elif summary.feature == "timbre":
            suggestions.append(
                {
                    "source_port_id": "mod:audio_to_control",
                    "target_port_id": "generation:batch_spread",
                    "label": "Timbre -> batch spread",
                    "feature": summary.feature,
                    "target_kind": "control",
                }
            )
        else:
            suggestions.append(
                {
                    "source_port_id": "mod:audio_to_control",
                    "target_port_id": "generation:seed_drift",
                    "label": f"{summary.feature.replace('_', ' ').title()} -> seed drift",
                    "feature": summary.feature,
                    "target_kind": "control",
                }
            )
    return suggestions


@router.post("/analyze-audio", response_model=ControlAnalysisResult)
def analyze_audio(request: ControlAudioAnalysisRequest) -> ControlAnalysisResult:
    source_path = _resolve_output_wav(request.input_audio_path)
    samples, channels, sample_rate, frame_count = _read_pcm16_wav(source_path)
    duration = frame_count / float(sample_rate)
    features, summaries = _analyze_features(
        samples=samples,
        channels=channels,
        sample_rate=sample_rate,
        frame_count=frame_count,
        request=request,
    )
    analysis_id = f"control_{uuid4().hex[:12]}"
    base = safe_stem(request.output_name, fallback=f"{source_path.stem}_control")
    control_path = control_registry.control_dir / f"{base}_{analysis_id}.json"
    suggestions = _route_suggestions(summaries)
    parent_paths = [request.metadata_path] if request.metadata_path else []
    artifact = {
        "app": PRODUCT_NAME,
        "product": PRODUCT_NAME,
        "legacy_app": LEGACY_ENGINE_NAME,
        "concept": SOUND_MATTER_CONCEPT,
        "type": "control_analysis",
        "id": analysis_id,
        "created_at": utc_now_iso(),
        "input_audio_path": storage.relative_path(source_path),
        "metadata_path": request.metadata_path,
        "source_id": request.source_id,
        "sample_rate": sample_rate,
        "duration": duration,
        "window_ms": request.window_ms,
        "hop_ms": request.hop_ms,
        "smooth": request.smooth,
        "normalize": request.normalize,
        "features": features,
        "summaries": [summary.model_dump(mode="json") for summary in summaries],
        "route_suggestions": suggestions,
        "lineage": {
            **request.lineage,
            "id": analysis_id,
            "parents": request.lineage.get("parents", []),
            "parent_metadata_paths": parent_paths,
            "operation": "control_analysis",
            "source_type": "control",
            "operation_params": {
                "features": request.features,
                "input_audio_path": storage.relative_path(source_path),
                "window_ms": request.window_ms,
                "hop_ms": request.hop_ms,
                "control_sources": [
                    {
                        "role": "audio-parent",
                        "path": storage.relative_path(source_path),
                        "metadata_path": request.metadata_path,
                    }
                ],
            },
        },
    }
    storage.write_json_atomic(control_path, artifact)
    control_registry.add_event(
        ControlEvent(
            kind="control",
            source="audio_analysis",
            value={"analysis_id": analysis_id, "features": request.features},
            metadata={"control_file": storage.relative_path(control_path)},
        )
    )
    return ControlAnalysisResult(
        id=analysis_id,
        status="done",
        input_audio_path=storage.relative_path(source_path),
        control_files=[storage.relative_path(control_path)],
        metadata_file=storage.relative_path(control_path),
        sample_rate=sample_rate,
        duration=duration,
        features=summaries,
        route_suggestions=suggestions,
    )


def _load_control_points(request: ControlCVRenderRequest) -> list[dict[str, float]]:
    if request.points:
        return [point.model_dump() for point in sorted(request.points, key=lambda item: item.t)]
    if not request.input_control_path:
        return []
    try:
        artifact_path = control_registry.resolve_control_artifact(request.input_control_path)
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    except (
        FileNotFoundError,
        PermissionError,
        UnicodeError,
        json.JSONDecodeError,
        OSError,
        RecursionError,
    ) as exc:
        raise HTTPException(status_code=422, detail=f"invalid control artifact: {exc}") from exc
    if not isinstance(artifact, dict):
        raise HTTPException(status_code=422, detail="control artifact must be a JSON object")
    features = artifact.get("features") if isinstance(artifact.get("features"), dict) else {}
    if not features:
        raise HTTPException(status_code=422, detail="control artifact has no features")
    feature = request.feature or next(iter(features))
    points = features.get(feature)
    if not isinstance(points, list) or not points:
        raise HTTPException(status_code=422, detail=f"control feature not found: {feature}")
    parsed: dict[float, float] = {}
    for point in points:
        if not isinstance(point, dict):
            continue
        try:
            t = float(point.get("t", 0.0))
            value = float(point.get("value", 0.0))
        except (TypeError, ValueError, OverflowError) as exc:
            raise HTTPException(status_code=422, detail="control points must be numeric") from exc
        if not math.isfinite(t) or not math.isfinite(value):
            raise HTTPException(status_code=422, detail="control points must be finite")
        parsed[max(0.0, t)] = max(-1.0, min(1.0, value))
        if len(parsed) > MAX_CONTROL_POINTS_PER_FEATURE:
            raise HTTPException(
                status_code=422,
                detail=f"control artifact exceeds {MAX_CONTROL_POINTS_PER_FEATURE} points",
            )
    return [{"t": t, "value": value} for t, value in sorted(parsed.items())]


def _cv_signal_value(request: ControlCVRenderRequest, value: float) -> float:
    if request.mode in {"gate", "clock"}:
        value = request.gate_value if value >= 0.5 else 0.0
    elif request.range == "unipolar":
        value = max(0.0, min(1.0, value))
    else:
        value = max(-1.0, min(1.0, (value * 2.0) - 1.0))
    value = (value * request.scale) + request.offset
    return max(request.clamp_min, min(request.clamp_max, value))


def _render_cv_bytes(request: ControlCVRenderRequest, points: list[dict[str, float]]) -> bytes:
    frame_count = max(1, round(request.duration * request.sample_rate))
    out = array.array("h")
    last_value = 0.0
    max_delta = None
    if request.slew_ms > 0:
        max_delta = 1.0 / max(1.0, (request.slew_ms / 1000.0) * request.sample_rate)
    point_index = 0
    for frame in range(frame_count):
        t = frame / request.sample_rate
        while point_index + 1 < len(points) and t > points[point_index + 1]["t"]:
            point_index += 1
        if t <= points[0]["t"]:
            interpolated = points[0]["value"]
        elif point_index + 1 < len(points):
            left = points[point_index]
            right = points[point_index + 1]
            span = max(1e-9, right["t"] - left["t"])
            unit = (t - left["t"]) / span
            interpolated = left["value"] + (right["value"] - left["value"]) * unit
        else:
            interpolated = points[-1]["value"]
        value = _cv_signal_value(request, interpolated)
        if max_delta is not None:
            delta = max(-max_delta, min(max_delta, value - last_value))
            value = last_value + delta
        last_value = value
        out.append(max(-32768, min(32767, int(round(value * 32767.0)))))
    if sys.byteorder != "little":
        out.byteswap()
    return out.tobytes()


@router.post("/render-cv", response_model=ControlCVRenderResult)
def render_cv(request: ControlCVRenderRequest) -> ControlCVRenderResult:
    points = _load_control_points(request)
    if not points:
        raise HTTPException(status_code=422, detail="no control points available for CV render")
    render_id = f"cv_{uuid4().hex[:12]}"
    base = safe_stem(request.output_name, fallback="cv_control_render")
    audio_path = control_registry.control_dir / f"{base}_{render_id}.wav"
    metadata_path = control_registry.control_dir / f"{base}_{render_id}.json"
    rendered = _render_cv_bytes(request, points)
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(audio_path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(request.sample_rate)
        wav.writeframes(rendered)
    metadata = {
        "app": PRODUCT_NAME,
        "product": PRODUCT_NAME,
        "legacy_app": LEGACY_ENGINE_NAME,
        "concept": SOUND_MATTER_CONCEPT,
        "type": "cv_safe_render",
        "id": render_id,
        "created_at": utc_now_iso(),
        "audio_path": storage.relative_path(audio_path),
        "duration": request.duration,
        "sample_rate": request.sample_rate,
        "mode": request.mode,
        "range": request.range,
        "scale": request.scale,
        "offset": request.offset,
        "clamp_min": request.clamp_min,
        "clamp_max": request.clamp_max,
        "slew_ms": request.slew_ms,
        "cv_safe": True,
        "hardware_output": False,
        "speaker_protection": "artifact_only_not_routed_to_audio_outputs",
        "source_control_path": request.input_control_path,
        "feature": request.feature,
        "lineage": {
            **request.lineage,
            "id": render_id,
            "operation": "cv_safe_render",
            "source_type": "control",
            "operation_params": {
                "mode": request.mode,
                "range": request.range,
                "input_control_path": request.input_control_path,
                "feature": request.feature,
                "hardware_output": False,
            },
        },
    }
    storage.write_json_atomic(metadata_path, metadata)
    control_registry.add_event(
        ControlEvent(
            kind="cv",
            source="cv_safe_render",
            value={"render_id": render_id, "mode": request.mode, "hardware_output": False},
            metadata={"audio_file": storage.relative_path(audio_path)},
        )
    )
    return ControlCVRenderResult(
        status="done",
        audio_file=storage.relative_path(audio_path),
        metadata_file=storage.relative_path(metadata_path),
        duration=request.duration,
        sample_rate=request.sample_rate,
        mode=request.mode,
        cv_safe=True,
        hardware_output=False,
    )
