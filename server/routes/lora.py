from __future__ import annotations

from fastapi import APIRouter

from server.registry import registry
from server.schemas import LoraLoadRequest, LoraStrengthRequest


router = APIRouter()


@router.post("/lora/load")
def load_lora(request: LoraLoadRequest) -> dict:
    try:
        return registry.get(request.provider).load_lora(request.paths)
    except Exception as exc:
        return {"status": "error", "provider": request.provider, "error": str(exc)}


@router.post("/lora/strength")
def set_lora_strength(request: LoraStrengthRequest) -> dict:
    try:
        provider = registry.get(request.provider)
        return provider.set_lora_strength(request.strength, request.lora_index)
    except Exception as exc:
        return {"status": "error", "provider": request.provider, "error": str(exc)}
