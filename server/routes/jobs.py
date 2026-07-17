from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from server.job_runner import JobQueueFullError
from server.routes._utils import request_model_for_mode, run_provider_method_with_existing_job
from server.registry import job_runner, settings, storage
from server.security import is_allowed_origin
from server.schemas import JobStatus, JobSubmitRequest, JobSubmitResponse


router = APIRouter()

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

    request_data = request_model.model_dump(exclude={"job_id"})
    job_id = storage.new_job(request.mode, request_data, status="queued")
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
        storage.update_job(job_id, status="error", error=str(exc))
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except RuntimeError as exc:
        storage.update_job(job_id, status="error", error=str(exc))
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
    return job


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
            signature = (payload["status"], payload["updated_at"])
            if signature != last_signature:
                await websocket.send_json(payload)
                last_signature = signature
            if payload["status"] in {"done", "error", "cancelled"}:
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
