"""
app/api/v1/transcribe.py
─────────────────────────
POST /v1/transcribe

Decision tree
─────────────
                   ┌── audio duration ≤ SYNC_MAX_DURATION_SEC?
                   │        YES → run inline, return TranscribeResponse
  POST /transcribe ┤
                   │        NO  → enqueue Celery task, return TranscribeAsyncResponse
                   └── (client polls /v1/tasks/{id})

The endpoint also accepts a JSON body field `options` alongside the
multipart file upload.  All option fields are optional.
"""

from __future__ import annotations

import io
import json
import logging
import subprocess
import uuid
from pathlib import Path
from typing import Annotated

import soundfile as sf  # type: ignore[import]
from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status

from app.config import get_settings
from app.core.archive import archive_file_error_record, archive_file_record
from app.core.asr.base import EngineOptions
from app.core.asr.router import ModelRouter
from app.core.model_manager import ModelManager
from app.core.pipeline.post.diarize import assign_speakers
from app.core.pipeline.post.punctuation import restore_punctuation
from app.db.crud import (
    create_task,
    create_transcript,
    update_task_audio_path,
    update_task_status,
)
from app.db.models import TaskStatus
from app.db.session import get_db
from app.dependencies import (
    Manager,
    OptionalUser,
    ValidAudioFile,
    validate_audio_upload,
)
from app.schemas.transcribe import (
    EngineResult,
    TranscribeAsyncResponse,
    TranscribeOptions,
    TranscribeResponse,
    TranscriptSegment,
)
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/transcribe", tags=["transcription"])
settings = get_settings()


# ── Helper: parse options from multipart form ──────────────────────────────────

def _parse_options(options_json: str | None) -> TranscribeOptions:
    """Parse the JSON `options` form field; fall back to defaults on error."""
    if not options_json:
        return TranscribeOptions(engines=[settings.default_engine])
    try:
        data = json.loads(options_json)
        return TranscribeOptions.model_validate(data)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Invalid options JSON: {exc}",
        ) from exc


# ── Helper: probe audio duration without loading full array ───────────────────

def _probe_duration(audio_bytes: bytes) -> float | None:
    try:
        with sf.SoundFile(io.BytesIO(audio_bytes)) as f:
            return f.frames / f.samplerate
    except Exception:
        return _probe_duration_ffprobe(audio_bytes)


def _probe_duration_ffprobe(audio_bytes: bytes) -> float | None:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        "pipe:0",
    ]
    try:
        proc = subprocess.run(cmd, input=audio_bytes, capture_output=True, check=False)
    except FileNotFoundError:
        return None
    if proc.returncode != 0:
        return None
    try:
        return float(proc.stdout.decode("utf-8").strip())
    except ValueError:
        return None


# ── Helper: save uploaded audio to disk ───────────────────────────────────────

async def _save_audio(
    audio_bytes: bytes,
    original_filename: str | None,
    opts: TranscribeOptions,
) -> Path:
    suffix = Path(original_filename or "audio.wav").suffix or ".wav"
    root = settings.audio_upload_dir
    if opts.allow_server_data_collection:
        root = Path(opts.archive_dir) if opts.archive_dir else settings.archive_dir
        if not root.is_absolute():
            root = settings.archive_dir / root
    root.mkdir(parents=True, exist_ok=True)
    dest = root / f"{uuid.uuid4().hex}{suffix}"
    dest.write_bytes(audio_bytes)
    return dest


# ── POST /v1/transcribe ───────────────────────────────────────────────────────

