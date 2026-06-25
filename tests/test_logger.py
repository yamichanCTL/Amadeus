"""
Tests for structured observable logging.
"""

import logging
from unittest import mock

from runner.observability.logger import (
    get_logger,
    log_agent_run,
    log_orchestrator_run,
)


class TestGetLogger:
    """Logger singleton tests."""

    def test_get_logger_returns_logger(self) -> None:
        logger = get_logger()
        assert logger is not None

    def test_get_logger_is_singleton(self) -> None:
        a = get_logger()
        b = get_logger()
        assert a is b

    def test_logger_has_info_method(self) -> None:
        logger = get_logger()
        assert hasattr(logger, "info")


class TestLogAgentRun:
    """log_agent_run structured logging tests."""

    def test_log_agent_run_does_not_raise(self) -> None:
        """log_agent_run should never raise."""
        log_agent_run(
            agent_name="mock",
            task="测试任务",
            success=True,
            available=True,
            duration_seconds=1.5,
        )

    def test_log_agent_run_with_all_fields(self) -> None:
        log_agent_run(
            agent_name="claude_code",
            task="分析项目",
            success=True,
            available=True,
            duration_seconds=3.2,
            exit_code=0,
            summary="项目分析完成",
        )

    def test_log_agent_run_with_failure(self) -> None:
        log_agent_run(
            agent_name="codex",
            task="deploy",
            success=False,
            available=False,
            duration_seconds=0.0,
            exit_code=1,
        )

    def test_log_agent_run_truncates_long_task(self) -> None:
        """Very long task text should be truncated (handled internally)."""
        long_task = "A" * 500
        # Should not raise
        log_agent_run(
            agent_name="mock",
            task=long_task,
            success=True,
            available=True,
            duration_seconds=0.1,
        )

    def test_log_agent_run_with_extra_kwargs(self) -> None:
        log_agent_run(
            agent_name="mock",
            task="test",
            success=True,
            available=True,
            duration_seconds=0.1,
            extra_field="extra_value",
        )


class TestLogOrchestratorRun:
    """log_orchestrator_run structured logging tests."""

    def test_log_orchestrator_run_does_not_raise(self) -> None:
        log_orchestrator_run(
            input_text="分析项目结构",
            agent_name="mock",
            success=True,
            total_duration=2.5,
            tts_text="任务完成，这是结果总结",
        )

    def test_log_orchestrator_run_with_extra(self) -> None:
        log_orchestrator_run(
            input_text="测试",
            agent_name="claude_code",
            success=False,
            total_duration=5.0,
            tts_text="",
            custom_key="custom_val",
        )

    def test_log_orchestrator_run_truncates_input(self) -> None:
        """Long input text should be truncated internally."""
        long_input = "测试" * 200
        log_orchestrator_run(
            input_text=long_input,
            agent_name="mock",
            success=True,
            total_duration=1.0,
        )
