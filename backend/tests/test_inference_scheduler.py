from __future__ import annotations

import asyncio
from typing import Any

import numpy as np
import pytest

from app.core.asr.base import ASRResult, BaseASREngine, EngineOptions, Segment
from app.core.asr.registry import available_engines
from app.core.asr.engines.fireredasr2 import FireRedASR2Engine
from app.core.inference_scheduler import InferenceScheduler


class ScheduledEngine(BaseASREngine):
    def __init__(self, name: str, delay: float = 0.0, block_first_batch: bool = False) -> None:
        self._name = name
        self.delay = delay
        self.block_first_batch = block_first_batch
        self.loaded = True
        self.batch_sizes: list[int] = []
        self.active = 0
        self.max_active = 0
        self.first_batch_started = asyncio.Event()
        self.release_first_batch = asyncio.Event()

    @property
    def name(self) -> str:
        return self._name

    async def load(self) -> None:
        self.loaded = True

    async def unload(self) -> None:
        self.loaded = False

    @property
    def is_loaded(self) -> bool:
        return self.loaded

    async def transcribe(self, audio_bytes: bytes, options: EngineOptions | None = None) -> ASRResult:
        return ASRResult(
            full_text=f"{self.name}:{len(audio_bytes)}",
            segments=[Segment(start=0.0, end=1.0, text=self.name)],
            language=options.language if options else None,
            engine_name=self.name,
        )

    async def transcribe_batch(self, items: list[tuple[bytes, EngineOptions | None]]) -> list[ASRResult]:
        self.batch_sizes.append(len(items))
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            if self.block_first_batch and len(self.batch_sizes) == 1:
                self.first_batch_started.set()
                await self.release_first_batch.wait()
            elif self.delay:
                await asyncio.sleep(self.delay)
            return [
                ASRResult(
                    full_text=f"{self.name}:{index}",
                    segments=[Segment(start=0.0, end=1.0, text=self.name)],
                    language=options.language if options else None,
                    engine_name=self.name,
                )
                for index, (_audio, options) in enumerate(items)
            ]
        finally:
            self.active -= 1


class StaticProvider:
    def __init__(self, *, block_first_batch: bool = False) -> None:
        self.engines: dict[str, ScheduledEngine] = {}
        self.block_first_batch = block_first_batch

    async def get_engine(self, name: str) -> ScheduledEngine:
        key = name.lower()
        self.engines.setdefault(key, ScheduledEngine(key, block_first_batch=self.block_first_batch))
        return self.engines[key]


@pytest.mark.asyncio
async def test_scheduler_accepts_every_registered_offline_engine() -> None:
    provider = StaticProvider()
    scheduler = InferenceScheduler(provider, max_batch_items=4, max_wait_ms=10)
    engine_names = ["fireredasr2", "sensevoice", "whisper", "qwen3asr", "x-asr", "mock"]
    assert set(engine_names).issubset(set(available_engines()))

    results = await asyncio.gather(*[
        scheduler.transcribe(name, b"RIFF", EngineOptions(language="zh"))
        for name in engine_names
    ])

    assert [result.engine_name for result in results] == engine_names
    snapshot = scheduler.snapshot()
    assert snapshot["submitted"] == len(engine_names)
    assert snapshot["completed"] == len(engine_names)
    await scheduler.shutdown()


@pytest.mark.asyncio
async def test_scheduler_serializes_busy_model_and_micro_batches_waiting_requests() -> None:
    provider = StaticProvider(block_first_batch=True)
    scheduler = InferenceScheduler(provider, max_batch_items=4, max_wait_ms=100)

    first = asyncio.create_task(scheduler.transcribe("mock", b"first"))
    engine = await provider.get_engine("mock")
    await asyncio.wait_for(engine.first_batch_started.wait(), timeout=1)

    queued = [
        asyncio.create_task(scheduler.transcribe("mock", f"q{index}".encode()))
        for index in range(4)
    ]
    await asyncio.sleep(0.02)
    assert not any(task.done() for task in queued)

    engine.release_first_batch.set()
    results = await asyncio.gather(first, *queued)

    assert [result.engine_name for result in results] == ["mock"] * 5
    assert engine.batch_sizes == [1, 4]
    assert engine.max_active == 1
    snapshot = scheduler.snapshot()
    assert snapshot["submitted"] == 5
    assert snapshot["completed"] == 5
    assert snapshot["max_batch_size"] == 4
    await scheduler.shutdown()


@pytest.mark.asyncio
async def test_scheduler_disabled_bypasses_batch_path() -> None:
    provider = StaticProvider()
    scheduler = InferenceScheduler(provider, enabled=False)

    result = await scheduler.transcribe("mock", b"direct", EngineOptions(language="en"))
    engine = await provider.get_engine("mock")

    assert result.engine_name == "mock"
    assert result.language == "en"
    assert engine.batch_sizes == []


@pytest.mark.asyncio
async def test_scheduler_shutdown_cancels_pending_requests() -> None:
    provider = StaticProvider(block_first_batch=True)
    scheduler = InferenceScheduler(provider, max_batch_items=1, max_wait_ms=100)

    first = asyncio.create_task(scheduler.transcribe("mock", b"first"))
    engine = await provider.get_engine("mock")
    await asyncio.wait_for(engine.first_batch_started.wait(), timeout=1)
    queued = asyncio.create_task(scheduler.transcribe("mock", b"queued"))
    await asyncio.sleep(0)

    await scheduler.shutdown()

    assert queued.cancelled()
    assert first.cancelled()


def test_fireredasr2_native_batch_adapter_calls_upstream_once() -> None:
    class FakeFireRedModel:
        def __init__(self) -> None:
            self.calls: list[tuple[list[str], int]] = []

        def transcribe(self, uttids: list[str], audios: list[tuple[int, Any]]) -> list[dict[str, Any]]:
            self.calls.append((uttids, len(audios)))
            return [
                {"uttid": uttid, "text": f"text-{index}", "dur_s": 1.0}
                for index, uttid in enumerate(uttids)
            ]

    engine = FireRedASR2Engine()
    fake_model = FakeFireRedModel()
    engine._model = fake_model

    audio = np.zeros(1600, dtype=np.int16)
    results = engine._run_batch_inference([
        ((16_000, audio), EngineOptions(language="zh")),
        ((16_000, audio), EngineOptions(language="en")),
        ((16_000, audio), EngineOptions(language="zh")),
    ])

    assert fake_model.calls == [(["utt0", "utt1", "utt2"], 3)]
    assert [result.full_text for result in results] == ["text-0", "text-1", "text-2"]
    assert [result.language for result in results] == ["zh", "en", "zh"]
