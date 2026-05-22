"""
app/core/pipeline/pre/vad.py
─────────────────────────────
Voice Activity Detection — reserved.

When ENABLE_VAD=true this module will:
  1. Run silero-vad on the raw audio.
  2. Return a list of (start_sec, end_sec) speech segments.
  3. The pipeline runner splices them into sub-arrays before passing to the
     ASR engine, reducing hallucinations on silent audio.

Current state: stub that returns the entire audio as one segment.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class SpeechSegment:
    start_sec: float
    end_sec: float


async def detect_speech(
    audio: np.ndarray,
    sample_rate: int = 16_000,
) -> list[SpeechSegment]:
    """
    Detect speech segments in `audio`.

    Returns
    ───────
    List of SpeechSegment objects.  An empty list means no speech detected.

    TODO: wire in silero-vad when ENABLE_VAD=true.
    """
    logger.debug("VAD: stub — returning entire audio as one speech segment.")
    duration = len(audio) / sample_rate
    return [SpeechSegment(start_sec=0.0, end_sec=round(duration, 3))]


def splice_segments(
    audio: np.ndarray,
    segments: list[SpeechSegment],
    sample_rate: int = 16_000,
    padding_sec: float = 0.1,
) -> list[np.ndarray]:
    """
    Splice `audio` into sub-arrays corresponding to `segments`.
    Adds `padding_sec` of silence on each side to avoid clipping.
    """
    chunks: list[np.ndarray] = []
    n = len(audio)
    for seg in segments:
        start = max(0, int((seg.start_sec - padding_sec) * sample_rate))
        end = min(n, int((seg.end_sec + padding_sec) * sample_rate))
        chunks.append(audio[start:end])
    return chunks