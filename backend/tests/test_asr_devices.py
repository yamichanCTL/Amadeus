"""Device selection must be explicit when CUDA is unavailable."""

from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.config import Settings
from app.core.asr.engines import formalasr, qwen3asr
from app.core.model_errors import classify_model_error


@pytest.fixture
def clean_device_defaults(monkeypatch):
    # Ignore this developer's .env and test both adapters against real defaults.
    for name in (
        "DEFAULT_QWEN3ASR_DEVICE", "DEFAULT_FORMALASR_DEVICE",
        "QWEN3ASR_TORCH_DTYPE", "FORMALASR_TORCH_DTYPE",
    ):
        monkeypatch.delenv(name, raising=False)

    def configure() -> None:
        settings = Settings(_env_file=None)
        monkeypatch.setattr(qwen3asr, "settings", settings)
        monkeypatch.setattr(formalasr, "get_settings", lambda: settings)

    return configure


def _mock_model_runtime(monkeypatch, *, cuda_available: bool) -> MagicMock:
    factory = MagicMock(return_value=object())
    monkeypatch.setitem(sys.modules, "qwen_asr", SimpleNamespace(
        Qwen3ASRModel=SimpleNamespace(from_pretrained=factory),
    ))
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(
        bfloat16="torch.bfloat16", float16="torch.float16", float32="torch.float32",
        cuda=SimpleNamespace(is_available=lambda: cuda_available),
    ))
    return factory


@pytest.mark.parametrize("engine_class", [qwen3asr.Qwen3ASREngine, formalasr.FormalASREngine])
@pytest.mark.parametrize("managed_runtime", [False, True])
@pytest.mark.parametrize("cuda_available", [False, True])
async def test_default_load_requires_cuda_in_all_runtimes(
    monkeypatch, tmp_path, clean_device_defaults, engine_class, managed_runtime, cuda_available,
) -> None:
    if managed_runtime:
        monkeypatch.setenv("AMADEUS_MANAGED_RUNTIME", "1")
    else:
        monkeypatch.delenv("AMADEUS_MANAGED_RUNTIME", raising=False)
    clean_device_defaults()
    factory = _mock_model_runtime(monkeypatch, cuda_available=cuda_available)
    (tmp_path / "config.json").write_text("{}", encoding="utf-8")
    engine = engine_class(model_dir=str(tmp_path))

    assert engine.info()["device"] == "cuda:0"
    if cuda_available:
        await engine.load()
        factory.assert_called_once()
        assert factory.call_args.args == (str(tmp_path),)
        assert factory.call_args.kwargs["device_map"] == "cuda:0"
        assert factory.call_args.kwargs["dtype"] == "torch.bfloat16"
        assert engine.is_loaded
    else:
        with pytest.raises(RuntimeError, match="No CUDA GPUs are available") as caught:
            await engine.load()
        factory.assert_not_called()
        assert not engine.is_loaded
        failure = classify_model_error(caught.value, engine.name)
        assert failure.code == "gpu_not_available"
        assert "PyTorch" in failure.user_message
    assert engine.info()["device"] == "cuda:0"


@pytest.mark.parametrize("engine_class", [qwen3asr.Qwen3ASREngine, formalasr.FormalASREngine])
@pytest.mark.parametrize("device,cuda_available,expected_device,expected_dtype", [
    ("cpu", False, "cpu", "torch.float32"),
    ("cpu", True, "cpu", "torch.float32"),
    ("auto", False, "cpu", "torch.float32"),
    ("auto", True, "cuda:0", "torch.bfloat16"),
    ("cuda:1", True, "cuda:1", "torch.bfloat16"),
])
async def test_explicit_device_selection_reaches_model_loader(
    monkeypatch, tmp_path, engine_class, device, cuda_available, expected_device, expected_dtype,
) -> None:
    factory = _mock_model_runtime(monkeypatch, cuda_available=cuda_available)
    engine = engine_class(model_dir=str(tmp_path), device=device, torch_dtype="auto")

    await engine.load()

    factory.assert_called_once()
    assert factory.call_args.kwargs["device_map"] == expected_device
    assert factory.call_args.kwargs["dtype"] == expected_dtype
    assert engine.info()["device"] == expected_device
    assert engine.is_loaded


@pytest.mark.parametrize("engine_class", [qwen3asr.Qwen3ASREngine, formalasr.FormalASREngine])
async def test_explicit_cuda_failure_does_not_retry_on_cpu(
    monkeypatch, tmp_path, engine_class,
) -> None:
    factory = _mock_model_runtime(monkeypatch, cuda_available=False)
    engine = engine_class(model_dir=str(tmp_path), device="cuda:1", torch_dtype="float16")

    with pytest.raises(RuntimeError, match="device 'cuda:1'"):
        await engine.load()

    factory.assert_not_called()
    assert engine.info()["device"] == "cuda:1"
    assert engine.info()["compute_type"] == "float16"
    assert not engine.is_loaded