@router.post(
    "",
    response_model=TranscribeResponse | TranscribeAsyncResponse,
    summary="Transcribe audio (auto sync/async)",
    responses={
        200: {"description": "Synchronous result (short audio)"},
        202: {"description": "Accepted for async processing (long audio)"},
    },
)
async def transcribe(
    file: ValidAudioFile,
    manager: Manager,
    user: OptionalUser,
    db: AsyncSession = Depends(get_db),
    options_json: str | None = Form(None, alias="options"),
) -> TranscribeResponse | TranscribeAsyncResponse:
    """
    Upload an audio file and receive a transcript.

    - **Short audio** (≤ `SYNC_MAX_DURATION_SEC`): result returned in the response body.
    - **Long audio**: task queued; poll `/v1/tasks/{task_id}` for the result.

    `options` (optional JSON form field):
    ```json
    {
      "engines": ["whisper"],
      "language": "zh",
      "whisper_model": "medium",
      "enable_punctuation": true,
      "merge_strategy": "first"
    }
    ```
    """
    opts = _parse_options(options_json)

    # Read file bytes
    audio_bytes = await file.read()
    if len(audio_bytes) > settings.max_upload_size_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {settings.max_upload_size_mb} MB limit.",
        )

    duration = _probe_duration(audio_bytes)

    # Resolve pipeline flags (request opts override server defaults)
    vad_on = opts.enable_vad if opts.enable_vad is not None else settings.enable_vad
    punc_on = (
        opts.enable_punctuation
        if opts.enable_punctuation is not None
        else settings.enable_punctuation
    )
    diarize_on = (
        opts.enable_diarize
        if opts.enable_diarize is not None
        else settings.enable_diarize
    )

    # Create DB task row
    task = await create_task(
        db,
        engines=opts.engines,
        filename=file.filename,
        duration_sec=duration,
        file_size_bytes=len(audio_bytes),
        mime_type=file.content_type,
        engine_options={
            "language": opts.language,
            "task": opts.whisper_task,
            "merge_strategy": opts.merge_strategy,
            "allow_server_data_collection": opts.allow_server_data_collection,
            "archive_category": opts.archive_category,
            "extra": (
                {"model_size": opts.whisper_model} if opts.whisper_model else {}
            ),
        },
        vad_enabled=vad_on,
        punctuation_enabled=punc_on,
        diarize_enabled=diarize_on,
        user_id=user.id if user else None,
    )
    await db.commit()

    # ── Async path: long audio ─────────────────────────────────────────────
    is_long = duration is not None and duration > settings.sync_max_duration_sec
    if is_long:
        audio_path = await _save_audio(audio_bytes, file.filename, opts)
        await update_task_audio_path(db, task.id, str(audio_path), duration)
        await db.commit()

        from app.tasks.asr_task import run_asr_task
        celery_result = run_asr_task.delay(task.id)
        await update_task_status(
            db, task.id, TaskStatus.PENDING, celery_task_id=celery_result.id
        )
        await db.commit()

        logger.info(
            "Task %s queued (duration=%.1fs, celery=%s)",
            task.id, duration, celery_result.id,
        )
        return TranscribeAsyncResponse(
            task_id=task.id,
            status=TaskStatus.PENDING,
        )

    # ── Sync path: short audio ─────────────────────────────────────────────
    await update_task_status(db, task.id, TaskStatus.PROCESSING)
    await db.commit()

    try:
        engine_options = EngineOptions(
            language=opts.language,
            task=opts.whisper_task,
            extra={"model_size": opts.whisper_model} if opts.whisper_model else {},
        )

        router_obj = ModelRouter(
            manager=manager,
            engines=opts.engines,
            merge_strategy=opts.merge_strategy,
        )
        result = await router_obj.run(audio_bytes, engine_options)

        # Post-pipeline
        if punc_on:
            result.full_text = await restore_punctuation(result.full_text, result.language)

        if diarize_on and result.segments:
            audio_arr, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=False)
            result.segments = await assign_speakers(result.segments, audio_arr, sr)

        # Persist
        segments_data = [
            {"start": s.start, "end": s.end, "text": s.text,
             "speaker": s.speaker, "confidence": s.confidence}
            for s in result.segments
        ]
        transcript = await create_transcript(
            db,
            task_id=task.id,
            full_text=result.full_text,
            segments=segments_data,
            language=result.language,
            engine_used=result.engine_name,
            confidence=result.confidence,
            raw_results=result.raw,
        )
        archive_file_record(
            audio_bytes=audio_bytes,
            suffix=Path(file.filename or "audio.wav").suffix or ".wav",
            user_id=user.id if user else None,
            category=opts.archive_category or settings.upload_archive_category,
            text=result.full_text,
            engine=result.engine_name,
            language=result.language,
            duration_sec=duration,
            metadata={
                "task_id": task.id,
                "transcript_id": transcript.id,
                "allow_server_data_collection": opts.allow_server_data_collection,
            },
        )

        # Reload task for elapsed_sec
        await update_task_status(db, task.id, TaskStatus.SUCCESS)
        await db.commit()

        segments_out = [
            TranscriptSegment(
                start=s.start, end=s.end, text=s.text,
                speaker=s.speaker, confidence=s.confidence,
            )
            for s in result.segments
        ]

        # Build multi-engine detail if applicable
        engine_results = None
        if len(opts.engines) > 1 and "all_engines" in result.raw:
            engine_results = [
                EngineResult(
                    engine=eng,
                    full_text=data.get("full_text", ""),
                    confidence=data.get("confidence"),
                )
                for eng, data in result.raw["all_engines"].items()
            ]

        return TranscribeResponse(
            task_id=task.id,
            status=TaskStatus.SUCCESS,
            full_text=result.full_text,
            segments=segments_out,
            language=result.language,
            engine_used=result.engine_name,
            confidence=result.confidence,
            duration_sec=duration,
            engine_results=engine_results,
        )

    except Exception as exc:
        logger.exception("Sync transcription failed for task %s: %s", task.id, exc)
        archive_file_error_record(
            audio_bytes=audio_bytes,
            suffix=Path(file.filename or "audio.wav").suffix or ".wav",
            user_id=user.id if user else None,
            category=opts.archive_category or settings.upload_archive_category,
            engine=",".join(opts.engines),
            language=opts.language,
            duration_sec=duration,
            error=str(exc),
            metadata={"task_id": task.id},
        )
        await update_task_status(
            db, task.id, TaskStatus.FAILED, error_message=str(exc)
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Transcription failed: {exc}",
        ) from exc
