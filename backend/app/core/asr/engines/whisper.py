"""
app/core/asr/engines/whisper.py
────────────────────────────────
Whisper engine backed by `faster-whisper` (CTranslate2-accelerated).

Model sizes: tiny / base / small / medium / large-v2 / large-v3
Devices    : cpu / cuda
Compute    : int8 (fastest on CPU) / float16 (GPU) / float32
"""

from __future__ import annotations

import io
import logging
from typing import Any

import numpy as np
import soundfile as sf

from app.config import get_settings
from app.core.asr.base import ASRResult, BaseASREngine, EngineOptions, Segment

logger = logging.getLogger(__name__)
settings = get_settings()


class WhisperEngine(BaseASREngine):
    """
    faster-whisper based offline transcription engine.

    Parameters
    ──────────
    model_size    : Whisper model variant (tiny/base/small/medium/large-v3).
    device        : "cpu" or "cuda".
    compute_type  : CTranslate2 quantisation level.
    model_dir     : Override for the model weights directory.
    """

    ENGINE_NAME = "whisper"
    SAMPLE_RATE = 16_000  # Whisper expects 16 kHz mono float32

    def __init__(
        self,
        model_size: str | None = None,
        device: str | None = None,
        compute_type: str | None = None,
        model_dir: str | None = None,
    ) -> None:
        self._model_size = model_size or settings.default_whisper_model
        self._device = device or settings.default_whisper_device
        self._compute_type = compute_type or settings.default_whisper_compute_type
        self._model_dir = model_dir or str(settings.whisper_model_path(self._model_size))
        self._model: Any = None  # faster_whisper.WhisperModel instance

    # ── Identity ──────────────────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return self.ENGINE_NAME

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def load(self) -> None:
        if self._model is not None:
            return  # already loaded

        try:
            from faster_whisper import WhisperModel  # type: ignore[import]
        except ImportError as exc:
            raise RuntimeError(
                "faster-whisper is not installed. "
                "Run: pip install 'asr-backend[whisper]'"
            ) from exc

        logger.info(
            "Loading Whisper model '%s' on %s (%s) …",
            self._model_size,
            self._device,
            self._compute_type,
        )

        # faster-whisper accepts either a model name (downloads automatically)
        # or a local directory path.
        model_ref = (
            self._model_dir
            if _path_has_weights(self._model_dir)
            else self._model_size
        )

        # NOTE: WhisperModel.__init__ is CPU-bound; run in thread pool in prod.
        import asyncio
        loop = asyncio.get_running_loop()
        self._model = await loop.run_in_executor(
            None,
            lambda: WhisperModel(
                model_ref,
                device=self._device,
                compute_type=self._compute_type,
                download_root=str(settings.models_dir / "whisper"),
            ),
        )
        logger.info("Whisper model loaded.")

    async def unload(self) -> None:
        if self._model is not None:
            del self._model
            self._model = None
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass
            logger.info("Whisper model unloaded.")

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    # ── Inference ─────────────────────────────────────────────────────────────

    async def transcribe(
        self,
        audio_bytes: bytes,
        options: EngineOptions | None = None,
    ) -> ASRResult:
        if not self.is_loaded:
            await self.load()

        opts = options or EngineOptions()
        audio_array = _decode_audio(audio_bytes, self.SAMPLE_RATE)

        # Run in thread pool to avoid blocking the event loop
        import asyncio
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: self._run_inference(audio_array, opts),
        )
        return result

    def _run_inference(self, audio_array: np.ndarray, opts: EngineOptions) -> ASRResult:
        """Blocking inference call – executed in a thread pool."""
        assert self._model is not None

        task = opts.task if opts.task in ("transcribe", "translate") else "transcribe"
        language = opts.language  # None → auto-detect

        # faster-whisper returns a generator + TranscriptionInfo
        segments_gen, info = self._model.transcribe(
            audio_array,
            language=language,
            task=task,
            beam_size=opts.extra.get("beam_size", 5),
            vad_filter=False,   # we handle VAD in our own pipeline layer
            word_timestamps=opts.extra.get("word_timestamps", False),
        )

        segments: list[Segment] = []
        full_text_parts: list[str] = []
        confidences: list[float] = []

        for seg in segments_gen:  # materialise the lazy generator
            text = seg.text.strip()
            if not text:
                continue
            segment = Segment(
                start=round(seg.start, 3),
                end=round(seg.end, 3),
                text=text,
            )
            # faster-whisper exposes avg_logprob per segment
            if hasattr(seg, "avg_logprob") and seg.avg_logprob is not None:
                # Convert log prob to a rough 0–1 confidence score
                import math
                conf = max(0.0, min(1.0, math.exp(seg.avg_logprob)))
                segment.confidence = round(conf, 4)
                confidences.append(conf)
            segments.append(segment)
            full_text_parts.append(text)

        full_text = " ".join(full_text_parts)
        avg_confidence = (
            round(sum(confidences) / len(confidences), 4) if confidences else None
        )

        return ASRResult(
            full_text=full_text,
            segments=segments,
            language=info.language,
            engine_name=self.name,
            confidence=avg_confidence,
            raw={
                "language_probability": round(info.language_probability, 4),
                "duration": round(info.duration, 3),
                "model_size": self._model_size,
            },
        )

    # ── Metadata ──────────────────────────────────────────────────────────────

    def info(self) -> dict[str, Any]:
        base = super().info()
        base.update(
            {
                "model_name": self._model_size,
                "device": self._device,
                "compute_type": self._compute_type,
                "languages": [],  # Whisper supports 99 languages; omit for brevity
            }
        )
        return base


# ── Helpers ───────────────────────────────────────────────────────────────────

def _decode_audio(audio_bytes: bytes, target_sr: int) -> np.ndarray:
    """
    Decode any audio format supported by soundfile into a float32 numpy array
    at `target_sr` Hz, mono.
    """
    buf = io.BytesIO(audio_bytes)
    audio, sr = sf.read(buf, dtype="float32", always_2d=True)

    # Mix down to mono
    if audio.ndim == 2 and audio.shape[1] > 1:
        audio = audio.mean(axis=1)
    else:
        audio = audio.squeeze()

    # Resample if needed
    if sr != target_sr:
        import librosa  # type: ignore[import]
        audio = librosa.resample(audio, orig_sr=sr, target_sr=target_sr)

    return audio.astype(np.float32)


def _path_has_weights(path: str) -> bool:
    """Return True if the directory looks like it contains model files."""
    from pathlib import Path
    p = Path(path)
    if not p.exists():
        return False
    # faster-whisper stores model.bin; openai-whisper stores .pt files
    return any(p.glob("*.bin")) or any(p.glob("*.pt"))