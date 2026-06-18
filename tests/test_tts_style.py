"""Tests for TTS style selection."""

from __future__ import annotations

import pytest

from runner.tts.style import SpeechStyle, VoiceSelector


class TestVoiceSelector:
    """Test that voice styles are correctly selected based on context."""

    def setup_method(self) -> None:
        self.selector = VoiceSelector()

    def test_fallback_notice_when_is_fallback(self) -> None:
        voice = self.selector.select(
            agent_success=True,
            agent_available=True,
            is_fallback=True,
        )
        assert voice.style == SpeechStyle.FALLBACK_NOTICE
        assert voice.voice == "calm"
        assert voice.speed == 0.95

    def test_fallback_notice_when_not_available(self) -> None:
        voice = self.selector.select(
            agent_success=True,
            agent_available=False,
            is_fallback=True,
        )
        assert voice.style == SpeechStyle.FALLBACK_NOTICE

    def test_error_brief_when_agent_fails(self) -> None:
        voice = self.selector.select(
            agent_success=False,
            agent_available=True,
            is_fallback=False,
        )
        assert voice.style == SpeechStyle.ERROR_BRIEF
        assert voice.voice == "concerned"

    def test_success_summary_when_agent_succeeds(self) -> None:
        voice = self.selector.select(
            agent_success=True,
            agent_available=True,
            is_fallback=False,
        )
        assert voice.style == SpeechStyle.SUCCESS_SUMMARY
        assert voice.voice == "happy"

    def test_long_result_briefing_when_output_long(self) -> None:
        voice = self.selector.select(
            agent_success=True,
            agent_available=True,
            is_fallback=False,
            output_length=5000,
        )
        assert voice.style == SpeechStyle.LONG_RESULT_BRIEFING
        assert voice.voice == "neutral"
        assert voice.speed == 1.1

    def test_need_user_action_overrides(self) -> None:
        voice = self.selector.select(
            agent_success=True,
            agent_available=True,
            is_fallback=False,
            needs_user_action=True,
        )
        assert voice.style == SpeechStyle.NEED_USER_ACTION
        assert voice.voice == "focused"
        assert voice.speed == 0.9

    def test_display_name(self) -> None:
        voice = self.selector.select(True, True, False)
        assert "成功" in voice.display_name


class TestSpeechStyleEnum:
    """Test the SpeechStyle enum values."""

    def test_all_styles_present(self) -> None:
        styles = {s.value for s in SpeechStyle}
        expected = {
            "success_summary",
            "error_brief",
            "need_user_action",
            "long_result_briefing",
            "fallback_notice",
        }
        assert styles == expected


class TestTTSManager:
    """Test TTSManager integrates provider + selector."""

    def test_synthesize_returns_voice_selection(self) -> None:
        from runner.tts.manager import TTSManager

        manager = TTSManager()
        output = manager.synthesize(
            text="任务完成",
            agent_success=True,
            agent_available=True,
            is_fallback=False,
        )
        assert "tts_result" in output
        assert "voice_selection" in output
        assert "provider_name" in output
        assert output["tts_result"].success is True
        assert output["provider_name"] == "mock"

    def test_synthesize_fallback_style(self) -> None:
        from runner.tts.manager import TTSManager

        manager = TTSManager()
        output = manager.synthesize(
            text="fallback test",
            agent_success=True,
            agent_available=False,
            is_fallback=True,
        )
        assert output["voice_selection"].style == SpeechStyle.FALLBACK_NOTICE
