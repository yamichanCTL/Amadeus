"""
app/api/v1/llm.py
─────────────────
Text post-processing endpoints backed by OpenAI-compatible chat APIs.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException, status

from app.core.llm import process_text
from app.schemas.llm import LLMProcessRequest, LLMTextResult

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
