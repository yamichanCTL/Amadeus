from __future__ import annotations

import io

import pytest
import soundfile as sf

from app.core.asr.base import ASRResult, EngineOptions, Segment
from app.tasks.asr_task import (
    _build_audio_inference_chunks,
    _merge_chunk_results,
    _transcribe_audio_via_scheduler,
)
from backend.tests.conftest import make_wav_bytes


def test_build_audio_inference_chunks_splits_long_audio_into_wav_chunks() -> None:
    audio = make_wav_bytes(duration_sec=2.5, sample_rate=16_000)

    chunks = _build_audio_inference_chunks(audio, chunk_sec=1.0)

    assert [(chunk.start_sec, chunk.end_sec) for chunk in chunks] == [
        (0.0, 1.0),
        (1.0, 2.0),
        (2.0, 2.5),
    ]
    decoded_lengths = [
        sf.read(io.BytesIO(chunk.audio_bytes), dtype="float32", always_2d=False)[0].shape[0]
        for chunk in chunks
    ]
    assert decoded_lengths == [16_000, 16_000, 8_000]


def test_merge_chunk_results_offsets_segments_and_keeps_order() -> None:
    chunks = _build_audio_inference_chunks(make_wav_bytes(duration_sec=2.0), chunk_sec=1.0)
    result = _merge_chunk_results([
        (
            chunks[0],
            ASRResult(
                full_text="第一段",
                segments=[Segment(start=0.1, end=0.8, text="第一段", confidence=0.8)],
                language="zh",
                engine_name="mock",
                confidence=0.8,
            ),
        ),
        (
            chunks[1],
            ASRResult(
                full_text="第二段",
                segments=[Segment(start=0.2, end=0.9, text="第二段", confidence=0.6)],
                language="zh",
                engine_name="mock",
                confidence=0.6,
            ),
        ),
    ])

    assert result.full_text == "第一段\n第二段"
    assert [(segment.start, segment.end, segment.text) for segment in result.segments] == [
        (0.1, 0.8, "第一段"),
        (1.2, 1.9, "第二段"),
    ]
    assert result.confidence == 0.7
    assert result.raw == {
        "chunked": True,
        "chunk_count": 2,
        "chunks": [
            {"index": 0, "start_sec": 0.0, "end_sec": 1.0, "text_chars": 3, "segment_count": 1},
            {"index": 1, "start_sec": 1.0, "end_sec": 2.0, "text_chars": 3, "segment_count": 1},
        ],
    }


@pytest.mark.asyncio
async def test_transcribe_audio_via_scheduler_sends_long_chunks_sequentially() -> None:
    calls: list[tuple[str, int, str | None]] = []

    async def transcribe(engine_name: str, audio_bytes: bytes, options: object) -> ASRResult:
        call_index = len(calls)
        language = options.language if isinstance(options, EngineOptions) else None
        calls.append((engine_name, len(audio_bytes), language))
        return ASRResult(
            full_text=f"chunk-{call_index}",
            segments=[Segment(start=0.0, end=1.0, text=f"chunk-{call_index}")],
            language=language,
            engine_name=engine_name,
        )

    result, meta = await _transcribe_audio_via_scheduler(
        engine_name="fireredasr2",
        audio_bytes=make_wav_bytes(duration_sec=2.2),
        options=EngineOptions(language="zh"),
        chunk_sec=1.0,
        transcribe=transcribe,
    )

    assert [call[0] for call in calls] == ["fireredasr2", "fireredasr2", "fireredasr2"]
    assert [call[2] for call in calls] == ["zh", "zh", "zh"]
    assert result.full_text == "chunk-0\nchunk-1\nchunk-2"
    assert [(segment.start, segment.end) for segment in result.segments] == [
        (0.0, 1.0),
        (1.0, 2.0),
        (2.0, 2.2),
    ]
    assert meta == {"asr_chunk_count": 3, "asr_chunk_sec": 1.0}
