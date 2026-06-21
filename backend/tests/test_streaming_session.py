from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import pytest

from app.core.asr.base import ASRResult, BaseASREngine, BaseStreamingASRSession, EngineOptions
from app.core.model_errors import ModelRuntimeError


@dataclass
class Decision:
    is_speech: bool
    speech_start: bool = False
    speech_end: bool = False


class SequenceVad:
    def __init__(self) -> None:
        self.calls = 0

    def reset(self) -> None:
        self.calls = 0

    def accept_pcm(self, pcm_bytes: bytes) -> Decision:
        self.calls += 1
        return Decision(self.calls < 3, self.calls == 1, self.calls == 3)


class FakeTrueStream(BaseStreamingASRSession):
    def __init__(self, final_text: str = "stream final") -> None:
        self.chunks: list[bytes] = []
        self.final_text = final_text

    async def accept_pcm(self, pcm_bytes: bytes) -> ASRResult:
        self.chunks.append(pcm_bytes)
        return ASRResult(full_text=f"stream partial {len(self.chunks)}", language="zh", engine_name="x-asr")

    async def finish(self) -> ASRResult:
        return ASRResult(full_text=self.final_text, language="zh", engine_name="x-asr")


class TrueStreamingEngine(BaseASREngine):
    def __init__(self, final_text: str = "stream final") -> None:
        self.stream = FakeTrueStream(final_text)
        self.transcribe_calls = 0

    @property
    def name(self) -> str:
        return "x-asr"

    async def load(self) -> None: pass
    async def unload(self) -> None: pass
    @property
    def is_loaded(self) -> bool: return True
    @property
    def supports_streaming(self) -> bool: return True

    async def create_streaming_session(self, sample_rate=16_000, options=None):
        assert sample_rate == 16_000
        return self.stream

    async def transcribe(self, audio_bytes: bytes, options: EngineOptions | None = None) -> ASRResult:
        self.transcribe_calls += 1
        raise AssertionError("native streaming must never call offline transcribe")


class TrueStreamingManager:
    def __init__(self, final_text: str = "stream final") -> None:
        self.engine = TrueStreamingEngine(final_text)

    async def get_engine(self, name: str) -> BaseASREngine:
        assert name == "x-asr"
        return self.engine


@pytest.mark.asyncio
async def test_streaming_session_reuses_online_decoder_and_adds_tail(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.core.streaming.session as session_module
    from app.core.streaming.session import StreamConfig, StreamingASRSession

    manager = TrueStreamingManager()
    monkeypatch.setattr(session_module, "get_model_manager", lambda: manager)
    session = StreamingASRSession(StreamConfig(engine="x-asr", archive=False), SequenceVad())
    pcm_400ms = b"\x01\x00" * 6400
    for _ in range(3):
        await session.accept_audio(pcm_400ms)
    await session.finish()

    events: list[dict[str, Any]] = []
    while not session.queue.empty():
        events.append(await session.queue.get())
    partials = [event for event in events if event["type"] == "partial"]
    final = next(event for event in events if event["type"] == "final")
    assert partials and all(event["true_streaming"] for event in partials)
    assert all(event["job_id"] == final["job_id"] for event in partials)
    assert final["asr_elapsed_sec"] > 0
    assert final["text"] == "stream final"
    assert manager.engine.transcribe_calls == 0
    assert len(manager.engine.stream.chunks[-1]) == 16_000 * 2  # 1 s tail silence
    assert set(manager.engine.stream.chunks[-1]) == {0}


@pytest.mark.asyncio
async def test_streaming_session_suppresses_empty_final(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.core.streaming.session as session_module
    from app.core.streaming.session import StreamConfig, StreamingASRSession

    monkeypatch.setattr(session_module, "get_model_manager", lambda: TrueStreamingManager(""))
    session = StreamingASRSession(StreamConfig(engine="x-asr", archive=False), SequenceVad())
    pcm_400ms = b"\x01\x00" * 6400
    for _ in range(3):
        await session.accept_audio(pcm_400ms)
    await session.finish()
    events = []
    while not session.queue.empty():
        events.append(await session.queue.get())
    assert not any(event["type"] == "final" for event in events)
    assert any(event["type"] == "no_speech" for event in events)


@pytest.mark.asyncio
async def test_failed_session_aborts_without_finishing_poisoned_decoder(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.core.streaming.session as session_module
    from app.core.streaming.session import StreamConfig, StreamingASRSession

    class FailingStream(FakeTrueStream):
        def __init__(self) -> None:
            super().__init__()
            self.finish_calls = 0

        async def accept_pcm(self, pcm_bytes: bytes) -> ASRResult:
            raise ModelRuntimeError(
                code="gpu_out_of_memory",
                user_message="显存不足：无法运行 x-asr 模型。",
                model="x-asr",
                detail="CUDA out of memory",
            )

        async def finish(self) -> ASRResult:
            self.finish_calls += 1
            raise AssertionError("abort must not finish a failed decoder")

    manager = TrueStreamingManager()
    failing_stream = FailingStream()
    manager.engine.stream = failing_stream
    monkeypatch.setattr(session_module, "get_model_manager", lambda: manager)
    session = StreamingASRSession(StreamConfig(engine="x-asr", archive=False), SequenceVad())

    with pytest.raises(ModelRuntimeError) as error:
        await session.accept_audio(b"\x01\x00" * 6400)
    await session.record_model_failure(error.value)
    await session.abort()

    events: list[dict[str, Any]] = []
    while not session.queue.empty():
        events.append(await session.queue.get())
    assert failing_stream.finish_calls == 0
    assert any(event.get("code") == "gpu_out_of_memory" and event.get("fatal") for event in events)
    assert events[-1]["type"] == "done"
    assert events[-1]["status"] == "error"


@pytest.mark.asyncio
async def test_websocket_sender_closes_immediately_after_fatal_model_error() -> None:
    from app.api.v1.stream import _send_loop
    from app.core.streaming.session import StreamConfig, StreamingASRSession

    class FakeWebSocket:
        def __init__(self) -> None:
            self.sent: list[dict[str, Any]] = []
            self.close_codes: list[int] = []

        async def send_text(self, message: str) -> None:
            self.sent.append(json.loads(message))

        async def close(self, code: int = 1000) -> None:
            self.close_codes.append(code)

    session = StreamingASRSession(StreamConfig(engine="x-asr", archive=False), SequenceVad())
    websocket = FakeWebSocket()
    await session.queue.put(
        {
            "type": "error",
            "code": "model_not_loaded",
            "message": "模型没有加载",
            "fatal": True,
        }
    )

    await _send_loop(websocket, session)  # type: ignore[arg-type]

    assert websocket.sent[0]["code"] == "model_not_loaded"
    assert websocket.close_codes == [1011]
