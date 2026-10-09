from __future__ import annotations

import json
import time
from pathlib import Path
from threading import Event
from typing import Any

from fastapi import HTTPException, Request
from pydantic import BaseModel

from server.registry import registry, settings, storage
from server.schemas import (
    AudioToAudioRequest,
    ContinueRequest,
    GenerateRequest,
    GenerationResult,
    InpaintRequest,
    ModeId,
)


MODE_SPECS: dict[ModeId, tuple[type[BaseModel], str]] = {
    "text-to-audio": (GenerateRequest, "generate"),
    "audio-to-audio": (AudioToAudioRequest, "audio_to_audio"),
    "inpainting": (InpaintRequest, "inpaint"),
    "continuation": (ContinueRequest, "continue_audio"),
}


def preflight_deployment(request_model: BaseModel) -> None:
    """Reject incomplete isolated deployments before creating a queued job.

    This checks manifest structure, not multi-gigabyte hashes. The provider
    repeats admission with digest verification immediately before execution.
    """
    try:
        if getattr(request_model, "provider", None) == "ace_step":
            from server.ace.deployment import deployment
            deployment()
        elif getattr(request_model, "provider", None) == "research":
            from server.research.deployment import deployment
            deployment(request_model.model)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        raise HTTPException(422, "Isolated deployment admission failed; verify the deployment manifest") from exc


def run_provider_method(request_model: BaseModel, mode: str, method_name: str) -> GenerationResult:
    from server.registry import job_runner
    from server.job_runner import JobQueueFullError
    from concurrent.futures import CancelledError
    preflight_deployment(request_model)
    job_id = storage.new_job(mode, request_model.model_dump(exclude={"job_id"}), status="queued")
    try:
        future = job_runner.submit(job_id, run_provider_method_with_existing_job, request_model,
                                   job_id=job_id, mode=mode, method_name=method_name)
    except (JobQueueFullError, RuntimeError) as exc:
        storage.update_job(job_id, status="error", error=str(exc), metrics={"execution_state": "not_admitted"})
        storage.write_job_receipt(job_id)
        raise HTTPException(429 if isinstance(exc, JobQueueFullError) else 503, str(exc)) from exc
    try:
        result = future.result()
        # Future.result can wake before its done callbacks persist lifecycle
        # receipts. A synchronous success must include that durable boundary.
        deadline = time.monotonic() + 10
        while True:
            job = storage.get_job(job_id)
            if job and job.metrics.get("lifecycle_receipt_error"):
                raise HTTPException(503, "Generation settled but its lifecycle receipt could not be written; inspect job " + job_id)
            if job and job.metrics.get("receipt_ready"):
                return result
            if time.monotonic() >= deadline:
                raise HTTPException(503, "Generation settled but its lifecycle receipt is unconfirmed; inspect this job before retrying")
            time.sleep(.01)
    except CancelledError:
        return GenerationResult(job_id=job_id, status="cancelled", mode=mode,
                                error="job cancelled before execution")


def request_model_for_mode(mode: ModeId, payload: dict[str, Any]) -> tuple[BaseModel, str]:
    model_cls, method_name = MODE_SPECS[mode]
    if mode == "inpainting" and isinstance(payload.get("inpaint_ranges"), str):
        payload = {**payload, "inpaint_ranges": parse_ranges_text(payload["inpaint_ranges"])}
    return model_cls(**payload), method_name


def _admission_wait() -> dict:
    """Seconds the provider waited for the host's heavy-operation lease, when it took one.

    A render and a listening share one lease per host. On 24 September a Stable Audio
    render in a Swarm took 213 s while another lane's Thinking listening ran, against
    about 55 s alone, and nothing recorded how much of it was waiting.
    """
    try:
        from akousma.resource_admission import last_wait_seconds
    except ImportError:
        return {}
    waited = last_wait_seconds()
    return {} if waited is None else {"admission_wait_seconds": round(waited, 3)}


