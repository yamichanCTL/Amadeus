"""
MockAgent adapter — always-available fallback.

Returns simulated results. Never fails.
Used when no real CLI agent is available.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path

from runner.agents.cli_base import CliAgentAdapter
from runner.core.task import AgentRunRequest, AgentRunResult

_MOCK_STDOUT_TEMPLATE = """[MockAgent] Simulated execution for task:

    {task}

Working directory: {cwd}

The MockAgent is running in simulated mode. In production, this task
would be executed by a real CLI agent (Codex, Claude Code, or OpenCode).

No actual code changes or shell commands were executed.
"""


class MockAgentAdapter(CliAgentAdapter):
    """Always-available mock agent for fallback and testing.

    This agent never touches the filesystem or runs commands.
    It returns a fixed success response for any task.
    """

    name = "mock"
    binary = "mock"  # Never checked — always "available"

    def check_available(self) -> bool:
        """MockAgent is always available."""
        return True

    def _build_command(self, request: AgentRunRequest, cwd: Path) -> list[str]:
        """MockAgent never runs a command — this is only for display."""
        return ["[MockAgent]", "simulated"]

    async def run_async(self, request: AgentRunRequest) -> AgentRunResult:
        """Override to avoid subprocess entirely for mock agent."""
        started_at = datetime.now(timezone.utc).isoformat()
        started_perf = time.perf_counter()

        cwd = str(Path(request.cwd).resolve()) if request.cwd else str(Path.cwd())

        if request.dry_run:
            finished_at = datetime.now(timezone.utc).isoformat()
            return AgentRunResult(
                agent_name=self.name,
                success=True,
                available=True,
                summary=f"[DRY RUN] MockAgent would process: {request.task[:100]}",
                command=["[MockAgent]", "simulated"],
                started_at=started_at,
                finished_at=finished_at,
                duration_seconds=round(time.perf_counter() - started_perf, 3),
                dry_run=True,
            )

        # Simulate some processing time (short)
        stdout = _MOCK_STDOUT_TEMPLATE.format(task=request.task, cwd=cwd)

        finished_at = datetime.now(timezone.utc).isoformat()
        duration = round(time.perf_counter() - started_perf, 3)

        return AgentRunResult(
            agent_name=self.name,
            success=True,
            available=True,
            exit_code=0,
            stdout=stdout,
            stderr="",
            summary=f"MockAgent simulated task successfully in {duration}s",
            command=["[MockAgent]", "simulated"],
            started_at=started_at,
            finished_at=finished_at,
            duration_seconds=duration,
            dry_run=request.dry_run,
        )
