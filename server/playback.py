"""Ephemeral browser playback grant. Digital owner-to-owner file resolution is unaffected."""

import secrets
from time import monotonic
from threading import Lock

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse


def install_playback_gate(app, prefix=""):
    grants = {}
    lock = Lock()
    cookie = "centaur_playback_station" if prefix else "centaur_playback_germ"

    def same_origin(request):
        if request.headers.get("origin") != str(request.base_url).rstrip("/"):
            raise HTTPException(403, "Playback opt-in requires the same browser origin")

    @app.post(prefix + "/playback-session")
    def enable(request: Request):
        same_origin(request)
        token = secrets.token_urlsafe(32)
        now = monotonic()
        with lock:
            expired = [k for k, deadline in grants.items() if deadline <= now]
            for key in expired:
                grants.pop(key, None)
            if len(grants) >= 256:
                raise HTTPException(429, "Too many playback sessions")
            grants.pop(request.cookies.get(cookie), None)
            grants[token] = now + 900
        response = JSONResponse({"enabled": True, "expires_in_seconds": 900})
        response.set_cookie(cookie, token, httponly=True, samesite="strict", path="/")
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.delete(prefix + "/playback-session")
    def disable(request: Request):
        same_origin(request)
        with lock:
            grants.pop(request.cookies.get(cookie), None)
        response = JSONResponse({"enabled": False})
        response.delete_cookie(cookie, path="/")
        return response

    @app.middleware("http")
    async def playback(request, call_next):
        token = request.cookies.get(cookie)
        with lock:
            admitted = grants.get(token, 0) > monotonic()
        path = request.url.path.lower()
        media_route = (
            (
                "/audio/" in path
                and not path.endswith("/resolve")
                and not (path.startswith("/library/audio/") and path.endswith("/authorization"))
            )
            or "/sources/radio/" in path
            or "/chunks/" in path
            or path.endswith(
                (".wav", ".flac", ".mp3", ".ogg", ".opus", ".aif", ".aiff", ".m4a", ".webm", ".mp4")
            )
            or (
                path.startswith("/wavetables/")
                and request.query_params.get("format") == "wav-stack"
            )
        )
        if (
            request.method in {"GET", "HEAD"}
            and path.startswith(prefix + "/")
            and media_route
            and not admitted
        ):
            return JSONResponse(
                {"detail": "Playback is locked; enable this session first."}, status_code=403
            )
        response = await call_next(request)
        media = response.headers.get("content-type", "").split(";")[0]
        token = request.cookies.get(cookie)
        # A document load is a new playback session, including reloads and imported UI state.
        if media == "text/html":
            with lock:
                grants.pop(token, None)
            response.delete_cookie(cookie, path="/")
        if media.startswith("audio/") or media in {"video/webm", "video/mp4"}:
            with lock:
                admitted = grants.get(token, 0) > monotonic()
            if not admitted:
                return JSONResponse(
                    {
                        "detail": "Playback is locked. Explicitly enable this session; spectral scope may be beyond-reference or unknown."
                    },
                    status_code=403,
                )
            response.headers["Cache-Control"] = "private, no-store"
        return response
