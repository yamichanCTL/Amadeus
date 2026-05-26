"""
app/schemas/transcribe.py
─────────────────────────
Request and response Pydantic models for the transcription endpoints.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.core.asr.registry import available_engines


# ── Segment (one time-stamped chunk in the result) ────────────────────────────

class TranscriptSegment(BaseModel):
    start: float = Field(..., ge=0, description="Start time in seconds")
    end: float = Field(..., ge=0, description="End time in seconds")
    text: str
    speaker: str | None = None          # set when diarization is enabled
    confidence: float | None = Field(None, ge=0.0, le=1.0)

    model_config = {"from_attributes": True}


# ── Per-engine result (used in multi-engine runs) ─────────────────────────────

class EngineResult(BaseModel):
    engine: str
    full_text: str
    segments: list[TranscriptSegment] = []
    language: str | None = None
    confidence: float | None = None


# ── Transcription request (query params / form fields) ───────────────────────

class TranscribeOptions(BaseModel):
    """
    Options accepted alongside the audio file upload.
    All fields are optional; defaults come from app config.
    """

    engines: list[str] = Field(
        default=["fireredasr2"],
        description="One or more engine names. Multiple = parallel run + merge.",
        examples=[["fireredasr2"], ["fireredasr2", "whisper"]],
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
    enable_diarize: bool | None = None

    # Merge strategy when multiple engines are selected
    merge_strategy: Literal["first", "vote", "concat"] = "first"

    # Uploaded audio/result archive. Enabled by default so recognition records
    # are written under user/day/type for both short and long audio.
    allow_server_data_collection: bool = True
    archive_dir: str | None = None
    archive_category: str | None = None

    @field_validator("engines")
    @classmethod
    def validate_engines(cls, v: list[str]) -> list[str]:
        allowed = set(available_engines())
        unknown = set(v) - allowed
        if unknown:
            raise ValueError(f"Unknown engine(s): {unknown}. Allowed: {allowed}")
        if not v:
            raise ValueError("At least one engine must be specified.")
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

    # Present only in multi-engine runs
    engine_results: list[EngineResult] | None = None

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
