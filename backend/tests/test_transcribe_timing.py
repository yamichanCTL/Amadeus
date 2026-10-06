from __future__ import annotations

import importlib
import json
from types import SimpleNamespace

import pytest

from app.core.asr.base import ASRResult
from app.db.crud import create_task, get_task
from app.tasks.asr_task import _run
from backend.tests.conftest import make_wav_bytes


@pytest.mark.asyncio
async def test_sync_response_keeps_wall_clock_totals_and_exposes_nested_asr_stages(async_client, monkeypatch):
    module = importlib.import_module("app.api.v1.transcribe")
    current = 100.0
    monkeypatch.setattr(module, "time", SimpleNamespace(perf_counter=lambda: current))

    async def timed_transcribe(*args):
        nonlocal current
        current += 6.0
        return ASRResult(full_text="测试", engine_name="mock", raw={"inference_timing": {
            "queue_wait_sec": 1.0, "model_ready_sec": 2.0, "model_inference_sec": 3.0,
            "audio_prepare_sec": 0.1, "sdk_inference_sec": 2.8, "result_format_sec": 0.1,
            "audio_decode_sec": 0.05,
            "total_sec": 999.0,
        }})

    monkeypatch.setattr(module, "transcribe_with_scheduler", timed_transcribe)
    response = await async_client.post(
        "/v1/transcribe",
        files={"file": ("timing.wav", make_wav_bytes(1.0), "audio/wav")},
        data={"options": json.dumps({"engine": "mock", "enable_punctuation": False, "enable_hotwords": False})},
    )
    assert response.status_code == 200, response.text
    timing = response.json()["timing"]
    assert timing["asr_sec"] == 6.0
    assert timing["total_sec"] == 6.0
    assert timing["queue_wait_sec"] == 1.0
    assert timing["model_ready_sec"] == 2.0
    assert timing["model_inference_sec"] == 3.0
    assert timing["audio_prepare_sec"] == 0.1
    assert timing["sdk_inference_sec"] == 2.8
    assert timing["audio_decode_sec"] == 0.05
    assert timing["result_format_sec"] == 0.1


@pytest.mark.asyncio
async def test_async_task_persists_the_same_optional_stage_contract(db_session, tmp_path, monkeypatch):
    audio_path = tmp_path / "timing.wav"
    audio_path.write_bytes(make_wav_bytes(1.0))
    task = await create_task(
        db_session, engines=["mock"], filename="timing.wav", audio_path=str(audio_path),
        engine_options={"timeout_sec": 0, "long_audio_chunk_sec": 0, "enable_hotwords": False},
    )
    await db_session.commit()

    class SessionContext:
        async def __aenter__(self):
            return db_session

        async def __aexit__(self, *args):
            return None

    async def timed_transcribe(*args):
        return ASRResult(full_text="测试", engine_name="mock", raw={"inference_timing": {
            "queue_wait_sec": 0.0, "model_ready_sec": 0.0, "model_inference_sec": 0.000001,
            "sdk_inference_sec": 0.000001,
        }})

    monkeypatch.setattr("app.db.session.AsyncSessionLocal", SessionContext)
    monkeypatch.setattr("app.core.inference_scheduler.transcribe_with_scheduler", timed_transcribe)
    result = await _run(task.id)
    assert result["status"] == "success"

    saved = await get_task(db_session, task.id)
    raw = json.loads(saved.transcript.raw_results)
    timing = raw["timing"]
    assert timing["queue_wait_sec"] == 0.0
    assert timing["model_ready_sec"] == 0.0
    assert timing["model_inference_sec"] == 0.000001
    assert timing["sdk_inference_sec"] == 0.000001
    assert timing["asr_sec"] >= 0
    assert timing["total_sec"] >= timing["asr_sec"]
    assert "audio_decode_sec" not in timing
    assert not audio_path.exists()
