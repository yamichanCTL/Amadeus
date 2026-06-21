"""
app/api/v1/tasks.py
────────────────────
Task management endpoints.

GET  /v1/tasks/{task_id}   – poll a single task (used by long-audio clients)
GET  /v1/tasks             – list tasks (optional auth filter)
POST /v1/tasks/{task_id}/cancel  – attempt to cancel a queued task
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import crud
from app.db.models import TaskStatus
from app.db.session import get_db
from app.dependencies import OptionalUser
from app.schemas.llm import LLMOutputs
from app.schemas.task import TaskListResponse, TaskStatusResponse
from app.schemas.transcribe import TranscriptSegment

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/tasks", tags=["tasks"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _build_response(task: object) -> TaskStatusResponse:  # type: ignore[type-arg]
    """Convert an ASRTask ORM object to TaskStatusResponse."""
    from app.db.models import ASRTask, Transcript

    t: ASRTask = task  # type: ignore[assignment]

    resp = TaskStatusResponse(
        id=t.id,
        status=t.status,
        engines=t.engines,
        filename=t.filename,
        duration_sec=t.duration_sec,
        created_at=t.created_at,
        started_at=t.started_at,
        finished_at=t.finished_at,
        elapsed_sec=t.elapsed_sec,
        error_message=t.error_message,
    )

    if t.transcript:
        tr: Transcript = t.transcript
        resp.full_text = tr.full_text
        resp.language = tr.language
        resp.engine_used = tr.engine_used
        resp.confidence = tr.confidence

        if tr.segments:
            try:
                raw_segs = json.loads(tr.segments)
                resp.segments = [TranscriptSegment(**s) for s in raw_segs]
            except Exception:
                resp.segments = []
        if tr.raw_results:
            try:
                raw_results = json.loads(tr.raw_results)
                if isinstance(raw_results, dict):
                    raw_outputs = raw_results.get("llm_outputs")
                    if isinstance(raw_outputs, dict):
                        resp.llm_outputs = LLMOutputs.model_validate(raw_outputs)
                    raw_error = raw_results.get("llm_error")
                    if isinstance(raw_error, str):
                        resp.llm_error = raw_error
                    raw_timing = raw_results.get("timing")
                    if isinstance(raw_timing, dict):
                        resp.timing = {
                            str(key): float(value)
                            for key, value in raw_timing.items()
                            if isinstance(value, (int, float))
                        }
            except Exception:
                pass

    return resp


# ── GET /v1/tasks/{task_id} ───────────────────────────────────────────────────

@router.get(
    "/{task_id}",
    response_model=TaskStatusResponse,
    summary="Get task status and result",
)
async def get_task(
    task_id: str,
    db: AsyncSession = Depends(get_db),
) -> TaskStatusResponse:
    """
    Poll this endpoint after submitting a long-audio job.

    Status values:
    - `pending`    – queued, not yet started
    - `processing` – inference running
    - `success`    – done; `full_text` and `segments` are populated
    - `failed`     – check `error_message`
    - `cancelled`  – job was cancelled before processing
    """
    task = await crud.get_task(db, task_id, load_transcript=True)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task '{task_id}' not found.",
        )
    return _build_response(task)


# ── GET /v1/tasks ─────────────────────────────────────────────────────────────

@router.get(
    "",
    response_model=TaskListResponse,
    summary="List tasks",
)
async def list_tasks(
    user: OptionalUser,
    db: AsyncSession = Depends(get_db),
    task_status: str | None = Query(None, alias="status", description="Filter by status"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> TaskListResponse:
    """
    Return a paginated list of tasks.

    - Authenticated users see only their own tasks.
    - Anonymous requests return all tasks (suitable for single-user / local deployments).
    """
    user_id = user.id if user else None
    tasks = await crud.list_tasks(
        db,
        user_id=user_id,
        status=task_status,
        limit=limit,
        offset=offset,
    )
    return TaskListResponse(
        tasks=[_build_response(t) for t in tasks],
        total=len(tasks),  # TODO: add COUNT query for accurate total
        limit=limit,
        offset=offset,
    )


# ── POST /v1/tasks/{task_id}/cancel ──────────────────────────────────────────

@router.post(
    "/{task_id}/cancel",
    response_model=TaskStatusResponse,
    summary="Cancel a pending or processing task",
)
async def cancel_task(
    task_id: str,
    db: AsyncSession = Depends(get_db),
) -> TaskStatusResponse:
    """
    Attempt to cancel a task.

    - `pending` tasks are cancelled immediately (Celery task is revoked).
    - `processing` tasks: Celery soft-kill is sent; the worker finishes the
       current inference step then stops.  Not guaranteed to cancel instantly.
    - Already-terminal tasks (success/failed/cancelled) raise HTTP 409.
    """
    task = await crud.get_task(db, task_id, load_transcript=False)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task '{task_id}' not found.",
        )

    if task.status in (TaskStatus.SUCCESS, TaskStatus.FAILED, TaskStatus.CANCELLED):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Task is already in terminal state: {task.status}",
        )

    # Revoke Celery task if we have the Celery task ID
    if task.celery_task_id:
        try:
            from app.tasks.celery_app import celery_app
            celery_app.control.revoke(task.celery_task_id, terminate=True, signal="SIGTERM")
            logger.info(
                "Celery task %s revoked for ASR task %s",
                task.celery_task_id, task_id,
            )
        except Exception as exc:
            logger.warning("Could not revoke Celery task: %s", exc)

    updated = await crud.update_task_status(db, task_id, TaskStatus.CANCELLED)
    await db.commit()
    if not _keeps_uploaded_audio(task.engine_options) and task.audio_path:
        try:
            from pathlib import Path

            Path(task.audio_path).unlink(missing_ok=True)
        except Exception as exc:
            logger.warning("Could not delete cancelled task audio %s: %s", task.audio_path, exc)
    return _build_response(updated)


def _keeps_uploaded_audio(engine_options: str | None) -> bool:
    if not engine_options:
        return False
    try:
        return bool(json.loads(engine_options).get("allow_server_data_collection"))
    except Exception:
        return False
