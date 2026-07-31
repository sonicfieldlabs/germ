from __future__ import annotations

import math
import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

from server.identity import PRODUCT_NAME


PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / ".env")
DEFAULT_ALLOWED_HOSTS = {"localhost", "127.0.0.1", "testserver"}


def _env(name: str, default: str | None = None, *, legacy: str | None = None) -> str | None:
    value = os.getenv(name)
    if value is not None:
        return value
    if legacy:
        legacy_value = os.getenv(legacy)
        if legacy_value is not None:
            return legacy_value
    return default


def _path_from_env(name: str, default: str, *, legacy: str | None = None) -> Path:
    value = _env(name, default, legacy=legacy) or default
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return path


def _path_list_from_env(name: str, defaults: list[Path], *, legacy: str | None = None) -> list[Path]:
    raw = _env(name, legacy=legacy)
    if not raw:
        return [path.resolve() for path in defaults]
    paths: list[Path] = []
    for item in raw.split(","):
        value = item.strip()
        if not value:
            continue
        path = Path(value).expanduser()
        if not path.is_absolute():
            path = PROJECT_ROOT / path
        paths.append(path.resolve())
    return paths or [path.resolve() for path in defaults]


def _float_from_env(
    name: str,
    default: float,
    *,
    legacy: str | None = None,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    raw = _env(name, str(default), legacy=legacy)
    try:
        value = float(raw) if raw is not None else default
    except (TypeError, ValueError, OverflowError):
        return default
    if not math.isfinite(value):
        return default
    if minimum is not None and value < minimum:
        return default
    if maximum is not None and value > maximum:
        return default
    return value


def _int_from_env(
    name: str,
    default: int,
    *,
    legacy: str | None = None,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    raw = _env(name, str(default), legacy=legacy)
    try:
        value = int(raw) if raw is not None else default
    except (TypeError, ValueError, OverflowError):
        return default
    if minimum is not None and value < minimum:
        return default
    if maximum is not None and value > maximum:
        return default
    return value


class Settings:
    server_name = PRODUCT_NAME
    engine_name = "stable-audio-3"

    def __init__(self) -> None:
        self.project_root = PROJECT_ROOT
        self.host = _env("GERM_HOST", "127.0.0.1", legacy="GERMINATOR_HOST") or "127.0.0.1"
        self.port = _int_from_env(
            "GERM_PORT",
            5178,
            legacy="GERMINATOR_PORT",
            minimum=1,
            maximum=65535,
        )
        self.active_provider = _env(
            "GERM_ACTIVE_PROVIDER",
            "mock",
            legacy="GERMINATOR_ACTIVE_PROVIDER",
        ) or "mock"
        self.default_model = _env(
            "GERM_DEFAULT_MODEL",
            "small-sfx",
            legacy="GERMINATOR_DEFAULT_MODEL",
        ) or "small-sfx"
        self.default_device = _env(
            "GERM_DEFAULT_DEVICE",
            "auto",
            legacy="GERMINATOR_DEFAULT_DEVICE",
        ) or "auto"
        self.output_root = _path_from_env(
            "GERM_OUTPUT_DIR",
            "output",
            legacy="GERMINATOR_OUTPUT_DIR",
        )
        self.audio_dir = self.output_root / "audio"
        self.metadata_dir = self.output_root / "metadata"
        self.upload_dir = self.output_root / "uploads"
        self.scratch_dir = self.output_root / "scratch"
        self.wavetable_dir = self.output_root / "wavetables"
        self.wavetable_metadata_dir = self.wavetable_dir / "metadata"
        self.wavetable_data_dir = self.wavetable_dir / "tables"
        self.wavetable_preview_dir = self.wavetable_dir / "previews"
        self.micro_biome_dir = self.output_root / "micro" / "biomes"
        self.session_dir = self.output_root / "sessions"
        self.allowed_input_roots = _path_list_from_env(
            "GERM_ALLOWED_INPUT_ROOTS",
            [self.output_root],
            legacy="GERMINATOR_ALLOWED_INPUT_ROOTS",
        )
        self.official_repo_dir = _path_from_env(
            "GERM_OFFICIAL_REPO_DIR",
            "vendor/stable-audio-3",
            legacy="GERMINATOR_OFFICIAL_REPO_DIR",
        )
        self.mlx_repo_dir = _path_from_env(
            "GERM_MLX_REPO_DIR",
            "vendor/stable-audio-3",
            legacy="GERMINATOR_MLX_REPO_DIR",
        )
        self.allowed_model_roots = _path_list_from_env(
            "GERM_ALLOWED_MODEL_ROOTS",
            [self.official_repo_dir, self.mlx_repo_dir, self.output_root],
            legacy="GERMINATOR_ALLOWED_MODEL_ROOTS",
        )
        self.mlx_decoder = _env(
            "GERM_MLX_DECODER",
            "same-s",
            legacy="GERMINATOR_MLX_DECODER",
        ) or "same-s"
        self.provider_timeout_seconds = _float_from_env(
            "GERM_PROVIDER_TIMEOUT_SECONDS",
            1800.0,
            legacy="GERMINATOR_PROVIDER_TIMEOUT_SECONDS",
            minimum=1.0,
            maximum=86400.0,
        )
        self.job_workers = _int_from_env(
            "GERM_JOB_WORKERS",
            1,
            legacy="GERMINATOR_JOB_WORKERS",
            minimum=1,
            maximum=64,
        )
        self.stability_api_key = os.getenv("STABILITY_API_KEY", "")
        self.stability_api_url = (
            _env("GERM_STABILITY_API_URL", "https://api.stability.ai")
            or "https://api.stability.ai"
        ).rstrip("/")
        self.stability_poll_seconds = _float_from_env(
            "GERM_STABILITY_POLL_SECONDS",
            10.0,
            minimum=0.1,
            maximum=3600.0,
        )
        self.oida_url = (
            _env("GERM_OIDA_URL", "http://127.0.0.1:8765")
            or "http://127.0.0.1:8765"
        ).rstrip("/")
        self.oida_timeout_seconds = _float_from_env(
            "GERM_OIDA_TIMEOUT_SECONDS",
            1800.0,
            minimum=1.0,
            maximum=86400.0,
        )
        # Cosmoaudition remains a separate local instrument. Germ only talks
        # to its loopback API through the bounded bridge in
        # ``server.cosmoaudition``; it never calls observatory providers
        # directly.
        self.cosmoaudition_url = (
            _env("GERM_COSMOAUDITION_URL", "http://127.0.0.1:8797")
            or "http://127.0.0.1:8797"
        ).rstrip("/")
        self.cosmoaudition_timeout_seconds = _float_from_env(
            "GERM_COSMOAUDITION_TIMEOUT_SECONDS",
            20.0,
            minimum=0.25,
            maximum=120.0,
        )
        self.cosmoaudition_max_response_bytes = _int_from_env(
            "GERM_COSMOAUDITION_MAX_RESPONSE_BYTES",
            2 * 1024 * 1024,
            minimum=16 * 1024,
            maximum=16 * 1024 * 1024,
        )
        self.cosmoaudition_archive_dir = self.output_root / "cosmoaudition" / "archives"
        self.masa_dir = self.output_root / "masa"
        self.masa_sidecars_enabled = (
            _env("GERM_MASA_SIDECARS", "1") or "1"
        ).lower() in {"1", "true", "yes", "on"}
        self.allowed_hosts = self._parse_allowed_hosts()
        self.max_upload_bytes = int(
            _float_from_env(
                "GERM_MAX_UPLOAD_MB",
                100.0,
                legacy="GERMINATOR_MAX_UPLOAD_MB",
                minimum=0.1,
                maximum=4096.0,
            )
            * 1024
            * 1024
        )
        self.max_image_upload_bytes = int(
            _float_from_env(
                "GERM_MAX_IMAGE_MB",
                8.0,
                legacy="GERMINATOR_MAX_IMAGE_MB",
                minimum=0.1,
                maximum=100.0,
            )
            * 1024
            * 1024
        )
        self.listener_score_max_bytes = int(
            _float_from_env(
                "GERM_LISTENER_MAX_AUDIO_MB",
                50.0,
                legacy="GERMINATOR_LISTENER_MAX_AUDIO_MB",
                minimum=0.1,
                maximum=4096.0,
            )
            * 1024
            * 1024
        )
        self.listener_score_max_duration_seconds = _float_from_env(
            "GERM_LISTENER_MAX_DURATION_SECONDS",
            600.0,
            legacy="GERMINATOR_LISTENER_MAX_DURATION_SECONDS",
            minimum=1.0,
            maximum=86400.0,
        )
        self.cloud_vision_enabled = (
            _env(
                "GERM_ENABLE_CLOUD_VISION",
                "0",
                legacy="GERMINATOR_ENABLE_CLOUD_VISION",
            )
            or "0"
        ).lower() in {"1", "true", "yes", "on"}
        configured_gemini_model = (
            _env("GERM_GEMINI_MODEL", "gemini-3.5-flash") or "gemini-3.5-flash"
        ).strip()
        self.gemini_model = (
            configured_gemini_model
            if configured_gemini_model
            and len(configured_gemini_model) <= 128
            and all(character.isalnum() or character in "._-" for character in configured_gemini_model)
            else "gemini-3.5-flash"
        )

    def _parse_allowed_hosts(self) -> list[str]:
        raw = _env("GERM_ALLOWED_HOSTS", legacy="GERMINATOR_ALLOWED_HOSTS")
        if raw is None:
            hosts = set(DEFAULT_ALLOWED_HOSTS)
            if self.host and self.host not in {"0.0.0.0", "::"}:
                hosts.add(self.host)
            return sorted(hosts)
        entries = [item.strip() for item in raw.split(",") if item.strip()]
        if not entries:
            hosts = set(DEFAULT_ALLOWED_HOSTS)
            if self.host and self.host not in {"0.0.0.0", "::"}:
                hosts.add(self.host)
            return sorted(hosts)
        if "*" in entries:
            return ["*"]
        hosts = set(entries)
        hosts.add("testserver")
        return sorted(hosts)


@lru_cache
def get_settings() -> Settings:
    return Settings()
