"""
app/schemas/llm.py
──────────────────
Schemas for OpenAI-compatible text post-processing.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


LLMOperation = Literal["polish", "translate"]


class LLMTextResult(BaseModel):
    operation: LLMOperation
    text: str
    model: str
    elapsed_sec: float | None = None


class LLMProcessRequest(BaseModel):
    text: str = Field(..., min_length=1)
    operation: LLMOperation
    model: str = Field(..., min_length=1)
    base_url: str = Field(..., min_length=1)
    api_token: str = Field(..., min_length=1)
    provider: str | None = None
    target_language: str | None = "English"
    style: str | None = None

    @field_validator("text", "model", "base_url", "api_token")
    @classmethod
    def non_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


class LLMAutoOptions(BaseModel):
    enable_polish: bool = False
    enable_translate: bool = False
    target_language: str = "English"
    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_token: str | None = None
    style: str | None = None


class LLMOutputs(BaseModel):
    polish: LLMTextResult | None = None
    translate: LLMTextResult | None = None


class LLMModelsRequest(BaseModel):
    base_url: str = Field(..., min_length=1)
    api_token: str = Field(..., min_length=1)
    provider: str | None = None

    @field_validator("base_url", "api_token")
    @classmethod
    def models_non_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


class LLMModelsResult(BaseModel):
    connected: bool
    models: list[str] = []
    provider: str | None = None
    base_url: str
    status_code: int | None = None
    message: str | None = None
    elapsed_sec: float | None = None


class ArchiveSummaryRequest(BaseModel):
    date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    user_id: str | None = None
    category: str | None = None
    start_time: str | None = Field(None, pattern=r"^\d{2}:\d{2}(:\d{2})?$")
    end_time: str | None = Field(None, pattern=r"^\d{2}:\d{2}(:\d{2})?$")
    provider: str | None = None
    model: str = Field(..., min_length=1)
    base_url: str = Field(..., min_length=1)
    api_token: str = Field(..., min_length=1)
    prompt: str | None = None
    style: str | None = "工作纪要"
    max_input_chars: int = Field(24000, ge=4000, le=120000)

    @field_validator("model", "base_url", "api_token")
    @classmethod
    def summary_non_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


class ArchiveSummaryResult(BaseModel):
    summary: str
    model: str
    provider: str | None = None
    elapsed_sec: float | None = None
    source_count: int
    input_chars: int
    estimated_input_tokens: int
    chunk_count: int = 1
    truncated: bool = False
    date: str
    time_range: str | None = None


class ArchiveSummarySaveRequest(BaseModel):
    summary: ArchiveSummaryResult
    user_id: str | None = None
    category: str | None = "当日总结"


class ArchiveSummarySaveResult(BaseModel):
    saved: bool
    path: str
