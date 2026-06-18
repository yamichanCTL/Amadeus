"""
TTS base abstraction.

All TTS providers implement this interface.
Phase 1 only has MockTTS.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field


@dataclass
class TTSRequest:
    """Request to generate speech from text.

    Attributes:
        text: The text to vocalize.
        voice: Voice/style selection (implementation-defined).
        speed: Speech speed multiplier.
        language: Language code hint.
    """

    text: str
    voice: str = "default"
    speed: float = 1.0
    language: str = "zh"

    def __post_init__(self) -> None:
        if not self.text.strip():
            raise ValueError("tts text must not be blank")


@dataclass
class TTSResult:
    """Result of a TTS generation request.

    Attributes:
        text: The text that would be spoken.
        audio_path: Path to generated audio file (empty for mock).
        duration_seconds: Estimated duration of the audio.
        provider: Name of the TTS provider that handled the request.
        success: Whether generation succeeded.
        error: Error message if generation failed.
    """

    text: str = ""
    audio_path: str = ""
    duration_seconds: float = 0.0
    provider: str = "mock"
    success: bool = True
    error: str = ""


class TTSProvider(abc.ABC):
    """Abstract base for TTS providers."""

    @abc.abstractmethod
    def synthesize(self, request: TTSRequest) -> TTSResult:
        """Generate speech from text. Must be implemented by providers."""
        ...
