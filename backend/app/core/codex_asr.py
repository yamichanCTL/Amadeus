"""Ordered, cancellable forwarding of final ASR segments to Codex."""

from __future__ import annotations

import asyncio
from contextlib import suppress

from app.core.codex_connection import CodexError
from app.core.codex_runtime import CodexRuntime
from app.schemas.codex import StreamCodexOptions


class CodexASRBridge:
    def __init__(self, runtime: CodexRuntime, output: asyncio.Queue, session_id: str):
        self.runtime = runtime
        self.output = output
        self.options = StreamCodexOptions(session_id=session_id)
        self.pending: asyncio.Queue = asyncio.Queue(maxsize=8)
        self.seen: set[str | int] = set()
        self._worker: asyncio.Task | None = None
        self._active: asyncio.Task | None = None
        self._drain: asyncio.Task | None = None
        self._closing = False

    async def configure(self, value: dict) -> None:
        updated = StreamCodexOptions.model_validate(
            {"session_id": self.options.session_id, **value}
        )
        if updated != self.options:
            await self.cancel()
        self.options = updated

    async def submit(self, event: dict) -> None:
        if self._closing or not self.options.enabled or event.get("type") != "final":
            return
        text = str(event.get("text", "")).strip()
        identifier = event.get("job_id")
        if not text or not identifier or identifier in self.seen:
            return
        if len(text) > 12000:
            await self.output.put(
                {
                    "type": "agent.error",
                    "code": "transcript_too_long",
                    "source_job_id": identifier,
                    "message": "语音文本过长，请分段发送。",
                }
            )
            return
        if len(self.seen) >= 512:
            # The stream's native job ids increase; retaining recent ids is enough.
            self.seen = {identifier}
        else:
            self.seen.add(identifier)
        try:
            self.pending.put_nowait((text, identifier, self.options.model_copy()))
        except asyncio.QueueFull:
            await self.output.put(
                {
                    "type": "agent.error",
                    "code": "codex_capacity",
                    "source_job_id": identifier,
                    "message": "待处理语音已满，请等待回答。",
                }
            )
            return
        await self.output.put(
            {
                "type": "agent.queued",
                "source_job_id": identifier,
                "session_id": self.options.session_id,
            }
        )
        if self._worker is None:
            self._worker = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            text, identifier, options = await self.pending.get()
            try:

                async def emit(event, source_job_id=identifier):
                    await self.output.put({**event, "source_job_id": source_job_id})

                self._active = asyncio.create_task(
                    self.runtime.turn(text, options, source="asr_stream", emit=emit)
                )
                try:
                    await self._active
                except asyncio.CancelledError:
                    if self._closing:
                        raise
                except CodexError as error:
                    await emit({"type": "agent.error", "code": error.code, "message": str(error)})
                except Exception:
                    await emit(
                        {
                            "type": "agent.error",
                            "code": "agent_failed",
                            "message": "Agent 请求或用量记录失败，请检查后端。",
                        }
                    )
            finally:
                self._active = None
                self.pending.task_done()

    def finish(self, done_event: dict) -> None:
        async def drain():
            await self.pending.join()
            await self.output.put({"type": "agent.drained", "asr_done": done_event})

        self._drain = asyncio.create_task(drain())

    async def cancel(self) -> None:
        while not self.pending.empty():
            self.pending.get_nowait()
            self.pending.task_done()
        if self._active:
            self._active.cancel()
            await asyncio.gather(self._active, return_exceptions=True)

    async def close(self) -> None:
        self._closing = True
        await self.cancel()
        for task in (self._worker, self._drain):
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
