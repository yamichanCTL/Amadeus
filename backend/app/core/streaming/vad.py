"""VAD wrappers used by the pseudo-streaming ASR session."""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

_SAMPLE_RATE = 16_000


@dataclass
class VadDecision:
    is_speech: bool
    speech_start: bool = False
    speech_end: bool = False
    confidence: float | None = None


class StreamingVad:
    def reset(self) -> None:
        raise NotImplementedError

    def accept_pcm(self, pcm_bytes: bytes) -> VadDecision:
        raise NotImplementedError


class EnergyVad(StreamingVad):
    """Small dependency-free fallback for tests and machines without FireRed deps."""

    def __init__(
        self,
        start_speech_ms: int,
        end_silence_ms: int,
        sample_rate: int = _SAMPLE_RATE,
        rms_threshold: float = 450.0,
    ) -> None:
        self.sample_rate = sample_rate
        self.rms_threshold = rms_threshold
        self.start_speech_ms = start_speech_ms
        self.end_silence_ms = end_silence_ms
        self.reset()

    def reset(self) -> None:
        self.in_speech = False
        self.speech_ms = 0.0
        self.silence_ms = 0.0

    def accept_pcm(self, pcm_bytes: bytes) -> VadDecision:
        audio = np.frombuffer(pcm_bytes, dtype=np.int16)
        if audio.size == 0:
            return VadDecision(False)
        duration_ms = audio.size / self.sample_rate * 1000.0
        rms = float(np.sqrt(np.mean(audio.astype(np.float32) ** 2)))
        is_speech = rms >= self.rms_threshold

        start = False
        end = False
        if is_speech:
            self.speech_ms += duration_ms
            self.silence_ms = 0.0
            if not self.in_speech and self.speech_ms >= self.start_speech_ms:
                self.in_speech = True
                start = True
        else:
            self.silence_ms += duration_ms
            if self.in_speech and self.silence_ms >= self.end_silence_ms:
                self.in_speech = False
                end = True
            if not self.in_speech:
                self.speech_ms = 0.0

        confidence = min(1.0, rms / max(self.rms_threshold, 1.0))
        return VadDecision(is_speech=is_speech, speech_start=start, speech_end=end, confidence=confidence)


class FireRedVad(StreamingVad):
    """FireRedVAD streaming endpoint detector."""

    def __init__(self) -> None:
        src_path = Path(
            settings.firered_vad_src_path
            or Path(__file__).resolve().parents[1] / "asr" / "engines" / "FireRedASR2S"
        )
        model_dir = settings.firered_vad_model_dir
        if not model_dir.exists():
            raise RuntimeError(f"FireRedVAD model directory not found: {model_dir}")
        if str(src_path) not in sys.path:
            sys.path.insert(0, str(src_path))

        try:
            from fireredasr2s.fireredvad.stream_vad import (
                FireRedStreamVad,
                FireRedStreamVadConfig,
            )
        except ImportError as exc:
            raise RuntimeError("FireRedVAD dependencies are not importable.") from exc

        config = FireRedStreamVadConfig(
            use_gpu=settings.firered_vad_use_gpu,
            smooth_window_size=5,
            speech_threshold=settings.firered_vad_speech_threshold,
            pad_start_frame=max(5, settings.stream_pre_roll_ms // 10),
            min_speech_frame=max(1, settings.stream_start_speech_ms // 10),
            max_speech_frame=max(1, settings.stream_hard_max_segment_ms // 10),
            min_silence_frame=max(1, settings.stream_end_silence_ms // 10),
            chunk_max_frame=30000,
        )
        self._vad: Any = FireRedStreamVad.from_pretrained(str(model_dir), config)

    def reset(self) -> None:
        self._vad.reset()

    def accept_pcm(self, pcm_bytes: bytes) -> VadDecision:
        audio = np.frombuffer(pcm_bytes, dtype=np.int16)
        if audio.size == 0:
            return VadDecision(False)
        results = self._vad.detect_chunk(audio)
        if not results:
            return VadDecision(False)
        return VadDecision(
            is_speech=any(bool(r.is_speech) for r in results),
            speech_start=any(bool(r.is_speech_start) for r in results),
            speech_end=any(bool(r.is_speech_end) for r in results),
            confidence=max((float(r.smoothed_prob) for r in results), default=None),
        )


def create_streaming_vad() -> StreamingVad:
    try:
        return FireRedVad()
    except Exception as exc:
        logger.warning("FireRedVAD unavailable, falling back to energy VAD: %s", exc)
        return EnergyVad(
            start_speech_ms=settings.stream_start_speech_ms,
            end_silence_ms=settings.stream_end_silence_ms,
            sample_rate=settings.stream_sample_rate,
        )
