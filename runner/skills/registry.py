"""
Skill Registry — central registry for skill discovery and execution.

Skills are registered by name and executed with parameter validation.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from runner.skills.base import SkillCall, SkillResult

logger = logging.getLogger("asrapp.skills")

SkillHandler = Callable[..., SkillResult]


class SkillRegistry:
    """Registry of named skills with parameter validation.

    Usage::

        registry = SkillRegistry()
        registry.register("my_skill", handler_fn, ["param1"], "Does something")
        result = registry.execute(SkillCall(name="my_skill", params={"param1": "value"}))
    """

    def __init__(self) -> None:
        self._skills: dict[str, dict[str, Any]] = {}
        self._register_builtins()

    def register(
        self,
        name: str,
        handler: SkillHandler,
        required_params: list[str] | None = None,
        description: str = "",
    ) -> None:
        """Register a skill."""
        self._skills[name] = {
            "handler": handler,
            "required_params": required_params or [],
            "description": description,
        }
        logger.debug("Registered skill: %s", name)

    def list_skills(self) -> list[dict[str, Any]]:
        """Return all registered skill names and descriptions."""
        return [
            {"name": name, "description": info["description"]}
            for name, info in self._skills.items()
        ]

    def has(self, name: str) -> bool:
        """Check if a skill is registered."""
        return name in self._skills

    def execute(self, call: SkillCall) -> SkillResult:
        """Execute a skill by name with parameter validation.

        Returns SkillResult (never raises).
        """
        name = call.name

        if name not in self._skills:
            return SkillResult(
                skill=name,
                success=False,
                error=f"Unknown skill: {name}",
            )

        info = self._skills[name]
        handler: SkillHandler = info["handler"]

        # Validate required params
        missing = [p for p in info["required_params"] if p not in call.params]
        if missing:
            return SkillResult(
                skill=name,
                success=False,
                error=f"Missing required parameters: {', '.join(missing)}",
            )

        try:
            result = handler(**call.params)
            result.skill = name
            logger.info(
                "Skill executed: %s success=%s caller=%s",
                name, result.success, call.caller,
            )
            return result
        except Exception as exc:
            logger.error("Skill '%s' failed: %s", name, exc)
            return SkillResult(
                skill=name,
                success=False,
                error=f"{type(exc).__name__}: {exc}",
            )

    def _register_builtins(self) -> None:
        """Register all built-in skills on initialization."""
        from runner.skills.builtins import register_all

        register_all(self)
