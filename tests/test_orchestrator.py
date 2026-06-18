"""Tests for the Orchestrator pipeline.

All tests use MockAgentAdapter to ensure tests are fast and deterministic,
never hitting real CLI agents (which take minutes).
"""

from __future__ import annotations

import pytest

from runner.agents.mock_agent import MockAgentAdapter
from runner.agents.router import AgentRouter
from runner.core.orchestrator import Orchestrator


def _make_router_mock_only() -> AgentRouter:
    """Create a router that only has MockAgent — fast and deterministic."""
    mock = MockAgentAdapter()
    return AgentRouter(adapters=[mock])


class TestOrchestrator:
    """Test the full orchestrator pipeline with MockAgent only."""

    def test_run_returns_result(self) -> None:
        orch = Orchestrator(router=_make_router_mock_only())
        result = orch.run("分析项目结构")
        assert result.input_text == "分析项目结构"
        assert result.agent_result is not None
        assert result.agent_result.agent_name == "mock"
        assert result.compressed_summary
        assert result.tts_result is not None
        assert result.total_duration_seconds >= 0
        assert len(result.trace) > 0

    def test_run_with_empty_input_raises(self) -> None:
        orch = Orchestrator(router=_make_router_mock_only())
        with pytest.raises(ValueError):
            orch.run("")

    def test_run_with_whitespace_input_raises(self) -> None:
        orch = Orchestrator(router=_make_router_mock_only())
        with pytest.raises(ValueError):
            orch.run("   ")

    def test_tts_result_has_text(self) -> None:
        orch = Orchestrator(router=_make_router_mock_only())
        result = orch.run("列出 Python 文件")
        assert result.tts_result.text
        assert result.tts_result.success is True
        assert result.tts_result.provider == "mock"

    def test_compressed_summary_is_reasonable(self) -> None:
        orch = Orchestrator(router=_make_router_mock_only())
        result = orch.run("检查系统状态")
        assert len(result.compressed_summary) > 0
        assert len(result.compressed_summary) < 2000

    def test_trace_contains_key_steps(self) -> None:
        orch = Orchestrator(router=_make_router_mock_only())
        result = orch.run("hello")
        trace_text = " ".join(result.trace)
        assert "Received input" in trace_text or "input" in trace_text.lower()
        assert "agent" in trace_text.lower()
        assert "TTS" in trace_text or "tts" in trace_text.lower()

    def test_multiple_runs(self) -> None:
        """Verify the orchestrator handles multiple runs without state corruption."""
        orch = Orchestrator(router=_make_router_mock_only())
        r1 = orch.run("任务一")
        r2 = orch.run("任务二")
        assert r1.input_text == "任务一"
        assert r2.input_text == "任务二"

    def test_voice_selection_in_result(self) -> None:
        """Verify voice selection is populated in orchestrator result."""
        orch = Orchestrator(router=_make_router_mock_only())
        result = orch.run("hello")
        assert result.voice_selection is not None
        assert result.voice_selection.style is not None

    def test_detected_agent_is_none_for_neutral_text(self) -> None:
        """Neutral text without agent mention should not trigger detection."""
        orch = Orchestrator(router=_make_router_mock_only())
        result = orch.run("分析项目结构")
        assert result.detected_agent is None
