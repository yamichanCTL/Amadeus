"""
app/api/v1/auth.py
───────────────────
Minimal JWT auth endpoints.

POST /v1/auth/register   – create a new user account
POST /v1/auth/token      – exchange username/password for a Bearer JWT
GET  /v1/auth/me         – return the current authenticated user
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from jose import jwt  # type: ignore[import]
from passlib.context import CryptContext  # type: ignore[import]
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import crud
from app.db.session import get_db
from app.dependencies import CurrentUser
from app.schemas.task import Token, UserCreate, UserResponse

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()

_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _hash_password(plain: str) -> str:
    return _pwd_ctx.hash(plain)


def _verify_password(plain: str, hashed: str) -> bool:
    return _pwd_ctx.verify(plain, hashed)


def _create_access_token(subject: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(
        minutes=settings.access_token_expire_minutes
    )
    payload = {"sub": subject, "exp": expire}
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


# ── POST /v1/auth/register ────────────────────────────────────────────────────

@router.post(
    "/register",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new user",
)
async def register(
    body: UserCreate,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    existing = await crud.get_user_by_username(db, body.username)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Username '{body.username}' is already taken.",
        )
    user = await crud.create_user(db, body.username, _hash_password(body.password))
    await db.commit()
    return UserResponse.model_validate(user)


# ── POST /v1/auth/token ───────────────────────────────────────────────────────

@router.post(
    "/token",
    response_model=Token,
    summary="Obtain a Bearer JWT token",
)
async def login(
    form: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db),
) -> Token:
    """
    Standard OAuth2 password flow.  Send `username` + `password` as form data.
    Returns a Bearer token valid for `ACCESS_TOKEN_EXPIRE_MINUTES` minutes.
    """
    user = await crud.get_user_by_username(db, form.username)
    if not user or not _verify_password(form.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is disabled.",
        )
    return Token(access_token=_create_access_token(user.username))


# ── GET /v1/auth/me ───────────────────────────────────────────────────────────

@router.get("/me", response_model=UserResponse, summary="Get current user")
async def me(user: CurrentUser) -> UserResponse:
    return UserResponse.model_validate(user)