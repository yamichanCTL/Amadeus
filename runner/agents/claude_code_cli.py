"""
Claude Code CLI adapter.

Wraps the `claude` CLI (Anthropic's Claude Code).

Command pattern:
    claude -p <task>
"""

from __future__ import annotations

from pathlib import Path

from runner.agents.cli_base import CliAgentAdapter
from runner.core.task import AgentRunRequest


class ClaudeCodeCliAdapter(CliAgentAdapter):
    """Adapter for the Claude Code CLI (Anthropic)."""

    name = "claude_code"
    binary = "claude"

    def _build_command(self, request: AgentRunRequest, cwd: Path) -> list[str]:
        command = [
            self.binary,
            "-p",
            request.task,
        ]
        # Add cwd handling if needed
        if request.extra_args:
            command[1:1] = request.extra_args
        return command
