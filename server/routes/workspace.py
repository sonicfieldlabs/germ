"""Listening Stack's generation workspace, using GERM jobs, Petri and lineage."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Literal
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from server.akousma_store import AkousmaUnavailable, derive_prompt_contract, open_store
from server.registry import registry, job_runner
from server.routes.jobs import submit_job
from server.routes.library import library_items, library_key, library_memory_replay, resolve_library_audio
from server.schemas import JobSubmitRequest

router = APIRouter(prefix="/workspace")


class Render(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    request_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,100}$")
    mode: Literal["prompt", "memory", "audio"]
    model: str = Field(default="sm-sfx", max_length=80)
    edit: Literal["variation", "inpaint", "continue"] = "variation"
    inpaint_ranges: list[tuple[float, float]] = Field(default_factory=list, max_length=8)
    synthesis: dict = Field(default_factory=dict)
    music: dict = Field(default_factory=dict)
    prompt: str = Field(default="", max_length=10000)
    negative_prompt: str = Field(default="", max_length=10000)
    duration: float = Field(default=10, gt=0, le=380)
    steps: int = Field(default=8, ge=1, le=250)
    cfg_scale: float = Field(default=1, ge=0, le=25)
    seed: int = Field(default=-1, ge=-1, le=4294967294)
    mutation: float = Field(default=0.45, ge=0, le=1)
    sound_keys: list[str] = Field(default_factory=list, max_length=4)
    record_ids: list[str] = Field(default_factory=list, max_length=100)
    reasoning_session_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,100}$")
    reasoning_decision_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,100}$")
    reasoning_summary: str = Field(default="", max_length=4000)


def digest(value):
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode()
    ).hexdigest()


def memory_context(record_ids=None, prompt_budget=9400):
    """Read the canonical store; use the existing Oída → GERM prompt handoff."""
    try:
        store = open_store()
    except AkousmaUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        if record_ids:
            if len(set(record_ids)) != len(record_ids) or any(
                not re.fullmatch(r"[A-Za-z0-9_:-]{1,100}", rid) for rid in record_ids
            ):
                raise HTTPException(422, "Select distinct Auditum record IDs")
            records = [store.get(rid) for rid in record_ids]
            if any(not r or "auditum" not in r for r in records):
                raise HTTPException(404, "A selected Auditum record is unavailable")
        else:
            records = store.query(has_auditum=True, limit=1001, oldest_first=True)
        if len(records) > 1000:
            raise HTTPException(
                422,
                "Memory exceeds the 1,000-record conditioning window; curate a smaller memory collection before rendering",
            )
        if not records:
            raise HTTPException(
                409, "Listen and save an Auditum record before generating from memory"
            )
        fragments, influences, excluded = [], [], []
        for record in records:
            from server.memory_policy import admitted_record
            try:
                admitted_record(store, record)
            except HTTPException as exc:
                if record_ids or exc.status_code != 423:
                    raise
                excluded.append(
                    {
                        "record_id": record["akousma_id"],
                        "reason": "Restricted or covenant-bearing memory requires a dedicated derivation policy",
                    }
                )
                continue
            contract = derive_prompt_contract(record)
            text = contract["prompt"].strip()
            if not text:
                excluded.append(
                    {"record_id": record["akousma_id"], "reason": "No textual listening context"}
                )
                continue
            fragments.append(text)
            influences.append(
                {
                    "record_id": record["akousma_id"],
                    "sha256": digest(record),
                    "handoff_contract": contract["contract"],
                }
            )
        if not fragments:
            raise HTTPException(409, "No retained memory has usable generation context")
        # Equal text allocation makes every eligible memory contribute. Preserve
        # the exact excerpt and full source hash, rather than claiming full text fits.
        allocation = max(1, (prompt_budget - len(fragments) * 2) // len(fragments))
        excerpts = [text[:allocation] for text in fragments]
        for influence, excerpt, original in zip(influences, excerpts, fragments):
            influence.update(excerpt=excerpt, abbreviated=len(excerpt) < len(original))
        return {
            "prompt": "Compose a sound combining these listening descriptions: "
            + "; ".join(excerpts),
            "memory_influences": influences,
            "excluded": excluded,
            "total_records": len(records),
            "policy": "Equal character budget per eligible memory; descriptions are conditioning, not recovered audio.",
        }
    finally:
        store.close()


@router.get("/memory-context")
def preview_memory():
    return memory_context()


@router.get("/library")
def sounds():
    items = []
    for item in library_items():
        if not item.get("audio_exists") or not item.get("audio_file"):
            continue
        lineage = item.get("lineage") or {}
        context = (lineage.get("operation_params") or {}).get("generation_context") or {}
        items.append(
            {
                "key": library_key(item),
                "sound_id": item["sound_id"],
                "title": (
                    f"Memory composition · {len(context.get('memory_influences', []))} records"
                    if context.get("workspace_mode") == "memory"
                    else item.get("title") or item.get("prompt") or Path(item["audio_file"]).stem
                ),
                "created_at": item.get("created_at"),
                "duration": item.get("duration"),
                "provider": item.get("provider"),
                "model": item.get("model"),
                "tags": item.get("tags") or [],
                "source": item.get("source") or {},
                "kind": item.get("source_type")
                if item.get("source_type") in {"import", "discovery"}
                else "generated"
                if str(item.get("provider", "")).startswith(
                    ("stable_audio", "stability", "synthesis", "mock", "ace_step", "research")
                )
                else item.get("source_type") or "audio",
                "parents": item.get("parents") or [],
                "memory_influences": context.get("memory_influences") or [],
                "memory_ids": item.get("memory_ids") or [],
                "seed": item.get("seed"),
                "steps": item.get("steps"),
                "cfg_scale": item.get("cfg_scale"),
                "mutation": item.get("init_noise_level"),
                "operation": item.get("operation"),
                "inpaint_ranges": item.get("inpaint_ranges") or [],
                "generation_receipt": item.get("generation_receipt") or {},
                "reasoning_decision_id": context.get("reasoning_decision_id"),
            }
        )
    # Reverse links are a view of canonical parent edges, not mutations to parents.
    children = {}
    for item in items:
        for parent in item["parents"]:
            children.setdefault(parent, []).append(item["sound_id"])
    for item in items:
        item["children"] = children.get(item["sound_id"], [])
    return {"items": items, "count": len(items)}


@router.get("/library/by-memory/{record_id}")
def memory_replay(record_id: str):
    if not re.fullmatch(r"[A-Za-z0-9_:-]{1,100}", record_id):
        raise HTTPException(422, "Invalid memory record ID")
    items = library_memory_replay(record_id)
    return {"items": items, "count": len(items)}


@router.post("/render")
def render(request: Render):
    from server.workspace_capabilities import admit
    capability = admit(request)
    provider = registry.get(capability["provider"])
    if not provider.is_available():
        raise HTTPException(503, provider.status_detail())
    if request.mode == "audio":
        if not request.sound_keys or len(set(request.sound_keys)) != len(request.sound_keys):
            raise HTTPException(422, "Select 1–4 distinct library sounds")
        sources = [resolve_library_audio(key) for key in request.sound_keys]
        if any(item.get("generation_receipt",{}).get("profile")=="noncommercial_research" for item,_ in sources):
            raise HTTPException(422, "This source carries a research restriction; use Research instruments with the noncommercial research profile")
    else:
        if request.sound_keys:
            raise HTTPException(422, "Audio selections are only used in Audio mode")
        sources = [None]
    if request.record_ids and request.mode != "memory":
        raise HTTPException(422, "Record selections require memory generation")
    if request.reasoning_summary and not (request.reasoning_session_id or request.reasoning_decision_id):
        raise HTTPException(422, "Reasoning context needs its retained decision or legacy session reference")
    context = (
        memory_context(
            request.record_ids,
            max(0, (384 if capability["provider"] == "ace_step" else 9700) - len(request.prompt.strip()) - len(request.reasoning_summary)),
        )
        if request.mode == "memory"
        else {}
    )
    prompt = context.get("prompt") or request.prompt.strip()
    if request.mode == "memory" and request.prompt.strip():
        prompt += "\nOperator direction: " + request.prompt.strip()
        context["operator_direction"] = request.prompt.strip()
    if request.reasoning_summary:
        prompt += "\nRelated reasoning context (interpretation): " + request.reasoning_summary
        context.update(
            reasoning_session_id=request.reasoning_session_id,
            reasoning_summary=request.reasoning_summary,
        )
        if request.reasoning_decision_id:
            context["reasoning_decision_id"] = request.reasoning_decision_id
    prompt_limit = 512 if capability["provider"] == "ace_step" else 10000
    if len(prompt) > prompt_limit:
        raise HTTPException(
            422,
            f"Combined generation context exceeds {prompt_limit} characters for this model; shorten the direction or select fewer memories",
        )
    if not prompt and request.mode == "prompt" and capability["provider"] != "synthesis":
        raise HTTPException(422, "Describe a sound to generate")
    prepared = []
    for source in sources:
        fields = request.model_dump(
            include={"negative_prompt", "duration", "steps", "cfg_scale", "seed"}
        )
        fields.update(
            provider=capability["provider"],
            model=capability["model"],
            prompt=prompt,
            generation_context={"workspace_mode": request.mode, **context},
            source={"kind": "listening-stack-" + request.mode},
            lineage={
                "operation": "memory-composition"
                if context
                else "audio-variation"
                if source
                else "prompt-generation"
            },
            remember_to_akousmata=False,
        )
        if capability["provider"] == "synthesis":
            fields["source"]["synthesis"] = request.synthesis
        if capability["provider"] == "ace_step":
            fields["source"]["music"] = request.music
        job_mode = "audio-to-audio" if source else "text-to-audio"
        if source:
            item, path = source
            # GERM remains responsible for input allowlists, decode and rendering.
            fields.update(input_audio_path=str(path), init_noise_level=request.mutation)
            fields["lineage"]["parents"] = [item["sound_id"]]
            with path.open("rb") as audio:
                sha = (
                    hashlib.file_digest(audio, "sha256").hexdigest()
                    if hasattr(hashlib, "file_digest")
                    else _file_hash(audio)
                )
            fields["source"].update(sound_id=item["sound_id"], sha256=sha)
            if request.edit in {"inpaint", "continue"}:
                import soundfile as sf
                info = sf.info(str(path))
                actual = info.frames / info.samplerate
                fields.pop("init_noise_level", None)
                if request.edit == "inpaint":
                    if any(not 0 <= start < end <= min(actual,request.duration) for start,end in request.inpaint_ranges):
                        raise HTTPException(422,"Inpaint intervals must be inside both source and output")
                    if abs(request.duration-actual)>1/info.samplerate:
                        raise HTTPException(422,"Inpainting keeps the source duration; choose that output duration")
                    fields["inpaint_ranges"] = request.inpaint_ranges
                    job_mode = "inpainting"
                else:
                    if request.duration <= actual:
                        raise HTTPException(422,"Continuation target must exceed the actual source duration")
                    fields.update(source_duration=actual,target_duration=request.duration)
                    job_mode = "continuation"
                fields["lineage"]["operation"] = job_mode
            fields["generation_context"]["operation"] = job_mode
        prepared.append(
            JobSubmitRequest(mode=job_mode, request=fields, request_id=request.request_id + "." + str(len(prepared)) if request.request_id else None)
        )
    state = job_runner.status()
    if request.request_id is None and state["capacity"] - state["outstanding"] < len(prepared):
        raise HTTPException(429, "Generation queue is full; wait for a render to finish")
    tickets, errors = [], []
    for job in prepared:
        try:
            tickets.append(submit_job(job).model_dump())
        except HTTPException as exc:
            # Never lose track of jobs already admitted when another client fills the queue.
            if not tickets:
                raise
            errors.append(str(exc.detail))
            break
    return {
        "request_id": request.request_id,
        "jobs": tickets,
        "errors": errors,
        "memory_count": len(context.get("memory_influences", [])),
    }


def _file_hash(handle):
    digest = hashlib.sha256()
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


@router.get("/jobs/{job_id}/sounds")
def job_sounds(job_id: str):
    """Resolve explicit job output paths to stable shared-library identities."""
    from server.registry import storage

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", job_id):
        raise HTTPException(400, "Invalid generation job")
    job = storage.get_job(job_id)
    if job is None:
        try:
            job = storage.read_job_receipt(job_id)
        except FileNotFoundError as exc:
            raise HTTPException(404, "Generation job unavailable") from exc
    if hasattr(job, "model_dump"):
        job = job.model_dump()
    files = {str(storage.resolve_path(p)) for p in job.get("audio_files", [])}
    keys = {
        library_key(item)
        for item in library_items()
        if item.get("audio_file") and str(storage.resolve_path(item["audio_file"])) in files
    }
    return {"items": [item for item in sounds()["items"] if item["key"] in keys]}


@router.get("/capabilities")
def workspace_capabilities():
    from server.workspace_capabilities import catalog
    from server.spectral_synthesis import MODELS, RATES
    return {"generators": catalog(registry), "spectral_generation": {
        "contract": "germ/spectral-generation/v1", "models": sorted(MODELS),
        "sample_rates_hz": list(RATES), "maximum_duration_seconds": 30,
        "playback": "explicit session opt-in; unknown and beyond-reference scope locked by default",
        "semantics": "Declared digital oscillator components, measured WAV energy and physical emission are distinct",
    }}
