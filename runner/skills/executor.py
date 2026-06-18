"""
FunctionExecutor — structured execution wrapper for skills.

Handles logging, permission checks, and error boundaries.
"""

from __future__ import annotations

import logging
from typing import Any

from runner.skills.base import SkillCall, SkillResult
from runner.skills.registry import SkillRegistry

logger = logging.getLogger("asrapp.skills")


class FunctionExecutor:
    """Executes skills with logging, permission checks, and error handling.

    Wraps SkillRegistry.execute() with:
    - Call logging (before and after)
    - Permission boundary
    - Error capture (never raises)
    """

    def __init__(self, registry: SkillRegistry | None = None) -> None:
        self.registry = registry or SkillRegistry()

    def execute(self, call: SkillCall) -> SkillResult:
        """Execute a skill with full observability.

        Args:
            call: The skill call to execute.

        Returns:
            SkillResult (never raises).
        """
        logger.info(
            "Executing skill: %s params=%s caller=%s",
            call.name,
            {k: str(v)[:50] for k, v in call.params.items()},
            call.caller,
        )

        # Security: check skill permission before execution
        if not self._check_permission(call):
            return SkillResult(
                skill=call.name,
                success=False,
                error=f"Permission denied for skill: {call.name}",
                permission_denied=True,
            )

        result = self.registry.execute(call)

        logger.info(
            "Skill result: %s success=%s",
            call.name,
            result.success,
        )
        return result

    def list_skills(self) -> list[dict[str, Any]]:
        """List all available skills."""
        return self.registry.list_skills()

    @staticmethod
    def _check_permission(call: SkillCall) -> bool:
        """Check if the caller has permission to execute this skill.

        In phase 1, all built-in skills are allowed.
        High-risk skills (shell commands) have internal parameter validation.
        """
        # All built-in skills are allowed in phase 1
        # Security is enforced at the skill handler level
        # (path restrictions, command allowlists, etc.)
        return True
