"""Permission and exact-input admission for memory-conditioned generation."""

import hashlib
import json
import os
import re

import httpx
from fastapi import HTTPException
from akousma.retained_policy import retained_covenant, blocks_untyped_prose


def digest(record):
    return hashlib.sha256(json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def admitted_record(store, record):
    identifier = record["akousma_id"]
    forgotten = getattr(store, "forgotten", lambda _: None)(identifier)
    covenant = retained_covenant(record)
    if forgotten or blocks_untyped_prose(covenant) or any(covenant.get(key) for key in ("withheld", "rules_applied", "commitments")):
        raise HTTPException(423, "Selected memory is withheld or forgotten")
    # In a managed workspace Oída owns the current (not only archived) policy.
    # Standalone GERM uses the canonical store and cumulative covenant above.
    if os.getenv("LISTENINGSTACK_WORKSPACE_ID"):
        from server.listener import _oida_workspace_headers
        from server.registry import settings
        try:
            with httpx.Client(timeout=10, trust_env=False, follow_redirects=False) as client:
                response = client.get(f"{settings.oida_url}/reasoning/workspace/routing/archive/{identifier}", headers=_oida_workspace_headers())
            response.raise_for_status()
            current = response.json()
            if current.get("view", {}).get("state") != "available" or digest(current.get("record")) != digest(record):
                raise HTTPException(423, "Memory policy or content changed")
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(503, "Current memory permission is unavailable") from exc
    return record


def validate_conditioning(request):
    validate_context(getattr(request, "generation_context", None) or {})


def validate_context(context):
    if not isinstance(context, dict):
        raise HTTPException(422, "Invalid memory conditioning context")
    influences = context.get("memory_influences") or []
    if not influences:
        return
    if not isinstance(influences, list) or len(influences) > 1000:
        raise HTTPException(422, "Invalid memory conditioning manifest")
    from server.akousma_store import open_store
    store = open_store()
    try:
        for item in influences:
            if not isinstance(item, dict) or not re.fullmatch(r"[A-Za-z0-9_:-]{1,100}", str(item.get("record_id", ""))) or not re.fullmatch(r"[a-f0-9]{64}", str(item.get("sha256", ""))):
                raise HTTPException(422, "Invalid memory conditioning dependency")
            record = store.get(item["record_id"])
            if not record or digest(admitted_record(store, record)) != item.get("sha256"):
                raise HTTPException(423, "Memory changed or was forgotten before generation admission")
    finally:
        store.close()
