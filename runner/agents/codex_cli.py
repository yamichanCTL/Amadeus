"""
Codex CLI adapter.

Wraps the `codex` CLI: https://github.com/openai/codex

Command pattern:
    codex exec --cd <cwd> --ask-for-approval never - <task>
"""

from __future__ import annotations

from pathlib import Path

from runner.agents.cli_base import CliAgentAdapter
from runner.core.task import AgentRunRequest


class CodexCliAdapter(CliAgentAdapter):
    """Adapter for the Codex CLI."""

    name = "codex"
    binary = "codex"

    def _build_command(self, request: AgentRunRequest, cwd: Path) -> list[str]:
        command = [
            self.binary,
            "exec",
            "--cd",
            str(cwd),
            "--ask-for-approval",
            "never",
            "-",
        ]
        # Insert extra_args after exec but before the positional args
        if request.extra_args:
            command[1:1] = request.extra_args
        return command
