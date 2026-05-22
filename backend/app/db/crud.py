"""
app/db/crud.py
──────────────
All database read/write helpers.  Routers and tasks import these; they never
touch SQLAlchemy directly.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models import ASRTask, TaskStatus, Transcript, User


# ─────────────────────────────────────────────────────────────────────────────
# User
# ─────────────────────────────────────────────────────────────────────────────

async def get_user_by_username(db: AsyncSession, username: str) -> User | None:
    result = await db.execute(select(User).where(User.username == username))
    return result.scalar_one_or_none()


async def create_user(db: AsyncSession, username: str, hashed_password: str) -> User:
    user = User(username=username, hashed_password=hashed_password)
    db.add(user)
    await db.flush()
    await db.refresh(user)
    return user


# ─────────────────────────────────────────────────────────────────────────────
# ASR Task
# ─────────────────────────────────────────────────────────────────────────────

async def create_task(
    db: AsyncSession,
    *,
    engines: list[str],
    filename: str | None = None,
    audio_path: str | None = None,
    duration_sec: float | None = None,
    file_size_bytes: int | None = None,
    mime_type: str | None = None,
    engine_options: dict[str, Any] | None = None,
    vad_enabled: bool = False,
    punctuation_enabled: bool = False,
    diarize_enabled: bool = False,
    user_id: str | None = None,
) -> ASRTask:
    task = ASRTask(
        user_id=user_id,
        engines=",".join(engines),
        filename=filename,
        audio_path=audio_path,
        duration_sec=duration_sec,
        file_size_bytes=file_size_bytes,
        mime_type=mime_type,
        engine_options=json.dumps(engine_options) if engine_options else None,
        vad_enabled=vad_enabled,
        punctuation_enabled=punctuation_enabled,
        diarize_enabled=diarize_enabled,
        status=TaskStatus.PENDING,
    )
    db.add(task)
    await db.flush()
    await db.refresh(task)
    return task


async def get_task(
    db: AsyncSession, task_id: str, *, load_transcript: bool = True
) -> ASRTask | None:
    stmt = select(ASRTask).where(ASRTask.id == task_id)
    if load_transcript:
        stmt = stmt.options(selectinload(ASRTask.transcript))
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def list_tasks(
    db: AsyncSession,
    *,
    user_id: str | None = None,
    status: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> list[ASRTask]:
    stmt = select(ASRTask).order_by(ASRTask.created_at.desc())
    stmt = stmt.options(selectinload(ASRTask.transcript))
    if user_id:
        stmt = stmt.where(ASRTask.user_id == user_id)
    if status:
        stmt = stmt.where(ASRTask.status == status)
    stmt = stmt.limit(limit).offset(offset)
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def update_task_status(
    db: AsyncSession,
    task_id: str,
    status: str,
    *,
    celery_task_id: str | None = None,
    error_message: str | None = None,
) -> ASRTask | None:
    task = await get_task(db, task_id, load_transcript=False)
    if task is None:
        return None

    task.status = status
    if celery_task_id is not None:
        task.celery_task_id = celery_task_id
    if error_message is not None:
        task.error_message = error_message

    now = datetime.now(timezone.utc)
    if status == TaskStatus.PROCESSING and task.started_at is None:
        task.started_at = now
    if status in (TaskStatus.SUCCESS, TaskStatus.FAILED, TaskStatus.CANCELLED):
        task.finished_at = now

    await db.flush()
    await db.refresh(task)
    return task


async def update_task_audio_path(
    db: AsyncSession, task_id: str, audio_path: str, duration_sec: float | None = None
) -> None:
    task = await get_task(db, task_id, load_transcript=False)
    if task:
        task.audio_path = audio_path
        if duration_sec is not None:
            task.duration_sec = duration_sec
        await db.flush()


# ─────────────────────────────────────────────────────────────────────────────
# Transcript
# ─────────────────────────────────────────────────────────────────────────────

async def create_transcript(
    db: AsyncSession,
    *,
    task_id: str,
    full_text: str,
    segments: list[dict[str, Any]] | None = None,
    language: str | None = None,
    engine_used: str = "whisper",
    confidence: float | None = None,
    raw_results: dict[str, Any] | None = None,
) -> Transcript:
    transcript = Transcript(
        task_id=task_id,
        full_text=full_text,
        segments=json.dumps(segments, ensure_ascii=False) if segments else None,
        language=language,
        engine_used=engine_used,
        confidence=confidence,
        raw_results=json.dumps(raw_results, ensure_ascii=False) if raw_results else None,
    )
    db.add(transcript)
    await db.flush()
    await db.refresh(transcript)
    return transcript


async def get_transcript_by_task(
    db: AsyncSession, task_id: str
) -> Transcript | None:
    result = await db.execute(
        select(Transcript).where(Transcript.task_id == task_id)
    )
    return result.scalar_one_or_none()
