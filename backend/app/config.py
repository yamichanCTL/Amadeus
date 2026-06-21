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

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
_PROJECT_ROOT = _BACKEND_ROOT.parent if _BACKEND_ROOT.name == "backend" else _BACKEND_ROOT


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_BACKEND_ROOT / ".env"),
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
    database_url: str = f"sqlite+aiosqlite:///{_PROJECT_ROOT / 'data/asr.db'}"

    # ── Redis / Celery ────────────────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str = "redis://localhost:6379/2"

    # ── Paths ─────────────────────────────────────────────────────────────────
    models_dir: Path = _BACKEND_ROOT / "models"
    audio_upload_dir: Path = _PROJECT_ROOT / "data/uploads"
    transcript_dir: Path = _PROJECT_ROOT / "data/transcripts"
    archive_dir: Path = _PROJECT_ROOT / "data/archive"

    # ── ASR engine defaults ───────────────────────────────────────────────────
    default_engine: str = "fireredasr2"
    default_stream_engine: str = "x-asr"
    preload_default_engine: bool = False

    # SenseVoice
    sensevoice_model_dir: Path = _BACKEND_ROOT / "models/SenseVoiceSmall"
    sensevoice_src_path: Path = Path("/home/yami/AI/audio/ASR/SenseVoice")
    default_sensevoice_device: str = "cuda:0"
    sensevoice_batch_size_s: int = 60

    # FireRedASR2
    fireredasr2_src_path: Path | None = None
    default_fireredasr2_model: str = "FireRedASR2-AED"
    default_fireredasr2_device: Literal["cpu", "cuda"] = "cuda"
    fireredasr2_model_dir: Path = _BACKEND_ROOT / "models/fireredasr2/FireRedASR2-AED"
    fireredasr2_asr_type: Literal["aed", "llm"] = "aed"
    fireredasr2_beam_size: int = 3
    fireredasr2_batch_size: int = 1
    fireredasr2_return_timestamp: bool = True
    fireredasr2_use_half: bool = False

    # FireRedVAD for native streaming endpoint detection
    firered_vad_src_path: Path | None = None
    firered_vad_model_dir: Path = _BACKEND_ROOT / "models/fireredasr2/FireRedVAD/Stream-VAD"
    firered_vad_use_gpu: bool = False
    firered_vad_speech_threshold: float = 0.25

    # Whisper
    default_whisper_model: str = "base"
    default_whisper_device: Literal["cpu", "cuda"] = "cuda"
    default_whisper_compute_type: Literal["int8", "float16", "float32"] = "float16"

    # Qwen3-ASR
    default_qwen3asr_model: str = "Qwen/Qwen3-ASR-1.7B"
    qwen3asr_model_dir: Path = _BACKEND_ROOT / "models/Qwen3-ASR-1.7B"
    default_qwen3asr_device: str = "cuda:0"
    qwen3asr_torch_dtype: str = "bfloat16"

    # X-ASR true streaming Zipformer
    default_x_asr_model: str = "chunk-160ms-model"
    x_asr_model_dir: Path = (
        _PROJECT_ROOT
        / "thirdparty/X-ASR/X-ASR-zh-en/deployment/models/chunk-160ms-model"
    )
    default_x_asr_provider: Literal["cpu", "cuda"] = "cuda"
    x_asr_num_threads: int = 1
    x_asr_text_format: Literal["none", "lower", "capitalize"] = "none"
    x_asr_cuda_library_path: str = ""

    # ── Pipeline feature flags ─────────────────────────────────────────────
    enable_vad: bool = False
    enable_denoise: bool = False
    enable_punctuation: bool = False
    punctuation_model: str = "ct-punc"
    punctuation_device: str = "cpu"

    # ── Streaming ASR ─────────────────────────────────────────────────────
    stream_sample_rate: int = 16000
    stream_ring_keep_ms: int = 3000
    stream_pre_roll_ms: int = 700
    stream_end_silence_ms: int = 700
    stream_start_speech_ms: int = 80
    stream_min_segment_ms: int = 300
    stream_max_segment_ms: int = 10000
    stream_hard_max_segment_ms: int = 15000
    stream_tail_keep_ms: int = 1000
    stream_archive_category: str = "实时转录"
    upload_archive_category: str = "一段语音转写"

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

    # ── LLM defaults (for frontend auto-configuration) ────────────────────────
    llm_default_api_token: str = ""
    llm_default_base_url: str = "https://api.deepseek.com"
    llm_default_model: str = "deepseek-chat"
    llm_default_provider: str = "deepseek"

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
        self._resolve_relative_paths()
        self._resolve_database_url()
        for path in (
            self.models_dir,
            self.audio_upload_dir,
            self.transcript_dir,
            self.archive_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
        # Create per-engine model subdirs
        for engine in ("fireredasr2", "whisper", "sensevoice", "qwen3asr"):
            (self.models_dir / engine).mkdir(parents=True, exist_ok=True)
        # DB directory
        if self.database_url.startswith("sqlite"):
            db_path = self.database_url.replace("sqlite+aiosqlite:///", "").replace("sqlite:///", "")
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        return self

    def _resolve_relative_paths(self) -> None:
        """Resolve local paths independently of the process cwd."""
        data_path_fields = (
            "audio_upload_dir",
            "transcript_dir",
            "archive_dir",
        )
        model_path_fields = (
            "models_dir",
            "sensevoice_model_dir",
            "sensevoice_src_path",
            "fireredasr2_model_dir",
            "firered_vad_model_dir",
            "qwen3asr_model_dir",
            "x_asr_model_dir",
        )
        for name in data_path_fields:
            value = getattr(self, name)
            if isinstance(value, Path) and not value.is_absolute():
                setattr(self, name, (_PROJECT_ROOT / value).resolve())

        for name in model_path_fields:
            value = getattr(self, name)
            if isinstance(value, Path) and not value.is_absolute():
                setattr(self, name, (_BACKEND_ROOT / value).resolve())

        if self.fireredasr2_src_path is not None and not self.fireredasr2_src_path.is_absolute():
            self.fireredasr2_src_path = (_BACKEND_ROOT / self.fireredasr2_src_path).resolve()
        if self.firered_vad_src_path is not None and not self.firered_vad_src_path.is_absolute():
            self.firered_vad_src_path = (_BACKEND_ROOT / self.firered_vad_src_path).resolve()

    def _resolve_database_url(self) -> None:
        """Resolve relative SQLite database paths against the project data root."""
        for prefix in ("sqlite+aiosqlite:///", "sqlite:///"):
            if not self.database_url.startswith(prefix):
                continue
            db_path = self.database_url.removeprefix(prefix)
            if db_path == ":memory:":
                return
            path = Path(db_path)
            if not path.is_absolute():
                path = (_PROJECT_ROOT / path).resolve()
                self.database_url = f"{prefix}{path}"
            return

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

    def fireredasr2_model_path(self, model_name: str | None = None) -> Path:
        if model_name is None or model_name == self.default_fireredasr2_model:
            return self.fireredasr2_model_dir
        return self.models_dir / "fireredasr2" / model_name

    def sensevoice_model_path(self) -> Path:
        return self.sensevoice_model_dir

    def qwen3asr_model_path(self, model_name: str | None = None) -> Path:
        if model_name is None or model_name == self.default_qwen3asr_model:
            return self.qwen3asr_model_dir
        return self.models_dir / "qwen3asr" / model_name


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """
    Return a cached Settings singleton.
    Call `get_settings.cache_clear()` in tests to reload config.
    """
    return Settings()
