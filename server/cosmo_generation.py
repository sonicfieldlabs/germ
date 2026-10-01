"""Explicit Cosmo signal intermodulation before the existing generation runner."""

from copy import deepcopy
from hashlib import sha256
import json
import math

from server.cosmo_freshness import frame_signal_freshness
from server.schemas import GenerateRequest, validate_json_compatible

BOUNDS = {"duration": (0.1, 30), "steps": (1, 250), "cfg_scale": (0, 25)}


def apply_frame(request, frame, selection, *, now=None):
    validate_json_compatible(frame)
    if (
        len(json.dumps(frame)) > 1024 * 1024
        or frame.get("contract") != "cosmo/generation-frame/v1"
        or frame.get("relation") != {"of": "signal"}
        or frame.get("sourceRegister") != "non-acoustic"
    ):
        raise ValueError("Expected a bounded Cosmo non-acoustic generation frame")
    if not isinstance(selection, dict) or set(selection) != {
        "mapping_ids",
        "intermodulation",
        "accept_held",
        "accept_uncertainty",
    }:
        raise ValueError(
            "Choose mapping IDs, intermodulation and explicit held/uncertainty handling"
        )
    if (
        selection["intermodulation"] not in {"replace", "add", "multiply"}
        or type(selection["accept_held"]) is not bool
        or type(selection["accept_uncertainty"]) is not bool
    ):
        raise ValueError("Invalid intermodulation policy")
    ids = selection["mapping_ids"]
    if not isinstance(ids, list) or not 1 <= len(ids) <= 3 or len(set(ids)) != len(ids):
        raise ValueError("Choose 1–3 distinct assignments")
    receipts = frame.get("receipts", [])
    selected = [r for r in receipts if r.get("mappingId") in ids]
    if len(selected) != len(ids) or len({r.get("target") for r in selected}) != len(ids):
        raise ValueError("Assignments are missing, ambiguous or repeat a target")
    values, decisions = {}, []
    for receipt in selected:
        r = deepcopy(receipt)
        target, status = r.get("target"), r.get("status")
        if target not in BOUNDS or status not in {
            "applied",
            "held",
            "uncertainty",
            "skipped",
            "refused",
        }:
            raise ValueError("Unsupported target or mapping status")
        r["consumer_outcome"] = "not_applied"
        accepted = (
            status == "applied"
            or status == "held"
            and selection["accept_held"]
            or status == "uncertainty"
            and selection["accept_uncertainty"]
        )
        r["consumer_freshness"] = frame_signal_freshness(frame, r.get("signalId"), now=now, receipt=r)
        if accepted and not r["consumer_freshness"]["mappingAllowed"]:
            raise ValueError("Selected assignment is not current: " + r["consumer_freshness"]["reason"])
        if accepted:
            value = r.get("outputValue")
            if (
                type(value) not in (int, float)
                or not math.isfinite(value)
                or not BOUNDS[target][0] <= value <= BOUNDS[target][1]
                or not r.get("receiptId")
            ):
                raise ValueError("Mapping lacks bounded value or receipt")
            base = getattr(request, target)
            value = (
                value
                if selection["intermodulation"] == "replace"
                else base + value
                if selection["intermodulation"] == "add"
                else base * value
            )
            if (
                not BOUNDS[target][0] <= value <= BOUNDS[target][1]
                or target == "steps"
                and int(value) != value
            ):
                raise ValueError("Intermodulation exceeds the target policy")
            values[target] = value
            r.update(consumer_outcome="parameter_selected", result=value)
        decisions.append(r)
    if not values:
        raise ValueError("No selected assignment can change generation parameters")
    payload = request.model_dump()
    payload.update(values)
    payload["source"]["cosmoaudition"] = {
        "contract": "germ/cosmo-generation/v1",
        "frame": deepcopy(frame),
        "frame_sha256": sha256(
            json.dumps(frame, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        ).hexdigest(),
        "selection": deepcopy(selection),
        "decisions": decisions,
        "relation": {"of": "signal"},
        "perceptual_access": "not_established",
    }
    return GenerateRequest(**payload)
