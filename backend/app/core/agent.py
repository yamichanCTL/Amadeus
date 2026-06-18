"""
Agent bridge — delegates to CLI coding agents via runner's AgentRouter.

Now uses runner.agents.AgentRouter for:
- Unified CLI adapters (Codex, Claude Code, OpenCode)
- Automatic fallback to MockAgent when CLIs are unavailable
- Structured results with availability info
"""

from __future__ import annotations

import sys
from pathlib import Path

from app.schemas.agent import AgentDelegateRequest, AgentDelegateResult

# Ensure runner is importable
_RUNNER_ROOT = Path(__file__).resolve().parents[3]
if str(_RUNNER_ROOT) not in sys.path:
    sys.path.insert(0, str(_RUNNER_ROOT))


async def delegate_to_agent(request: AgentDelegateRequest) -> AgentDelegateResult:
    """Delegate a task to a CLI coding agent via runner's AgentRouter.

    Routes through AgentRouter with automatic fallback.
    NEVER raises FileNotFoundError — returns result with available=False instead.
    """
    from runner.agents.router import AgentRouter
    from runner.core.task import AgentRunRequest

    # Map agent name: backend uses "claude" for Claude Code, runner uses "claude_code"
    agent_name = request.agent
    if agent_name == "claude":
        agent_name = "claude_code"
    elif agent_name == "claudecode":
        agent_name = "claude_code"

    router = AgentRouter()
    runner_request = AgentRunRequest(
        task=request.prompt,
        cwd=request.cwd,
        agent_name=agent_name,
        timeout_seconds=request.timeout_sec,
        extra_args=(
            ["--model", request.model] if request.model else []
        ),
    )

    runner_result = await router.route_async(runner_request)

    # Detect fallback
    fallback_used = (
        runner_result.agent_name == "mock"
        or (agent_name and agent_name != "mock" and runner_result.agent_name != agent_name)
    )

    return AgentDelegateResult(
        agent=runner_result.agent_name,
        cwd=str(request.cwd or ""),
        command=runner_result.command,
        exit_code=runner_result.exit_code,
        timed_out=not runner_result.success and runner_result.available,
        stdout=runner_result.stdout,
        stderr=runner_result.stderr,
        final_message=(
            runner_result.stdout[:2000]
            if runner_result.stdout
            else runner_result.summary
        ),
        elapsed_sec=runner_result.duration_seconds,
        available=runner_result.available,
        summary=runner_result.summary,
        fallback_used=fallback_used,
        fallback_reason=(
            f"Agent '{request.agent}' not available, fell back to {runner_result.agent_name}"
            if fallback_used and runner_result.agent_name != request.agent
            else ""
        ),
    )
