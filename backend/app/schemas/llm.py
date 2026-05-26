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
    model: str | None = None
    base_url: str | None = None
    api_token: str | None = None
    style: str | None = None


class LLMOutputs(BaseModel):
    polish: LLMTextResult | None = None
    translate: LLMTextResult | None = None

