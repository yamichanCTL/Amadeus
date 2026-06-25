"""
Tests for TTSRequest, TTSResult dataclasses (validation and defaults).
"""

import pytest

from runner.tts.base import TTSProvider, TTSRequest, TTSResult


class TestTTSRequest:
    """TTSRequest validation and defaults."""

    def test_valid_request(self) -> None:
        req = TTSRequest(text="你好世界")
        assert req.text == "你好世界"
        assert req.voice == "default"
        assert req.speed == 1.0
        assert req.language == "zh"

    def test_custom_voice_and_speed(self) -> None:
        req = TTSRequest(text="Hello", voice="happy", speed=1.5, language="en")
        assert req.voice == "happy"
        assert req.speed == 1.5
        assert req.language == "en"

    def test_empty_text_raises(self) -> None:
        with pytest.raises(ValueError, match="must not be blank"):
            TTSRequest(text="")

    def test_whitespace_only_raises(self) -> None:
        with pytest.raises(ValueError, match="must not be blank"):
            TTSRequest(text="   ")

    def test_speed_zero(self) -> None:
        """Speed 0 is accepted at the dataclass level (provider may reject)."""
        req = TTSRequest(text="test", speed=0.0)
        assert req.speed == 0.0

    def test_very_long_text_accepted(self) -> None:
        """Very long text is accepted at dataclass level (provider truncates)."""
        long_text = "测试" * 5000
        req = TTSRequest(text=long_text)
        assert len(req.text) == 10000


class TestTTSResult:
    """TTSResult defaults and fields."""

    def test_default_result(self) -> None:
        r = TTSResult()
        assert r.text == ""
        assert r.audio_path == ""
        assert r.duration_seconds == 0.0
        assert r.provider == "mock"
        assert r.success is True
        assert r.error == ""

    def test_success_result_with_audio(self) -> None:
        r = TTSResult(
            text="你好",
            audio_path="/tmp/out.wav",
            duration_seconds=2.5,
            provider="gpt_sovits",
            success=True,
        )
        assert r.text == "你好"
        assert r.audio_path == "/tmp/out.wav"
        assert r.duration_seconds == 2.5
        assert r.provider == "gpt_sovits"
        assert r.success is True
        assert r.error == ""

    def test_failure_result(self) -> None:
        r = TTSResult(success=False, error="Server unavailable")
        assert r.success is False
        assert r.error == "Server unavailable"

    def test_provider_name_preserved(self) -> None:
        r = TTSResult(provider="voxcpm2")
        assert r.provider == "voxcpm2"


class TestTTSProviderAbstract:
    """Verify TTSProvider is properly abstract."""

    def test_cannot_instantiate_abstract(self) -> None:
        with pytest.raises(TypeError):
            TTSProvider()  # type: ignore[abstract]

    def test_concrete_subclass_requires_synthesize(self) -> None:
        """A subclass without synthesize() cannot be instantiated."""
        with pytest.raises(TypeError):

            class Incomplete(TTSProvider):
                pass  # type: ignore[abstract]

            Incomplete()  # type: ignore[abstract]
