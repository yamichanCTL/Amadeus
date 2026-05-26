"""Archived recognition records API."""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from app.config import get_settings
from app.core.archive import list_archived_records

router = APIRouter(prefix="/records", tags=["records"])
settings = get_settings()


@router.get("")
def list_records(
    user_id: Annotated[str | None, Query(description="Filter by archived user id")] = None,
    date: Annotated[
        str | None,
        Query(pattern=r"^\d{4}-\d{2}-\d{2}$", description="Filter by local day, for example 2026-05-23"),
    ] = None,
    category: Annotated[str | None, Query(description="Filter by record category")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict[str, object]:
    items = list_archived_records(
        user_id=user_id,
        date=date,
        category=category,
        limit=limit,
        offset=offset,
    )
    return {"items": items, "count": len(items)}


@router.get("/audio")
def get_record_audio(
    path: Annotated[str, Query(description="Absolute or archive-relative audio path returned by records/stream APIs")],
) -> FileResponse:
    audio_path = _resolve_archive_audio_path(path)
    media_type = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
    return FileResponse(audio_path, media_type=media_type, filename=audio_path.name)


def _resolve_archive_audio_path(path: str) -> Path:
    archive_root = settings.archive_dir.resolve()
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = archive_root / candidate
    candidate = candidate.resolve()
    try:
        candidate.relative_to(archive_root)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Audio path is outside archive directory") from exc
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Audio file not found")
    return candidate
