"""Offline hotword management endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.core.asr.hotwords import get_hotword_manager

router = APIRouter(prefix="/hotwords", tags=["hotwords"])


class HotwordConfigRequest(BaseModel):
    hotwords: str = ""
    rules: str = ""
    enabled: bool = True
    rule_enabled: bool = True
    threshold: float = Field(0.85, ge=0, le=1)
    similar_threshold: float = Field(0.60, ge=0, le=1)


@router.get("")
async def get_hotwords() -> dict[str, Any]:
    return get_hotword_manager().get_state()


@router.put("")
async def update_hotwords(payload: HotwordConfigRequest) -> dict[str, Any]:
    if payload.similar_threshold > payload.threshold:
        payload.similar_threshold = payload.threshold
    return get_hotword_manager().save(**payload.model_dump())


@router.post("/preview")
async def preview_hotwords(payload: dict[str, str]) -> dict[str, Any]:
    result = get_hotword_manager().apply(payload.get("text", ""))
    return {"text": result.text, "replacements": result.replacements, "suggestions": result.suggestions}
