"""Owner-side A13/E16 decisions over retained output bytes and later accounts.

Only the host resolves evidence. Decisions are additive and never execute a
follow-up job, delete an asset, or assert that a result improved.
"""

from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import json
from threading import Lock

from akousma import validation_errors
from akousma.record_evolution import next_record_reference_errors
from akouo_contract.record_workflows import generation_decision
from akouo_contract.validation import contract_errors
from server.akousma_store import open_store, resolve_audio_path
from server.registry import storage
from server.schemas import validate_json_compatible

_LOCK = Lock()
POLICY = {"id": "germ:subsequent-listening", "revision": "1"}


def _hash(path):
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read(path):
    if path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Evidence document exceeds 2 MiB")
    value = json.loads(path.read_text())
    validate_json_compatible(value)
    return value


def resolve_evidence(store, workflow, metadata_file):
    """Resolve current local files; client output_evidence is never accepted."""
    path = storage.resolve_existing_metadata_path(metadata_file)
    metadata = _read(path)
    masa = metadata.get("masa", {})
    generation_ref = metadata.get("akousmata", {}).get("akousma_id")
    job_id = metadata.get("generation_job_id")
    try:
        receipt = storage.read_job_receipt(job_id) if job_id else None
    except FileNotFoundError:
        receipt = None
    if (
        not receipt
        or receipt.get("status") != "done"
        or metadata_file not in receipt.get("metadata_files", [])
    ):
        # Compare canonical paths too: relative and absolute owner locators may differ.
        paths = receipt.get("metadata_files", []) if receipt else []
        if (
            not receipt
            or receipt.get("status") != "done"
            or not any(storage.resolve_existing_metadata_path(p) == path for p in paths)
        ):
            raise ValueError("A settled completed generation receipt is required")
    output = storage.resolve_existing_input_audio_path(metadata["output_audio_path"])
    digest = _hash(output)
    if masa.get("status") != "written" or masa.get("output_sha256") != digest:
        raise ValueError("Output bytes differ from the retained MASA receipt")
    sidecar_path = storage.resolve_existing_path(masa["sidecar_path"])
    if not storage.is_within(sidecar_path, storage.settings.output_root / "masa"):
        raise ValueError("MASA receipt must be in the owned sidecar directory")
    sidecar = _read(sidecar_path)
    event = next(
        (
            e
            for e in sidecar.get("history", {}).get("events", [])
            if e["id"] == masa.get("receipt_id")
        ),
        None,
    )
    rep = next(
        (r for r in sidecar.get("representations", []) if r["id"] == masa.get("representation_id")),
        None,
    )
    if (
        not event
        or not rep
        or event.get("finalStatus") != "completed"
        or rep["id"] not in event["outputs"]
        or rep.get("integrity", {}).get("value", {}).get("digest") != digest
        or event.get("extensions", {}).get("germ:execution", {}).get("jobId") != job_id
    ):
        raise ValueError("MASA representation and receipt do not bind this output")
    d = workflow["decision"]
    if generation_ref != d.get("generation_ref") or workflow.get("output_ref") != rep["id"]:
        raise ValueError("Decision selects a different generated output")
    records = []
    for ref in workflow["source_refs"]:
        record = store.get(ref)
        if record is None:
            raise ValueError("Selected record was forgotten")
        records.append(record)
    generated = next((r for r in records if r["akousma_id"] == generation_ref), None)
    generation_audio = resolve_audio_path(store, generated or {})
    if generation_audio is None or _hash(generation_audio) != digest:
        raise ValueError("Canonical generation does not resolve to these bytes")
    history = metadata.get("extensions", {}).get("germ.relisten", {}).get("history", [])
    bindings = []
    for ref in d["subsequent_listenings"]:
        record = next((r for r in records if r["akousma_id"] == ref["record_ref"]), None)
        if not any(
            item.get("contract") == "germ.oida-relisten/v0.1"
            and item.get("remembered") is True
            and item.get("akousma_id") == ref["record_ref"]
            and item.get("output_sha256") == digest
            and item.get("event_id")
            for item in history
            if isinstance(item, dict)
        ):
            raise ValueError("Later account lacks a host-retained pass/output binding")
        audio = resolve_audio_path(store, record or {})
        if audio is None or _hash(audio) != digest:
            raise ValueError("Later account must retain the exact generated audio")
        # Earworm validates the real listening ID, attribution and chronology below.
        bindings.append({**ref, "output_ref": rep["id"]})
    return records, dict(
        output_ref=rep["id"],
        generation_ref=generation_ref,
        status="retained",
        receipt_ref=event["id"],
        sha256=digest,
        subsequent_listenings=bindings,
    )


def retain(body):
    if not isinstance(body, dict) or set(body) != {"workflow", "metadata_file"}:
        raise ValueError("Expected workflow and metadata_file")
    validate_json_compatible(body)
    if len(json.dumps(body)) > 256 * 1024:
        raise ValueError("Decision request exceeds 256 KiB")
    workflow = deepcopy(body["workflow"])
    errors = contract_errors("record-workflow-request", workflow)
    if errors:
        raise ValueError("; ".join(errors))
    d = workflow.get("decision", {})
    if d.get("policy_ref") != POLICY["id"] or d.get("policy_revision") != POLICY["revision"]:
        raise ValueError("Unknown subsequent-listening policy")
    if (
        not isinstance(workflow.get("source_refs"), list)
        or not 2 <= len(workflow["source_refs"]) <= 32
    ):
        raise ValueError("Select 2–32 generation and later-listening records")
    with _LOCK, open_store() as store:
        records, evidence = resolve_evidence(store, workflow, body["metadata_file"])
        record = generation_decision(
            workflow,
            records,
            output_evidence=evidence,
            validate_record=validation_errors,
            validate_references=next_record_reference_errors,
        )
        # A13 leaves local retention to this host. Re-resolve immediately before writing.
        current, current_evidence = resolve_evidence(store, workflow, body["metadata_file"])
        if current != records or current_evidence != evidence:
            raise ValueError("Decision inputs changed during validation")
        old = store.get(record["akousma_id"])
        if old is not None and old != record:
            raise ValueError("Decision identity already exists with different content")
        if old is None:
            store.put(record)
        return dict(
            contract="germ/retained-decision/v0.1",
            record=record,
            status="retained",
            reused=old is not None,
            execution="not_requested",
            quality_improvement="not_established",
        )
