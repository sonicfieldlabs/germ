from __future__ import annotations

from fastapi import APIRouter, HTTPException

from server.registry import registry, job_runner
from server.schemas import LoadModelRequest, LoadModelResponse, ModelsResponse


router = APIRouter()


@router.get("/models", response_model=ModelsResponse)
def list_models() -> ModelsResponse:
    return ModelsResponse(providers=registry.list_status())


@router.post("/models/load", response_model=LoadModelResponse)
def load_model(request: LoadModelRequest) -> LoadModelResponse:
    try:
        result = job_runner.idle_control(
            lambda: registry.load_model(request.provider, request.model, request.device)
        )
        return LoadModelResponse(**result)
    except Exception as exc:
        return LoadModelResponse(
            provider=request.provider,
            model=request.model,
            device=request.device,
            status="error",
            detail=str(exc),
        )


@router.post("/models/reboot", response_model=LoadModelResponse)
def reboot_model(request: LoadModelRequest):
    try:
        result = job_runner.idle_control(
            lambda: registry.reboot_model(request.provider, request.model, request.device)
        )
        return LoadModelResponse(**result)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/capabilities")
def capabilities():
    from akousma.resource_admission import admission_status
    return dict(contract="listening-stack/capability-catalog/v1", owner="germ",
        legacy_models=[p.model_dump() for p in registry.list_status()],
        deployments=registry.deployments.catalog(), admission=admission_status(),
        legacy_policy="Existing provider settings preserved; methods must be validated per checkpoint")
