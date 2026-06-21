"""
app/schemas/transcribe.py
─────────────────────────
Request and response Pydantic models for the transcription endpoints.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.core.asr.registry import available_engines
from app.schemas.llm import LLMAutoOptions, LLMOutputs


# ── Segment (one time-stamped chunk in the result) ────────────────────────────

class TranscriptSegment(BaseModel):
    start: float = Field(..., ge=0, description="Start time in seconds")
    end: float = Field(..., ge=0, description="End time in seconds")
    text: str
    confidence: float | None = Field(None, ge=0.0, le=1.0)

    model_config = {"from_attributes": True}


# ── Transcription request (query params / form fields) ───────────────────────

class TranscribeOptions(BaseModel):
    """
    Options accepted alongside the audio file upload.
    All fields are optional; defaults come from app config.
    """

    engine: str = Field(
        default="fireredasr2",
        description="Offline ASR engine name.",
        examples=["fireredasr2", "sensevoice"],
    )
    language: str | None = Field(
        None,
        description="BCP-47 language code, e.g. 'zh', 'en'. None = auto-detect.",
    )
    # Whisper-specific
    whisper_model: str | None = Field(None, description="Override default Whisper model size.")
    whisper_task: Literal["transcribe", "translate"] = "transcribe"

    # Pipeline toggles (override server-side defaults)
    enable_vad: bool | None = None
    enable_punctuation: bool | None = None

    enable_hotwords: bool = True

    # Uploaded audio/result archive. Enabled by default so recognition records
    # are written under user/day/type for both short and long audio.
    allow_server_data_collection: bool = True
    archive_dir: str | None = None
    archive_category: str | None = None
    user_id: str | None = Field(None, max_length=128, description="Desktop archive user ID.")
    llm: LLMAutoOptions | None = None

    @field_validator("engine")
    @classmethod
    def validate_engine(cls, v: str) -> str:
        allowed = set(available_engines())
        if v not in allowed:
            raise ValueError(f"Unknown engine: {v}. Allowed: {allowed}")
        if v == "x-asr":
            raise ValueError("x-asr is reserved for realtime streaming; choose an offline engine")
        return v


# ── Responses ─────────────────────────────────────────────────────────────────

class TranscribeResponse(BaseModel):
    """Returned for synchronous (short audio) requests."""

    task_id: str
    status: str
    full_text: str
    segments: list[TranscriptSegment] = []
    language: str | None = None
    engine_used: str
    confidence: float | None = None
    duration_sec: float | None = None
    elapsed_sec: float | None = None
    timing: dict[str, float] | None = None

    llm_outputs: LLMOutputs | None = None
    llm_error: str | None = None

    model_config = {"from_attributes": True}


class TranscribeAsyncResponse(BaseModel):
    """Returned immediately for async (long audio) requests."""

    task_id: str
    status: str
    message: str = "Task queued. Poll /v1/tasks/{task_id} for status."


# ── Model info ────────────────────────────────────────────────────────────────

class ModelInfo(BaseModel):
    engine: str
    model_name: str
    is_loaded: bool
    device: str | None = None
    compute_type: str | None = None
    languages: list[str] = []
    extra: dict[str, Any] = {}


class ModelsListResponse(BaseModel):
    engines: list[ModelInfo]
    default_engine: str
