from __future__ import annotations

import base64
import binascii
import json
import math
import os
import re
from typing import Any, Literal

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from server.registry import settings


router = APIRouter()

SUPPORTED_IMAGE_MIME_TYPES = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
}


class ImageToAudioAnalyzeRequest(BaseModel):
    image_base64: str = Field(min_length=1)
    mime_type: str = Field(default="image/png", min_length=1, max_length=64)
    mode: Literal["vision", "spectrogram"] = "vision"
    interpretation_mode: str = Field(default="cinematic", min_length=1, max_length=100)
    use_case: str = Field(default="sound_design", min_length=1, max_length=100)


def _vision_prompt(mode: str, use_case: str) -> str:
    return f"""You are an expert sound designer translating an image into a Stable Audio prompt.

Interpretation mode: {mode}
Use case: {use_case}

Return only JSON:
{{
  "imageSummary": "one sentence",
  "visualElements": [{{"element": "visible object", "sonicPotential": "possible sounds", "category": "Atmosphere | Foley | UI | Action | Material"}}],
  "acousticSpace": "room or space description",
  "materialTextures": ["texture"],
  "mood": {{"primary": "mood", "secondary": ["trait"]}},
  "soundCards": [
    {{
      "title": "short title",
      "prompt": "detailed audio-generation prompt, acoustic action, materials, space, no music, no dialogue",
      "durationSeconds": 4,
      "loop": false
    }}
  ]
}}
Keep prompts under 420 characters and describe sound, not pixels."""


def _mock_analysis() -> dict[str, Any]:
    return {
        "imageSummary": "Image interpreted as a textured visual source for a focused sound design prompt.",
        "visualElements": [
            {
                "element": "image structure",
                "sonicPotential": "layered texture, movement, implied space",
                "category": "Atmosphere",
            }
        ],
        "acousticSpace": "medium close space with restrained reflections",
        "materialTextures": ["grain", "air", "surface movement"],
        "mood": {"primary": "textural", "secondary": ["detailed", "controlled"]},
        "soundCards": [
            {
                "title": "Image-derived texture",
                "prompt": "Detailed textural sound derived from the image, close material movement, subtle air pressure, controlled dynamics, tactile surface detail, no music, no dialogue.",
                "durationSeconds": 6,
                "loop": False,
            }
        ],
        "fallback": True,
    }


