from __future__ import annotations

import sys
import wave
from io import BytesIO
from types import SimpleNamespace

import numpy as np
import pytest
from app.core.asr.engines.x_asr import XASREngine
from app.core.model_errors import ModelRuntimeError


class FakeOnlineStream:
    def __init__(self) -> None:
        self.samples = 0
        self.ready = False
        self.finished = False

    def accept_waveform(self, sample_rate: int, samples: np.ndarray) -> None:
        assert sample_rate == 16_000
        self.samples += len(samples)
        self.ready = True

    def input_finished(self) -> None:
        self.finished = True
        self.ready = True


class FakeRecognizer:
    def __init__(self) -> None:
        self.streams: list[FakeOnlineStream] = []

    def create_stream(self) -> FakeOnlineStream:
        stream = FakeOnlineStream()
        self.streams.append(stream)
        return stream

    def is_ready(self, stream: FakeOnlineStream) -> bool:
        return stream.ready

    def decode_stream(self, stream: FakeOnlineStream) -> None:
        stream.ready = False

    def get_result(self, stream: FakeOnlineStream) -> str:
        return "你好世界" if stream.finished else "你好"


def _install_fake_sherpa(monkeypatch: pytest.MonkeyPatch, recognizer: FakeRecognizer) -> None:
    class OnlineRecognizer:
        @staticmethod
        def from_transducer(**kwargs):
            assert kwargs["model_type"] == "zipformer2"
            assert kwargs["sample_rate"] == 16_000
            return recognizer

    monkeypatch.setitem(
        sys.modules,
        "sherpa_onnx",
        SimpleNamespace(OnlineRecognizer=OnlineRecognizer),
    )


def _model_dir(tmp_path, chunk_ms: int = 160):
    model_dir = tmp_path / f"chunk-{chunk_ms}ms-model"
    model_dir.mkdir()
    (model_dir / "tokens.txt").write_text("0 <blk>\n1 你\n", encoding="utf-8")
    for name in (f"encoder-{chunk_ms}ms.onnx", f"decoder-{chunk_ms}ms.onnx", f"joiner-{chunk_ms}ms.onnx"):
        (model_dir / name).write_bytes(b"onnx-model")
    return model_dir


@pytest.mark.asyncio
async def test_x_asr_reuses_online_stream_for_partial_and_final(tmp_path, monkeypatch) -> None:
    recognizer = FakeRecognizer()
    _install_fake_sherpa(monkeypatch, recognizer)
    engine = XASREngine(model_dir=str(_model_dir(tmp_path)), device="cpu")

    await engine.load()
    stream = await engine.create_streaming_session()
    partial = await stream.accept_pcm(np.ones(2560, dtype="<i2").tobytes())
    final = await stream.finish()

    assert len(recognizer.streams) == 1
    assert partial is not None
    assert partial.full_text == "你好"
    assert partial.raw["is_final"] is False
    assert final.full_text == "你好世界"
    assert final.raw["is_final"] is True
    assert engine.info()["supports_streaming"] is True
    await engine.unload()


@pytest.mark.parametrize("chunk_ms", [160, 480, 960, 1920])
def test_x_asr_resolves_all_released_window_files(tmp_path, chunk_ms: int) -> None:
    engine = XASREngine(
        model_name=f"chunk-{chunk_ms}ms-model",
        model_dir=str(_model_dir(tmp_path, chunk_ms)),
        device="cpu",
    )

    assert engine.info()["chunk_ms"] == chunk_ms
    assert {path.name for path in engine._model_paths().values()} == {
        "tokens.txt",
        f"encoder-{chunk_ms}ms.onnx",
        f"decoder-{chunk_ms}ms.onnx",
        f"joiner-{chunk_ms}ms.onnx",
    }


