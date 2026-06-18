"""
ASR base types — uniform interface for speech-to-text.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field


@dataclass
class ASRResult:
    """Unified result from any ASR provider.

    Attributes:
        text: The transcribed text.
        language: Detected or requested language code (e.g. "zh", "en").
        confidence: Average confidence 0-1, None if unavailable.
        engine: Name of the ASR engine that produced this result.
        duration_seconds: Audio duration in seconds.
        segments: Time-stamped segments if supported.
    """

    text: str
    language: str | None = None
    confidence: float | None = None
    engine: str = "unknown"
    duration_seconds: float = 0.0
    segments: list[dict] = field(default_factory=list)


class ASRProvider(abc.ABC):
    """Abstract base for all ASR providers.

    Subclasses must implement:
        name: str — unique identifier
        transcribe(audio_path: str) -> ASRResult
    """

    @property
    @abc.abstractmethod
    def name(self) -> str: ...

    @abc.abstractmethod
    def transcribe(self, audio_path: str) -> ASRResult:
        """Transcribe an audio file to text.

        Args:
            audio_path: Path to an audio file (WAV, MP3, M4A, etc.).

        Returns:
            ASRResult with transcribed text.
        """
        ...