def _clean_text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _normalize_analysis(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return _mock_analysis()
    raw_elements = value.get("visualElements")
    elements = []
    if isinstance(raw_elements, list):
        for item in raw_elements[:32]:
            if not isinstance(item, dict):
                continue
            elements.append(
                {
                    "element": _clean_text(item.get("element"), 500),
                    "sonicPotential": _clean_text(item.get("sonicPotential"), 1_000),
                    "category": _clean_text(item.get("category"), 100),
                }
            )
    raw_textures = value.get("materialTextures")
    textures = (
        [_clean_text(item, 200) for item in raw_textures[:64] if _clean_text(item, 200)]
        if isinstance(raw_textures, list)
        else []
    )
    raw_mood = value.get("mood") if isinstance(value.get("mood"), dict) else {}
    raw_secondary = raw_mood.get("secondary")
    mood = {
        "primary": _clean_text(raw_mood.get("primary"), 200),
        "secondary": (
            [_clean_text(item, 200) for item in raw_secondary[:32] if _clean_text(item, 200)]
            if isinstance(raw_secondary, list)
            else []
        ),
    }
    raw_cards = value.get("soundCards")
    cards = []
    if isinstance(raw_cards, list):
        for item in raw_cards[:16]:
            if not isinstance(item, dict):
                continue
            try:
                duration = float(item.get("durationSeconds", 6))
            except (TypeError, ValueError, OverflowError):
                duration = 6.0
            if not math.isfinite(duration):
                duration = 6.0
            cards.append(
                {
                    "title": _clean_text(item.get("title"), 200),
                    "prompt": _clean_text(item.get("prompt"), 2_000),
                    "durationSeconds": max(0.1, min(380.0, duration)),
                    "loop": item.get("loop") is True,
                }
            )
    fallback = _mock_analysis()
    if not cards:
        cards = fallback["soundCards"]
    return {
        "imageSummary": _clean_text(value.get("imageSummary"), 2_000)
        or fallback["imageSummary"],
        "visualElements": elements or fallback["visualElements"],
        "acousticSpace": _clean_text(value.get("acousticSpace"), 2_000)
        or fallback["acousticSpace"],
        "materialTextures": textures or fallback["materialTextures"],
        "mood": mood if mood["primary"] or mood["secondary"] else fallback["mood"],
        "soundCards": cards,
        **({"fallback": bool(value.get("fallback"))} if "fallback" in value else {}),
        **(
            {"vision_error": _clean_text(value.get("vision_error"), 500)}
            if value.get("vision_error")
            else {}
        ),
    }


def _json_from_text(text: str) -> dict[str, Any] | None:
    stripped = text.strip()
    stripped = re.sub(r"^```(?:json)?", "", stripped).strip()
    stripped = re.sub(r"```$", "", stripped).strip()
    try:
        value = json.loads(stripped)
        return value if isinstance(value, dict) else None
    except (json.JSONDecodeError, RecursionError):
        match = re.search(r"\{.*\}", stripped, flags=re.S)
        if not match:
            return None
        try:
            value = json.loads(match.group(0))
            return value if isinstance(value, dict) else None
        except (json.JSONDecodeError, RecursionError):
            return None


def _validate_inline_image(request: ImageToAudioAnalyzeRequest) -> tuple[str, str]:
    mime_type = request.mime_type.lower().strip()
    if mime_type not in SUPPORTED_IMAGE_MIME_TYPES:
        raise HTTPException(status_code=422, detail="Unsupported image type.")

    image_base64 = request.image_base64.strip()
    max_base64_chars = ((settings.max_image_upload_bytes + 2) // 3) * 4
    if len(image_base64) > max_base64_chars:
        raise HTTPException(
            status_code=413,
            detail=f"image exceeds the {settings.max_image_upload_bytes // (1024 * 1024)} MB limit",
        )
    try:
        decoded = base64.b64decode(image_base64, validate=True)
    except binascii.Error as exc:
        raise HTTPException(status_code=422, detail="image_base64 must be valid base64.") from exc
    if len(decoded) > settings.max_image_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"image exceeds the {settings.max_image_upload_bytes // (1024 * 1024)} MB limit",
        )
    mime_type = "image/jpeg" if mime_type == "image/jpg" else mime_type
    signatures_match = {
        "image/jpeg": decoded.startswith(b"\xff\xd8\xff"),
        "image/png": decoded.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": len(decoded) >= 12
        and decoded.startswith(b"RIFF")
        and decoded[8:12] == b"WEBP",
    }
    if not signatures_match[mime_type]:
        raise HTTPException(status_code=422, detail="image data does not match its MIME type")
    return image_base64, mime_type


async def _gemini_analysis(
    request: ImageToAudioAnalyzeRequest,
    *,
    image_base64: str,
) -> dict[str, Any] | None:
    if not settings.cloud_vision_enabled:
        return None
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return None
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": _vision_prompt(request.interpretation_mode, request.use_case)},
                    {
                        "inline_data": {
                            "mime_type": request.mime_type,
                            "data": image_base64,
                        }
                    },
                ]
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "maxOutputTokens": 2048,
        },
    }
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{settings.gemini_model}:generateContent"
    )
    async with httpx.AsyncClient(timeout=35) as client:
        response = await client.post(
            url,
            headers={"x-goog-api-key": api_key.strip()},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
    text = (
        data.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text", "")
    )
    return _json_from_text(text)


@router.post("/image-to-audio/analyze")
async def analyze_image_to_audio(request: ImageToAudioAnalyzeRequest) -> dict[str, Any]:
    image_base64, mime_type = _validate_inline_image(request)
    request = request.model_copy(
        update={"image_base64": image_base64, "mime_type": mime_type}
    )
    if request.mode == "spectrogram":
        return {
            **_mock_analysis(),
            "imageSummary": "Image will be interpreted directly as a spectrogram-like signal.",
            "mode": "spectrogram",
            "analysis_provider": "browser_spectrogram",
            "cloud_vision": False,
            "fallback": False,
        }
    analysis_provider = "local_fallback"
    try:
        analysis = await _gemini_analysis(request, image_base64=image_base64)
        if analysis:
            analysis_provider = "gemini"
    except httpx.HTTPStatusError as exc:
        analysis = {
            **_mock_analysis(),
            "vision_error": f"Gemini request failed with HTTP {exc.response.status_code}.",
        }
    except httpx.HTTPError:
        analysis = {**_mock_analysis(), "vision_error": "Gemini request failed."}
    except Exception as exc:
        analysis = {**_mock_analysis(), "vision_error": f"{type(exc).__name__}: analysis failed."}
    if not analysis:
        analysis = _mock_analysis()
    analysis = _normalize_analysis(analysis)
    cards = analysis.get("soundCards") if isinstance(analysis.get("soundCards"), list) else []
    primary = cards[0] if cards and isinstance(cards[0], dict) else {}
    return {
        **analysis,
        "mode": "vision",
        "analysis_provider": analysis_provider,
        "cloud_vision": analysis_provider == "gemini",
        "cloud_vision_enabled": settings.cloud_vision_enabled,
        "prompt": primary.get("prompt") or _mock_analysis()["soundCards"][0]["prompt"],
        "duration": primary.get("durationSeconds") or 6,
    }
