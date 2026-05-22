"""
app/db/session.py
─────────────────
Async SQLAlchemy engine + session factory.
Call `init_db()` once at application startup.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings
from app.db.models import Base

settings = get_settings()

# ── Engine ─────────────────────────────────────────────────────────────────────
# connect_args={"check_same_thread": False} is required for SQLite only.
_connect_args: dict = (
    {"check_same_thread": False}
    if settings.database_url.startswith("sqlite")
    else {}
)

engine = create_async_engine(
    settings.database_url,
    echo=not settings.is_production,   # SQL log in dev
    connect_args=_connect_args,
    pool_pre_ping=True,
)

# ── Session factory ────────────────────────────────────────────────────────────
AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,   # avoid lazy-load errors after commit
    autoflush=False,
    autocommit=False,
)


# ── Initialisation ─────────────────────────────────────────────────────────────
async def init_db() -> None:
    """Create all tables (idempotent).  Use Alembic for migrations in prod."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def close_db() -> None:
    """Dispose connection pool on shutdown."""
    await engine.dispose()


# ── FastAPI dependency ─────────────────────────────────────────────────────────
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    Yield an async session per request; roll back on exception, close always.

    Usage in route:
        async def my_route(db: AsyncSession = Depends(get_db)):
            ...
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()