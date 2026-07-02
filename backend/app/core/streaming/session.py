"""Native streaming ASR session following the X-ASR live demo flow."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from app.config import get_settings
from app.core.archive import archive_pcm_record
from app.core.asr.base import BaseStreamingASRSession, EngineOptions
from app.core.model_errors import ModelRuntimeError, classify_model_error
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
    language: str | None = "zh"
    user_id: str | None = None
    category: str = settings.stream_archive_category
    sample_rate: int = settings.stream_sample_rate
    # Debug audio/JSON retention is opt-in for every WebSocket client.
    archive: bool = False


class StreamingASRSession:
    """Session state for one WebSocket stream."""

    def __init__(self, config: StreamConfig | None = None, vad: StreamingVad | None = None) -> None:
        self.config = config or StreamConfig()
        self.session_id = uuid.uuid4().hex
        # Defer VAD creation to first accept_audio() so the WebSocket handshake
        # and "ready" message are not blocked by model loading (FireRedVAD can
        # take 10-30 s on first load).  This matches X-ASR's pattern of loading
        # the ASR engine on the "start" / "config" message rather than on connect.
        self._vad: StreamingVad | None = vad
        self._ring = bytearray()
        self._ring_limit = _ms_to_bytes(settings.stream_ring_keep_ms, self.config.sample_rate)
        self._pre_roll = _ms_to_bytes(settings.stream_pre_roll_ms, self.config.sample_rate)
        self._utterance = bytearray()
        self._session_audio = bytearray()
        self._state = StreamState.IDLE
        self._session_started_at = datetime.now(timezone.utc)
        self._utterance_started_at: datetime | None = None
        self._utterance_started_perf: float | None = None
        self._received_ms = 0.0
        self._job_id = 0
        self._finalizing_job = False
        self._partials: deque[str] = deque(maxlen=2)
        self._final_results: list[dict[str, Any]] = []
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._tasks: set[asyncio.Task[None]] = set()
        self._true_stream: BaseStreamingASRSession | None = None
        self._fatal_error: ModelRuntimeError | None = None
        self._terminal_event_sent = False

    @property
    def queue(self) -> asyncio.Queue[dict[str, Any]]:
        return self._queue

    @property
    def state(self) -> str:
        return self._state.value

    @property
    def fatal_error(self) -> ModelRuntimeError | None:
        return self._fatal_error

    async def record_model_failure(self, exc: BaseException) -> ModelRuntimeError:
        """Queue one fatal model error for the WebSocket sender."""

        failure = classify_model_error(exc, self.config.engine)
        if self._fatal_error is None:
            self._fatal_error = failure
            await self._queue.put(failure.as_event(session_id=self.session_id))
        return self._fatal_error

    async def _ensure_vad(self) -> None:
        """Lazy-load the VAD model on first audio (matches X-ASR deferred-load pattern)."""
        if self._vad is not None:
            return
        # Guard against concurrent load attempts from multiple accept_audio() calls.
        if getattr(self, "_vad_loading", False):
            # Another task is already loading; wait a beat and re-check.
            while getattr(self, "_vad_loading", False):
                await asyncio.sleep(0.1)
            if self._vad is not None:
                return
        self._vad_loading = True
        try:
            loop = asyncio.get_running_loop()
            self._vad = await loop.run_in_executor(None, create_streaming_vad)
            logger.info("VAD model loaded for session %s", self.session_id)
        finally:
            self._vad_loading = False

    async def send_ready(self) -> None:
        await self._queue.put(
            {
                "type": "ready",
                "session_id": self.session_id,
                "engine": self.config.engine,
                "sample_rate": self.config.sample_rate,
                "pre_roll_ms": settings.stream_pre_roll_ms,
                "state": self._state.value,
            }
        )

    async def prepare(self) -> None:
        """Warm VAD and the configured native streaming engine before capture."""

        manager = get_model_manager()
        vad_task = asyncio.create_task(self._ensure_vad())
        engine_task = asyncio.create_task(manager.get_engine(self.config.engine))
        _, engine = await asyncio.gather(vad_task, engine_task)
        if not engine.supports_streaming:
            raise ValueError(f"Engine '{self.config.engine}' does not support native streaming")

    def update_config(self, data: dict[str, Any]) -> None:
        if data.get("engine"):
            self.config.engine = str(data["engine"])
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
        await self._ensure_vad()
        if len(pcm_bytes) % 2:
            pcm_bytes = pcm_bytes[:-1]
        self._session_audio.extend(pcm_bytes)
        pre_roll = bytes(self._ring[-self._pre_roll :])
        self._append_ring(pcm_bytes)
        assert self._vad is not None
        if getattr(self._vad, "run_in_worker", False):
            decision = await asyncio.to_thread(self._vad.accept_pcm, pcm_bytes)
        else:
            decision = self._vad.accept_pcm(pcm_bytes)
        chunk_ms = _bytes_to_ms(len(pcm_bytes), self.config.sample_rate)
        self._received_ms += chunk_ms

        if self._state == StreamState.IDLE and decision.speech_start:
            self._state = StreamState.SPEAKING
            self._finalizing_job = False
            self._job_id += 1
            self._utterance = bytearray(pre_roll)
            self._utterance.extend(pcm_bytes)
            self._utterance_started_at = datetime.now(timezone.utc)
            self._utterance_started_perf = time.perf_counter()
            self._partials.clear()
            await self._queue.put(
                {
                    "type": "speech_start",
                    "session_id": self.session_id,
                    "job_id": self._job_id,
                    "at_ms": round(self._received_ms, 1),
                    "pre_roll_ms": settings.stream_pre_roll_ms,
                    "state": self._state.value,
                }
            )
            await self._start_true_stream(bytes(self._utterance))
            return

        if self._state in {StreamState.SPEAKING, StreamState.PARTIAL_RECOGNIZING}:
            self._utterance.extend(pcm_bytes)
            await self._accept_true_stream(pcm_bytes)
            duration_ms = _bytes_to_ms(len(self._utterance), self.config.sample_rate)
            if decision.speech_end or duration_ms >= settings.stream_max_segment_ms:
                await self._schedule_final(reason="vad_end" if decision.speech_end else "max_segment")

    async def finish(self) -> None:
        if self._terminal_event_sent:
            return
        if self._fatal_error is not None:
            await self.abort()
            return
        if self._state in {StreamState.SPEAKING, StreamState.PARTIAL_RECOGNIZING} and self._utterance:
            await self._schedule_final(reason="client_end")
        if self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
        if self._fatal_error is not None:
            await self.abort()
            return
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
        self._terminal_event_sent = True

    async def abort(self) -> None:
        """End a failed session without calling the poisoned native decoder again."""

        if self._terminal_event_sent:
            return
        self._true_stream = None
        current = asyncio.current_task()
        pending = [task for task in self._tasks if task is not current and not task.done()]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self._tasks.clear()
        self._reset_utterance()
        await self._queue.put(
            {
                "type": "done",
                "session_id": self.session_id,
                "state": self._state.value,
                "status": "error",
            }
        )
        self._terminal_event_sent = True

    async def _schedule_final(self, reason: str) -> None:
        if self._finalizing_job:
            return
        duration_ms = _bytes_to_ms(len(self._utterance), self.config.sample_rate)
        if duration_ms < settings.stream_min_segment_ms:
            if self._true_stream is not None:
                await self._true_stream.finish()
                self._true_stream = None
            self._reset_utterance()
            return
        self._state = StreamState.FINALIZING
        self._finalizing_job = True
        audio = bytes(self._utterance)
        started_at = self._utterance_started_at or datetime.now(timezone.utc)
        started_perf = self._utterance_started_perf or time.perf_counter()
        true_stream = self._true_stream
        self._true_stream = None
        self._reset_utterance()
        task = asyncio.create_task(
            self._run_final(
                self._job_id,
                audio,
                duration_ms,
                started_at,
                started_perf,
                reason,
                true_stream,
            )
        )
        self._track(task)

    async def _start_true_stream(self, pcm_bytes: bytes) -> None:
        manager = get_model_manager()
        engine = await manager.get_engine(self.config.engine)
        if not engine.supports_streaming:
            raise ValueError(f"Engine '{self.config.engine}' does not support native streaming")
        self._true_stream = await engine.create_streaming_session(
            self.config.sample_rate,
            EngineOptions(language=self.config.language),
        )
        await self._accept_true_stream(pcm_bytes)

    async def _accept_true_stream(self, pcm_bytes: bytes) -> None:
        if self._true_stream is None:
            return
        result = await self._true_stream.accept_pcm(pcm_bytes)
        if result is None:
            return
        text = _clean_asr_text(result.full_text)
        if not text:
            return
        stable, unstable = self._stabilize(text)
        await self._queue.put(
            {
                "type": "partial",
                "session_id": self.session_id,
                "job_id": self._job_id,
                "text": text,
                "stable_text": stable,
                "unstable_text": unstable,
                "duration_sec": round(
                    _bytes_to_ms(len(self._utterance), self.config.sample_rate) / 1000.0,
                    3,
                ),
                "asr_elapsed_sec": round(
                    time.perf_counter() - (self._utterance_started_perf or time.perf_counter())
                    + settings.stream_start_speech_ms / 1000.0,
                    3,
                ),
                "engine": result.engine_name,
                "language": result.language,
                "confidence": result.confidence,
                "true_streaming": True,
                "state": self._state.value,
            }
        )

    async def _run_final(
        self,
        job_id: int,
        pcm_bytes: bytes,
        duration_ms: float,
        started_at: datetime,
        started_perf: float,
        reason: str,
        true_stream: BaseStreamingASRSession | None = None,
    ) -> None:
        ended_at = datetime.now(timezone.utc)
        try:
            if true_stream is None:
                raise RuntimeError("Native streaming decoder was not created")
            # X-ASR live demo feeds one second of tail silence before
            # input_finished so the transducer can emit delayed final tokens.
            tail_samples = int(self.config.sample_rate * settings.stream_tail_keep_ms / 1000)
            if tail_samples:
                await true_stream.accept_pcm(b"\x00\x00" * tail_samples)
            streaming_result = await true_stream.finish()
            text = streaming_result.full_text
            engine = streaming_result.engine_name
            language = streaming_result.language
            confidence = streaming_result.confidence
            text = _clean_asr_text(text)
            if not text:
                logger.info("Skipping empty final ASR result for stream job %s", job_id)
                await self._queue.put(
                    {
                        "type": "no_speech",
                        "session_id": self.session_id,
                        "job_id": job_id,
                        "duration_sec": round(duration_ms / 1000.0, 3),
                        "engine": engine,
                        "language": language,
                        "state": StreamState.IDLE.value,
                    }
                )
                return
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
                        "true_streaming": True,
                        "pre_roll_ms": settings.stream_pre_roll_ms,
                        "tail_silence_ms": settings.stream_tail_keep_ms,
                    },
                )
            await self._queue.put(
                {
                    "type": "final",
                    "session_id": self.session_id,
                    "job_id": job_id,
                    "text": text,
                    "duration_sec": round(duration_ms / 1000.0, 3),
                    "asr_elapsed_sec": round(
                        time.perf_counter() - started_perf
                        + settings.stream_start_speech_ms / 1000.0,
                        3,
                    ),
                    "engine": engine,
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
        except ModelRuntimeError as exc:
            logger.exception("Final ASR model failed: %s", exc.detail)
            await self.record_model_failure(exc)
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

    def _append_ring(self, pcm_bytes: bytes) -> None:
        self._ring.extend(pcm_bytes)
        if len(self._ring) > self._ring_limit:
            del self._ring[: len(self._ring) - self._ring_limit]

    def _reset_utterance(self) -> None:
        self._state = StreamState.IDLE
        self._finalizing_job = False
        self._utterance = bytearray()
        self._utterance_started_at = None
        self._utterance_started_perf = None
        self._partials.clear()
        if self._vad is not None:
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
                    "engine": self.config.engine,
                    "results": self._final_results,
                    "status": "received",
                },
            )
        except Exception as exc:
            logger.warning("Could not archive received stream audio: %s", exc)
            return {}


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


def _clean_asr_text(text: str | None) -> str:
    return (text or "").strip()


def parse_stream_config(raw: str) -> dict[str, Any]:
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("stream config must be a JSON object")
    return data
