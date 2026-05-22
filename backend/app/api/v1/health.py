"""
app/api/v1/health.py
─────────────────────
Health and readiness probes.

GET /v1/health         – liveness  (always 200 if process is alive)
GET /v1/health/ready   – readiness (200 if DB + at least one engine reachable)
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, status
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends

from app.db.session import get_db
from app.dependencies import Manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/health", tags=["health"])

_START_TIME = time.time()


# ── GET /v1/health ─────────────────────────────────────────────────────────────

@router.get("", summary="Liveness probe")
async def liveness() -> dict:
    """
    Returns 200 as long as the FastAPI process is running.
    Used by container orchestrators (Docker, k8s) to detect crashes.
    """
    return {
        "status": "ok",
        "uptime_sec": round(time.time() - _START_TIME, 1),
    }


# ── GET /v1/health/ready ───────────────────────────────────────────────────────

@router.get("/ready", summary="Readiness probe")
async def readiness(
    manager: Manager,
    db: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """
    Returns 200 when the service is ready to accept requests:
    - Database connection works.
    - At least one ASR engine is registered (not necessarily loaded).

    Returns 503 if any check fails.
    """
    checks: dict[str, str] = {}
    healthy = True

    # ── DB check ──────────────────────────────────────────────────────────────
    try:
        await db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as exc:
        checks["database"] = f"error: {exc}"
        healthy = False

    # ── Engine registry check ─────────────────────────────────────────────────
    try:
        engines = manager.list_engines()
        loaded = [e["engine"] for e in engines if e.get("is_loaded")]
        checks["engines_registered"] = str(len(engines))
        checks["engines_loaded"] = str(len(loaded))
        if loaded:
            checks["engines_loaded_names"] = ", ".join(loaded)
    except Exception as exc:
        checks["engines"] = f"error: {exc}"
        healthy = False

    http_status = status.HTTP_200_OK if healthy else status.HTTP_503_SERVICE_UNAVAILABLE
    return JSONResponse(
        status_code=http_status,
        content={
            "status": "ok" if healthy else "degraded",
            "checks": checks,
        },
    )