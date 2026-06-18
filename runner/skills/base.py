"""
Skill base types — structured input/output for all skills.

Every skill receives a SkillCall and returns a SkillResult.
Skills must NOT execute arbitrary code or access paths outside the project.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class SkillCall:
    """A validated call to a named skill.

    Attributes:
        name: Skill name (e.g. "get_project_tree").
        params: Keyword arguments for the skill.
        caller: Identifier of who/what invoked the skill.
    """

    name: str
    params: dict[str, Any] = field(default_factory=dict)
    caller: str = "unknown"

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("skill name must not be blank")


@dataclass
class SkillResult:
    """Structured result from a skill execution.

    Attributes:
        skill: Name of the skill that was called.
        success: True if the skill completed without error.
        output: Human-readable output (truncated if very long).
        error: Error message if success is False.
        metadata: Additional structured data.
        permission_denied: True if the call was blocked by security policy.
    """

    skill: str
    success: bool = False
    output: str = ""
    error: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    permission_denied: bool = False

    def to_log_entry(self) -> dict[str, Any]:
        """Convert to a loggable dictionary."""
        return {
            "skill": self.skill,
            "success": self.success,
            "output": self.output[:200] if self.output else "",
            "error": self.error[:200] if self.error else "",
            "permission_denied": self.permission_denied,
            **self.metadata,
        }
