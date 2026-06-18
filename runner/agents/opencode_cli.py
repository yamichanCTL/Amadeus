"""
OpenCode CLI adapter.

Wraps the `opencode` CLI (terminal-native coding agent).

Command pattern:
    opencode <task>
"""

from __future__ import annotations

from pathlib import Path

from runner.agents.cli_base import CliAgentAdapter
from runner.core.task import AgentRunRequest


class OpenCodeCliAdapter(CliAgentAdapter):
    """Adapter for the OpenCode CLI."""

    name = "opencode"
    binary = "opencode"

    def _build_command(self, request: AgentRunRequest, cwd: Path) -> list[str]:
        command = [self.binary, request.task]
        if request.extra_args:
            command[1:1] = request.extra_args
        return command
