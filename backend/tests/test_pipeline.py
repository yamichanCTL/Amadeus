"""
tests/test_pipeline.py
───────────────────────
Tests for pre/post pipeline stubs.
These are lightweight smoke tests — the stubs are identity functions, so we
verify they pass through data unchanged and don't raise.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.core.asr.base import Segment
from app.core.pipeline.post.diarize import assign_speakers
from app.core.pipeline.post.punctuation import restore_punctuation
from app.core.pipeline.pre.vad import SpeechSegment, detect_speech, splice_segments


# ── VAD ───────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_vad_stub_returns_single_segment() -> None:
    audio = np.zeros(16_000, dtype=np.float32)  # 1 second silence
    segments = await detect_speech(audio, sample_rate=16_000)
    assert len(segments) == 1
    assert segments[0].start_sec == 0.0
    assert segments[0].end_sec == pytest.approx(1.0, abs=0.01)


@pytest.mark.asyncio
async def test_vad_stub_empty_audio() -> None:
    audio = np.zeros(0, dtype=np.float32)
    segments = await detect_speech(audio, sample_rate=16_000)
    assert isinstance(segments, list)


def test_splice_segments_basic() -> None:
    audio = np.ones(32_000, dtype=np.float32)  # 2 seconds
    segments = [SpeechSegment(start_sec=0.5, end_sec=1.5)]
    chunks = splice_segments(audio, segments, sample_rate=16_000, padding_sec=0.0)
    assert len(chunks) == 1
    # 1.5 - 0.5 = 1 second = 16000 samples
    assert len(chunks[0]) == pytest.approx(16_000, abs=100)


def test_splice_segments_padding_clamped() -> None:
    """Padding should not extend beyond audio boundaries."""
    audio = np.ones(1600, dtype=np.float32)  # 0.1 s
    segments = [SpeechSegment(start_sec=0.0, end_sec=0.1)]
    chunks = splice_segments(audio, segments, sample_rate=16_000, padding_sec=1.0)
    assert len(chunks) == 1
    assert len(chunks[0]) == len(audio)  # clamped to audio length


# ── Punctuation ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_punctuation_stub_passthrough() -> None:
    text = "hello world this is a test"
    result = await restore_punctuation(text)
    assert result == text


@pytest.mark.asyncio
async def test_punctuation_stub_empty_string() -> None:
    result = await restore_punctuation("")
    assert result == ""


@pytest.mark.asyncio
async def test_punctuation_stub_with_language() -> None:
    text = "你好世界"
    result = await restore_punctuation(text, language="zh")
    assert result == text


# ── Diarization ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_diarize_stub_returns_unchanged() -> None:
    segs = [
        Segment(start=0.0, end=1.0, text="Hello", confidence=0.9),
        Segment(start=1.0, end=2.0, text="World", confidence=0.8),
    ]
    audio = np.zeros(32_000, dtype=np.float32)
    result = await assign_speakers(segs, audio)

    assert len(result) == len(segs)
    for original, returned in zip(segs, result):
        assert original.text == returned.text
        assert returned.speaker is None  # stub doesn't assign speakers


@pytest.mark.asyncio
async def test_diarize_stub_empty_segments() -> None:
    audio = np.zeros(16_000, dtype=np.float32)
    result = await assign_speakers([], audio)
    assert result == []