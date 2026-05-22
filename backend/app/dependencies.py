"""
app/dependencies.py
────────────────────
Reusable FastAPI `Depends()` factories.

  get_db            – async database session (per request)
  get_model_manager – ModelManager singleton
  get_current_user  – JWT auth (optional; routes may skip this dep)
  get_optional_user – Same but returns None if no token provided
  validate_audio    – Upload size / mime-type guard
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Depends, File, HTTPException, UploadFile, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt  # type: ignore[import]
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.core.model_manager import ModelManager, get_model_manager as _get_manager
from app.db.crud import get_user_by_username
from app.db.models import User
from app.db.session import get_db

logger = logging.getLogger(__name__)

# ── Re-export DB dep so routes import from one place ──────────────────────────
DbSession = Annotated[AsyncSession, Depends(get_db)]

# ── Settings dep ─────────────────────────────────────────────────────────────
def get_settings_dep() -> Settings:
    return get_settings()

AppSettings = Annotated[Settings, Depends(get_settings_dep)]


# ── Model manager dep ─────────────────────────────────────────────────────────
def _manager_dep() -> ModelManager:
    return _get_manager()

Manager = Annotated[ModelManager, Depends(_manager_dep)]


# ── JWT Auth ──────────────────────────────────────────────────────────────────

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    db: DbSession,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    settings: Settings = Depends(get_settings_dep),
) -> User:
    """
    Decode Bearer JWT and return the corresponding User row.
    Raises HTTP 401 if token is missing, invalid, or the user is inactive.
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials
    try:
        payload = jwt.decode(
            token, settings.secret_key, algorithms=[settings.algorithm]
        )
        username: str | None = payload.get("sub")
        if username is None:
            raise JWTError("Missing sub claim")
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Could not validate credentials: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    user = await get_user_by_username(db, username)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


async def get_optional_user(
    db: DbSession,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    settings: Settings = Depends(get_settings_dep),
) -> User | None:
    """
    Like get_current_user but returns None instead of raising 401.
    Use on routes that support both authenticated and anonymous access.
    """
    if credentials is None:
        return None
    try:
        return await get_current_user(db, credentials, settings)
    except HTTPException:
        return None


CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]


# ── Audio upload validation ───────────────────────────────────────────────────

ALLOWED_AUDIO_TYPES = {
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",       # mp3
    "audio/mp4",
    "audio/x-m4a",
    "audio/ogg",
    "audio/flac",
    "audio/webm",
    "video/mp4",        # video files with audio track
    "video/webm",
    "application/octet-stream",  # generic binary — allow and let soundfile decide
}


async def validate_audio_upload(
    file: UploadFile = File(...),
    settings: Settings = Depends(get_settings_dep),
) -> UploadFile:
    """
    Guard dependency for audio upload endpoints.

    Checks:
    - Content-Type is an audio/video MIME type (or octet-stream).
    - File size does not exceed MAX_UPLOAD_SIZE_MB.

    Returns the UploadFile unchanged so routes can continue reading it.
    """
    content_type = (file.content_type or "").lower().split(";")[0].strip()

    if content_type not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=(
                f"Unsupported file type: '{content_type}'. "
                f"Allowed: {sorted(ALLOWED_AUDIO_TYPES)}"
            ),
        )

    # Read a small header chunk to verify size limit without loading everything
    # (full size check happens after reading in the route handler)
    if file.size is not None and file.size > settings.max_upload_size_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"File too large: {file.size / 1_048_576:.1f} MB. "
                f"Limit: {settings.max_upload_size_mb} MB."
            ),
        )

    return file


ValidAudioFile = Annotated[UploadFile, Depends(validate_audio_upload)]