"""
tests/test_pipeline.py
───────────────────────
Tests for the lightweight pre/post pipeline boundaries.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.core.pipeline.post import punctuation
from app.core.pipeline.post.punctuation import restore_punctuation
from app.core.pipeline.pre.vad import SpeechSegment, detect_speech, splice_segments


async def _run_inline(function, *args):
    return function(*args)


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
async def test_punctuation_restores_model_text(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakePunctuationModel:
        def generate(self, *, input: str):
            assert input == "hello world this is a test"
            return [{"text": "Hello world, this is a test."}]

    monkeypatch.setattr(punctuation, "_load_model", lambda: FakePunctuationModel())
    monkeypatch.setattr(punctuation.asyncio, "to_thread", _run_inline)
    text = "hello world this is a test"
    result = await restore_punctuation(text)
    assert result == "Hello world, this is a test."


@pytest.mark.asyncio
async def test_punctuation_empty_string_does_not_load_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(punctuation, "_load_model", lambda: pytest.fail("empty input loaded model"))
    result = await restore_punctuation("")
    assert result == ""


@pytest.mark.asyncio
async def test_punctuation_rejects_empty_model_result(monkeypatch: pytest.MonkeyPatch) -> None:
    class EmptyModel:
        def generate(self, *, input: str):
            return []

    monkeypatch.setattr(punctuation, "_load_model", lambda: EmptyModel())
    monkeypatch.setattr(punctuation.asyncio, "to_thread", _run_inline)
    with pytest.raises(RuntimeError, match="未返回有效文本"):
        await restore_punctuation("你好世界", language="zh")