def run_provider_method_with_existing_job(
    request_model: BaseModel,
    *,
    job_id: str,
    mode: str,
    method_name: str,
    cancel_event: Event | None = None,
) -> GenerationResult:
    request_model = request_model.model_copy(update={"job_id": job_id})
    job = storage.get_job(job_id)
    if (job and job.status == "cancelled") or (cancel_event and cancel_event.is_set()):
        return GenerationResult(
            job_id=job_id,
            status="cancelled",
            error="job cancelled before execution",
            mode=mode,
        )
    storage.update_job(job_id, status="running", metrics={"execution_state": "running"})
    started = time.perf_counter()
    provider = None
    try:
        from server.memory_policy import validate_conditioning
        validate_conditioning(request_model)
        source = getattr(request_model, "source", {})
        if isinstance(source.get("derivation"), dict):
            from server.generation_workflow import admit_derivation
            admit_derivation(request_model)
        if cancel_event and cancel_event.is_set():
            return GenerationResult(job_id=job_id, status="cancelled", mode=mode, error="job cancelled before provider admission")
        provider = registry.get(getattr(request_model, "provider"))
        if cancel_event:
            provider.register_cancel_event(job_id, cancel_event)
        method = getattr(provider, method_name)
        # Providers record their own result; no extra record_result needed.
        result = method(request_model)
        # Providers may have written artifacts already. A failed recheck keeps
        # the job failed and records that fact; it never claims erasure.
        validate_conditioning(request_model)
        if cancel_event and cancel_event.is_set() and result.status != "cancelled":
            result = result.model_copy(update={"status": "cancelled", "error": "provider settled after cancellation request; any artifacts are retained"})
            storage.record_result(result)
        storage.update_job(
            job_id,
            metrics={
                "elapsed_seconds": round(time.perf_counter() - started, 6),
                **_admission_wait(),
            },
        )
        return result
    except Exception as exc:
        if cancel_event and cancel_event.is_set():
            result = GenerationResult(
                job_id=job_id,
                status="cancelled",
                error="job cancelled",
                provider=getattr(request_model, "provider", None),
                model=getattr(request_model, "model", None),
                mode=mode,
            )
            storage.record_result(result)
            storage.update_job(
                job_id,
                metrics={"elapsed_seconds": round(time.perf_counter() - started, 6)},
            )
            return result
        result = storage.write_error_metadata(
            request=request_model,
            mode=mode,
            job_id=job_id,
            error=str(exc),
            provider=getattr(request_model, "provider", None),
            model=getattr(request_model, "model", None),
        )
        storage.update_job(
            job_id,
            metrics={"elapsed_seconds": round(time.perf_counter() - started, 6)},
        )
        return result
    finally:
        if provider is not None:
            provider.clear_cancel_event(job_id)


async def payload_from_json_or_form(request: Request) -> dict[str, Any]:
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        data: dict[str, Any] = {}
        uploads: list[Any] = []
        for key, value in form.multi_items():
            if hasattr(value, "filename") and value.filename:
                uploads.append(value)
            else:
                data[key] = coerce_form_value(value, key=key)
        if len(uploads) > 1:
            raise HTTPException(status_code=400, detail="only one audio upload is supported")
        transient_upload = bool(
            data.pop("transient_upload", False) or data.pop("scratch_upload", False)
        )
        transient_paths: list[str] = []
        for value in uploads:
            try:
                saved, size = await storage.save_upload_stream(
                    filename=value.filename,
                    upload=value,
                    max_bytes=settings.max_upload_bytes,
                    directory=settings.scratch_dir if transient_upload else None,
                )
            except ValueError as exc:
                raise HTTPException(
                    status_code=413,
                    detail=str(exc),
                ) from exc
            if size == 0:
                saved.unlink(missing_ok=True)
                raise HTTPException(status_code=400, detail="uploaded audio is empty")
            data["input_audio_path"] = str(saved)
            if transient_upload:
                transient_paths.append(str(saved))
        if transient_paths:
            data["_transient_upload_paths"] = transient_paths
        return data
    try:
        payload = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="request body must be valid JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")
    return payload


def coerce_form_value(value: Any, *, key: str | None = None) -> Any:
    if not isinstance(value, str):
        return value
    json_keys = {
        "lora",
        "tags",
        "lineage",
        "source",
        "latents",
        "ratings",
        "modulators",
        "semantic_layers",
        "semantic_effects",
        "generation_context",
        "region_roles",
        "preserve_ranges",
        "accent_ranges",
        "forbidden_ranges",
        "seed_ranges",
        "texture_ranges",
        "variation_ranges",
        "bridge_ranges",
        "silence_ranges",
        "genetic_identities",
        "generation_sequences",
        "parent_akousma_ids",
        "akousma_relations",
        "listening_context",
        "covenant",
    }
    if key in json_keys:
        try:
            return json.loads(value)
        except (json.JSONDecodeError, RecursionError):
            if key == "tags":
                return [tag.strip() for tag in value.split(",") if tag.strip()]
            return value
    if key in {"transient_upload", "scratch_upload"}:
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "on"}:
            return True
        if lowered in {"false", "0", "no", "off", ""}:
            return False
    # Pydantic performs field-aware coercion later. Keeping ordinary form
    # strings intact prevents prompts such as "123" or "true" from being
    # silently changed into numbers or booleans.
    return value


def pop_transient_upload_paths(payload: dict[str, Any]) -> list[Path]:
    paths: list[Path] = []
    legacy_path = payload.pop("_transient_upload_path", None)
    if legacy_path:
        path = _safe_transient_upload_path(legacy_path)
        if path:
            paths.append(path)
    for item in payload.pop("_transient_upload_paths", []) or []:
        if item:
            path = _safe_transient_upload_path(item)
            if path:
                paths.append(path)
    return paths


def _safe_transient_upload_path(path: str | Path) -> Path | None:
    try:
        resolved = storage.resolve_path(path)
    except (OSError, RuntimeError):
        return None
    if not storage.is_within(resolved, settings.scratch_dir):
        return None
    return resolved


def cleanup_transient_uploads(paths: list[Path]) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def parse_ranges_text(value: str | list | None) -> list[tuple[float, float]]:
    if value is None:
        return []
    if isinstance(value, list):
        return [tuple(item) for item in value]
    ranges: list[tuple[float, float]] = []
    for raw_line in value.replace(";", "\n").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        pieces = [piece.strip() for piece in line.split(",")]
        if len(pieces) != 2:
            raise ValueError(f"invalid range '{line}', expected start,end")
        ranges.append((float(pieces[0]), float(pieces[1])))
    return ranges
