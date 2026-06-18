"""
Base class for CLI agent adapters.

Each adapter wraps a specific CLI tool (Codex, Claude Code, OpenCode).
Adapters are thin — they do NOT implement agent logic.
They only handle: availability check, subprocess call, result structuring.
"""

from __future__ import annotations

import abc
import asyncio
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from runner.core.config import DEFAULT_CWD, MAX_CAPTURE_CHARS, WORKSPACE_BOUND
from runner.core.task import AgentRunRequest, AgentRunResult

if TYPE_CHECKING:
    from runner.observability.logger import _LoggerProtocol


def _truncate(value: bytes | str, limit: int = MAX_CAPTURE_CHARS) -> str:
    """Truncate long output, keeping the tail."""
    text = value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value
    if len(text) <= limit:
        return text
    return "...(truncated)...\n" + text[-limit:]


def _resolve_cwd(cwd: str | None) -> Path:
    """Resolve and validate the working directory.

    If workspace_bound is enabled, the cwd must be inside PROJECT_ROOT.
    """
    if cwd is None:
        return DEFAULT_CWD
    resolved = Path(cwd).resolve()
    if WORKSPACE_BOUND:
        if resolved != DEFAULT_CWD and DEFAULT_CWD not in resolved.parents and resolved != DEFAULT_CWD:
            # Allow cwd that IS the project root or a child of it
            try:
                resolved.relative_to(DEFAULT_CWD)
            except ValueError:
                raise ValueError(
                    f"cwd must be inside project workspace ({DEFAULT_CWD}), got: {resolved}"
                )
    return resolved


class CliAgentAdapter(abc.ABC):
    """Abstract base for all CLI agent adapters.

    Subclasses must implement:
        name: str — the agent identifier (e.g. "codex", "claude_code")
        binary: str — the CLI binary name (e.g. "codex", "claude")
        _build_command(...) — construct the CLI argument list
    """

    name: str
    binary: str

    def check_available(self) -> bool:
        """Return True if the CLI binary is on PATH."""
        return shutil.which(self.binary) is not None

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        """Synchronous entry point — wraps the async run_async."""
        return asyncio.run(self.run_async(request))

    async def run_async(self, request: AgentRunRequest) -> AgentRunResult:
        """Execute the agent and return a structured result.

        NEVER raises on missing binary — returns available=False instead.
        """
        started_at = datetime.now(timezone.utc).isoformat()
        started_perf = time.perf_counter()

        # Check availability
        if not self.check_available():
            finished_at = datetime.now(timezone.utc).isoformat()
            return AgentRunResult(
                agent_name=self.name,
                success=False,
                available=False,
                summary=f"{self.name} CLI not found on PATH (binary: {self.binary})",
                started_at=started_at,
                finished_at=finished_at,
                duration_seconds=round(time.perf_counter() - started_perf, 3),
                dry_run=request.dry_run,
            )

        # Resolve cwd
        try:
            cwd = _resolve_cwd(request.cwd)
        except ValueError as e:
            return AgentRunResult(
                agent_name=self.name,
                success=False,
                available=True,
                summary=str(e),
                started_at=started_at,
                finished_at=datetime.now(timezone.utc).isoformat(),
                duration_seconds=round(time.perf_counter() - started_perf, 3),
                dry_run=request.dry_run,
            )

        # Build command
        command = self._build_command(request, cwd)

        # Dry run
        if request.dry_run:
            finished_at = datetime.now(timezone.utc).isoformat()
            return AgentRunResult(
                agent_name=self.name,
                success=True,
                available=True,
                summary=f"[DRY RUN] Would execute: {' '.join(command)}",
                command=command,
                started_at=started_at,
                finished_at=finished_at,
                duration_seconds=round(time.perf_counter() - started_perf, 3),
                dry_run=True,
            )

        # Execute
        exit_code = None
        stdout = ""
        stderr = ""
        success = False
        timed_out = False

        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                cwd=str(cwd),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**__import__("os").environ, **request.env} if request.env else None,
            )

            try:
                stdin_data = request.task.encode("utf-8")
                proc_stdout, proc_stderr = await asyncio.wait_for(
                    process.communicate(stdin_data),
                    timeout=request.timeout_seconds,
                )
            except asyncio.TimeoutError:
                timed_out = True
                process.kill()
                proc_stdout, proc_stderr = await process.communicate()

            exit_code = process.returncode
            stdout = _truncate(proc_stdout)
            stderr = _truncate(proc_stderr)
            success = exit_code == 0 and not timed_out

        except FileNotFoundError:
            # Race condition: binary disappeared between check and exec
            return AgentRunResult(
                agent_name=self.name,
                success=False,
                available=False,
                summary=f"{self.name} CLI binary vanished during execution",
                started_at=started_at,
                finished_at=datetime.now(timezone.utc).isoformat(),
                duration_seconds=round(time.perf_counter() - started_perf, 3),
                dry_run=request.dry_run,
            )

        finished_at = datetime.now(timezone.utc).isoformat()
        duration = round(time.perf_counter() - started_perf, 3)

        # Build summary
        if timed_out:
            summary = f"{self.name} timed out after {request.timeout_seconds}s"
        elif success:
            summary = f"{self.name} completed successfully in {duration}s"
        else:
            summary = f"{self.name} exited with code {exit_code} in {duration}s"

        return AgentRunResult(
            agent_name=self.name,
            success=success,
            available=True,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            summary=summary,
            command=command,
            started_at=started_at,
            finished_at=finished_at,
            duration_seconds=duration,
            dry_run=request.dry_run,
        )

    @abc.abstractmethod
    def _build_command(self, request: AgentRunRequest, cwd: Path) -> list[str]:
        """Build the CLI argument list for this agent.

        Args:
            request: The agent run request.
            cwd: Resolved working directory.

        Returns:
            List of command-line arguments (including the binary name).
        """
        ...
