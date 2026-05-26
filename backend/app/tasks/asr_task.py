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
   d. Dispatches to ModelRouter (one or more engines).
   e. Runs the optional post-pipeline (punctuation, diarize).
   f. Saves Transcript row, updates status → success.
3. On any exception: updates status → failed with error_message.
4. API client polls GET /v1/tasks/{id} until status ∈ {success, failed}.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from celery import Task  # type: ignore[import]

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
    throws=(),          # don't auto-retry on these (we handle all exceptions manually)
)
def run_asr_task(self: ASRBaseTask, task_id: str) -> dict:  # type: ignore[misc]
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
    return self.run_async(_run(task_id))  # type: ignore[return-value]


# ── Async implementation ──────────────────────────────────────────────────────

async def _run(task_id: str) -> dict:
    from app.config import get_settings
    from app.core.archive import archive_file_error_record, archive_file_record
    from app.core.asr.base import EngineOptions
    from app.core.asr.router import ModelRouter
    from app.core.model_manager import get_model_manager
    from app.core.pipeline.post.diarize import assign_speakers
    from app.core.pipeline.post.punctuation import restore_punctuation
    from app.core.pipeline.pre.vad import detect_speech
    from app.db.crud import (
        create_transcript,
        get_task,
        update_task_status,
    )
    from app.db.models import TaskStatus
    from app.db.session import AsyncSessionLocal

    settings = get_settings()

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

            audio_bytes = Path(task.audio_path).read_bytes()

            # ── 4. Parse engine options ───────────────────────────────────
            engine_opts_raw: dict = (
                json.loads(task.engine_options) if task.engine_options else {}
            )
            keep_audio = bool(engine_opts_raw.get("allow_server_data_collection"))
            engines = [e.strip() for e in task.engines.split(",") if e.strip()]

            options = EngineOptions(
                language=engine_opts_raw.get("language"),
                task=engine_opts_raw.get("task", "transcribe"),
                extra=engine_opts_raw.get("extra", {}),
            )

            # ── 5. Pre-pipeline (VAD) ─────────────────────────────────────
            if task.vad_enabled:
                import io
                import numpy as np
                import soundfile as sf

                buf = io.BytesIO(audio_bytes)
                audio_array, sr = sf.read(buf, dtype="float32", always_2d=False)
                speech_segments = await detect_speech(audio_array, sr)
                logger.info(
                    "Task %s: VAD found %d speech segments.", task_id, len(speech_segments)
                )
                # TODO: splice audio and run per-segment (reassemble afterwards)
                # For now: pass full audio through

            # ── 6. ASR inference ──────────────────────────────────────────
            manager = get_model_manager()
            router = ModelRouter(
                manager=manager,
                engines=engines,
                merge_strategy=engine_opts_raw.get("merge_strategy", "first"),
            )
            result = await router.run(audio_bytes, options)
            logger.info(
                "Task %s: ASR complete — %d chars, engine=%s",
                task_id, len(result.full_text), result.engine_name,
            )

            # ── 7. Post-pipeline ──────────────────────────────────────────
            final_text = result.full_text

            if task.punctuation_enabled:
                final_text = await restore_punctuation(final_text, result.language)
                result.full_text = final_text

            if task.diarize_enabled and result.segments:
                import io
                import soundfile as sf
                buf = io.BytesIO(audio_bytes)
                audio_array, sr = sf.read(buf, dtype="float32", always_2d=False)
                result.segments = await assign_speakers(result.segments, audio_array, sr)

            # ── 8. Persist result ─────────────────────────────────────────
            segments_data = [
                {
                    "start": s.start,
                    "end": s.end,
                    "text": s.text,
                    "speaker": s.speaker,
                    "confidence": s.confidence,
                }
                for s in result.segments
            ]

            transcript = await create_transcript(
                db,
                task_id=task_id,
                full_text=result.full_text,
                segments=segments_data,
                language=result.language,
                engine_used=result.engine_name,
                confidence=result.confidence,
                raw_results=result.raw,
            )
            archive_file_record(
                audio_bytes=audio_bytes,
                suffix=Path(task.filename or "audio.wav").suffix or ".wav",
                user_id=task.user_id,
                category=engine_opts_raw.get("archive_category") or settings.upload_archive_category,
                text=result.full_text,
                engine=result.engine_name,
                language=result.language,
                duration_sec=task.duration_sec,
                metadata={
                    "task_id": task_id,
                    "transcript_id": transcript.id,
                    "allow_server_data_collection": keep_audio,
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
            if "audio_bytes" in locals():
                archive_file_error_record(
                    audio_bytes=audio_bytes,
                    suffix=Path(task.filename or "audio.wav").suffix or ".wav",
                    user_id=task.user_id,
                    category=engine_opts_raw.get("archive_category") or settings.upload_archive_category
                    if "engine_opts_raw" in locals()
                    else settings.upload_archive_category,
                    engine=task.engines,
                    language=engine_opts_raw.get("language") if "engine_opts_raw" in locals() else None,
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
