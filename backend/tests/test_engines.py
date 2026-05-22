"""
tests/test_engines.py
──────────────────────
Unit tests for ASR engines and ModelRouter.
All tests use the MockASREngine — no real model files required.
"""

from __future__ import annotations

import pytest

from app.core.asr.base import ASRResult, EngineOptions
from app.core.asr.router import ModelRouter
from app.core.model_manager import ModelManager
from app.core.asr.registry import available_engines, get_engine_class
from tests.conftest import MockASREngine, make_wav_bytes


# ── Registry ──────────────────────────────────────────────────────────────────

def test_registry_contains_default_engines() -> None:
    engines = available_engines()
    assert "fireredasr2" in engines
    assert "whisper" in engines
    assert "vosk" in engines
    assert "sherpa" in engines
    assert "mock" in engines


def test_registry_unknown_engine_raises() -> None:
    with pytest.raises(KeyError, match="Unknown ASR engine"):
        get_engine_class("does_not_exist")


# ── MockASREngine ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_mock_engine_lifecycle() -> None:
    engine = MockASREngine()
    assert not engine.is_loaded

    await engine.load()
    assert engine.is_loaded

    await engine.unload()
    assert not engine.is_loaded


@pytest.mark.asyncio
async def test_mock_engine_transcribe() -> None:
    engine = MockASREngine()
    await engine.load()

    audio = make_wav_bytes(1.0)
    result = await engine.transcribe(audio)

    assert isinstance(result, ASRResult)
    assert result.full_text == "测试识别结果"
    assert result.language == "zh"
    assert result.engine_name == "mock"
    assert result.confidence == pytest.approx(0.95)
    assert len(result.segments) == 1
    assert result.segments[0].start == 0.0
    assert result.segments[0].end == 1.0


@pytest.mark.asyncio
async def test_mock_engine_auto_loads_on_transcribe() -> None:
    """transcribe() should call load() automatically if not loaded."""
    engine = MockASREngine()
    assert not engine.is_loaded
    audio = make_wav_bytes(0.5)
    result = await engine.transcribe(audio)
    assert result.full_text  # got a result
    assert engine.is_loaded  # side-effect: engine is now loaded


# ── ModelManager ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_model_manager_get_engine() -> None:
    from app.core.asr.registry import register_engine
    register_engine("mock", MockASREngine)

    manager = ModelManager()
    engine = await manager.get_engine("mock")
    assert engine.is_loaded
    assert engine.name == "mock"


@pytest.mark.asyncio
async def test_model_manager_hot_swap() -> None:
    from app.core.asr.registry import register_engine
    register_engine("mock", MockASREngine)

    manager = ModelManager()
    await manager.get_engine("mock")
    assert manager.is_loaded("mock")

    await manager.hot_swap("mock")
    assert manager.is_loaded("mock")


@pytest.mark.asyncio
async def test_model_manager_unload() -> None:
    from app.core.asr.registry import register_engine
    register_engine("mock", MockASREngine)

    manager = ModelManager()
    await manager.get_engine("mock")
    assert manager.is_loaded("mock")

    await manager.unload_engine("mock")
    assert not manager.is_loaded("mock")


# ── ModelRouter ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_router_single_engine() -> None:
    from app.core.asr.registry import register_engine
    register_engine("mock", MockASREngine)

    manager = ModelManager()
    router = ModelRouter(manager, engines=["mock"])
    audio = make_wav_bytes(1.0)
    result = await router.run(audio)

    assert result.full_text == "测试识别结果"
    assert result.engine_name == "mock"


@pytest.mark.asyncio
async def test_router_multi_engine_first_strategy() -> None:
    from app.core.asr.registry import register_engine
    register_engine("mock", MockASREngine)
    register_engine("mock2", MockASREngine)

    manager = ModelManager()
    router = ModelRouter(manager, engines=["mock", "mock2"], merge_strategy="first")
    audio = make_wav_bytes(1.0)
    result = await router.run(audio)

    assert result.full_text == "测试识别结果"
    assert "all_engines" in result.raw


@pytest.mark.asyncio
async def test_router_multi_engine_concat_strategy() -> None:
    from app.core.asr.registry import register_engine
    register_engine("mock", MockASREngine)
    register_engine("mock2", MockASREngine)

    manager = ModelManager()
    router = ModelRouter(manager, engines=["mock", "mock2"], merge_strategy="concat")
    audio = make_wav_bytes(1.0)
    result = await router.run(audio)

    assert "[mock]" in result.full_text


@pytest.mark.asyncio
async def test_router_invalid_engine_raises() -> None:
    manager = ModelManager()
    router = ModelRouter(manager, engines=["does_not_exist"])
    audio = make_wav_bytes(0.5)
    # Single-engine path: KeyError from registry bubbles up directly
    # Multi-engine path: wrapped in RuntimeError after all engines fail
    # Either is acceptable — just assert it raises
    with pytest.raises((RuntimeError, KeyError)):
        await router.run(audio)


def test_router_empty_engines_raises() -> None:
    manager = ModelManager()
    with pytest.raises(ValueError, match="At least one engine"):
        ModelRouter(manager, engines=[])
