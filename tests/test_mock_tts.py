"""
Tests for MockTTS provider (direct tests beyond orchestrator integration).
"""

from runner.tts.mock import MockTTS
from runner.tts.base import TTSRequest, TTSResult


class TestMockTTS:
    """Direct MockTTS provider tests."""

    def test_name_is_mock(self) -> None:
        tts = MockTTS()
        assert tts.name == "mock"

    def test_synthesize_basic(self) -> None:
        tts = MockTTS()
        result = tts.synthesize(TTSRequest(text="你好世界"))
        assert isinstance(result, TTSResult)
        assert result.success is True
        assert result.provider == "mock"
        assert result.audio_path == ""  # mock never creates audio
        assert result.duration_seconds >= 1.0  # minimum 1 second

    def test_synthesize_text_preserved(self) -> None:
        tts = MockTTS()
        result = tts.synthesize(TTSRequest(text="Hello World"))
        assert "Hello World" in result.text

    def test_synthesize_long_text_truncated(self) -> None:
        """Text longer than TTS_MAX_TEXT_LENGTH (2000) should be truncated."""
        tts = MockTTS()
        long_text = "测试" * 1500  # 3000 chars
        result = tts.synthesize(TTSRequest(text=long_text))
        assert len(result.text) <= 2000
        assert result.text.endswith("...")

    def test_synthesize_duration_increases_with_length(self) -> None:
        tts = MockTTS()
        short = tts.synthesize(TTSRequest(text="Hi"))
        long = tts.synthesize(TTSRequest(text="这是一个很长的句子用来测试时长估算是否正确"))
        assert long.duration_seconds >= short.duration_seconds

    def test_synthesize_minimum_duration(self) -> None:
        tts = MockTTS()
        result = tts.synthesize(TTSRequest(text="."))
        assert result.duration_seconds == 1.0

    def test_synthesize_strips_whitespace(self) -> None:
        tts = MockTTS()
        result = tts.synthesize(TTSRequest(text="  你好  "))
        assert result.text == "你好"

    def test_select_voice_error(self) -> None:
        tts = MockTTS()
        assert tts.select_voice(is_success=True, is_error=True) == "concerned"

    def test_select_voice_failure(self) -> None:
        tts = MockTTS()
        assert tts.select_voice(is_success=False) == "neutral"

    def test_select_voice_long_content(self) -> None:
        tts = MockTTS()
        assert tts.select_voice(is_success=True, content_length=600) == "calm"

    def test_select_voice_short_success(self) -> None:
        tts = MockTTS()
        assert tts.select_voice(is_success=True, content_length=100) == "happy"

    def test_select_voice_error_overrides_failure(self) -> None:
        """Error takes priority over failure in the decision chain."""
        tts = MockTTS()
        assert tts.select_voice(is_success=False, is_error=True) == "concerned"
