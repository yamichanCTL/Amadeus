"""FormalASR contracts without downloading weights or running a GPU model."""

from __future__ import annotations

import json
import io
import math
import sys
import weakref
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
import numpy as np
import soundfile as sf

from app.config import get_settings
from app.core.asr.base import ASRResult, EngineOptions
from app.core.asr.engines.formalasr import FormalASREngine
from app.core.asr.engines.qwen3asr import Qwen3ASREngine, _decode_qwen_audio, _load_qwen_model, _resolve_runtime_options
from app.core.asr.registry import get_engine_class
from backend.tests.conftest import make_wav_bytes


def test_formalasr_defaults_are_separate_from_qwen_and_offline() -> None:
    settings = get_settings()
    engine = get_engine_class("formalasr")()
    info = engine.info()

    assert isinstance(engine, FormalASREngine)
    assert info["model_name"] == "TaurenMountain/FormalASR-1.7B"
    assert Path(info["model_dir"]).name == "FormalASR-1.7B"
    assert Path(info["model_dir"]) != settings.qwen3asr_model_dir
    assert Path(info["model_dir"]).is_absolute()
    assert info["languages"] == ["zh"]
    assert info["output_kind"] == "written_text"
    assert info["supports_streaming"] is False
    assert info["supports_timestamps"] is False
    assert info["native_punctuation"] is True
    assert info["model_modes"] == ["offline"]


@pytest.mark.asyncio
async def test_model_unload_releases_reference_cycles_before_empty_cache(monkeypatch) -> None:
    class CyclicModel:
        def __init__(self):
            self.reference = self

    engine = FormalASREngine()
    model = CyclicModel()
    reference = weakref.ref(model)
    engine._model = model
    del model

    def empty_cache():
        assert reference() is None, "CUDA tensors must be released before flushing cached blocks"

    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: True, empty_cache=empty_cache),
    ))
    await engine.unload()
    assert not engine.is_loaded
    assert reference() is None


@pytest.mark.asyncio
async def test_formalasr_load_forwards_local_weights_device_dtype_and_token_limit(
    monkeypatch, tmp_path,
) -> None:
    from app.core.asr.engines import qwen3asr

    (tmp_path / "model.safetensors").write_bytes(b"test placeholder")
    model = object()
    factory = MagicMock(return_value=model)
    monkeypatch.setitem(sys.modules, "qwen_asr", SimpleNamespace(
        Qwen3ASRModel=SimpleNamespace(from_pretrained=factory),
    ))
    monkeypatch.setattr(qwen3asr, "_resolve_torch_dtype", lambda name: f"resolved:{name}")
    engine = FormalASREngine(
        model_dir=str(tmp_path), device="cpu", torch_dtype="float32", max_new_tokens=768,
    )

    await engine.load()
    await engine.load()  # idempotent

    factory.assert_called_once_with(
        str(tmp_path), device_map="cpu", dtype="resolved:float32",
        max_new_tokens=768, max_inference_batch_size=1,
    )
    assert engine.is_loaded
    assert engine.info()["compute_type"] == "float32"


def test_qwen_loader_does_not_retry_without_explicit_device_on_type_error() -> None:
    factory = MagicMock(side_effect=TypeError("invalid runtime option"))
    with pytest.raises(TypeError, match="invalid runtime option"):
        _load_qwen_model(SimpleNamespace(from_pretrained=factory), "model", {"device_map": "cpu"})
    assert factory.call_count == 1


@pytest.mark.parametrize("cuda_available, expected", [
    (False, ("cpu", "float32")), (True, ("cuda:0", "bfloat16")),
])
def test_managed_runtime_auto_device_follows_installed_torch(monkeypatch, cuda_available, expected):
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: cuda_available),
    ))
    assert _resolve_runtime_options("auto", "auto") == expected
    assert _resolve_runtime_options("cuda:1", "float16") == ("cuda:1", "float16")


@pytest.mark.parametrize("engine_class", [FormalASREngine, Qwen3ASREngine])
@pytest.mark.parametrize("fail_inference", [False, True])
@pytest.mark.parametrize("supported_wav", [False, True])
def test_supported_wav_uses_waveform_and_codec_fallback_cleans_up(
    engine_class, fail_inference, supported_wav, tmp_path,
) -> None:
    wav = make_wav_bytes(0.1) if supported_wav else b"SDK-only test container"
    paths: list[Path] = []

    def transcribe(*, audio, **kwargs):
        if supported_wav:
            assert isinstance(audio, tuple)
            assert audio[1] == 16000
            assert len(audio[0]) == 1600
            assert audio[0].dtype == np.float32
        else:
            path = Path(audio)
            paths.append(path)
            # On Windows this fails if the temporary writer is still open.
            assert path.read_bytes() == wav
        if fail_inference:
            raise RuntimeError("test decode failed")
        if engine_class is FormalASREngine:
            assert kwargs == {"language": "Chinese", "return_time_stamps": False}
        return [SimpleNamespace(text="请将会议改到周四。", language="Chinese")]

    engine = engine_class(model_dir=str(tmp_path), device="cpu")
    engine._model = SimpleNamespace(transcribe=transcribe)
    if fail_inference:
        with pytest.raises(RuntimeError, match="test decode failed"):
            engine._run_inference(wav, EngineOptions())
    else:
        result = engine._run_inference(wav, EngineOptions())
        assert result.full_text == "请将会议改到周四。"
        json.dumps(result.raw, ensure_ascii=False)
        timing = result.raw["inference_timing"]
        assert timing["sdk_inference_sec"] >= 0
        assert timing["audio_input_mode"] == ("waveform" if supported_wav else "sdk_path")
        assert (timing["audio_decode_sec"] is not None) == supported_wav
        if engine_class is FormalASREngine:
            assert result.engine_name == "formalasr"
            assert result.language == "zh"
            assert result.segments == []
            assert result.raw["native_punctuation"] is True
    assert len(paths) == (0 if supported_wav else 1)
    for path in paths:
        assert not path.exists()


