from __future__ import annotations

from fastapi import APIRouter

from server.listener import enhance_prompt, relisten_with_oida, score_audio
from server.schemas import (
    ListenerEnhanceRequest,
    ListenerEnhanceResult,
    ListenerRelistenRequest,
    ListenerRelistenResult,
    ListenerScoreRequest,
    ListenerScoreResult,
)


router = APIRouter(prefix="/listener", tags=["listener"])


@router.get("/providers")
def providers() -> dict[str, object]:
    return {
        "providers": [
            {
                "id": "neutral",
                "label": "Neutral Prompt Compiler",
                "available": True,
                "requires_key": False,
                "performs_listening": False,
            },
            {
                "id": "local_signal",
                "label": "Local Signal Check",
                "available": True,
                "requires_key": False,
                "performs_listening": False,
            },
            {
                "id": "oida",
                "label": "Oída Re-listening Bridge",
                "available": True,
                "requires_key": False,
                "performs_listening": True,
                "ownership": "oida",
            },
        ],
        "boundary": "Oída hears. Germ cultivates.",
    }


@router.post("/enhance", response_model=ListenerEnhanceResult)
def enhance(request: ListenerEnhanceRequest) -> ListenerEnhanceResult:
    return enhance_prompt(request)


@router.post("/score", response_model=ListenerScoreResult)
def score(request: ListenerScoreRequest) -> ListenerScoreResult:
    return score_audio(request)


@router.post("/relisten", response_model=ListenerRelistenResult)
def relisten(request: ListenerRelistenRequest) -> ListenerRelistenResult:
    return relisten_with_oida(request)
