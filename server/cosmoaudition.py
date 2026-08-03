from __future__ import annotations

import json
import logging
import math
from ipaddress import ip_address
from typing import Any
from urllib.parse import urlsplit

import httpx

from server.schemas import (
    CosmoauditionMapRequest,
    CosmoauditionMapping,
    CosmoauditionSignal,
    validate_json_compatible,
)
from server.storage import utc_now_iso


COSMOAUDITION_GERM_CONTRACT = "cosmoaudition-germ/v0.1"
COSMOAUDITION_REMOTE_PATHS = frozenset({"/health", "/api/sources", "/api/snapshot"})
LOGGER = logging.getLogger(__name__)


class CosmoauditionBridgeError(RuntimeError):
    """A bounded local bridge request could not be completed safely."""


def _reject_nonfinite_json(value: str) -> None:
    raise ValueError(f"non-finite JSON constant: {value}")


def _decode_json_object(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(raw, parse_constant=_reject_nonfinite_json)
    except (UnicodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
        raise CosmoauditionBridgeError("Cosmoaudition returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise CosmoauditionBridgeError("Cosmoaudition response must be a JSON object")
    try:
        validate_json_compatible(value, label="Cosmoaudition response")
    except (ValueError, RecursionError) as exc:
        raise CosmoauditionBridgeError("Cosmoaudition returned invalid JSON") from exc
    return value


def validate_loopback_base_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "http":
        raise ValueError("Cosmoaudition bridge URL must use http on loopback")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Cosmoaudition bridge URL cannot contain credentials, query, or fragment")
    if parsed.path not in {"", "/"}:
        raise ValueError("Cosmoaudition bridge URL must not include an API path")
    hostname = (parsed.hostname or "").lower()
    is_loopback = hostname == "localhost"
    if not is_loopback:
        try:
            is_loopback = ip_address(hostname).is_loopback
        except ValueError:
            is_loopback = False
    if not is_loopback:
        raise ValueError("Cosmoaudition bridge URL must resolve from an explicit loopback host")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Cosmoaudition bridge URL has an invalid port") from exc
    netloc = f"[{hostname}]" if ":" in hostname else hostname
    if port is not None:
        netloc = f"{netloc}:{port}"
    return f"http://{netloc}"


class CosmoauditionBridge:
    def __init__(
        self,
        *,
        base_url: str,
        timeout_seconds: float,
        max_response_bytes: int,
    ) -> None:
        self.base_url = validate_loopback_base_url(base_url)
        self.timeout_seconds = timeout_seconds
        self.max_response_bytes = max_response_bytes

    def get_json(self, path: str, *, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if path not in COSMOAUDITION_REMOTE_PATHS:
            raise CosmoauditionBridgeError(f"Cosmoaudition route is not allowlisted: {path}")
        url = f"{self.base_url}{path}"
        try:
            with httpx.Client(
                timeout=self.timeout_seconds,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                with client.stream(
                    "GET",
                    url,
                    params=params or {},
                    headers={"Accept": "application/json"},
                ) as response:
                    if 300 <= response.status_code < 400:
                        raise CosmoauditionBridgeError("Cosmoaudition redirects are refused")
                    response.raise_for_status()
                    declared = response.headers.get("content-length")
                    if declared:
                        try:
                            if int(declared) > self.max_response_bytes:
                                raise CosmoauditionBridgeError(
                                    "Cosmoaudition response exceeds the configured boundary"
                                )
                        except ValueError:
                            pass
                    chunks: list[bytes] = []
                    total = 0
                    for chunk in response.iter_bytes():
                        total += len(chunk)
                        if total > self.max_response_bytes:
                            raise CosmoauditionBridgeError(
                                "Cosmoaudition response exceeds the configured boundary"
                            )
                        chunks.append(chunk)
        except CosmoauditionBridgeError:
            raise
        except (httpx.HTTPError, OSError) as exc:
            raise CosmoauditionBridgeError(str(exc)[:2_000]) from exc
        return _decode_json_object(b"".join(chunks))

    def status(self) -> dict[str, Any]:
        try:
            remote = self.get_json("/health")
        except (CosmoauditionBridgeError, ValueError) as exc:
            LOGGER.warning("Cosmoaudition health check unavailable: %s", exc)
            return {
                "available": False,
                "contract": COSMOAUDITION_GERM_CONTRACT,
                "baseUrl": self.base_url,
                "error": "Cosmoaudition bridge unavailable",
            }
        return {
            "available": remote.get("ok", True) is True,
            "contract": COSMOAUDITION_GERM_CONTRACT,
            "baseUrl": self.base_url,
            "remote": remote,
        }


def cosmoaudition_modules_manifest() -> list[dict[str, Any]]:
    return [
        {
            "id": "cosmo_observation",
            "label": "Observatory Source",
            "kind": "observation",
            "sphere": None,
        },
        {"id": "cosmo_cosmic_field", "label": "Cosmic Field", "kind": "observation", "sphere": "cosmos"},
        {
            "id": "cosmo_earth_field",
            "label": "Earth Field",
            "kind": "observation",
            "spheres": ["atmosphere", "geosphere"],
        },
        {"id": "cosmo_biosphere_field", "label": "Biosphere Field", "kind": "observation", "sphere": "biosphere"},
        {
            "id": "cosmo_human_machine_field",
            "label": "Human–Machine Field",
            "kind": "observation",
            "spheres": ["human", "machine"],
        },
        {"id": "cosmo_relational_index", "label": "Relational Index", "kind": "operator"},
        {"id": "cosmo_event_pulsar", "label": "Event Pulsar", "kind": "operator"},
        {"id": "cosmo_mapping_loom", "label": "Mapping Loom", "kind": "operator"},
        {"id": "cosmo_semantic_field", "label": "Semantic Field", "kind": "operator"},
        {"id": "cosmo_uncertainty_field", "label": "Uncertainty Field", "kind": "operator"},
        {"id": "cosmo_matter_modulator", "label": "Matter Modulator", "kind": "processor"},
        {"id": "matter_analysis", "label": "Matter Analysis", "kind": "analyzer"},
        {"id": "cosmo_observation_archive", "label": "Observation Archive", "kind": "archive"},
    ]


def _base_decision(
    mapping: CosmoauditionMapping,
    signal: CosmoauditionSignal | None,
    previous_output: float | None,
) -> dict[str, Any]:
    return {
        "contract": COSMOAUDITION_GERM_CONTRACT,
        "mappingId": mapping.id,
        "signalId": mapping.signalId,
        "layer": mapping.layer,
        "target": mapping.target,
        "inputValue": signal.value if signal else None,
        "previousOutput": previous_output,
        "sourceId": signal.sourceId if signal else None,
        "sphere": signal.sphere if signal else None,
        "confidence": signal.confidence if signal else None,
        "epistemicStatus": signal.epistemicStatus if signal else None,
        "temporalCharacter": signal.temporalCharacter if signal else None,
        "signalKind": signal.signalKind if signal else None,
        "eventKey": signal.eventKey if signal else None,
        "observedAt": signal.timestamp if signal else None,
        "smoothingMs": mapping.smoothingMs,
        "epistemicNote": mapping.epistemicNote,
        "createdAt": utc_now_iso(),
    }


def _without_output(
    mapping: CosmoauditionMapping,
    signal: CosmoauditionSignal | None,
    previous_output: float | None,
    *,
    status: str,
    reason: str,
) -> dict[str, Any]:
    return {
        **_base_decision(mapping, signal, previous_output),
        "status": status,
        "reason": reason,
        "normalizedInput": None,
        "outputValue": None,
    }


def _output_is_valid(value: float, output_range: tuple[float, float]) -> bool:
    lower, upper = sorted(output_range)
    return math.isfinite(value) and lower <= value <= upper


def _missing_decision(
    request: CosmoauditionMapRequest,
    *,
    reason: str,
) -> dict[str, Any]:
    mapping = request.mapping
    signal = request.signal
    previous = request.previousOutput
    policy = request.missingData or mapping.missingData
    if policy == "refuse":
        return _without_output(
            mapping, signal, previous, status="refused", reason="policy-refusal"
        )
    if policy == "interpolate-explicitly":
        return _without_output(
            mapping,
            signal,
            previous,
            status="refused",
            reason="interpolation-history-unavailable",
        )
    if policy == "hold-explicitly" and previous is not None:
        if _output_is_valid(previous, mapping.outputRange):
            return {
                **_base_decision(mapping, signal, previous),
                "status": "held",
                "reason": reason,
                "normalizedInput": None,
                "outputValue": previous,
            }
        return _without_output(
            mapping,
            signal,
            previous,
            status="refused",
            reason="invalid-previous-output",
        )
    # Skip and map-uncertainty do not invent a zero. Mapping uncertainty
    # requires an explicitly supplied uncertainty signal in a later route.
    return _without_output(mapping, signal, previous, status="skipped", reason=reason)


def execute_cosmoaudition_mapping(request: CosmoauditionMapRequest) -> dict[str, Any]:
    mapping = request.mapping
    signal = request.signal
    previous = request.previousOutput
    if not request.enabled:
        return _without_output(
            mapping, signal, previous, status="skipped", reason="route-disabled"
        )
    if signal is None:
        return _missing_decision(request, reason="missing-signal")
    if signal.id != mapping.signalId:
        return _without_output(
            mapping, signal, previous, status="refused", reason="invalid-input"
        )
    if signal.confidence == "error":
        return _missing_decision(request, reason="source-error")
    if signal.value is None:
        return _missing_decision(request, reason="missing-value")
    if not math.isfinite(signal.value):
        return _without_output(
            mapping, signal, previous, status="refused", reason="invalid-input"
        )

    raw_normalized: float
    output_value: float
    if mapping.scale == "categorical":
        match_index = next(
            (index for index, item in enumerate(mapping.categories) if item.value == signal.value),
            None,
        )
        if match_index is None:
            return _without_output(
                mapping, signal, previous, status="refused", reason="invalid-input"
            )
        category = mapping.categories[match_index]
        raw_normalized = 1.0 if len(mapping.categories) == 1 else match_index / (len(mapping.categories) - 1)
        normalized = raw_normalized * request.amount
        output_value = mapping.outputRange[0] + (
            category.output - mapping.outputRange[0]
        ) * request.amount
    else:
        assert mapping.inputRange is not None
        start, end = mapping.inputRange
        if mapping.scale == "log":
            raw_normalized = (
                math.log(signal.value / start) / math.log(end / start)
                if signal.value > 0
                else math.nan
            )
            if math.isfinite(raw_normalized):
                raw_normalized = max(0.0, min(1.0, raw_normalized))
        else:
            raw_normalized = (signal.value - start) / (end - start)
            raw_normalized = max(0.0, min(1.0, raw_normalized))
            if mapping.scale == "exp":
                raw_normalized = math.expm1(raw_normalized) / math.expm1(1.0)
        if not math.isfinite(raw_normalized):
            return _without_output(
                mapping, signal, previous, status="refused", reason="invalid-input"
            )
        normalized = raw_normalized * request.amount
        output_value = mapping.outputRange[0] + (
            mapping.outputRange[1] - mapping.outputRange[0]
        ) * normalized
        if mapping.scale == "quantized":
            output_value = float(round(output_value))

    if not _output_is_valid(output_value, mapping.outputRange):
        return _without_output(
            mapping, signal, previous, status="refused", reason="invalid-mapping"
        )
    uncertain = signal.confidence in {"low", "stale"}
    reason = "low-confidence" if signal.confidence == "low" else (
        "stale-input" if signal.confidence == "stale" else "mapped"
    )
    return {
        **_base_decision(mapping, signal, previous),
        "status": "uncertainty" if uncertain else "applied",
        "reason": reason,
        "rawNormalizedInput": raw_normalized,
        "normalizedInput": normalized,
        "mappingAmount": request.amount,
        "outputValue": output_value,
    }
