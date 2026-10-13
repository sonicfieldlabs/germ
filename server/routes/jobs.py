from __future__ import annotations

import asyncio
import sqlite3
import time

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from server.job_runner import JobQueueFullError
from server.job_journal import JobConflict
from server.routes._utils import preflight_deployment, request_model_for_mode, run_provider_method_with_existing_job
from server.registry import job_runner, settings, storage
from server.security import is_allowed_origin
from server.schemas import JobStatus, JobSubmitRequest, JobSubmitResponse


router = APIRouter()

def validate_retained_context(context, metrics):
    from hashlib import sha256
    from server.memory_policy import validate_context
    binding = metrics.get("workspace_binding_sha256")
    if binding is not None and binding != sha256(storage.job_journal.binding.encode()).hexdigest():
        raise HTTPException(409, "Retained job belongs to another workspace generation")
    validate_context(context)


@router.get("/jobs/status")
def runner_status():
    return job_runner.status()


@router.get("/jobs/requests/{request_id}")
def lookup_request(request_id: str):
    import re
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", request_id):
        raise HTTPException(400, "Invalid retained generation request")
    from server.memory_policy import validate_context
    try:
        rows = [storage.job_journal.lookup_request(request_id), *[storage.job_journal.lookup_request(request_id + "." + str(i)) for i in range(4)]]
    except JobConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    jobs = []
    for row in rows:
        if row:
            validate_context(row.get("request", {}).get("generation_context") or {})
            jobs.append({key: row.get(key) for key in ("job_id", "status", "mode", "provider", "model", "metrics")})
    if not jobs:
        raise HTTPException(404, "No retained admission for this request; execution remains unknown")
    return dict(request_id=request_id, jobs=jobs, automatic_replay=False)


@router.post("/jobs/submit", response_model=JobSubmitResponse)
def submit_job(request: JobSubmitRequest) -> JobSubmitResponse:
    try:
        request_model, method_name = request_model_for_mode(request.mode, request.request)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail=exc.errors(include_context=False, include_input=False),
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    preflight_deployment(request_model)
    request_data = request_model.model_dump(exclude={"job_id"})
    try:
        job_id, created = storage.admit_job(request.mode, request_data, request_id=request.request_id)
    except JobConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except (OSError, ValueError, sqlite3.Error) as exc:
        raise HTTPException(503, "Durable job admission unavailable") from exc
    if not created:
        retained = storage.get_job(job_id)
        validate_retained_context(retained.request.get("generation_context") or {}, retained.metrics)
        return JobSubmitResponse(job_id=job_id, status=retained.status, mode=request.mode, provider=retained.provider, model=retained.model, status_url=f"/jobs/{job_id}", events_url=f"/jobs/{job_id}/events")
    try:
        job_runner.submit(
            job_id,
            run_provider_method_with_existing_job,
            request_model,
            job_id=job_id,
            mode=request.mode,
            method_name=method_name,
        )
    except JobQueueFullError as exc:
        storage.update_job(job_id, status="error", error=str(exc), metrics={"execution_state": "not_admitted"})
        storage.write_job_receipt(job_id)
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except RuntimeError as exc:
        storage.update_job(job_id, status="error", error=str(exc), metrics={"execution_state": "not_admitted"})
        storage.write_job_receipt(job_id)
        raise HTTPException(status_code=503, detail="background job runner is unavailable") from exc
    return JobSubmitResponse(
        job_id=job_id,
        status="queued",
        mode=request.mode,
        provider=request_data.get("provider"),
        model=request_data.get("model"),
        status_url=f"/jobs/{job_id}",
        events_url=f"/jobs/{job_id}/events",
    )


@router.get("/jobs/{job_id}", response_model=JobStatus)
def get_job(job_id: str) -> JobStatus:
    job = storage.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"job not found: {job_id}")
    validate_retained_context(job.request.get("generation_context") or {}, job.metrics)
    return job


@router.get("/jobs/{job_id}/receipt")
def job_receipt(job_id: str):
    try:
        value = storage.read_job_receipt(job_id)
        validate_retained_context(value.get("memory_conditioning") or {}, value.get("metrics") or {})
        return value
    except FileNotFoundError as exc:
        raise HTTPException(404, "No retained lifecycle receipt") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, str | bool]:
    result = job_runner.cancel(job_id)
    if result["status"] == "missing":
        raise HTTPException(status_code=404, detail=f"job not found: {job_id}")
    return {"job_id": job_id, **result}


@router.websocket("/jobs/{job_id}/events")
async def job_events(websocket: WebSocket, job_id: str) -> None:
    if not is_allowed_origin(
        websocket.headers.get("origin"),
        websocket.headers.get("host"),
        settings.allowed_hosts,
    ):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    storage.add_job_listener(job_id)
    last_signature: tuple[str, str] | None = None
    deadline = time.monotonic() + max(60.0, settings.provider_timeout_seconds + 300.0)
    try:
        while True:
            job = storage.get_job(job_id)
            if job is None:
                await websocket.send_json(
                    {
                        "job_id": job_id,
                        "status": "error",
                        "error": f"job not found: {job_id}",
                    }
                )
                return

            payload = job.model_dump()
            try:
                validate_retained_context(job.request.get("generation_context") or {}, job.metrics)
            except HTTPException:
                await websocket.send_json({"job_id": job_id, "status": "withheld_or_unavailable"})
                return
            signature = (payload["status"], payload["updated_at"])
            if signature != last_signature:
                await websocket.send_json(payload)
                last_signature = signature
            execution_state = payload.get("metrics", {}).get("execution_state")
            terminal = payload["status"] in {"done", "error", "cancelled"}
            if terminal and execution_state not in {"admitted", "running", "cancellation_requested"} and (execution_state != "settled" or payload.get("metrics", {}).get("receipt_ready")):
                return
            if time.monotonic() >= deadline:
                await websocket.send_json(
                    {**payload, "error": "job events stream timed out"}
                )
                return
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        return
    finally:
        storage.remove_job_listener(job_id)
