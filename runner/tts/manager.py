"""
TTS Manager — coordinates TTS provider selection and synthesis.

Provides a unified interface for voice selection + text generation.
"""

from __future__ import annotations

from runner.core.config import TTS_MAX_TEXT_LENGTH
from runner.tts.base import TTSProvider, TTSRequest, TTSResult
from runner.tts.mock import MockTTS
from runner.tts.style import SpeechStyle, VoiceSelection, VoiceSelector


class TTSManager:
    """Manages TTS synthesis with style-aware voice selection.

    Usage::

        manager = TTSManager()
        result = manager.synthesize(
            text="任务完成",
            agent_success=True,
            agent_available=True,
            is_fallback=False,
        )
        print(result.style, result.text)
    """

    def __init__(
        self,
        provider: TTSProvider | None = None,
        selector: VoiceSelector | None = None,
    ) -> None:
        self.provider = provider or MockTTS()
        self.selector = selector or VoiceSelector()

    def synthesize(
        self,
        text: str,
        agent_success: bool,
        agent_available: bool,
        is_fallback: bool = False,
        output_length: int = 0,
        needs_user_action: bool = False,
        language: str = "zh",
    ) -> dict:
        """Synthesize TTS output with style selection.

        Args:
            text: The text to convert to speech.
            agent_success: Whether the agent completed successfully.
            agent_available: Whether the agent binary was found.
            is_fallback: Whether MockAgent fallback was used.
            output_length: Length of agent output in characters.
            needs_user_action: Whether user confirmation is needed.
            language: Language hint for TTS.

        Returns:
            Dict with keys: tts_result, voice_selection, provider_name.
        """
        # Select voice style
        voice = self.selector.select(
            agent_success=agent_success,
            agent_available=agent_available,
            is_fallback=is_fallback,
            output_length=output_length,
            needs_user_action=needs_user_action,
        )

        # Prepare TTS request
        request = TTSRequest(
            text=text[:TTS_MAX_TEXT_LENGTH],
            voice=voice.voice,
            speed=voice.speed,
            language=language,
        )

        # Synthesize
        result = self.provider.synthesize(request)

        return {
            "tts_result": result,
            "voice_selection": voice,
            "provider_name": self.provider.name,
        }
