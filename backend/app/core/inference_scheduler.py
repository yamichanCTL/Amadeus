"""ASR inference admission control and micro-batch scheduling."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Protocol

from app.config import get_settings
from app.core.asr.base import ASRResult, BaseASREngine, EngineOptions


class EngineProvider(Protocol):
    async def get_engine(self, name: str) -> BaseASREngine:
        ...


@dataclass
class SchedulerMetrics:
    submitted: int = 0
    completed: int = 0
    failed: int = 0
    batches: int = 0
    max_batch_size: int = 0
    total_queue_wait_ms: float = 0.0
    max_queue_wait_ms: float = 0.0
    last_batch_engine: str | None = None
    last_batch_size: int = 0
    last_queue_wait_ms: float = 0.0

    def snapshot(self) -> dict[str, float | int | str | None]:
        average_wait = self.total_queue_wait_ms / self.completed if self.completed else 0.0
        return {
            "submitted": self.submitted,
            "completed": self.completed,
            "failed": self.failed,
            "batches": self.batches,
            "max_batch_size": self.max_batch_size,
            "average_queue_wait_ms": round(average_wait, 3),
            "max_queue_wait_ms": round(self.max_queue_wait_ms, 3),
            "last_batch_engine": self.last_batch_engine,
            "last_batch_size": self.last_batch_size,
            "last_queue_wait_ms": round(self.last_queue_wait_ms, 3),
        }


@dataclass
class _InferenceRequest:
    audio_bytes: bytes
    options: EngineOptions | None
    future: asyncio.Future[ASRResult]
    submitted_at: float = field(default_factory=time.perf_counter)


class _EngineExecutor:
    def __init__(
        self,
        *,
        engine_name: str,
        provider: EngineProvider,
        max_batch_items: int,
        max_wait_ms: int,
        metrics: SchedulerMetrics,
    ) -> None:
        self.engine_name = engine_name
        self.provider = provider
        self.max_batch_items = max(1, max_batch_items)
        self.max_wait_sec = max(0, max_wait_ms) / 1000.0
        self.metrics = metrics
        self.queue: asyncio.Queue[_InferenceRequest] = asyncio.Queue()
        self._runner: asyncio.Task[None] | None = None
        self._ran_batch = False
        self._closed = False

    async def submit(self, request: _InferenceRequest) -> ASRResult:
        if self._closed:
            raise RuntimeError(f"ASR inference executor for '{self.engine_name}' is shut down.")
        await self.queue.put(request)
        self._ensure_runner()
        return await request.future

    def _ensure_runner(self) -> None:
        if self._runner is not None and not self._runner.done():
            return
        self._runner = asyncio.create_task(self._run(), name=f"asr-inference-{self.engine_name}")
        self._runner.add_done_callback(lambda _task: self._ensure_runner() if not self.queue.empty() else None)

    async def _run(self) -> None:
        while not self.queue.empty():
            first = await self.queue.get()
            batch = [first]
            self._drain_ready(batch)
            if self._ran_batch and len(batch) < self.max_batch_items and self.max_wait_sec > 0:
                await self._wait_for_micro_batch(batch)
            await self._execute_batch(batch)
            self._ran_batch = True

    def _drain_ready(self, batch: list[_InferenceRequest]) -> None:
        while len(batch) < self.max_batch_items:
            try:
                batch.append(self.queue.get_nowait())
            except asyncio.QueueEmpty:
                return

    async def _wait_for_micro_batch(self, batch: list[_InferenceRequest]) -> None:
        deadline = time.perf_counter() + self.max_wait_sec
        while len(batch) < self.max_batch_items:
            timeout = deadline - time.perf_counter()
            if timeout <= 0:
                return
            try:
                batch.append(await asyncio.wait_for(self.queue.get(), timeout=timeout))
            except TimeoutError:
                return

    async def _execute_batch(self, batch: list[_InferenceRequest]) -> None:
        now = time.perf_counter()
        waits_ms = [(now - request.submitted_at) * 1000.0 for request in batch]
        self.metrics.batches += 1
        self.metrics.max_batch_size = max(self.metrics.max_batch_size, len(batch))
        self.metrics.last_batch_engine = self.engine_name
        self.metrics.last_batch_size = len(batch)
        self.metrics.last_queue_wait_ms = max(waits_ms) if waits_ms else 0.0
        self.metrics.max_queue_wait_ms = max(self.metrics.max_queue_wait_ms, self.metrics.last_queue_wait_ms)

        try:
            engine = await self.provider.get_engine(self.engine_name)
            results = await engine.transcribe_batch([(item.audio_bytes, item.options) for item in batch])
            if len(results) != len(batch):
                raise RuntimeError(
                    f"Engine '{self.engine_name}' returned {len(results)} batch results for {len(batch)} requests."
                )
        except asyncio.CancelledError:
            for request in batch:
                if not request.future.done():
                    request.future.cancel()
            raise
        except Exception as exc:
            self.metrics.failed += len(batch)
            for request in batch:
                if not request.future.done():
                    request.future.set_exception(exc)
            return

        for request, result, wait_ms in zip(batch, results, waits_ms, strict=True):
            self.metrics.completed += 1
            self.metrics.total_queue_wait_ms += wait_ms
            if not request.future.done():
                request.future.set_result(result)

    async def shutdown(self) -> None:
        self._closed = True
        if self._runner is None or self._runner.done():
            self._cancel_pending()
            return
        self._runner.cancel()
        try:
            await self._runner
        except asyncio.CancelledError:
            pass
        self._cancel_pending()

    def _cancel_pending(self) -> None:
        while True:
            try:
                request = self.queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            if not request.future.done():
                request.future.cancel()


class InferenceScheduler:
    def __init__(
        self,
        provider: EngineProvider,
        *,
        enabled: bool = True,
        max_batch_items: int = 4,
        max_wait_ms: int = 100,
    ) -> None:
        self.provider = provider
        self.enabled = enabled
        self.max_batch_items = max(1, max_batch_items)
        self.max_wait_ms = max(0, max_wait_ms)
        self.metrics = SchedulerMetrics()
        self._executors: dict[str, _EngineExecutor] = {}

    async def transcribe(
        self,
        engine_name: str,
        audio_bytes: bytes,
        options: EngineOptions | None = None,
    ) -> ASRResult:
        if not self.enabled:
            engine = await self.provider.get_engine(engine_name)
            return await engine.transcribe(audio_bytes, options)

        loop = asyncio.get_running_loop()
        future: asyncio.Future[ASRResult] = loop.create_future()
        request = _InferenceRequest(audio_bytes=audio_bytes, options=options, future=future)
        self.metrics.submitted += 1
        executor = self._executor(engine_name)
        return await executor.submit(request)

    def snapshot(self) -> dict[str, float | int | str | None]:
        return self.metrics.snapshot()

    async def shutdown(self) -> None:
        await asyncio.gather(*(executor.shutdown() for executor in self._executors.values()))
        self._executors.clear()

    def _executor(self, engine_name: str) -> _EngineExecutor:
        name = engine_name.lower()
        executor = self._executors.get(name)
        if executor is None:
            executor = _EngineExecutor(
                engine_name=name,
                provider=self.provider,
                max_batch_items=self.max_batch_items,
                max_wait_ms=self.max_wait_ms,
                metrics=self.metrics,
            )
            self._executors[name] = executor
        return executor


_scheduler: InferenceScheduler | None = None


def get_inference_scheduler() -> InferenceScheduler:
    global _scheduler
    if _scheduler is None:
        from app.core.model_manager import get_model_manager

        settings = get_settings()
        _scheduler = InferenceScheduler(
            get_model_manager(),
            enabled=settings.asr_inference_scheduler_enabled,
            max_batch_items=settings.asr_inference_max_batch_items,
            max_wait_ms=settings.asr_inference_max_wait_ms,
        )
    return _scheduler


async def transcribe_with_scheduler(
    engine_name: str,
    audio_bytes: bytes,
    options: EngineOptions | None = None,
) -> ASRResult:
    return await get_inference_scheduler().transcribe(engine_name, audio_bytes, options)


async def shutdown_inference_scheduler() -> None:
    global _scheduler
    if _scheduler is None:
        return
    await _scheduler.shutdown()
    _scheduler = None
