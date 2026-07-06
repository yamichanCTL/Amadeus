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

import asyncio
import io
import json
import logging
import subprocess
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypeVar

import soundfile as sf  # type: ignore[import]
from fastapi import APIRouter, Depends, Form, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.archive import archive_file_error_record, archive_file_record
from app.core.asr.base import EngineOptions
from app.core.asr.hotwords import get_hotword_manager
from app.core.llm import log_asr_ai_polish_result, run_auto_processing
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
)
from app.schemas.llm import LLMOutputs
from app.schemas.transcribe import (
    TranscribeAsyncResponse,
    TranscribeOptions,
    TranscribeResponse,
    TranscriptSegment,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/transcribe", tags=["transcription"])
settings = get_settings()
T = TypeVar("T")


def should_archive_debug_data(opts: TranscribeOptions) -> bool:
    """Single opt-in boundary used by success and error archive paths."""
    return opts.allow_server_data_collection is True


async def _run_with_timeout(operation: Callable[[], Awaitable[T]], timeout_sec: float) -> T:
    if timeout_sec <= 0:
        return await operation()
    try:
        return await asyncio.wait_for(operation(), timeout=timeout_sec)
    except TimeoutError as exc:
        raise TimeoutError(f"ASR execution exceeded {timeout_sec:g} seconds") from exc


def _long_audio_timeout_sec(duration_sec: float, requested_timeout_sec: int) -> int:
    """Give queued long audio enough inference time while respecting no-limit."""
    if requested_timeout_sec <= 0:
        return 0
    duration_budget = int(duration_sec * 3 + 60)
    return min(3600, max(requested_timeout_sec, duration_budget))


# ── Helper: parse options from multipart form ──────────────────────────────────

def _parse_options(options_json: str | None) -> TranscribeOptions:
    """Parse the JSON `options` form field; fall back to defaults on error."""
    if not options_json:
        return TranscribeOptions(
            engine=settings.default_engine,
            timeout_sec=settings.transcribe_timeout_sec,
        )
    try:
        data = json.loads(options_json)
        data.setdefault("timeout_sec", settings.transcribe_timeout_sec)
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


async def _run_llm_auto(text: str, opts: TranscribeOptions) -> tuple[LLMOutputs | None, str | None]:
    if opts.llm is None:
        return None, None
    outputs, error = await run_auto_processing(
        text=text,
        model=opts.llm.model,
        base_url=opts.llm.base_url,
        api_token=opts.llm.api_token,
        target_language=opts.llm.target_language,
        style=opts.llm.style,
        enable_polish=opts.llm.enable_polish,
        enable_translate=opts.llm.enable_translate,
        prompt=opts.llm.prompt,
    )
    llm_outputs = LLMOutputs(
        polish=outputs.get("polish"),
        translate=outputs.get("translate"),
    )
    if not llm_outputs.polish and not llm_outputs.translate:
        llm_outputs = None
    return llm_outputs, error


def _raw_results_with_llm(
    raw: dict | None,
    llm_outputs: LLMOutputs | None,
    llm_error: str | None,
) -> dict | None:
    raw_results = dict(raw or {})
    if llm_outputs:
        raw_results["llm_outputs"] = llm_outputs.model_dump(mode="json", exclude_none=True)
    if llm_error:
        raw_results["llm_error"] = llm_error
    return raw_results or None


def _llm_celery_options(opts: TranscribeOptions) -> dict | None:
    if opts.llm is None:
        return None
    if not (opts.llm.enable_polish or opts.llm.enable_translate):
        return None
    return opts.llm.model_dump(mode="json")


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
      "engine": "whisper",
      "language": "zh",
      "whisper_model": "medium",
      "enable_punctuation": true,
      "enable_hotwords": true
    }
    ```
    """
    request_started = time.perf_counter()
    timing: dict[str, float] = {}
    opts = _parse_options(options_json)

    # Read file bytes
    audio_bytes = await file.read()
    timing["upload_read_sec"] = round(time.perf_counter() - request_started, 6)
    if len(audio_bytes) > settings.max_upload_size_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {settings.max_upload_size_mb} MB limit.",
        )

    probe_started = time.perf_counter()
    duration = _probe_duration(audio_bytes)
    timing["audio_probe_sec"] = round(time.perf_counter() - probe_started, 6)
    is_long = duration is not None and duration > settings.sync_max_duration_sec
    effective_timeout_sec = (
        _long_audio_timeout_sec(duration, opts.timeout_sec)
        if is_long and duration is not None
        else opts.timeout_sec
    )

    # Resolve pipeline flags (request opts override server defaults)
    vad_on = opts.enable_vad if opts.enable_vad is not None else settings.enable_vad
    punc_on = (
        opts.enable_punctuation
        if opts.enable_punctuation is not None
        else settings.enable_punctuation
    )
    # Create DB task row
    task_started = time.perf_counter()
    task = await create_task(
        db,
        engines=[opts.engine],
        filename=file.filename,
        duration_sec=duration,
        file_size_bytes=len(audio_bytes),
        mime_type=file.content_type,
        engine_options={
            "language": opts.language,
            "task": opts.whisper_task,
            "timeout_sec": effective_timeout_sec,
            "enable_hotwords": opts.enable_hotwords,
            "allow_server_data_collection": opts.allow_server_data_collection,
            "archive_category": opts.archive_category,
            "archive_user_id": opts.user_id,
            "llm": (
                opts.llm.model_dump(mode="json", exclude={"api_token"}, exclude_none=True)
                if opts.llm
                else None
            ),
            "extra": (
                {"model_size": opts.whisper_model} if opts.whisper_model else {}
            ),
        },
        vad_enabled=vad_on,
        punctuation_enabled=punc_on,
        user_id=user.id if user else None,
    )
    await db.commit()
    timing["task_create_sec"] = round(time.perf_counter() - task_started, 6)

    # ── Async path: long audio ─────────────────────────────────────────────
    if is_long:
        audio_path = await _save_audio(audio_bytes, file.filename, opts)
        await update_task_audio_path(db, task.id, str(audio_path), duration)
        await db.commit()

        from app.tasks.asr_task import run_asr_task
        celery_result = run_asr_task.delay(task.id, _llm_celery_options(opts))
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

        async def load_and_transcribe():
            model_started = time.perf_counter()
            engine = await manager.get_engine(opts.engine)
            timing["model_ready_sec"] = round(time.perf_counter() - model_started, 6)
            asr_started = time.perf_counter()
            result = await engine.transcribe(audio_bytes, engine_options)
            timing["asr_sec"] = round(time.perf_counter() - asr_started, 6)
            return result

        result = await _run_with_timeout(load_and_transcribe, opts.timeout_sec)

        # Post-pipeline
        if punc_on:
            punctuation_started = time.perf_counter()
            result.full_text = await restore_punctuation(result.full_text, result.language)
            timing["punctuation_sec"] = round(time.perf_counter() - punctuation_started, 6)
            if len(result.segments) == 1:
                result.segments[0].text = result.full_text

        hotword_started = time.perf_counter()
        hotword_result = get_hotword_manager().apply(result.full_text, enabled=opts.enable_hotwords)
        timing["hotword_sec"] = round(time.perf_counter() - hotword_started, 6)
        result.full_text = hotword_result.text
        if hotword_result.replacements or hotword_result.suggestions:
            result.raw = dict(result.raw or {})
            result.raw["hotwords"] = {
                "replacements": hotword_result.replacements,
                "suggestions": hotword_result.suggestions,
            }

        llm_started = time.perf_counter()
        llm_outputs, llm_error = await _run_llm_auto(result.full_text, opts)
        if llm_outputs:
            log_asr_ai_polish_result(task.id, llm_outputs)
        timing["llm_sec"] = round(time.perf_counter() - llm_started, 6)

        # Persist
        persist_started = time.perf_counter()
        segments_data = [
            {"start": s.start, "end": s.end, "text": s.text,
             "confidence": s.confidence}
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
            raw_results=_raw_results_with_llm(
                {**(result.raw or {}), "timing": timing}, llm_outputs, llm_error
            ),
        )
        if should_archive_debug_data(opts):
            archive_file_record(
                audio_bytes=audio_bytes,
                suffix=Path(file.filename or "audio.wav").suffix or ".wav",
                user_id=user.id if user else opts.user_id,
                category=opts.archive_category or settings.upload_archive_category,
                text=result.full_text,
                engine=result.engine_name,
                language=result.language,
                duration_sec=duration,
                llm_outputs=(
                    llm_outputs.model_dump(mode="json", exclude_none=True)
                    if llm_outputs
                    else None
                ),
                metadata={
                    "task_id": task.id,
                    "transcript_id": transcript.id,
                    "allow_server_data_collection": True,
                },
            )

        # Reload task for elapsed_sec
        await update_task_status(db, task.id, TaskStatus.SUCCESS)
        await db.commit()
        timing["persist_sec"] = round(time.perf_counter() - persist_started, 6)
        timing["total_sec"] = round(time.perf_counter() - request_started, 6)

        segments_out = [
            TranscriptSegment(
                start=s.start, end=s.end, text=s.text,
                confidence=s.confidence,
            )
            for s in result.segments
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
            timing=timing,
            llm_outputs=llm_outputs,
            llm_error=llm_error,
        )

    except Exception as exc:
        logger.exception("Sync transcription failed for task %s: %s", task.id, exc)
        if should_archive_debug_data(opts):
            archive_file_error_record(
                audio_bytes=audio_bytes,
                suffix=Path(file.filename or "audio.wav").suffix or ".wav",
                user_id=user.id if user else opts.user_id,
                category=opts.archive_category or settings.upload_archive_category,
                engine=opts.engine,
                language=opts.language,
                duration_sec=duration,
                error=str(exc),
                metadata={"task_id": task.id},
            )
        await update_task_status(
            db, task.id, TaskStatus.FAILED, error_message=str(exc)
        )
        await db.commit()
        timed_out = isinstance(exc, TimeoutError)
        raise HTTPException(
            status_code=(
                status.HTTP_504_GATEWAY_TIMEOUT
                if timed_out
                else status.HTTP_500_INTERNAL_SERVER_ERROR
            ),
            detail=(
                f"Transcription timed out: {exc}"
                if timed_out
                else f"Transcription failed: {exc}"
            ),
        ) from exc
