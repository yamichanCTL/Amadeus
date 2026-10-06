from __future__ import annotations

import io

import pytest
import soundfile as sf

from app.core.asr.base import ASRResult, EngineOptions, Segment
from app.core.inference_scheduler import inference_timing_from_result
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


def test_merge_written_chunks_keeps_punctuation_and_does_not_invent_timestamps() -> None:
    chunks = _build_audio_inference_chunks(make_wav_bytes(duration_sec=2.0), chunk_sec=1.0)
    result = _merge_chunk_results([
        (chunk, ASRResult(
            full_text=f"第{index + 1}段。", engine_name="formalasr", language="zh",
            raw={
                "output_kind": "written_text", "native_punctuation": True,
                "supports_timestamps": False,
            },
        ))
        for index, chunk in enumerate(chunks)
    ])

    assert result.full_text == "第1段。\n第2段。"
    assert result.segments == []
    assert result.raw["output_kind"] == "written_text"
    assert result.raw["native_punctuation"] is True
    assert result.raw["supports_timestamps"] is False
    assert result.raw["chunk_count"] == 2


@pytest.mark.asyncio
async def test_long_audio_timing_sums_sequential_stages_without_repeating_model_load() -> None:
    calls = 0

    async def transcribe(engine_name, audio_bytes, options):
        nonlocal calls
        calls += 1
        return ASRResult(full_text=f"chunk-{calls}", raw={"inference_timing": {
            "queue_wait_sec": calls / 10,
            "model_ready_sec": 2.0 if calls == 1 else 0.0,
            "model_inference_sec": 1.0,
            "audio_prepare_sec": 0.1,
            "sdk_inference_sec": 0.8,
            "result_format_sec": 0.1,
        }})

    result, meta = await _transcribe_audio_via_scheduler(
        engine_name="formalasr", audio_bytes=make_wav_bytes(duration_sec=2.2),
        options=None, chunk_sec=1.0, transcribe=transcribe,
    )

    assert meta == {"asr_chunk_count": 3, "asr_chunk_sec": 1.0}
    assert inference_timing_from_result(result) == {
        "queue_wait_sec": 0.6, "model_ready_sec": 2.0, "model_inference_sec": 3.0,
        "audio_prepare_sec": 0.3, "sdk_inference_sec": 2.4, "result_format_sec": 0.3,
    }
    assert [chunk["inference_timing"]["model_ready_sec"] for chunk in result.raw["chunks"]] == [2.0, 0.0, 0.0]
    assert "asr_sec" not in result.raw["inference_timing"]
    assert "total_sec" not in result.raw["inference_timing"]


def test_merge_chunk_timing_does_not_publish_partial_stage_as_complete() -> None:
    chunks = _build_audio_inference_chunks(make_wav_bytes(duration_sec=2.0), chunk_sec=1.0)
    result = _merge_chunk_results([
        (chunks[0], ASRResult(full_text="one", raw={"inference_timing": {
            "model_inference_sec": 1.0, "sdk_inference_sec": 0.9,
        }})),
        (chunks[1], ASRResult(full_text="two", raw={"inference_timing": {
            "model_inference_sec": 2.0,
        }})),
    ])
    assert inference_timing_from_result(result) == {"model_inference_sec": 3.0}
    assert result.raw["chunks"][0]["inference_timing"]["sdk_inference_sec"] == 0.9
