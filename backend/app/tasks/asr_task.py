"""
app/tasks/asr_task.py
──────────────────────
Celery task that runs ASR inference for long audio files.

Flow
────
1. API handler creates an ASRTask row (status=pending), saves the audio file,
   then calls `run_asr_task.delay(task_id)`.
2. This task picks up the job:
   a. Updates status → processing.
   b. Reads the audio file.
   c. Runs the optional pre-pipeline (VAD, denoise).
   d. Dispatches to the selected offline engine.
   e. Runs the optional punctuation post-pipeline.
   f. Saves Transcript row, updates status → success.
3. On any exception: updates status → failed with error_message.
4. API client polls GET /v1/tasks/{id} until status ∈ {success, failed}.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from celery import Task  # type: ignore[import]

from app.core.asr.base import ASRResult, EngineOptions, Segment
from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)


class ASRBaseTask(Task):
    """
    Base class that holds a lazily-initialised asyncio event loop.
    Celery workers are synchronous; we bridge to our async engine layer here.
    """

    _loop: asyncio.AbstractEventLoop | None = None

    def get_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None or self._loop.is_closed():
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
        return self._loop

    def run_async(self, coro: object) -> object:
        return self.get_loop().run_until_complete(coro)  # type: ignore[arg-type]


# ── Main task ─────────────────────────────────────────────────────────────────

@celery_app.task(
    bind=True,
    base=ASRBaseTask,
    name="asr.run",
    max_retries=2,
    default_retry_delay=10,
    ignore_result=True,
    throws=(),          # don't auto-retry on these (we handle all exceptions manually)
)
def run_asr_task(self: ASRBaseTask, task_id: str, llm_options: dict | None = None) -> dict:  # type: ignore[misc]
    """
    Entry point called by the API layer.

    Parameters
    ──────────
    task_id : UUID string of the ASRTask row created before this call.

    Returns
    ───────
    dict with keys: task_id, status, full_text, engine_used
    """
    logger.info("Starting ASR task %s", task_id)
    return self.run_async(_run(task_id, llm_options))  # type: ignore[return-value]


# ── Async implementation ──────────────────────────────────────────────────────

async def _run(task_id: str, llm_options: dict | None = None) -> dict:
    import time
    from app.config import get_settings
    from app.core.archive import archive_file_error_record, archive_file_record
    from app.core.asr.hotwords import get_hotword_manager
    from app.core.llm import log_asr_ai_polish_result, run_auto_processing
    from app.core.inference_scheduler import transcribe_with_scheduler
    from app.core.pipeline.post.punctuation import restore_punctuation
    from app.core.pipeline.pre.vad import detect_speech
    from app.db.crud import (
        create_transcript,
        get_task,
        update_task_status,
    )
    from app.db.models import TaskStatus
    from app.db.session import AsyncSessionLocal
    from app.schemas.llm import LLMAutoOptions, LLMOutputs

    settings = get_settings()
    task_started = time.perf_counter()
    timing: dict[str, float] = {}

    async with AsyncSessionLocal() as db:
        # ── 1. Load task ──────────────────────────────────────────────────
        task = await get_task(db, task_id)
        if task is None:
            logger.error("Task %s not found in DB.", task_id)
            return {"task_id": task_id, "status": "failed", "error": "task not found"}

        # ── 2. Mark processing ────────────────────────────────────────────
        await update_task_status(db, task_id, TaskStatus.PROCESSING)
        await db.commit()

        keep_audio = False

        try:
            # ── 3. Read audio file ────────────────────────────────────────
            if not task.audio_path or not Path(task.audio_path).exists():
                raise FileNotFoundError(f"Audio file missing: {task.audio_path}")

            read_started = time.perf_counter()
            audio_bytes = Path(task.audio_path).read_bytes()
            timing["audio_read_sec"] = round(time.perf_counter() - read_started, 6)

            # ── 4. Parse engine options ───────────────────────────────────
            engine_opts_raw: dict = (
                json.loads(task.engine_options) if task.engine_options else {}
            )
            keep_audio = bool(engine_opts_raw.get("allow_server_data_collection"))
            engine_name = next((e.strip() for e in task.engines.split(",") if e.strip()), settings.default_engine)

            options = EngineOptions(
                language=engine_opts_raw.get("language"),
                task=engine_opts_raw.get("task", "transcribe"),
                extra=engine_opts_raw.get("extra", {}),
            )

            # ── 5. Pre-pipeline (VAD) ─────────────────────────────────────
            if task.vad_enabled:
                audio_array, sr = _decode_audio_for_chunking(audio_bytes)
                speech_segments = await detect_speech(audio_array, sr)
                logger.info(
                    "Task %s: VAD found %d speech segments.", task_id, len(speech_segments)
                )
                timing["vad_segments"] = len(speech_segments)

            # ── 6. ASR inference ──────────────────────────────────────────
            async def load_and_transcribe():
                asr_started = time.perf_counter()
                result, chunk_meta = await _transcribe_audio_via_scheduler(
                    engine_name=engine_name,
                    audio_bytes=audio_bytes,
                    options=options,
                    chunk_sec=float(
                        engine_opts_raw.get(
                            "long_audio_chunk_sec",
                            settings.asr_long_audio_chunk_sec,
                        )
                    ),
                    transcribe=transcribe_with_scheduler,
                )
                timing["asr_sec"] = round(time.perf_counter() - asr_started, 6)
                timing["asr_scheduler"] = "enabled"
                timing.update(chunk_meta)
                return result

            timeout_sec = max(
                0,
                int(engine_opts_raw.get("timeout_sec", settings.transcribe_timeout_sec)),
            )
            if timeout_sec > 0:
                try:
                    result = await asyncio.wait_for(load_and_transcribe(), timeout=timeout_sec)
                except TimeoutError as exc:
                    raise TimeoutError(f"ASR execution exceeded {timeout_sec} seconds") from exc
            else:
                result = await load_and_transcribe()
            logger.info(
                "Task %s: ASR complete — %d chars, engine=%s",
                task_id, len(result.full_text), result.engine_name,
            )

            # ── 7. Post-pipeline ──────────────────────────────────────────
            final_text = result.full_text

            if task.punctuation_enabled:
                punctuation_started = time.perf_counter()
                final_text = await restore_punctuation(final_text, result.language)
                result.full_text = final_text
                timing["punctuation_sec"] = round(time.perf_counter() - punctuation_started, 6)
                if len(result.segments) == 1:
                    result.segments[0].text = final_text

            hotword_started = time.perf_counter()
            hotword_result = get_hotword_manager().apply(
                result.full_text,
                enabled=bool(engine_opts_raw.get("enable_hotwords", True)),
            )
            timing["hotword_sec"] = round(time.perf_counter() - hotword_started, 6)
            result.full_text = hotword_result.text
            if hotword_result.replacements or hotword_result.suggestions:
                result.raw = dict(result.raw or {})
                result.raw["hotwords"] = {
                    "replacements": hotword_result.replacements,
                    "suggestions": hotword_result.suggestions,
                }

            llm_outputs = None
            llm_error = None
            if llm_options:
                llm_started = time.perf_counter()
                llm_opts = LLMAutoOptions.model_validate(llm_options)
                outputs, llm_error = await run_auto_processing(
                    text=result.full_text,
                    model=llm_opts.model,
                    base_url=llm_opts.base_url,
                    api_token=llm_opts.api_token,
                    target_language=llm_opts.target_language,
                    style=llm_opts.style,
                    enable_polish=llm_opts.enable_polish,
                    enable_translate=llm_opts.enable_translate,
                    prompt=llm_opts.prompt,
                )
                llm_outputs = LLMOutputs(
                    polish=outputs.get("polish"),
                    translate=outputs.get("translate"),
                )
                if not llm_outputs.polish and not llm_outputs.translate:
                    llm_outputs = None
                if llm_outputs:
                    log_asr_ai_polish_result(task_id, llm_outputs)
                timing["llm_sec"] = round(time.perf_counter() - llm_started, 6)

            # ── 8. Persist result ─────────────────────────────────────────
            segments_data = [
                {
                    "start": s.start,
                    "end": s.end,
                    "text": s.text,
                    "confidence": s.confidence,
                }
                for s in result.segments
            ]
            raw_results = dict(result.raw or {})
            timing["total_sec"] = round(time.perf_counter() - task_started, 6)
            raw_results["timing"] = timing
            if llm_outputs:
                raw_results["llm_outputs"] = llm_outputs.model_dump(mode="json", exclude_none=True)
            if llm_error:
                raw_results["llm_error"] = llm_error

            transcript = await create_transcript(
                db,
                task_id=task_id,
                full_text=result.full_text,
                segments=segments_data,
                language=result.language,
                engine_used=result.engine_name,
                confidence=result.confidence,
                raw_results=raw_results or None,
            )
            if keep_audio:
                archive_file_record(
                    audio_bytes=audio_bytes,
                    suffix=Path(task.filename or "audio.wav").suffix or ".wav",
                    user_id=task.user_id or engine_opts_raw.get("archive_user_id"),
                    category=(
                        engine_opts_raw.get("archive_category")
                        or settings.upload_archive_category
                    ),
                    text=result.full_text,
                    engine=result.engine_name,
                    language=result.language,
                    duration_sec=task.duration_sec,
                    llm_outputs=(
                        llm_outputs.model_dump(mode="json", exclude_none=True)
                        if llm_outputs
                        else None
                    ),
                    metadata={
                        "task_id": task_id,
                        "transcript_id": transcript.id,
                        "allow_server_data_collection": True,
                    },
                )

            await update_task_status(db, task_id, TaskStatus.SUCCESS)
            await db.commit()

            if not keep_audio:
                _delete_temp_audio(task.audio_path)

            logger.info("Task %s completed successfully.", task_id)
            return {
                "task_id": task_id,
                "status": TaskStatus.SUCCESS,
                "full_text": result.full_text,
                "engine_used": result.engine_name,
            }

        except Exception as exc:
            logger.exception("Task %s failed: %s", task_id, exc)
            if keep_audio and "audio_bytes" in locals():
                archive_file_error_record(
                    audio_bytes=audio_bytes,
                    suffix=Path(task.filename or "audio.wav").suffix or ".wav",
                    user_id=task.user_id or engine_opts_raw.get("archive_user_id"),
                    category=(
                        engine_opts_raw.get("archive_category")
                        or settings.upload_archive_category
                        if "engine_opts_raw" in locals()
                        else settings.upload_archive_category
                    ),
                    engine=task.engines,
                    language=(
                        engine_opts_raw.get("language")
                        if "engine_opts_raw" in locals()
                        else None
                    ),
                    duration_sec=task.duration_sec,
                    error=str(exc),
                    metadata={"task_id": task_id},
                )
            await update_task_status(
                db, task_id, TaskStatus.FAILED, error_message=str(exc)
            )
            await db.commit()
            if not keep_audio:
                _delete_temp_audio(task.audio_path)
            return {
                "task_id": task_id,
                "status": TaskStatus.FAILED,
                "error": str(exc),
            }


def _delete_temp_audio(audio_path: str | None) -> None:
    if not audio_path:
        return
    try:
        path = Path(audio_path)
        if path.exists():
            path.unlink()
    except Exception as exc:
        logger.warning("Could not delete temporary audio %s: %s", audio_path, exc)


@dataclass(frozen=True)
class AudioInferenceChunk:
    start_sec: float
    end_sec: float
    audio_bytes: bytes


async def _transcribe_audio_via_scheduler(
    *,
    engine_name: str,
    audio_bytes: bytes,
    options: EngineOptions | None,
    chunk_sec: float,
    transcribe: Callable[[str, bytes, EngineOptions | None], Awaitable[ASRResult]],
) -> tuple[ASRResult, dict[str, int | float | str]]:
    chunks = _build_audio_inference_chunks(audio_bytes, chunk_sec)
    if len(chunks) == 1:
        result = await transcribe(engine_name, chunks[0].audio_bytes, options)
        return result, {
            "asr_chunk_count": 1,
            "asr_chunk_sec": round(chunk_sec, 3) if chunk_sec > 0 else 0,
        }

    results: list[tuple[AudioInferenceChunk, ASRResult]] = []
    for chunk in chunks:
        result = await transcribe(engine_name, chunk.audio_bytes, options)
        results.append((chunk, result))

    return _merge_chunk_results(results), {
        "asr_chunk_count": len(chunks),
        "asr_chunk_sec": round(chunk_sec, 3),
    }


def _build_audio_inference_chunks(audio_bytes: bytes, chunk_sec: float) -> list[AudioInferenceChunk]:
    if chunk_sec <= 0:
        return [AudioInferenceChunk(start_sec=0.0, end_sec=0.0, audio_bytes=audio_bytes)]

    try:
        audio, sample_rate = _decode_audio_for_chunking(audio_bytes)
    except Exception as exc:
        logger.warning("Could not decode audio for chunked ASR; falling back to single request: %s", exc)
        return [AudioInferenceChunk(start_sec=0.0, end_sec=0.0, audio_bytes=audio_bytes)]

    total_samples = len(audio)
    if total_samples == 0:
        return [AudioInferenceChunk(start_sec=0.0, end_sec=0.0, audio_bytes=audio_bytes)]

    samples_per_chunk = max(1, int(chunk_sec * sample_rate))
    if total_samples <= samples_per_chunk:
        return [
            AudioInferenceChunk(
                start_sec=0.0,
                end_sec=round(total_samples / sample_rate, 6),
                audio_bytes=audio_bytes,
            )
        ]

    chunks: list[AudioInferenceChunk] = []
    for start in range(0, total_samples, samples_per_chunk):
        end = min(total_samples, start + samples_per_chunk)
        chunk_audio = audio[start:end]
        chunks.append(
            AudioInferenceChunk(
                start_sec=round(start / sample_rate, 6),
                end_sec=round(end / sample_rate, 6),
                audio_bytes=_encode_wav_chunk(chunk_audio, sample_rate),
            )
        )
    return chunks


def _decode_audio_for_chunking(audio_bytes: bytes) -> tuple[np.ndarray, int]:
    import soundfile as sf

    audio, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=True)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    return np.asarray(audio, dtype=np.float32), int(sample_rate)


def _encode_wav_chunk(audio: np.ndarray, sample_rate: int) -> bytes:
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _merge_chunk_results(results: list[tuple[AudioInferenceChunk, ASRResult]]) -> ASRResult:
    if not results:
        return ASRResult(full_text="", segments=[], engine_name="unknown", raw={"chunked": True})

    texts: list[str] = []
    segments: list[Segment] = []
    confidences: list[float] = []
    languages: list[str] = []
    raw_chunks: list[dict[str, object]] = []
    engine_name = "unknown"

    for index, (chunk, result_obj) in enumerate(results):
        result = result_obj
        engine_name = result.engine_name or engine_name
        text = result.full_text.strip()
        if text:
            texts.append(text)
        if result.language and result.language not in languages:
            languages.append(result.language)
        if result.confidence is not None:
            confidences.append(float(result.confidence))

        if result.segments:
            for segment in result.segments:
                start = min(chunk.end_sec, max(chunk.start_sec, chunk.start_sec + segment.start))
                end = min(chunk.end_sec, max(start, chunk.start_sec + segment.end))
                segments.append(
                    Segment(
                        start=round(start, 6),
                        end=round(end, 6),
                        text=segment.text,
                        confidence=segment.confidence,
                    )
                )
        elif text:
            segments.append(
                Segment(
                    start=chunk.start_sec,
                    end=chunk.end_sec,
                    text=text,
                    confidence=result.confidence,
                )
            )

        raw_chunks.append(
            {
                "index": index,
                "start_sec": chunk.start_sec,
                "end_sec": chunk.end_sec,
                "text_chars": len(result.full_text),
                "segment_count": len(result.segments),
            }
        )

    confidence = round(sum(confidences) / len(confidences), 6) if confidences else None
    return ASRResult(
        full_text="\n".join(texts),
        segments=segments,
        language=languages[0] if languages else None,
        engine_name=engine_name,
        confidence=confidence,
        raw={
            "chunked": True,
            "chunk_count": len(results),
            "chunks": raw_chunks,
        },
    )
