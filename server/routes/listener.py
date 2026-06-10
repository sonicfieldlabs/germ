from __future__ import annotations

from fastapi import APIRouter

from server.listener import enhance_prompt, score_audio
from server.schemas import ListenerEnhanceRequest, ListenerEnhanceResult, ListenerScoreRequest, ListenerScoreResult


router = APIRouter(prefix="/listener", tags=["listener"])


@router.get("/providers")
def providers() -> dict[str, object]:
    return {
        "providers": [
            {
                "id": "mock",
                "label": "Heuristic Listener",
                "available": True,
                "requires_key": False,
            },
            {
                "id": "local",
                "label": "Local Ollama Listener",
                "available": True,
                "requires_key": False,
                "fallback": "heuristic",
            },
            {
                "id": "api",
                "label": "API Listener",
                "available": False,
                "requires_key": True,
            },
        ]
    }


@router.post("/enhance", response_model=ListenerEnhanceResult)
def enhance(request: ListenerEnhanceRequest) -> ListenerEnhanceResult:
    return enhance_prompt(request)


@router.post("/score", response_model=ListenerScoreResult)
def score(request: ListenerScoreRequest) -> ListenerScoreResult:
    return score_audio(request)
