"""
app/schemas/skill.py
───────────────────
Schemas for the agent skill registry and execution.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class SkillParameter(BaseModel):
    name: str
    type: str = "string"  # string, number, boolean
    description: str = ""
    required: bool = False
    default: Any = None


class SkillDefinition(BaseModel):
    """Public-facing description of a registered skill."""
    name: str
    description: str
    parameters: list[SkillParameter] = []
    category: str = "general"  # audio, code, fs, model, agent


class SkillListResponse(BaseModel):
    skills: list[SkillDefinition]
    total: int


class SkillExecuteRequest(BaseModel):
    skill: str = Field(..., min_length=1)
    parameters: dict[str, Any] = {}


class SkillExecuteResult(BaseModel):
    skill: str
    success: bool
    output: str = ""
    error: str | None = None
    metadata: dict[str, Any] = {}