@pytest.mark.parametrize("sample_rate", [16000, 44100, 48000])
@pytest.mark.parametrize("channels", [1, 2])
def test_decode_preserves_full_duration_and_mono_channels(sample_rate, channels):
    frames = sample_rate // 5 + 7
    waveform = np.sin(np.arange(frames) * 0.1).astype(np.float32) * 0.2
    if channels == 2:
        waveform = np.stack((waveform, waveform * 0.5), axis=-1)
    buffer = io.BytesIO()
    sf.write(buffer, waveform, sample_rate, format="WAV", subtype="FLOAT")
    result, rate = _decode_qwen_audio(buffer.getvalue())
    assert rate == 16000
    assert len(result) == math.ceil(frames * 16000 / sample_rate)
    assert result.dtype == np.float32
    assert np.isfinite(result).all()
    if sample_rate == 16000:
        expected = waveform.mean(axis=-1) if channels == 2 else waveform
        np.testing.assert_array_equal(result, expected)


@pytest.mark.parametrize("options", [EngineOptions(language="en"), EngineOptions(task="translate")])
def test_formalasr_does_not_claim_translation_or_non_chinese_support(options) -> None:
    engine = FormalASREngine()
    model = MagicMock()
    engine._model = model
    with pytest.raises(ValueError):
        engine._call_model("unused.wav", options)
    model.transcribe.assert_not_called()


@pytest.mark.asyncio
async def test_formalasr_model_api_maps_config_to_own_engine() -> None:
    from app.api.v1.models import LoadModelRequest, load_model

    engine = FormalASREngine(device="cpu", torch_dtype="float32", max_new_tokens=768)
    manager = MagicMock()
    manager.hot_swap = AsyncMock()
    manager.get_engine = AsyncMock(return_value=engine)
    response = await load_model("formalasr", manager, LoadModelRequest(
        model_name="TaurenMountain/FormalASR-1.7B", device="cpu", compute_type="float32",
        extra={"max_new_tokens": 768},
    ))

    manager.hot_swap.assert_awaited_once_with(
        "formalasr", model_name="TaurenMountain/FormalASR-1.7B",
        model_dir=str(get_settings().formalasr_model_dir), device="cpu",
        torch_dtype="float32", max_new_tokens=768,
    )
    assert response.engine == "formalasr"
    assert response.compute_type == "float32"
    assert response.extra["output_kind"] == "written_text"


def _written_result() -> ASRResult:
    return ASRResult(
        full_text="请将会议改到周四。", engine_name="formalasr", language="zh",
        raw={"native_punctuation": True, "supports_timestamps": False, "output_kind": "written_text"},
    )


@pytest.mark.asyncio
async def test_formalasr_sync_transcription_skips_repunctuation(async_client, monkeypatch) -> None:
    from app.api.v1 import transcribe

    inference = AsyncMock(return_value=_written_result())
    punctuation = AsyncMock(side_effect=AssertionError("written text must not be repunctuated"))
    monkeypatch.setattr(transcribe, "transcribe_with_scheduler", inference)
    monkeypatch.setattr(transcribe, "restore_punctuation", punctuation)
    response = await async_client.post(
        "/v1/transcribe", files={"file": ("speech.wav", make_wav_bytes(0.1), "audio/wav")},
        data={"options": json.dumps({
            "engine": "formalasr", "enable_punctuation": True, "enable_hotwords": False,
        })},
    )
    assert response.status_code == 200, response.text
    assert response.json()["full_text"] == "请将会议改到周四。"
    assert response.json()["segments"] == []
    assert response.json()["llm_outputs"] is None
    punctuation.assert_not_awaited()
    assert inference.await_args.args[0] == "formalasr"


@pytest.mark.asyncio
async def test_formalasr_background_task_skips_repunctuation(db_session, monkeypatch, tmp_path) -> None:
    from app.core import inference_scheduler
    from app.core.pipeline.post import punctuation
    from app.db import session
    from app.db.crud import create_task, update_task_audio_path
    from app.tasks.asr_task import _run

    @asynccontextmanager
    async def sessions():
        yield db_session

    inference = AsyncMock(return_value=_written_result())
    restore = AsyncMock(side_effect=AssertionError("written text must not be repunctuated"))
    monkeypatch.setattr(session, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(inference_scheduler, "transcribe_with_scheduler", inference)
    monkeypatch.setattr(punctuation, "restore_punctuation", restore)
    audio_path = tmp_path / "speech.wav"
    audio_path.write_bytes(make_wav_bytes(0.1))
    task = await create_task(
        db_session, engines=["formalasr"], filename="speech.wav", punctuation_enabled=True,
        engine_options={"enable_hotwords": False, "timeout_sec": 0},
    )
    await update_task_audio_path(db_session, task.id, str(audio_path), 0.1)
    await db_session.commit()

    result = await _run(task.id)

    assert result["status"] == "success", result
    assert result["full_text"] == "请将会议改到周四。"
    restore.assert_not_awaited()
    assert not audio_path.exists()  # existing opt-in privacy policy remains intact
