from __future__ import annotations

import logging

from fastapi import APIRouter

from server.registry import registry
from server.schemas import LoraLoadRequest, LoraStrengthRequest


router = APIRouter()
LOGGER = logging.getLogger(__name__)


@router.post("/lora/load")
def load_lora(request: LoraLoadRequest) -> dict:
    try:
        return registry.get(request.provider).load_lora(request.paths)
    except Exception:
        LOGGER.exception("LoRA load failed for provider %s", request.provider)
        return {"status": "error", "provider": request.provider, "error": "LoRA load failed"}


@router.post("/lora/strength")
def set_lora_strength(request: LoraStrengthRequest) -> dict:
    try:
        provider = registry.get(request.provider)
        return provider.set_lora_strength(request.strength, request.lora_index)
    except Exception:
        LOGGER.exception("LoRA strength update failed for provider %s", request.provider)
        return {
            "status": "error",
            "provider": request.provider,
            "error": "LoRA strength update failed",
        }
