"""
app/core/pipeline/post/diarize.py
───────────────────────────────────
Speaker diarization — reserved.

When ENABLE_DIARIZE=true this module will:
  - Run pyannote.audio on the raw audio to produce speaker turn timestamps.
  - Align the speaker turns with ASR segments (by time overlap).
  - Annotate each Segment with a speaker label (SPEAKER_00, SPEAKER_01, …).

Current state: stub that returns segments unchanged.
"""

from __future__ import annotations

import logging

import numpy as np

from app.core.asr.base import Segment

logger = logging.getLogger(__name__)


async def assign_speakers(
    segments: list[Segment],
    audio: np.ndarray,
    sample_rate: int = 16_000,
) -> list[Segment]:
    """
    Assign speaker labels to each segment.

    Returns
    ───────
    The same list with `segment.speaker` populated.

    TODO: integrate pyannote.audio when ENABLE_DIARIZE=true.
    """
    logger.debug("Diarization: stub — no speaker assignment applied.")
    return segments