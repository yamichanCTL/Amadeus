"""Pseudo-streaming ASR session driven by VAD endpoints."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
import wave
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from io import BytesIO
from typing import Any

from app.config import get_settings
from app.core.archive import archive_pcm_record
from app.core.asr.base import EngineOptions
from app.core.model_manager import get_model_manager
from app.core.streaming.vad import StreamingVad, create_streaming_vad

logger = logging.getLogger(__name__)
settings = get_settings()


class StreamState(str, Enum):
    IDLE = "idle"
    SPEAKING = "speaking"
    PARTIAL_RECOGNIZING = "partial_recognizing"
    FINALIZING = "finalizing"


@dataclass
class StreamConfig:
    engine: str = settings.default_stream_engine
    final_engine: str = settings.default_stream_final_engine
    language: str | None = "zh"
    user_id: str | None = None
    category: str = settings.stream_archive_category
    sample_rate: int = settings.stream_sample_rate
    archive: bool = True


class StreamingASRSession:
    """Session state for one WebSocket stream."""

    def __init__(self, config: StreamConfig | None = None, vad: StreamingVad | None = None) -> None:
        self.config = config or StreamConfig()
        self.session_id = uuid.uuid4().hex
        self._vad = vad or create_streaming_vad()
        self._ring = bytearray()
        self._ring_limit = _ms_to_bytes(settings.stream_ring_keep_ms, self.config.sample_rate)
        self._pre_roll = _ms_to_bytes(settings.stream_pre_roll_ms, self.config.sample_rate)
        self._utterance = bytearray()
        self._session_audio = bytearray()
        self._state = StreamState.IDLE
        self._session_started_at = datetime.now(timezone.utc)
        self._utterance_started_at: datetime | None = None
        self._last_partial_at_ms = 0.0
        self._received_ms = 0.0
        self._job_id = 0
        self._latest_partial_id = 0
        self._finalizing_job = False
        self._partials: deque[str] = deque(maxlen=2)
        self._final_results: list[dict[str, Any]] = []
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._asr_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def queue(self) -> asyncio.Queue[dict[str, Any]]:
        return self._queue

    @property
    def state(self) -> str:
        return self._state.value

    async def send_ready(self) -> None:
        await self._queue.put(
            {
                "type": "ready",
                "session_id": self.session_id,
                "engine": self.config.engine,
                "final_engine": self.config.final_engine,
                "sample_rate": self.config.sample_rate,
                "pre_roll_ms": settings.stream_pre_roll_ms,
                "state": self._state.value,
            }
        )

    def update_config(self, data: dict[str, Any]) -> None:
        if data.get("engine"):
            self.config.engine = str(data["engine"])
        if data.get("final_engine"):
            self.config.final_engine = str(data["final_engine"])
        if "language" in data:
            self.config.language = data["language"] or None
        if data.get("user_id"):
            self.config.user_id = str(data["user_id"])
        if data.get("category"):
            self.config.category = str(data["category"])
        if "archive" in data:
            self.config.archive = bool(data["archive"])
        if data.get("sample_rate"):
            sample_rate = int(data["sample_rate"])
            if sample_rate != self.config.sample_rate and self._state != StreamState.IDLE:
                raise ValueError("sample_rate can only be changed before speech starts")
            self.config.sample_rate = sample_rate
            self._ring_limit = _ms_to_bytes(settings.stream_ring_keep_ms, self.config.sample_rate)
            self._pre_roll = _ms_to_bytes(settings.stream_pre_roll_ms, self.config.sample_rate)

    async def accept_audio(self, pcm_bytes: bytes) -> None:
        if not pcm_bytes:
            return
        if len(pcm_bytes) % 2:
            pcm_bytes = pcm_bytes[:-1]
        self._session_audio.extend(pcm_bytes)
        pre_roll = bytes(self._ring[-self._pre_roll :])
        self._append_ring(pcm_bytes)
        decision = self._vad.accept_pcm(pcm_bytes)
        chunk_ms = _bytes_to_ms(len(pcm_bytes), self.config.sample_rate)
        self._received_ms += chunk_ms

        if self._state == StreamState.IDLE and decision.speech_start:
            self._state = StreamState.SPEAKING
            self._finalizing_job = False
            self._utterance = bytearray(pre_roll)
            self._utterance.extend(pcm_bytes)
            self._utterance_started_at = datetime.now(timezone.utc)
            self._last_partial_at_ms = 0.0
            self._partials.clear()
            await self._queue.put(
                {
                    "type": "speech_start",
                    "session_id": self.session_id,
                    "at_ms": round(self._received_ms, 1),
                    "pre_roll_ms": settings.stream_pre_roll_ms,
                    "state": self._state.value,
                }
            )
            return

        if self._state in {StreamState.SPEAKING, StreamState.PARTIAL_RECOGNIZING}:
            self._utterance.extend(pcm_bytes)
            await self._maybe_partial()
            duration_ms = _bytes_to_ms(len(self._utterance), self.config.sample_rate)
            if decision.speech_end or duration_ms >= settings.stream_max_segment_ms:
                await self._schedule_final(reason="vad_end" if decision.speech_end else "max_segment")

    async def finish(self) -> None:
        if self._state in {StreamState.SPEAKING, StreamState.PARTIAL_RECOGNIZING} and self._utterance:
            await self._schedule_final(reason="client_end")
        if self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
        session_archive = self._archive_received_session()
        if session_archive:
            await self._queue.put(
                {
                    "type": "archive",
                    "session_id": self.session_id,
                    "archive": session_archive,
                }
            )
        await self._queue.put({"type": "done", "session_id": self.session_id, "state": self._state.value})

    async def _maybe_partial(self) -> None:
        if not settings.stream_partial_enabled or self._finalizing_job:
            return
        duration_ms = _bytes_to_ms(len(self._utterance), self.config.sample_rate)
        if duration_ms < settings.stream_first_partial_after_ms:
            return
        if duration_ms - self._last_partial_at_ms < settings.stream_partial_interval_ms:
            return
        if self._asr_lock.locked():
            return
        self._last_partial_at_ms = duration_ms
        self._job_id += 1
        self._latest_partial_id = self._job_id
        audio = bytes(self._utterance)
        self._state = StreamState.PARTIAL_RECOGNIZING
        task = asyncio.create_task(self._run_partial(self._job_id, audio, duration_ms))
        self._track(task)

    async def _schedule_final(self, reason: str) -> None:
        if self._finalizing_job:
            return
        duration_ms = _bytes_to_ms(len(self._utterance), self.config.sample_rate)
        if duration_ms < settings.stream_min_segment_ms:
            self._reset_utterance()
            return
        self._state = StreamState.FINALIZING
        self._finalizing_job = True
        self._job_id += 1
        self._latest_partial_id = self._job_id
        audio = bytes(self._utterance)
        started_at = self._utterance_started_at or datetime.now(timezone.utc)
        self._reset_utterance()
        task = asyncio.create_task(self._run_final(self._job_id, audio, duration_ms, started_at, reason))
        self._track(task)

    async def _run_partial(self, job_id: int, pcm_bytes: bytes, duration_ms: float) -> None:
        try:
            async with self._asr_lock:
                text, engine, language, confidence = await self._transcribe_pcm(
                    pcm_bytes,
                    self.config.engine,
                )
        except Exception as exc:
            logger.warning("Partial ASR failed: %s", exc)
            return
        if job_id < self._latest_partial_id or self._finalizing_job:
            return
        stable, unstable = self._stabilize(text)
        if self._state == StreamState.PARTIAL_RECOGNIZING:
            self._state = StreamState.SPEAKING
        await self._queue.put(
            {
                "type": "partial",
                "session_id": self.session_id,
                "job_id": job_id,
                "text": text,
                "stable_text": stable,
                "unstable_text": unstable,
                "duration_sec": round(duration_ms / 1000.0, 3),
                "engine": engine,
                "partial_engine": self.config.engine,
                "final_engine": self.config.final_engine,
                "language": language,
                "confidence": confidence,
                "state": self._state.value,
            }
        )

    async def _run_final(
        self,
        job_id: int,
        pcm_bytes: bytes,
        duration_ms: float,
        started_at: datetime,
        reason: str,
    ) -> None:
        ended_at = datetime.now(timezone.utc)
        try:
            async with self._asr_lock:
                text, engine, language, confidence = await self._transcribe_pcm(
                    pcm_bytes,
                    self.config.final_engine,
                )
            archive_paths: dict[str, str] = {}
            if self.config.archive:
                archive_paths = archive_pcm_record(
                    pcm_bytes=pcm_bytes,
                    sample_rate=self.config.sample_rate,
                    user_id=self.config.user_id,
                    category=self.config.category,
                    text=text,
                    engine=engine,
                    language=language,
                    started_at=started_at,
                    ended_at=ended_at,
                    duration_sec=duration_ms / 1000.0,
                    metadata={
                        "session_id": self.session_id,
                        "job_id": job_id,
                        "reason": reason,
                        "partial_engine": self.config.engine,
                        "final_engine": self.config.final_engine,
                        "pre_roll_ms": settings.stream_pre_roll_ms,
                    },
                )
            await self._queue.put(
                {
                    "type": "final",
                    "session_id": self.session_id,
                    "job_id": job_id,
                    "text": text,
                    "duration_sec": round(duration_ms / 1000.0, 3),
                    "engine": engine,
                    "partial_engine": self.config.engine,
                    "final_engine": self.config.final_engine,
                    "replace_previous": True,
                    "language": language,
                    "confidence": confidence,
                    "real_time_start": started_at.astimezone().isoformat(),
                    "real_time_end": ended_at.astimezone().isoformat(),
                    "archive": archive_paths,
                    "state": StreamState.FINALIZING.value,
                }
            )
            self._final_results.append(
                {
                    "job_id": job_id,
                    "text": text,
                    "engine": engine,
                    "language": language,
                    "confidence": confidence,
                    "duration_sec": round(duration_ms / 1000.0, 3),
                    "real_time_start": started_at.astimezone().isoformat(),
                    "real_time_end": ended_at.astimezone().isoformat(),
                    "archive": archive_paths,
                }
            )
        except Exception as exc:
            logger.exception("Final ASR failed: %s", exc)
            await self._queue.put(
                {
                    "type": "error",
                    "session_id": self.session_id,
                    "message": str(exc),
                    "state": StreamState.FINALIZING.value,
                }
            )
        finally:
            self._finalizing_job = False

    async def _transcribe_pcm(
        self,
        pcm_bytes: bytes,
        engine_name: str,
    ) -> tuple[str, str, str | None, float | None]:
        wav_bytes = _pcm_to_wav(pcm_bytes, self.config.sample_rate)
        manager = get_model_manager()
        engine = await manager.get_engine(engine_name)
        result = await engine.transcribe(wav_bytes, EngineOptions(language=self.config.language))
        return result.full_text, result.engine_name, result.language, result.confidence

    def _append_ring(self, pcm_bytes: bytes) -> None:
        self._ring.extend(pcm_bytes)
        if len(self._ring) > self._ring_limit:
            del self._ring[: len(self._ring) - self._ring_limit]

    def _reset_utterance(self) -> None:
        self._state = StreamState.IDLE
        self._finalizing_job = False
        self._utterance = bytearray()
        self._utterance_started_at = None
        self._last_partial_at_ms = 0.0
        self._partials.clear()
        self._vad.reset()

    def _stabilize(self, text: str) -> tuple[str, str]:
        self._partials.append(text)
        if len(self._partials) < 2:
            return "", text
        stable = _longest_common_prefix(self._partials[0], self._partials[1])
        return stable, text[len(stable) :]

    def _track(self, task: asyncio.Task[None]) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _archive_received_session(self) -> dict[str, str]:
        if not self.config.archive or not self._session_audio:
            return {}
        ended_at = datetime.now(timezone.utc)
        duration_ms = _bytes_to_ms(len(self._session_audio), self.config.sample_rate)
        text = "\n".join(item.get("text", "") for item in self._final_results if item.get("text"))
        try:
            return archive_pcm_record(
                pcm_bytes=bytes(self._session_audio),
                sample_rate=self.config.sample_rate,
                user_id=self.config.user_id,
                category=self.config.category,
                text=text,
                engine="stream_received",
                language=self.config.language,
                started_at=self._session_started_at,
                ended_at=ended_at,
                duration_sec=duration_ms / 1000.0,
                metadata={
                    "session_id": self.session_id,
                    "partial_engine": self.config.engine,
                    "final_engine": self.config.final_engine,
                    "results": self._final_results,
                    "status": "received",
                },
            )
        except Exception as exc:
            logger.warning("Could not archive received stream audio: %s", exc)
            return {}


def _pcm_to_wav(pcm_bytes: bytes, sample_rate: int) -> bytes:
    buf = BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


def _ms_to_bytes(ms: int, sample_rate: int) -> int:
    return int(sample_rate * ms / 1000) * 2


def _bytes_to_ms(byte_count: int, sample_rate: int) -> float:
    return byte_count / 2 / sample_rate * 1000.0


def _longest_common_prefix(a: str, b: str) -> str:
    limit = min(len(a), len(b))
    idx = 0
    while idx < limit and a[idx] == b[idx]:
        idx += 1
    return a[:idx]


def parse_stream_config(raw: str) -> dict[str, Any]:
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("stream config must be a JSON object")
    return data
