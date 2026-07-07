from __future__ import annotations

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


class Settings:
    server_name = PRODUCT_NAME
    engine_name = "stable-audio-3"

    def __init__(self) -> None:
        self.project_root = PROJECT_ROOT
        self.host = _env("GERM_HOST", "127.0.0.1", legacy="GERMINATOR_HOST") or "127.0.0.1"
        self.port = int(_env("GERM_PORT", "5178", legacy="GERMINATOR_PORT") or "5178")
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
        self.provider_timeout_seconds = float(
            _env(
                "GERM_PROVIDER_TIMEOUT_SECONDS",
                "1800",
                legacy="GERMINATOR_PROVIDER_TIMEOUT_SECONDS",
            )
            or "1800"
        )
        self.job_workers = max(
            1,
            int(_env("GERM_JOB_WORKERS", "1", legacy="GERMINATOR_JOB_WORKERS") or "1"),
        )
        self.stability_api_key = os.getenv("STABILITY_API_KEY", "")
        self.allowed_hosts = self._parse_allowed_hosts()
        self.max_upload_bytes = int(
            float(_env("GERM_MAX_UPLOAD_MB", "100", legacy="GERMINATOR_MAX_UPLOAD_MB") or "100")
            * 1024
            * 1024
        )
        self.max_image_upload_bytes = int(
            float(_env("GERM_MAX_IMAGE_MB", "8", legacy="GERMINATOR_MAX_IMAGE_MB") or "8")
            * 1024
            * 1024
        )
        self.listener_score_max_bytes = int(
            float(
                _env(
                    "GERM_LISTENER_MAX_AUDIO_MB",
                    "50",
                    legacy="GERMINATOR_LISTENER_MAX_AUDIO_MB",
                )
                or "50"
            )
            * 1024
            * 1024
        )
        self.listener_score_max_duration_seconds = float(
            _env(
                "GERM_LISTENER_MAX_DURATION_SECONDS",
                "600",
                legacy="GERMINATOR_LISTENER_MAX_DURATION_SECONDS",
            )
            or "600"
        )
        self.cloud_vision_enabled = (
            _env(
                "GERM_ENABLE_CLOUD_VISION",
                "0",
                legacy="GERMINATOR_ENABLE_CLOUD_VISION",
            )
            or "0"
        ).lower() in {"1", "true", "yes", "on"}

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
