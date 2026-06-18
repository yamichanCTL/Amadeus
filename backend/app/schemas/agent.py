"""
Schemas for delegating work to local coding agents.

Now uses runner's AgentRouter under the hood with automatic fallback.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


AgentName = Literal["codex", "claude", "claudecode", "claude_code", "opencode", "mock"]
AgentSandbox = Literal["read-only", "workspace-write"]


class AgentDelegateRequest(BaseModel):
    agent: AgentName = "claude_code"
    prompt: str = Field(..., min_length=1, max_length=12000)
    cwd: str | None = None
    model: str | None = None
    sandbox: AgentSandbox = "workspace-write"
    timeout_sec: int = Field(180, ge=5, le=900)

    @field_validator("prompt")
    @classmethod
    def prompt_non_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


class AgentDelegateResult(BaseModel):
    agent: str  # Now dynamic — includes mock, claude_code, etc.
    cwd: str = ""
    command: list[str] = []
    exit_code: int | None = None
    timed_out: bool = False
    stdout: str = ""
    stderr: str = ""
    final_message: str = ""
    elapsed_sec: float = 0.0
    available: bool = True
    summary: str = ""
    fallback_used: bool = False
    fallback_reason: str = ""
