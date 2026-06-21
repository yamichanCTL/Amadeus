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
from typing import Any, AsyncGenerator

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
    logger.info("Starting Amadeus backend", env=settings.app_env)

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
    # ── Raise multipart part size limit ─────────────────────────────────────
    # Starlette hardcodes max_part_size=1 MiB in both Request._get_form()
    # AND MultiPartParser.__init__ default arguments.  Monkey-patch the
    # constructor to unconditionally use the app's upload limit instead,
    # because every framework caller passes the same 1 MiB constant.
    from starlette.formparsers import MultiPartParser

    _orig_init = MultiPartParser.__init__

    def _patched_init(
        self,
        *args: Any,
        max_part_size: int = 1024 * 1024,
        **kwargs: Any,
    ) -> None:
        _orig_init(
            self,
            *args,
            max_part_size=settings.max_upload_size_bytes,
            **kwargs,
        )

    MultiPartParser.__init__ = _patched_init  # type: ignore[method-assign]

    app = FastAPI(
        title="Amadeus Backend",
        description=(
            "Offline-first Automatic Speech Recognition service.\n\n"
            "Supports offline engines (FireRedASR2, SenseVoice, Whisper, Qwen3-ASR), "
            "native X-ASR streaming, hotword correction, and a pluggable pipeline."
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
        allow_origin_regex=(
            r"app://.*|file://.*|"
            r"https?://(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?|"
            r"https?://10\.\d+\.\d+\.\d+(:\d+)?|"
            r"https?://172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+(:\d+)?|"
            r"https?://192\.168\.\d+\.\d+(:\d+)?|"
            r"https?://\d{1,3}(\.\d{1,3}){3}(:\d+)?"
        ),
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
        response.headers["Server-Timing"] = f"app;dur={elapsed * 1000:.2f}"
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
            {"message": "Amadeus Backend", "docs": "/docs", "health": "/v1/health"}
        )

    return app


# ── Module-level app instance (for uvicorn) ───────────────────────────────────
app: FastAPI = create_app()
