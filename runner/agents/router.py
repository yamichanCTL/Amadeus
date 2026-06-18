"""
AgentRouter — selects and routes tasks to the appropriate CLI agent.

Priority order:
  1. Request-specified agent (if available)
  2. Agent detected from task text (keywords: claude, codex, opencode)
  3. Available CLI agents in default priority order (Claude Code first)
  4. MockAgent (always-available fallback)
"""

from __future__ import annotations

import re

from runner.agents.cli_base import CliAgentAdapter
from runner.agents.codex_cli import CodexCliAdapter
from runner.agents.claude_code_cli import ClaudeCodeCliAdapter
from runner.agents.opencode_cli import OpenCodeCliAdapter
from runner.agents.mock_agent import MockAgentAdapter
from runner.core.task import AgentRunRequest, AgentRunResult


# Default priority order: Claude Code → Codex → OpenCode
DEFAULT_PRIORITY = ["claude_code", "codex", "opencode"]

# Keywords mapping for detecting agent preference from task text
_AGENT_KEYWORDS: dict[str, str] = {
    "claude": "claude_code",
    "codex": "codex",
    "opencode": "opencode",
}

# Regex for matching agent mentions in Chinese or English context
_AGENT_DETECT_RE = re.compile(
    r"(?:使用|用|调用|通过|优先|请用|让|叫|选择|切换到|switch\s+to|use|using|with|via|prefer)\s*(?:cli\s*)?(claude|codex|opencode)",
    re.IGNORECASE,
)


def detect_agent_from_text(text: str) -> str | None:
    """Detect agent preference from natural-language task text.

    Examples:
        "请用 claude 分析项目结构" → "claude_code"
        "用 codex 帮我重构" → "codex"
        "use opencode to review" → "opencode"
        "分析项目结构" → None (no explicit preference)
    """
    # Try structured pattern first
    match = _AGENT_DETECT_RE.search(text)
    if match:
        keyword = match.group(1).lower()
        return _AGENT_KEYWORDS.get(keyword)

    # Fallback: simple keyword scan
    text_lower = text.lower()
    for keyword, agent_name in _AGENT_KEYWORDS.items():
        if keyword in text_lower:
            return agent_name

    return None


class AgentRouter:
    """Routes tasks to CLI agents with automatic fallback.

    The router maintains a registry of available adapters and selects
    the best one for each request. It NEVER throws — if no real agent
    is available, it falls back to MockAgent.
    """

    def __init__(self, adapters: list[CliAgentAdapter] | None = None) -> None:
        if adapters is not None:
            self._adapters: dict[str, CliAgentAdapter] = {a.name: a for a in adapters}
        else:
            self._adapters: dict[str, CliAgentAdapter] = {}
            # Register built-in adapters
            for cls in (CodexCliAdapter, ClaudeCodeCliAdapter, OpenCodeCliAdapter):
                adapter = cls()
                self._adapters[adapter.name] = adapter
        # MockAgent is always last-resort
        self._mock: MockAgentAdapter = MockAgentAdapter()
        # Cache availability on first check
        self._available_cache: dict[str, bool] = {}
        self._priority: list[str] = list(DEFAULT_PRIORITY)

    def register(self, adapter: CliAgentAdapter) -> None:
        """Register a new adapter."""
        self._adapters[adapter.name] = adapter
        self._available_cache.pop(adapter.name, None)

    @property
    def adapters(self) -> list[CliAgentAdapter]:
        """Return all registered adapters (excluding mock)."""
        return list(self._adapters.values())

    def available_agents(self) -> list[str]:
        """Return names of all currently available real agents."""
        available: list[str] = []
        for name in self._priority:
            adapter = self._adapters.get(name)
            if adapter is not None:
                if name not in self._available_cache:
                    self._available_cache[name] = adapter.check_available()
                if self._available_cache[name]:
                    available.append(name)
        return available

    def all_agents(self) -> list[str]:
        """Return names of all registered agents plus mock."""
        return list(self._adapters.keys()) + [self._mock.name]

    def route(self, request: AgentRunRequest) -> AgentRunResult:
        """Synchronous route — see route_async."""
        import asyncio

        return asyncio.run(self.route_async(request))

    async def route_async(self, request: AgentRunRequest) -> AgentRunResult:
        """Select an agent and execute the request.

        Routing logic:
        1. If request specifies an agent_name, try that agent first.
        2. Detect agent preference from task text (e.g. "用 claude 分析").
        3. If the specified agent is unavailable or none specified,
           try agents in priority order (Claude Code → Codex → OpenCode).
        4. If no real agent is available, use MockAgent.

        NEVER raises — always returns a result.
        """
        agent_name = request.agent_name

        # Step 0: Detect agent from task text if not explicitly set
        if not agent_name or agent_name == self._mock.name:
            detected = detect_agent_from_text(request.task)
            if detected:
                agent_name = detected

        # Step 1: If mock is explicitly requested, use it directly
        if agent_name == self._mock.name:
            return await self._mock.run_async(request)

        # Step 2: Try the requested/detected agent
        if agent_name:
            adapter = self._adapters.get(agent_name)
            if adapter is not None:
                if self._is_available(adapter):
                    return await adapter.run_async(request)
                else:
                    import logging

                    logging.getLogger("asrapp").warning(
                        "Requested agent %s is unavailable, falling back", agent_name
                    )

        # Step 3: Try priority order
        for name in self._priority:
            adapter = self._adapters.get(name)
            if adapter is not None and self._is_available(adapter):
                return await adapter.run_async(request)

        # Step 3: Fallback to MockAgent
        import logging

        logging.getLogger("asrapp").info(
            "No real CLI agent available, using MockAgent fallback"
        )
        return await self._mock.run_async(request)

    def _is_available(self, adapter: CliAgentAdapter) -> bool:
        """Check availability with caching."""
        if adapter.name not in self._available_cache:
            self._available_cache[adapter.name] = adapter.check_available()
        return self._available_cache[adapter.name]

    def clear_cache(self) -> None:
        """Clear the availability cache. Use after PATH changes."""
        self._available_cache.clear()

    def set_priority(self, priority: list[str]) -> None:
        """Set the agent priority order."""
        self._priority = list(priority)
