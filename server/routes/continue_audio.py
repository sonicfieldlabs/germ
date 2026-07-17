from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from server.routes._utils import (
    cleanup_transient_uploads,
    payload_from_json_or_form,
    pop_transient_upload_paths,
    run_provider_method,
)
from server.schemas import ContinueRequest, GenerationResult


router = APIRouter()


@router.post("/continue", response_model=GenerationResult)
async def continue_audio(request: Request) -> GenerationResult:
    payload = await payload_from_json_or_form(request)
    transient_upload_paths = pop_transient_upload_paths(payload)
    try:
        try:
            model = ContinueRequest(**payload)
        except ValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail=exc.errors(include_context=False, include_input=False),
            ) from exc
        return await run_in_threadpool(
            run_provider_method,
            model,
            "continuation",
            "continue_audio",
        )
    finally:
        cleanup_transient_uploads(transient_upload_paths)
