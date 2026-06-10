from __future__ import annotations

from fastapi import APIRouter

from server.performance import performance_monitor


router = APIRouter()


@router.get("/performance")
def performance_snapshot() -> dict:
    return performance_monitor.snapshot()
