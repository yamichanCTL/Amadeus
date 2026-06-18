"""
Lightweight Skill system for asrapp.

Skills are small, deterministic tools — NOT a second agent framework.
Big tasks go to CLI agents (Codex/Claude/OpenCode).
Skills handle small, well-defined, reusable operations.
"""

from runner.skills.registry import SkillRegistry
from runner.skills.executor import FunctionExecutor

__all__ = ["SkillRegistry", "FunctionExecutor"]
