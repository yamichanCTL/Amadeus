"""
app/core/asr/engines/stream_stub.py
────────────────────────────────────
Reserved stub for a future real-time streaming ASR engine.

When you are ready to implement streaming:
  1. Replace this class with a concrete implementation.
  2. Implement `transcribe_stream()` to yield `ASRResult` objects as each
     chunk of audio arrives.
  3. Register it in `registry.py` under the key "stream".

Design contract for streaming engines
──────────────────────────────────────
`transcribe_stream(audio_chunk_iter, options)` receives an async iterator of
`bytes` chunks (e.g. from a WebSocket connection) and should yield:

  ASRResult(
      full_text="partial text so far",
      segments=[...],
      ...
  )

each time a new word / sentence is finalised.  The client differentiates
partial from final results via a `is_final` flag in the `raw` dict.

Candidate backends
──────────────────
- sherpa-onnx streaming recogniser (OnlineRecognizer) — recommended
- vosk KaldiRecognizer in streaming mode
- whisper.cpp server via socket
"""

from __future__ import annotations

import logging
from typing import Any, AsyncIterator

from app.core.asr.base import ASRResult, BaseASREngine, EngineOptions

logger = logging.getLogger(__name__)


class StreamStubEngine(BaseASREngine):
    """
    Placeholder streaming engine.  All public methods raise NotImplementedError
    with a descriptive message so failures are immediately obvious.
    """

    ENGINE_NAME = "stream"

    @property
    def name(self) -> str:
        return self.ENGINE_NAME

    async def load(self) -> None:
        logger.warning(
            "StreamStubEngine.load() called — streaming is not yet implemented."
        )

    async def unload(self) -> None:
        pass

    @property
    def is_loaded(self) -> bool:
        return False

    async def transcribe(
        self,
        audio_bytes: bytes,
        options: EngineOptions | None = None,
    ) -> ASRResult:
        raise NotImplementedError(
            "Streaming engine is reserved for future implementation. "
            "Use 'whisper', 'vosk', or 'sherpa' for offline transcription."
        )

    async def transcribe_stream(
        self,
        audio_chunk_iter: AsyncIterator[bytes],
        options: EngineOptions | None = None,
    ) -> AsyncIterator[ASRResult]:
        """
        Future implementation should look like:

            async for chunk in audio_chunk_iter:
                partial_result = self._process_chunk(chunk)
                if partial_result:
                    yield partial_result
            yield self._finalize()
        """
        raise NotImplementedError(
            "Streaming transcription is not yet implemented. "
            "This endpoint is reserved for a future release."
        )
        # Make the return type an async generator (unreachable but satisfies type checker)
        if False:  # pragma: no cover
            yield ASRResult(full_text="")

    def info(self) -> dict[str, Any]:
        return {
            "engine": self.name,
            "is_loaded": False,
            "status": "reserved — not implemented",
        }