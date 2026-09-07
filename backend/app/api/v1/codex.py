"""Codex conversation, model catalogue and app-scoped usage endpoints."""

from __future__ import annotations

from typing import Annotated

from app.core.codex_connection import CodexError
from app.core.codex_runtime import CodexRuntime, get_codex_runtime
from app.db.models import ASRTask, TaskStatus, Transcript
from app.db.session import get_db
from app.schemas.codex import CodexTurnRequest, CodexTurnResult
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/agents/codex", tags=["codex"])
Runtime = Annotated[CodexRuntime, Depends(get_codex_runtime)]


def _http_error(error: CodexError) -> HTTPException:
    status = 409 if error.code == "codex_busy" else 429 if error.code == "codex_capacity" else 503
    return HTTPException(status_code=status, detail={"code": error.code, "message": str(error)})


@router.get("/models")
async def models(runtime: Runtime):
    try:
        return await runtime.inspect()
    except CodexError as error:
        raise _http_error(error) from None
    except TimeoutError:
        raise HTTPException(
            503, detail={"code": "codex_timeout", "message": "Codex 模型查询超时。"}
        ) from None


@router.post("/turns", response_model=CodexTurnResult)
async def turn(
    request: CodexTurnRequest, runtime: Runtime, db: Annotated[AsyncSession, Depends(get_db)]
):
    text = request.text
    if request.task_id:
        row = (
            await db.execute(
                select(ASRTask.status, Transcript.full_text)
                .outerjoin(
                    Transcript,
                    Transcript.task_id == ASRTask.id,
                )
                .where(ASRTask.id == request.task_id)
            )
        ).first()
        if row is None:
            raise HTTPException(404, "ASR task was not found")
        if row.status != TaskStatus.SUCCESS:
            raise HTTPException(409, "ASR task has not completed successfully")
        text = (row.full_text or "").strip()
    if not text:
        raise HTTPException(422, "ASR result is empty; Codex was not called")
    if len(text) > 12000:
        raise HTTPException(
            422, "ASR result exceeds 12000 characters; split it before calling Codex"
        )
    try:
        return await runtime.turn(text, request, source="asr_task" if request.task_id else "text")
    except CodexError as error:
        raise _http_error(error) from None


@router.post("/sessions/{session_id}/cancel")
async def cancel(session_id: str, runtime: Runtime):
    return {"session_id": session_id, "cancelled": await runtime.cancel(session_id)}


@router.delete("/sessions/{session_id}")
async def reset(session_id: str, runtime: Runtime):
    await runtime.reset(session_id)
    return {"session_id": session_id, "reset": True}


@router.get("/usage")
async def usage(
    runtime: Runtime,
    session_id: Annotated[str | None, Query(max_length=80)] = None,
    model: Annotated[str | None, Query(max_length=120)] = None,
):
    return await runtime.ledger.summary(session_id, model)
