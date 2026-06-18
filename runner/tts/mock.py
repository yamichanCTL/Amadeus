"""
Mock TTS provider.

In phase 1, TTS is mocked — it returns the text that *would* be spoken,
without generating actual audio.
"""

from __future__ import annotations

from runner.core.config import TTS_MAX_TEXT_LENGTH
from runner.tts.base import TTSProvider, TTSRequest, TTSResult


class MockTTS(TTSProvider):
    """Mock TTS that returns text-to-speak without generating audio.

    Used in phase 1 to verify the pipeline end-to-end without
    requiring a real TTS engine.
    """

    name = "mock"

    def synthesize(self, request: TTSRequest) -> TTSResult:
        """Generate a mock TTS result.

        The result contains the text to speak and an estimated duration.
        No audio file is created.
        """
        text = request.text.strip()

        if len(text) > TTS_MAX_TEXT_LENGTH:
            text = text[: TTS_MAX_TEXT_LENGTH - 3] + "..."

        # Rough estimate: ~3 chars per second for Chinese, ~12 for English
        # Use a simple average
        char_count = len(text)
        estimated_duration = max(1.0, char_count / 5.0)

        return TTSResult(
            text=text,
            audio_path="",  # No audio in mock mode
            duration_seconds=round(estimated_duration, 1),
            provider=self.name,
            success=True,
        )

    def select_voice(
        self,
        is_success: bool,
        is_error: bool = False,
        content_length: int = 0,
    ) -> str:
        """Select an appropriate voice based on context.

        In mock mode, this is informational only.
        """
        if is_error:
            return "concerned"
        if not is_success:
            return "neutral"
        if content_length > 500:
            return "calm"
        return "happy"
