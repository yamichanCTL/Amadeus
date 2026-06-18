"""Tests for AgentRouter."""

from __future__ import annotations

from runner.agents.router import AgentRouter
from runner.agents.mock_agent import MockAgentAdapter
from runner.core.task import AgentRunRequest


class TestAgentRouter:
    """Test that AgentRouter correctly routes and falls back."""

    def test_router_has_mock_fallback(self) -> None:
        router = AgentRouter()
        # Even without any real CLI agents, the router should work
        agents = router.available_agents()
        assert isinstance(agents, list)

    def test_all_agents_includes_mock(self) -> None:
        router = AgentRouter()
        all_agents = router.all_agents()
        assert "mock" in all_agents
        assert "codex" in all_agents
        assert "claude_code" in all_agents
        assert "opencode" in all_agents

    def test_route_never_raises(self) -> None:
        router = AgentRouter()
        request = AgentRunRequest(task="测试任务", agent_name="mock")
        # Should never raise, even if no real CLI agents are available
        result = router.route(request)
        assert result is not None
        assert result.agent_name in router.all_agents()

    def test_route_returns_success(self) -> None:
        router = AgentRouter()
        request = AgentRunRequest(task="列出文件", agent_name="mock")
        result = router.route(request)
        assert result.success is True
        # If no real agent available, should fall back to mock
        if result.agent_name == "mock":
            assert result.available is True

    def test_route_with_explicit_mock(self) -> None:
        router = AgentRouter()
        request = AgentRunRequest(task="test", agent_name="mock")
        result = router.route(request)
        assert result.agent_name == "mock"
        assert result.success is True

    def test_register_adapter(self) -> None:
        router = AgentRouter()
        mock = MockAgentAdapter()
        mock.name = "custom_mock"
        router.register(mock)
        assert "custom_mock" in router.all_agents()

    def test_clear_cache(self) -> None:
        router = AgentRouter()
        router.clear_cache()
        # Should still work after cache clear
        agents = router.available_agents()
        assert isinstance(agents, list)

    def test_set_priority(self) -> None:
        router = AgentRouter()
        router.set_priority(["mock", "codex"])
        # Should still route without error
        result = router.route(AgentRunRequest(task="test", agent_name="mock"))
        assert result is not None

    def test_dry_run_routing(self) -> None:
        router = AgentRouter()
        request = AgentRunRequest(task="test task", agent_name="mock", dry_run=True)
        result = router.route(request)
        assert result.dry_run is True
        assert result.success is True
