"""
app/api/v1/llm.py
─────────────────
Text post-processing endpoints backed by OpenAI-compatible chat APIs.
"""

from __future__ import annotations

import json

import httpx
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse

from app.core.llm import list_provider_models, process_text, summarize_archive, summarize_archive_stream
from app.core.archive import save_summary_record
from app.schemas.llm import (
    ArchiveSummaryRequest,
    ArchiveSummaryResult,
    ArchiveSummarySaveRequest,
    ArchiveSummarySaveResult,
    LLMModelsRequest,
    LLMModelsResult,
    LLMProcessRequest,
    LLMTextResult,
)

router = APIRouter(prefix="/llm", tags=["llm"])


@router.post("/process", response_model=LLMTextResult, summary="Polish or translate text")
async def process_llm_text(request: LLMProcessRequest) -> LLMTextResult:
    try:
        return await process_text(request)
    except httpx.HTTPStatusError as exc:
        detail = f"LLM provider returned HTTP {exc.response.status_code}"
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=detail) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LLM provider request failed",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"LLM processing failed: {exc}",
        ) from exc


@router.post("/models", response_model=LLMModelsResult, summary="Check provider and list models")
async def list_llm_models(request: LLMModelsRequest) -> LLMModelsResult:
    return await list_provider_models(request)


@router.post(
    "/archive-summary",
    response_model=ArchiveSummaryResult,
    summary="Summarize archived ASR records",
)
async def summarize_archived_asr(request: ArchiveSummaryRequest) -> ArchiveSummaryResult:
    try:
        return await summarize_archive(request)
    except httpx.HTTPStatusError as exc:
        detail = f"LLM provider returned HTTP {exc.response.status_code}"
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=detail) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LLM provider request failed",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Archive summary failed: {exc}",
        ) from exc


@router.post(
    "/archive-summary/stream",
    summary="Stream archived ASR summary",
)
async def stream_archived_asr_summary(request: ArchiveSummaryRequest) -> StreamingResponse:
    async def event_stream():
        try:
            async for event in summarize_archive_stream(request):
                yield json.dumps(event, ensure_ascii=False) + "\n"
        except httpx.HTTPStatusError as exc:
            yield json.dumps(
                {"type": "error", "message": f"LLM provider returned HTTP {exc.response.status_code}"},
                ensure_ascii=False,
            ) + "\n"
        except httpx.HTTPError:
            yield json.dumps(
                {"type": "error", "message": "LLM provider request failed"},
                ensure_ascii=False,
            ) + "\n"
        except Exception as exc:
            yield json.dumps(
                {"type": "error", "message": f"Archive summary failed: {exc}"},
                ensure_ascii=False,
            ) + "\n"

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Content-Encoding": "identity",
        },
    )


@router.post("/archive-summary/save", response_model=ArchiveSummarySaveResult, summary="Save archive summary")
async def save_archived_summary(request: ArchiveSummarySaveRequest) -> ArchiveSummarySaveResult:
    path = save_summary_record(
        summary=request.summary.model_dump(),
        user_id=request.user_id,
        category=request.category,
    )
    return ArchiveSummarySaveResult(saved=True, path=path)
