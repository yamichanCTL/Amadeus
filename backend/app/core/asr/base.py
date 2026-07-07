"""
app/core/asr/base.py
────────────────────
Abstract base class that every ASR engine must implement.

All engines return a uniform `ASRResult` dataclass, making the rest of the
system engine-agnostic.
"""

from __future__ import annotations

import abc
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

# ── Result dataclass ──────────────────────────────────────────────────────────

@dataclass
class Segment:
    """One time-stamped chunk of recognised speech."""
    start: float
    end: float
    text: str
    confidence: float | None = None


@dataclass
class ASRResult:
    """
    Unified result returned by every engine's `transcribe()` call.

    Attributes
    ──────────
    full_text   : Plain concatenated transcript.
    segments    : List of Segment objects (may be empty for engines that don't
                  support timestamping).
    language    : Detected or requested language code (e.g. "zh", "en").
    engine_name : Name of the engine that produced this result.
    confidence  : Average word/token confidence across the whole audio (0–1).
                  None if the engine does not expose confidence scores.
    raw         : Engine-specific raw output for debugging / downstream use.
    """
    full_text: str
    segments: list[Segment] = field(default_factory=list)
    language: str | None = None
    engine_name: str = "unknown"
    confidence: float | None = None
    raw: dict[str, Any] = field(default_factory=dict)


# ── Engine options dataclass ──────────────────────────────────────────────────

@dataclass
class EngineOptions:
    """
    Common options passed to every engine.
    Engine-specific extras go into `extra`.
    """
    language: str | None = None          # None = auto-detect
    task: str = "transcribe"             # "transcribe" | "translate"  (whisper)
    extra: dict[str, Any] = field(default_factory=dict)


class BaseStreamingASRSession(abc.ABC):
    """Per-utterance state owned by a true streaming ASR engine."""

    @abc.abstractmethod
    async def accept_pcm(self, pcm_bytes: bytes) -> ASRResult | None:
        """Consume signed 16-bit mono PCM and return a changed partial result."""
        ...

    @abc.abstractmethod
    async def finish(self) -> ASRResult:
        """Mark input complete, flush the decoder, and return the final result."""
        ...


# ── Abstract engine ───────────────────────────────────────────────────────────

class BaseASREngine(abc.ABC):
    """
    Every concrete engine subclass must implement:

      - name          : str  –  unique identifier (e.g. "sensevoice", "whisper")
      - load()        –  load model weights into memory
      - unload()      –  release GPU/RAM resources
      - is_loaded     : bool
      - transcribe()  –  run inference on raw audio bytes (WAV, 16 kHz mono)

    Optionally override:
      - transcribe_stream()  –  for streaming engines (yields partial results)
      - info()               –  return extra metadata for the /models endpoint
    """

    # ── Identity ──────────────────────────────────────────────────────────────

    @property
    @abc.abstractmethod
    def name(self) -> str:
        """Unique engine identifier, lower-case, no spaces."""
        ...

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    @abc.abstractmethod
    async def load(self) -> None:
        """
        Load model weights.  Must be idempotent (calling twice is safe).
        Raise `RuntimeError` if the model files are missing.
        """
        ...

    @abc.abstractmethod
    async def unload(self) -> None:
        """Release all held resources (GPU memory, file handles, etc.)."""
        ...

    @property
    @abc.abstractmethod
    def is_loaded(self) -> bool:
        """True iff the model is ready to accept inference calls."""
        ...

    # ── Inference ─────────────────────────────────────────────────────────────

    @abc.abstractmethod
    async def transcribe(
        self,
        audio_bytes: bytes,
        options: EngineOptions | None = None,
    ) -> ASRResult:
        """
        Transcribe audio.

        Parameters
        ──────────
        audio_bytes : Raw audio data.  Engines should accept at minimum:
                      16 kHz, 16-bit PCM, mono WAV.  The pipeline layer
                      normalises audio before calling this method.
        options     : Per-request options (language, task, extras).

        Returns
        ───────
        ASRResult with full_text, segments, language, confidence filled in.
        """
        ...

    async def transcribe_batch(
        self,
        items: list[tuple[bytes, EngineOptions | None]],
    ) -> list[ASRResult]:
        """
        Transcribe a micro-batch of independent requests.

        Engines with native batch APIs should override this method. The default
        keeps every existing engine compatible while still letting the scheduler
        own queueing, admission, and GPU serialization.
        """
        results: list[ASRResult] = []
        for audio_bytes, options in items:
            results.append(await self.transcribe(audio_bytes, options))
        return results

    async def transcribe_stream(
        self,
        audio_chunk_iter: AsyncIterator[bytes],
        options: EngineOptions | None = None,
        sample_rate: int = 16_000,
    ) -> AsyncIterator[ASRResult]:
        """
        Reserved for streaming engines.  Default raises NotImplementedError.
        Concrete streaming engines override this to yield partial ASRResult.
        """
        session = await self.create_streaming_session(sample_rate, options)
        async for chunk in audio_chunk_iter:
            result = await session.accept_pcm(chunk)
            if result is not None:
                yield result
        yield await session.finish()

    @property
    def supports_streaming(self) -> bool:
        """Whether this engine preserves decoder state across incoming chunks."""
        return False

    async def create_streaming_session(
        self,
        sample_rate: int = 16_000,
        options: EngineOptions | None = None,
    ) -> BaseStreamingASRSession:
        raise NotImplementedError(
            f"Engine '{self.name}' does not support streaming transcription."
        )

    # ── Metadata ──────────────────────────────────────────────────────────────

    def info(self) -> dict[str, Any]:
        """
        Return a dict with engine metadata for the /models endpoint.
        Subclasses should call super().info() and extend the dict.
        """
        return {
            "engine": self.name,
            "is_loaded": self.is_loaded,
            "supports_streaming": self.supports_streaming,
            "model_modes": ["streaming"] if self.supports_streaming else ["offline"],
        }

    # ── Helpers ───────────────────────────────────────────────────────────────

    def __repr__(self) -> str:
        loaded = "loaded" if self.is_loaded else "not loaded"
        return f"<{self.__class__.__name__} name={self.name!r} {loaded}>"
