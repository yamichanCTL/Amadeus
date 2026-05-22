"""
app/config.py
─────────────
Central configuration loaded from environment variables / .env file.
All other modules import `get_settings()` rather than reading env vars directly.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Application ───────────────────────────────────────────────────────────
    app_env: Literal["development", "production"] = "development"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    app_log_level: Literal["debug", "info", "warning", "error"] = "info"
    secret_key: str = Field(default="dev-secret-key-change-in-prod")

    # ── Database ──────────────────────────────────────────────────────────────
    database_url: str = "sqlite+aiosqlite:///./data/asr.db"

    # ── Redis / Celery ────────────────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str = "redis://localhost:6379/2"

    # ── Paths ─────────────────────────────────────────────────────────────────
    models_dir: Path = Path("./models")
    audio_upload_dir: Path = Path("./data/uploads")
    transcript_dir: Path = Path("./data/transcripts")
    archive_dir: Path = Path("./data/archive")

    # ── ASR engine defaults ───────────────────────────────────────────────────
    default_engine: str = "fireredasr2"
    preload_default_engine: bool = False

    # FireRedASR2
    fireredasr2_src_path: Path | None = None
    default_fireredasr2_model: str = "FireRedASR2-AED"
    default_fireredasr2_device: Literal["cpu", "cuda"] = "cuda"
    fireredasr2_model_dir: Path = Path("./models/fireredasr2/FireRedASR2-AED")
    fireredasr2_asr_type: Literal["aed", "llm"] = "aed"
    fireredasr2_beam_size: int = 3
    fireredasr2_batch_size: int = 1
    fireredasr2_return_timestamp: bool = True
    fireredasr2_use_half: bool = False

    # Whisper
    default_whisper_model: str = "base"
    default_whisper_device: Literal["cpu", "cuda"] = "cpu"
    default_whisper_compute_type: Literal["int8", "float16", "float32"] = "int8"

    # Vosk
    default_vosk_model: str = "vosk-model-cn-0.22"

    # Sherpa-onnx
    default_sherpa_model: str = (
        "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
    )

    # ── Pipeline feature flags ─────────────────────────────────────────────
    enable_vad: bool = False
    enable_denoise: bool = False
    enable_punctuation: bool = False
    enable_diarize: bool = False

    # ── Task / upload limits ──────────────────────────────────────────────────
    max_upload_size_mb: int = 500
    sync_max_duration_sec: float = 60.0
    celery_task_time_limit: int = 3600
    celery_task_always_eager: bool = False

    # ── Auth ──────────────────────────────────────────────────────────────────
    access_token_expire_minutes: int = 60
    algorithm: str = "HS256"

    # ── CORS ──────────────────────────────────────────────────────────────────
    allowed_origins: list[str] = ["http://localhost:3000", "http://localhost:5173"]

    # ─────────────────────────────────────────────────────────────────────────
    @field_validator("allowed_origins", mode="before")
    @classmethod
    def split_origins(cls, v: str | list[str]) -> list[str]:
        """Accept comma-separated string or list."""
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @model_validator(mode="after")
    def create_directories(self) -> "Settings":
        """Ensure all required directories exist at startup."""
        for path in (
            self.models_dir,
            self.audio_upload_dir,
            self.transcript_dir,
            self.archive_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
        # Create per-engine model subdirs
        for engine in ("fireredasr2", "whisper", "vosk", "sherpa"):
            (self.models_dir / engine).mkdir(parents=True, exist_ok=True)
        # DB directory
        if self.database_url.startswith("sqlite"):
            db_path = self.database_url.replace("sqlite+aiosqlite:///", "")
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        return self

    # ── Convenience helpers ───────────────────────────────────────────────────
    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def max_upload_size_bytes(self) -> int:
        return self.max_upload_size_mb * 1024 * 1024

    def whisper_model_path(self, model_name: str | None = None) -> Path:
        name = model_name or self.default_whisper_model
        return self.models_dir / "whisper" / name

    def vosk_model_path(self, model_name: str | None = None) -> Path:
        name = model_name or self.default_vosk_model
        return self.models_dir / "vosk" / name

    def sherpa_model_path(self, model_name: str | None = None) -> Path:
        name = model_name or self.default_sherpa_model
        return self.models_dir / "sherpa" / name

    def fireredasr2_model_path(self, model_name: str | None = None) -> Path:
        if model_name is None or model_name == self.default_fireredasr2_model:
            return self.fireredasr2_model_dir
        return self.models_dir / "fireredasr2" / model_name


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """
    Return a cached Settings singleton.
    Call `get_settings.cache_clear()` in tests to reload config.
    """
    return Settings()
