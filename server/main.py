from __future__ import annotations

import asyncio
import hashlib
import json
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from server.playback import install_playback_gate
from server.config import get_settings
from server.identity import LEGACY_ENGINE_NAME, PRODUCT_DESCRIPTION, PRODUCT_NAME, __version__
from server.routes import (
    akousma,
    audio_tools,
    audio_to_audio,
    continue_audio,
    control,
    cosmoaudition,
    diagnostics,
    earworm,
    files,
    generate,
    health,
    huggingface,
    image_to_audio,
    import_audio,
    inpaint,
    jobs,
    library,
    listener,
    lora,
    matter,
    micro,
    models,
    performance,
    sessions,
    strains,
    time_render,
    wavetables,
    workspace,
    research,
    spectral,
    simulated,
)
from server.performance import PerformanceMiddleware
from server.security import LocalOriginAndHeadersMiddleware


settings = get_settings()


@asynccontextmanager
async def lifespan(_app):
    from server.registry import job_runner

    job_runner.startup()
    try:
        yield
    finally:
        job_runner.shutdown(wait=False)
        _app.state.shutdown_settled = await asyncio.to_thread(
            job_runner.wait_for_settlement, settings.worker_shutdown_seconds
        )


app = FastAPI(
    lifespan=lifespan,
    title=PRODUCT_NAME,
    description=(
        f"{PRODUCT_NAME} FastAPI sidecar for local Stable Audio 3 providers, "
        f"{PRODUCT_DESCRIPTION}, and legacy {LEGACY_ENGINE_NAME} clients."
    ),
    version=__version__,
    docs_url=None,
)

_WORKSPACE_ID = os.getenv("LISTENINGSTACK_WORKSPACE_ID")
_WORKSPACE_GENERATION = os.getenv("LISTENINGSTACK_WORKSPACE_GENERATION")
_WORKSPACE_BINDING = hashlib.sha256(
    json.dumps(
        ["germ", _WORKSPACE_ID, _WORKSPACE_GENERATION, str(settings.output_root.resolve())],
        separators=(",", ":"),
    ).encode()
).hexdigest()


@app.middleware("http")
async def workspace_admission(request: Request, call_next):
    if (
        _WORKSPACE_ID
        and _WORKSPACE_GENERATION
        and request.method.upper() not in {"GET", "HEAD", "OPTIONS"}
    ):
        supplied = (
            request.headers.get("x-centaur-workspace"),
            request.headers.get("x-centaur-generation"),
            request.headers.get("x-centaur-binding"),
        )
        if supplied != (_WORKSPACE_ID, _WORKSPACE_GENERATION, _WORKSPACE_BINDING):
            return JSONResponse(
                status_code=409,
                content={"detail": "GERM refused a stale or mismatched workspace binding"},
            )
    return await call_next(request)


@app.get("/owner/identity")
def owner_identity() -> dict[str, object]:
    return {
        "contract": "centaur/owner-identity/v1",
        "owner": "germ",
        "mode": "workspace" if _WORKSPACE_ID and _WORKSPACE_GENERATION else "legacy",
        "workspace_id": _WORKSPACE_ID,
        "generation": _WORKSPACE_GENERATION,
        "binding": _WORKSPACE_BINDING,
        "pid": os.getpid(),
    }


app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Validate the Host header to block DNS-rebinding / cross-origin side-effect
# requests against this local server. Override with GERM_ALLOWED_HOSTS.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
app.add_middleware(
    LocalOriginAndHeadersMiddleware,
    allowed_hosts=settings.allowed_hosts,
)
app.add_middleware(PerformanceMiddleware)


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(
    _request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    """Return JSON-safe validation details without reflecting raw request data."""
    details = []
    errors = exc.errors()
    for error in errors[:100]:
        location = [
            value if isinstance(value, int) else str(value)[:500] for value in error.get("loc", ())
        ]
        details.append(
            {
                "type": str(error.get("type") or "value_error")[:200],
                "loc": location,
                "msg": str(error.get("msg") or "Invalid request value")[:2_000],
            }
        )
    if len(errors) > 100:
        details.append(
            {
                "type": "too_many_errors",
                "loc": ["body"],
                "msg": f"Request has {len(errors)} validation errors; showing the first 100.",
            }
        )
    return JSONResponse(status_code=422, content={"detail": details})


install_playback_gate(app)

app.include_router(health.router)
app.include_router(diagnostics.router)
app.include_router(earworm.router)
app.include_router(akousma.router)
app.include_router(huggingface.router)
app.include_router(models.router)
app.include_router(performance.router)
app.include_router(control.router)
app.include_router(cosmoaudition.router)
app.include_router(generate.router)
app.include_router(import_audio.router)
app.include_router(image_to_audio.router)
app.include_router(audio_tools.router)
app.include_router(audio_to_audio.router)
app.include_router(inpaint.router)
app.include_router(continue_audio.router)
app.include_router(lora.router)
app.include_router(strains.router)
app.include_router(matter.router)
app.include_router(micro.router)
app.include_router(sessions.router)
app.include_router(jobs.router)
app.include_router(library.router)
app.include_router(workspace.router)
app.include_router(spectral.router)
app.include_router(simulated.router)
app.include_router(research.router)
app.include_router(listener.router)
app.include_router(files.router)
app.include_router(time_render.router)
app.include_router(wavetables.router)

dashboard_dir = settings.project_root / "dashboard" / "static"
app.mount("/dashboard/assets", StaticFiles(directory=dashboard_dir), name="dashboard-assets")


@app.get("/")
def root() -> dict[str, str]:
    return {
        "server": settings.server_name,
        "health": "/health",
        "diagnostics": "/diagnostics",
        "models": "/models",
        "docs": "/docs",
    }


@app.get("/docs", include_in_schema=False)
def api_docs() -> HTMLResponse:
    response = get_swagger_ui_html(
        openapi_url=app.openapi_url,
        title=f"{PRODUCT_NAME} — documentation",
        swagger_favicon_url="/dashboard/assets/favicon.svg",
        swagger_ui_parameters={
            "displayRequestDuration": True,
            "docExpansion": "list",
            "filter": True,
            "persistAuthorization": True,
        },
    )
    html = response.body.decode("utf-8").replace(
        "</head>",
        (
            '<script src="/dashboard/assets/docs_theme.js?v=20260715-oida-family-p1"></script>'
            '<link rel="stylesheet" href="/dashboard/assets/docs.css?v=20260715-oida-family-p1">'
            "</head>"
        ),
    )
    return HTMLResponse(html)


@app.get("/dashboard", include_in_schema=False)
@app.get("/dashboard/", include_in_schema=False)
@app.head("/dashboard", include_in_schema=False)
@app.head("/dashboard/", include_in_schema=False)
def dashboard() -> FileResponse:
    return FileResponse(dashboard_dir / "index.html")