@pytest.mark.parametrize("chunk_ms", [160, 480, 960, 1920])
def test_x_asr_released_variant_is_downloaded_and_selectable(chunk_ms: int) -> None:
    engine = XASREngine(model_name=f"chunk-{chunk_ms}ms-model", device="cpu")

    info = engine.info()
    assert info["model_available"] is True
    assert info["chunk_ms"] == chunk_ms
    assert f"chunk-{chunk_ms}ms-model" in info["available_variants"]


@pytest.mark.asyncio
async def test_x_asr_supports_complete_wav_through_streaming_runtime(tmp_path, monkeypatch) -> None:
    recognizer = FakeRecognizer()
    _install_fake_sherpa(monkeypatch, recognizer)
    engine = XASREngine(model_dir=str(_model_dir(tmp_path)), device="cpu")
    pcm = np.ones(3200, dtype="<i2")
    buffer = BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16_000)
        wav.writeframes(pcm.tobytes())

    result = await engine.transcribe(buffer.getvalue())

    assert result.full_text == "你好世界"
    assert result.engine_name == "x-asr"
    assert len(recognizer.streams) == 1
    await engine.unload()


@pytest.mark.asyncio
async def test_x_asr_rejects_cpu_only_runtime_when_cuda_requested(tmp_path, monkeypatch) -> None:
    recognizer = FakeRecognizer()
    _install_fake_sherpa(monkeypatch, recognizer)
    monkeypatch.setattr(sys.modules["sherpa_onnx"], "__version__", "1.12.39", raising=False)
    monkeypatch.setattr("app.core.asr.engines.x_asr.settings.x_asr_isolate_cuda", False)
    engine = XASREngine(model_dir=str(_model_dir(tmp_path)), device="cuda")

    with pytest.raises(RuntimeError, match="CPU-only"):
        await engine.load()


@pytest.mark.asyncio
async def test_x_asr_cuda_warmup_failure_does_not_mark_model_loaded(tmp_path, monkeypatch) -> None:
    class FailingRecognizer(FakeRecognizer):
        def decode_stream(self, stream: FakeOnlineStream) -> None:
            raise RuntimeError("CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH")

    recognizer = FailingRecognizer()
    _install_fake_sherpa(monkeypatch, recognizer)
    monkeypatch.setattr(sys.modules["sherpa_onnx"], "__version__", "1.13.2+cuda12.cudnn9", raising=False)
    monkeypatch.setattr("app.core.asr.engines.x_asr.settings.x_asr_isolate_cuda", False)
    monkeypatch.setattr("app.core.asr.engines.x_asr._preload_cuda_libraries", lambda *_: None)

    async def run_inline(function, *args):
        return function(*args)

    # pytest-asyncio on Python 3.13 leaves the default to_thread executor alive
    # after this isolated test; inline execution keeps the unit test deterministic.
    monkeypatch.setattr("app.core.asr.engines.x_asr.asyncio.to_thread", run_inline)
    engine = XASREngine(model_dir=str(_model_dir(tmp_path)), device="cuda")

    with pytest.raises(ModelRuntimeError) as error:
        await engine.load()

    assert error.value.code == "model_not_loaded"
    assert not engine.is_loaded
    assert len(recognizer.streams) == 1


@pytest.mark.asyncio
async def test_x_asr_runtime_failure_revokes_loaded_state(tmp_path, monkeypatch) -> None:
    class FailingRecognizer(FakeRecognizer):
        def decode_stream(self, stream: FakeOnlineStream) -> None:
            raise RuntimeError("CUDA out of memory")

    recognizer = FailingRecognizer()
    _install_fake_sherpa(monkeypatch, recognizer)
    engine = XASREngine(model_dir=str(_model_dir(tmp_path)), device="cpu")
    await engine.load()
    stream = await engine.create_streaming_session()

    with pytest.raises(ModelRuntimeError) as error:
        await stream.accept_pcm(np.ones(2560, dtype="<i2").tobytes())

    assert error.value.code == "gpu_out_of_memory"
    assert not engine.is_loaded
