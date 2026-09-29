"""Codex conversation, model catalogue and app-scoped usage endpoints."""

from __future__ import annotations

import asyncio
import json
from typing import Annotated

from app.core.codex_connection import CodexError
from app.core.codex_meeting import explain_excerpt, stream_explanation
from app.core.codex_runtime import CodexRuntime, get_codex_runtime
from app.core.work_authorization import valid_work_token
from app.db.models import ASRTask, TaskStatus, Transcript
from app.db.session import get_db
from app.schemas.codex import CodexExplanationRequest, CodexTurnRequest, CodexTurnResult
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/agents/codex", tags=["codex"])
Runtime = Annotated[CodexRuntime, Depends(get_codex_runtime)]


def _check_work_origin(options: CodexTurnRequest, request: Request) -> None:
    if not options.allow_work:
        return
    if request.client is None or request.client.host not in {"127.0.0.1", "::1"}:
        raise HTTPException(403, "工作区任务只能从本机发起")
    if not valid_work_token(request.headers.get("X-Amadeus-Work-Token")):
        raise HTTPException(403, "工作区任务需要桌面端授权令牌")


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
    request: CodexTurnRequest, runtime: Runtime, db: Annotated[AsyncSession, Depends(get_db)], http_request: Request
):
    _check_work_origin(request, http_request)
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


@router.post("/turns/stream")
async def turn_stream(request: CodexTurnRequest, runtime: Runtime, http_request: Request):
    _check_work_origin(request, http_request)
    if not request.text:
        raise HTTPException(422, "流式对话需要 text")

    async def events():
        queue: asyncio.Queue[dict] = asyncio.Queue()

        async def emit(event: dict):
            await queue.put(event)

        task = asyncio.create_task(runtime.turn(request.text, request, emit=emit))
        try:
            while not task.done() or not queue.empty():
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=0.5)
                except TimeoutError:
                    continue
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            try:
                await task
            except CodexError as error:
                yield f"data: {json.dumps({'type': 'agent.error', 'message': str(error)}, ensure_ascii=False)}\n\n"
        finally:
            if not task.done():
                await runtime.cancel(request.session_id)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/explanations")
async def explanation(request: CodexExplanationRequest, runtime: Runtime):
    try:
        return await explain_excerpt(runtime, request)
    except CodexError as error:
        raise _http_error(error) from None


@router.post("/explanations/stream")
async def explanation_stream(request: CodexExplanationRequest, runtime: Runtime):
    return StreamingResponse(
        stream_explanation(runtime, request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
