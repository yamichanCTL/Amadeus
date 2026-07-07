"""
tests/conftest.py
──────────────────
Shared pytest fixtures.
"""

from __future__ import annotations

import asyncio
import io
import os
import wave
from collections.abc import AsyncGenerator
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.asr.base import ASRResult, BaseASREngine, EngineOptions, Segment
from app.db.models import Base


# ── Override settings for tests ───────────────────────────────────────────────
# Must happen BEFORE any app module that calls get_settings() is imported.

def _apply_test_env(tmp_dir: str) -> None:
    os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{tmp_dir}/test.db"
    os.environ["MODELS_DIR"] = f"{tmp_dir}/models"
    os.environ["AUDIO_UPLOAD_DIR"] = f"{tmp_dir}/uploads"
    os.environ["TRANSCRIPT_DIR"] = f"{tmp_dir}/transcripts"
    os.environ["ARCHIVE_DIR"] = f"{tmp_dir}/archive"
    os.environ["DEFAULT_ENGINE"] = "mock"
    os.environ["ENABLE_VAD"] = "false"
    os.environ["ENABLE_PUNCTUATION"] = "false"
    os.environ["ENABLE_DIARIZE"] = "false"
    # Clear lru_cache so next call picks up the new env vars
    from app.config import get_settings
    get_settings.cache_clear()


@pytest.fixture(scope="function", autouse=True)
def override_settings(tmp_path) -> None:
    """Re-apply env overrides for every test function and bust the settings cache."""
    _apply_test_env(str(tmp_path))
    # Also refresh module-level settings cached in archive.py (imported once)
    from app.config import get_settings
    try:
        import app.core.archive as _archive_mod
        _archive_mod.settings = get_settings()
    except Exception:
        pass
    try:
        import app.api.records as _records_mod
        _records_mod.settings = get_settings()
    except Exception:
        pass
    try:
        import app.core.inference_scheduler as _scheduler_mod
        _scheduler_mod._scheduler = None
    except Exception:
        pass
    yield
    get_settings.cache_clear()


# ── In-memory SQLite for tests ────────────────────────────────────────────────

@pytest_asyncio.fixture(scope="function")
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:", connect_args={"check_same_thread": False}
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session

    await engine.dispose()


# ── Mock ASR engine ───────────────────────────────────────────────────────────

class MockASREngine(BaseASREngine):
    """Deterministic mock engine that returns a fixed transcript."""

    ENGINE_NAME = "mock"

    def __init__(self, **kwargs: Any) -> None:
        # Instance variable (not class variable) to avoid shared state between instances
        self._loaded_flag = False

    @property
    def name(self) -> str:
        return self.ENGINE_NAME

    async def load(self) -> None:
        self._loaded_flag = True

    async def unload(self) -> None:
        self._loaded_flag = False

    @property
    def is_loaded(self) -> bool:
        return self._loaded_flag

    async def transcribe(
        self, audio_bytes: bytes, options: EngineOptions | None = None
    ) -> ASRResult:
        # Auto-load like real engines do
        if not self._loaded_flag:
            await self.load()
        return ASRResult(
            full_text="测试识别结果",
            segments=[Segment(start=0.0, end=1.0, text="测试识别结果", confidence=0.95)],
            language="zh",
            engine_name=self.name,
            confidence=0.95,
        )

    def info(self) -> dict[str, Any]:
        return {"engine": self.name, "is_loaded": self._loaded_flag, "model_name": "mock"}


@pytest.fixture(autouse=True)
def register_mock_engine() -> None:
    """Register the mock engine so tests don't require real model files."""
    from app.core.asr.registry import register_engine
    register_engine("mock", MockASREngine)


@pytest.fixture
def mock_manager() -> MagicMock:
    """Return a MagicMock ModelManager that uses the MockASREngine."""
    engine = MockASREngine()
    engine._loaded_flag = True   # pre-loaded

    manager = MagicMock()
    manager.get_engine = AsyncMock(return_value=engine)
    manager.list_engines = MagicMock(return_value=[engine.info()])
    manager.is_loaded = MagicMock(return_value=True)
    return manager


# ── FastAPI test app ──────────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def async_client(db_session: AsyncSession, mock_manager: MagicMock) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client with DB and manager overridden."""
    from app.db.session import get_db
    from app.dependencies import _manager_dep
    from app.main import create_app

    app = create_app()

    # Override DB: yield the test session directly
    async def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[_manager_dep] = lambda: mock_manager

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


# ── Audio helpers ─────────────────────────────────────────────────────────────

def make_wav_bytes(duration_sec: float = 1.0, sample_rate: int = 16_000) -> bytes:
    """Generate a silent WAV file of the given duration."""
    import io
    import wave
    n_samples = int(duration_sec * sample_rate)
    pcm = np.zeros(n_samples, dtype=np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()
