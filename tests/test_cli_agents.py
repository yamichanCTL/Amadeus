"""Tests for CLI agent adapters."""

from __future__ import annotations

import pytest

from runner.agents.codex_cli import CodexCliAdapter
from runner.agents.claude_code_cli import ClaudeCodeCliAdapter
from runner.agents.opencode_cli import OpenCodeCliAdapter
from runner.agents.mock_agent import MockAgentAdapter
from runner.core.task import AgentRunRequest


class TestMockAgent:
    """MockAgent should always be available and return success."""

    def test_always_available(self) -> None:
        agent = MockAgentAdapter()
        assert agent.check_available() is True
        assert agent.name == "mock"

    def test_returns_success_for_any_task(self) -> None:
        agent = MockAgentAdapter()
        request = AgentRunRequest(task="分析项目结构")
        result = agent.run(request)
        assert result.success is True
        assert result.available is True
        assert result.agent_name == "mock"
        assert result.exit_code == 0
        assert "MockAgent" in result.stdout

    def test_dry_run(self) -> None:
        agent = MockAgentAdapter()
        request = AgentRunRequest(task="test task", dry_run=True)
        result = agent.run(request)
        assert result.dry_run is True
        assert result.success is True
        assert "[DRY RUN]" in result.summary

    def test_empty_task_raises(self) -> None:
        with pytest.raises(ValueError, match="must not be blank"):
            AgentRunRequest(task="")


@pytest.mark.parametrize(
    "adapter_cls, expected_name",
    [
        (CodexCliAdapter, "codex"),
        (ClaudeCodeCliAdapter, "claude_code"),
        (OpenCodeCliAdapter, "opencode"),
    ],
)
class TestCliAdapters:
    """Test real CLI adapter construction and availability checks."""

    def test_name(self, adapter_cls, expected_name) -> None:
        adapter = adapter_cls()
        assert adapter.name == expected_name

    def test_check_available_does_not_raise(self, adapter_cls, expected_name) -> None:
        adapter = adapter_cls()
        # check_available should never raise, just return bool
        result = adapter.check_available()
        assert isinstance(result, bool)

    def test_unavailable_returns_fallback_result(self, adapter_cls, expected_name) -> None:
        """If the CLI is not on PATH, the result should indicate unavailable."""
        adapter = adapter_cls()
        if adapter.check_available():
            pytest.skip(f"{adapter.name} is available on this system, skipping unavailable test")
        request = AgentRunRequest(task="test task")
        result = adapter.run(request)
        assert result.agent_name == adapter.name
        assert result.available is False
        assert result.success is False
        # Should never raise
        assert result.summary != ""


class TestAgentRunRequest:
    """Tests for AgentRunRequest validation."""

    def test_valid_request(self) -> None:
        req = AgentRunRequest(task="分析项目")
        assert req.task == "分析项目"
        assert req.timeout_seconds == 300
        assert req.dry_run is False

    def test_custom_timeout(self) -> None:
        req = AgentRunRequest(task="test", timeout_seconds=60)
        assert req.timeout_seconds == 60

    def test_extra_args_and_env(self) -> None:
        req = AgentRunRequest(
            task="test",
            extra_args=["--verbose"],
            env={"DEBUG": "1"},
        )
        assert req.extra_args == ["--verbose"]
        assert req.env == {"DEBUG": "1"}
