"""Tests for agent detection from natural-language task text."""

from __future__ import annotations

import pytest

from runner.agents.router import detect_agent_from_text


class TestAgentDetection:
    """Test that agent preferences are correctly detected from text."""

    @pytest.mark.parametrize(
        "text, expected",
        [
            ("请用 claude 分析项目结构", "claude_code"),
            ("请用 codex 分析项目结构", "codex"),
            ("请用 opencode 分析项目结构", "opencode"),
            ("使用 claude 来帮我重构代码", "claude_code"),
            ("用 codex 执行这个任务", "codex"),
            ("通过 opencode 查看项目", "opencode"),
            ("让 claude 来处理", "claude_code"),
            ("切换到 codex", "codex"),
            ("use claude to analyze", "claude_code"),
            ("switch to opencode", "opencode"),
            ("prefer codex for this", "codex"),
        ],
    )
    def test_detect_explicit_agent(self, text, expected) -> None:
        assert detect_agent_from_text(text) == expected

    @pytest.mark.parametrize(
        "text",
        [
            "分析项目结构",
            "帮我看看这个项目",
            "列出所有 Python 文件",
            "hello world",
            "",
            "普通的任务描述，没有提到任何 agent",
        ],
    )
    def test_no_agent_in_neutral_text(self, text) -> None:
        assert detect_agent_from_text(text) is None

    def test_case_insensitive(self) -> None:
        assert detect_agent_from_text("请用 CLAUDE 分析") == "claude_code"
        assert detect_agent_from_text("Use Codex to help") == "codex"
        assert detect_agent_from_text("用 OpenCode 执行") == "opencode"
