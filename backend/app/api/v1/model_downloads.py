"""Catalog-only model installation: renderer never supplies a path or URL."""
from __future__ import annotations

from typing import Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict
from app.core.model_downloads import DownloadError, get_model_download_manager

router = APIRouter(prefix="/model-downloads", tags=["model-downloads"])


class DownloadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    region: Literal["mainland", "global"] = "mainland"
    source: Literal["auto", "huggingface", "modelscope", "hf-mirror", "github"] = "auto"


@router.get("/catalog")
async def catalog() -> dict:
    return get_model_download_manager().catalog()


@router.get("/status")
async def status() -> dict:
    return {"jobs": list(get_model_download_manager().jobs.values())}


@router.post("/{identifier}/start")
async def start(identifier: str, body: DownloadRequest | None = None) -> dict:
    body = body or DownloadRequest()
    try:
        return await get_model_download_manager().start(identifier, region=body.region, source=body.source)
    except KeyError as exc:
        raise HTTPException(404, "这个模型不在已审核目录中。") from exc
    except DownloadError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/{identifier}/cancel")
async def cancel(identifier: str) -> dict:
    try:
        return await get_model_download_manager().cancel(identifier)
    except KeyError as exc:
        raise HTTPException(404, "这个模型不在已审核目录中。") from exc
