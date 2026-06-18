"""
Whisper ASR adapter using faster-whisper.

Lightweight, runs on CPU, good for Chinese and English.
No GPU required — works immediately on any system.
"""

from __future__ import annotations

import logging
import os
import tempfile
import time
from pathlib import Path

from runner.asr.base import ASRProvider, ASRResult

logger = logging.getLogger("runner.asr.whisper")

# Lazy-loaded model instance
_model: object | None = None
_model_size: str = "base"


def _load_model(size: str = "base"):
    """Load faster-whisper model (lazy, cached)."""
    global _model, _model_size
    if _model is not None and _model_size == size:
        return _model

    try:
        from faster_whisper import WhisperModel

        _model = WhisperModel(size, device="cpu", compute_type="int8")
        _model_size = size
        logger.info("faster-whisper model loaded: %s (cpu/int8)", size)
        return _model
    except ImportError:
        logger.error("faster-whisper not installed. Install: pip install faster-whisper")
        return None
    except Exception as e:
        logger.error("Failed to load faster-whisper model: %s", e)
        return None


def _convert_to_wav(audio_path: str) -> str:
    """Convert audio file to 16kHz mono WAV using ffmpeg if needed."""
    path = Path(audio_path)
    if not path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    # If already WAV, return as-is
    if path.suffix.lower() == ".wav":
        return str(path.resolve())

    # Convert with ffmpeg
    output = path.with_suffix(".wav")
    if output.exists():
        return str(output)

    import subprocess

    logger.info("Converting %s to WAV...", path.name)
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(path),
            "-ar", "16000", "-ac", "1", "-sample_fmt", "s16",
            str(output),
        ],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg conversion failed: {result.stderr[:500]}")

    return str(output)


class WhisperASR(ASRProvider):
    """Whisper ASR using faster-whisper (CPU).

    Usage::

        asr = WhisperASR()
        result = asr.transcribe("/path/to/audio.m4a")
        print(result.text)
    """

    name = "whisper"

    def __init__(self, model_size: str = "base", language: str | None = None):
        """
        Args:
            model_size: Whisper model size (tiny, base, small, medium, large).
            language: Language code hint (e.g. "zh", "en") or None for auto-detect.
        """
        self.model_size = model_size
        self.language = language

    def transcribe(self, audio_path: str) -> ASRResult:
        """Transcribe audio to text."""
        started = time.perf_counter()

        model = _load_model(self.model_size)
        if model is None:
            return ASRResult(
                text="",
                engine=self.name,
                confidence=0.0,
                error="Whisper model failed to load",
            )

        # Convert to WAV if needed
        wav_path = _convert_to_wav(audio_path)

        # Run inference
        segments_list: list[dict] = []
        full_text_parts: list[str] = []
        confidences: list[float] = []

        try:
            segments_gen, info = model.transcribe(  # type: ignore[union-attr]
                wav_path,
                language=self.language,
                beam_size=5,
                vad_filter=True,
            )
            for segment in segments_gen:
                segments_list.append({
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text.strip(),
                })
                full_text_parts.append(segment.text.strip())
                if hasattr(segment, "avg_logprob"):
                    confidences.append(segment.avg_logprob)

            full_text = " ".join(full_text_parts)
            avg_confidence = (
                sum(confidences) / len(confidences) if confidences else None
            )
            detected_lang = info.language if hasattr(info, "language") else self.language

            duration = round(time.perf_counter() - started, 3)
            logger.info(
                "Whisper transcribed %d segments in %.2fs (lang=%s)",
                len(segments_list), duration, detected_lang,
            )

            return ASRResult(
                text=full_text,
                language=detected_lang or self.language,
                engine=self.name,
                confidence=avg_confidence,
                duration_seconds=duration,
                segments=segments_list,
            )
        except Exception as e:
            logger.error("Whisper transcription failed: %s", e)
            return ASRResult(
                text="",
                engine=self.name,
                confidence=0.0,
            )

        finally:
            # Clean up converted WAV if it was a temp conversion
            if wav_path != str(Path(audio_path).resolve()):
                # Keep the converted file for reuse
                pass
