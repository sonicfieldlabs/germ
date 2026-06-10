from __future__ import annotations

from fastapi import APIRouter

from server.diagnostics import environment_report
from server.registry import registry, settings


router = APIRouter()


@router.get("/diagnostics")
def diagnostics() -> dict:
    return environment_report(settings, registry)

