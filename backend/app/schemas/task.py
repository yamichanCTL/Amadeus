"""
app/schemas/task.py
───────────────────
Schemas for task status queries and auth endpoints.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.llm import LLMOutputs
from app.schemas.transcribe import TranscriptSegment


# ── Task status ───────────────────────────────────────────────────────────────

class TaskStatusResponse(BaseModel):
    id: str
    status: str
    engines: str
    filename: str | None = None
    duration_sec: float | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    elapsed_sec: float | None = None
    error_message: str | None = None

    # Populated once status == "success"
    full_text: str | None = None
    segments: list[TranscriptSegment] | None = None
    language: str | None = None
    engine_used: str | None = None
    confidence: float | None = None
    llm_outputs: LLMOutputs | None = None
    llm_error: str | None = None

    model_config = {"from_attributes": True}


class TaskListResponse(BaseModel):
    tasks: list[TaskStatusResponse]
    total: int
    limit: int
    offset: int


# ── Auth ──────────────────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=64)
    password: str = Field(..., min_length=8)


class UserResponse(BaseModel):
    id: str
    username: str
    is_active: bool

    model_config = {"from_attributes": True}


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TokenData(BaseModel):
    username: str | None = None
