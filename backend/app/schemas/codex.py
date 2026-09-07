"""Public contracts for ASR-to-Codex. Credentials never enter these models."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


class CodexOptions(BaseModel):
    session_id: str = Field(default="default", pattern=r"^[A-Za-z0-9_-]{1,80}$")
    model: str | None = Field(default=None, min_length=1, max_length=120, pattern=r"^[\w./:-]+$")
    effort: Literal["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] | None = (
        None
    )
    context: str = Field(default="", max_length=16000)
    timeout_sec: int = Field(180, ge=5, le=900)


class CodexTurnRequest(CodexOptions):
    text: str | None = Field(default=None, min_length=1, max_length=12000)
    task_id: str | None = Field(default=None, min_length=1, max_length=80)

    @model_validator(mode="after")
    def one_input(self) -> CodexTurnRequest:
        if self.text is not None:
            self.text = self.text.strip()
            if not self.text:
                raise ValueError("text must not be blank")
        if (self.text is None) == (self.task_id is None):
            raise ValueError("provide exactly one of text or a completed ASR task_id")
        return self


class StreamCodexOptions(CodexOptions):
    enabled: bool = False


class CodexUsage(BaseModel):
    input_tokens: int = Field(ge=0)
    cached_input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    reasoning_output_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)


class CodexTurnResult(BaseModel):
    call_id: str
    session_id: str
    thread_id: str = ""
    turn_id: str = ""
    status: Literal["completed", "failed", "cancelled", "timed_out"]
    model: str | None = None
    provider: str
    effort: str | None = None
    text: str = ""
    usage: CodexUsage | None = None
    elapsed_sec: float = 0
    error_code: str | None = None
    error: str | None = None
