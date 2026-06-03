from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from app.core.asr.base import ASRResult, BaseASREngine, EngineOptions, Segment


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
        return Decision(
            is_speech=self.calls < 3,
            speech_start=self.calls == 1,
            speech_end=self.calls == 3,
        )


class NamedEngine(BaseASREngine):
    def __init__(self, name: str, text: str) -> None:
        self._name = name
        self._text = text
        self._loaded = True

    @property
    def name(self) -> str:
        return self._name

    async def load(self) -> None:
        self._loaded = True

    async def unload(self) -> None:
        self._loaded = False

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    async def transcribe(
        self,
        audio_bytes: bytes,
        options: EngineOptions | None = None,
    ) -> ASRResult:
        return ASRResult(
            full_text=self._text,
            segments=[Segment(start=0.0, end=1.0, text=self._text)],
            language=options.language if options else "zh",
            engine_name=self._name,
        )


class FakeManager:
    def __init__(self) -> None:
        self.engines = {
            "sensevoice": NamedEngine("sensevoice", "partial text"),
            "fireredasr2": NamedEngine("fireredasr2", "final text"),
        }

    async def get_engine(self, name: str) -> BaseASREngine:
        return self.engines[name]


class EmptyFinalManager:
    def __init__(self) -> None:
        self.engines = {
            "sensevoice": NamedEngine("sensevoice", ""),
            "fireredasr2": NamedEngine("fireredasr2", "   "),
        }

    async def get_engine(self, name: str) -> BaseASREngine:
        return self.engines[name]


@pytest.mark.asyncio
async def test_streaming_session_uses_final_engine_for_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.core.streaming.session as session_module
    from app.core.streaming.session import StreamConfig, StreamingASRSession

    monkeypatch.setattr(session_module, "get_model_manager", lambda: FakeManager())
    session = StreamingASRSession(
        config=StreamConfig(
            engine="sensevoice",
            final_engine="fireredasr2",
            archive=False,
        ),
        vad=SequenceVad(),
    )

    pcm_400ms = b"\x01\x00" * 6400
    await session.accept_audio(pcm_400ms)
    await session.accept_audio(pcm_400ms)
    await session.accept_audio(pcm_400ms)
    await session.finish()

    events: list[dict[str, Any]] = []
    while not session.queue.empty():
        events.append(await session.queue.get())

    final = next(event for event in events if event["type"] == "final")
    assert final["text"] == "final text"
    assert final["engine"] == "fireredasr2"
    assert final["partial_engine"] == "sensevoice"
    assert final["final_engine"] == "fireredasr2"
    assert final["replace_previous"] is True


@pytest.mark.asyncio
async def test_streaming_session_suppresses_empty_final_text(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.core.streaming.session as session_module
    from app.core.streaming.session import StreamConfig, StreamingASRSession

    monkeypatch.setattr(session_module, "get_model_manager", lambda: EmptyFinalManager())
    session = StreamingASRSession(
        config=StreamConfig(
            engine="sensevoice",
            final_engine="fireredasr2",
            archive=False,
        ),
        vad=SequenceVad(),
    )

    pcm_400ms = b"\x01\x00" * 6400
    await session.accept_audio(pcm_400ms)
    await session.accept_audio(pcm_400ms)
    await session.accept_audio(pcm_400ms)
    await session.finish()

    events: list[dict[str, Any]] = []
    while not session.queue.empty():
        events.append(await session.queue.get())

    assert not any(event["type"] == "partial" for event in events)
    assert not any(event["type"] == "final" for event in events)
    no_speech = next(event for event in events if event["type"] == "no_speech")
    assert no_speech["engine"] == "fireredasr2"
