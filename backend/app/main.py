"""
app/main.py
────────────
FastAPI application factory.

Run in development:
    uvicorn app.main:app --reload --port 8000

Run in production:
    uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
    (keep workers=1 per GPU; scale horizontally with multiple containers)
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import structlog  # type: ignore[import]
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from app.api.router import api_router
from app.config import get_settings
from app.db.session import close_db, init_db

settings = get_settings()

# ── Structured logging setup ──────────────────────────────────────────────────

def _configure_logging() -> None:
    log_level = settings.app_log_level.upper()
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, log_level)
        ),
        logger_factory=structlog.PrintLoggerFactory(),
    )


_configure_logging()
logger = structlog.get_logger(__name__)


# ── Lifespan (startup / shutdown) ─────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # ── Startup ───────────────────────────────────────────────────────────────
    logger.info("Starting ASR backend", env=settings.app_env)

    # Create DB tables (idempotent; use Alembic for migrations in prod)
    await init_db()
    logger.info("Database initialised.")

    if settings.preload_default_engine:
        # Optional because large offline models can make CPU-only startup very slow.
        from app.core.model_manager import get_model_manager
        manager = get_model_manager()
        try:
            await manager.get_engine(settings.default_engine)
            logger.info("Default engine loaded.", engine=settings.default_engine)
        except Exception as exc:
            # Non-fatal: server starts even if the model files are not yet present
            logger.warning(
                "Could not pre-load default engine — model files may be missing.",
                engine=settings.default_engine,
                error=str(exc),
            )
    else:
        logger.info("Default engine preload skipped.", engine=settings.default_engine)

    yield  # ── running ─────────────────────────────────────────────────────

    # ── Shutdown ──────────────────────────────────────────────────────────────
    logger.info("Shutting down ASR backend …")
    from app.core.model_manager import get_model_manager as _mgr
    await _mgr().shutdown()
    await close_db()
    logger.info("Shutdown complete.")


# ── Application factory ────────────────────────────────────────────────────────

def create_app() -> FastAPI:
    app = FastAPI(
        title="ASR Backend",
        description=(
            "Offline-first Automatic Speech Recognition service.\n\n"
            "Supports multiple engines (FireRedASR2, Whisper, Vosk, Sherpa-onnx) with "
            "sync and async transcription, multi-engine parallel runs, "
            "and a pluggable pre/post processing pipeline."
        ),
        version="0.1.0",
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
        lifespan=lifespan,
    )

    # ── Middleware ─────────────────────────────────────────────────────────────
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_origin_regex=r"app://.*|file://.*",   # Electron production
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    # ── Request timing middleware ──────────────────────────────────────────────
    @app.middleware("http")
    async def add_process_time_header(request: Request, call_next):  # type: ignore
        start = time.perf_counter()
        response = await call_next(request)
        elapsed = time.perf_counter() - start
        response.headers["X-Process-Time"] = f"{elapsed:.4f}"
        return response

    # ── Global exception handler ───────────────────────────────────────────────
    @app.exception_handler(Exception)
    async def unhandled_exception_handler(
        request: Request, exc: Exception
    ) -> JSONResponse:
        logger.error(
            "Unhandled exception",
            path=request.url.path,
            method=request.method,
            error=str(exc),
            exc_info=True,
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "detail": "Internal server error.",
                "path": str(request.url.path),
            },
        )

    # ── Routes ────────────────────────────────────────────────────────────────
    app.include_router(api_router)

    # Root redirect to docs
    @app.get("/", include_in_schema=False)
    async def root() -> JSONResponse:
        return JSONResponse(
            {"message": "ASR Backend", "docs": "/docs", "health": "/v1/health"}
        )

    return app


# ── Module-level app instance (for uvicorn) ───────────────────────────────────
app: FastAPI = create_app()
