"""
app/core/model_manager.py
──────────────────────────
Singleton that owns loaded engine instances.

Responsibilities
────────────────
- Instantiate engines with correct config on first use (lazy loading).
- Maintain a pool of live engine objects keyed by engine name.
- Support hot-swapping: unload old instance, load new one atomically.
- Provide thread-safe access (asyncio Lock per engine slot).
- Multiple engines can load concurrently; GPU cache is cleared before each load.

Usage
─────
    from app.core.model_manager import get_model_manager

    manager = get_model_manager()
    engine  = await manager.get_engine("whisper")
    result  = await engine.transcribe(audio_bytes)
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.config import get_settings
from app.core.asr.base import BaseASREngine
from app.core.asr.registry import available_engines, get_engine_class
from app.core.model_errors import ModelRuntimeError, classify_model_error

logger = logging.getLogger(__name__)
settings = get_settings()

def _get_gpu_memory_info() -> dict[str, Any]:
    """Return GPU memory info for all visible CUDA devices, or empty dict."""
    try:
        import torch  # type: ignore[import]
    except ImportError:
        return {}
    if not torch.cuda.is_available():
        return {}
    result: dict[str, Any] = {}
    for i in range(torch.cuda.device_count()):
        try:
            total = torch.cuda.get_device_properties(i).total_memory
            reserved = torch.cuda.memory_reserved(i)
            allocated = torch.cuda.memory_allocated(i)
            free = total - reserved
            result[f"cuda:{i}"] = {
                "total_mb": round(total / 1024 ** 2, 1),
                "reserved_mb": round(reserved / 1024 ** 2, 1),
                "allocated_mb": round(allocated / 1024 ** 2, 1),
                "free_mb": round(free / 1024 ** 2, 1),
            }
        except Exception:
            result[f"cuda:{i}"] = {"error": "unavailable"}
    return result


def _clear_gpu_cache() -> None:
    """Release unused cached GPU memory without affecting loaded tensors."""
    try:
        import torch
    except ImportError:
        return
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


class ModelManager:
    """
    Central manager for ASR engine instances.

    Engines are loaded lazily: the first call to `get_engine("x")` triggers
    `WhisperEngine.load()` (or equivalent).  Subsequent calls return the
    already-loaded instance.

    Different engines can load concurrently (each has its own asyncio.Lock).
    GPU out-of-memory is caught and surfaced as ModelRuntimeError, with
    automatic cache cleanup on failure.
    """

    def __init__(self) -> None:
        # engine_name → engine instance (None = not yet loaded)
        self._engines: dict[str, BaseASREngine] = {}
        # Per-engine lock to prevent concurrent load/unload races
        self._locks: dict[str, asyncio.Lock] = {
            name: asyncio.Lock() for name in available_engines()
        }
        # Extra kwargs passed to engine constructors (set via configure())
        self._engine_kwargs: dict[str, dict[str, Any]] = {}

    # ── Configuration ──────────────────────────────────────────────────────────

    def configure(self, engine_name: str, **kwargs: Any) -> None:
        """
        Set constructor kwargs for an engine before it is loaded.
        Call this before the first get_engine() for that engine.

        Example:
            manager.configure("whisper", model_size="large-v3", device="cuda")
        """
        self._engine_kwargs[engine_name] = kwargs
        # If already loaded with different options, mark for reload
        if engine_name in self._engines:
            logger.warning(
                "Engine '%s' is already loaded.  "
                "Call hot_swap() to reload with new config.",
                engine_name,
            )

    # ── Access ────────────────────────────────────────────────────────────────

    async def get_engine(self, name: str) -> BaseASREngine:
        """
        Return the loaded engine instance for `name`, loading it first if needed.
        Thread-safe: concurrent calls for the same engine wait on the lock.
        """
        name = name.lower()
        lock = self._locks.setdefault(name, asyncio.Lock())

        async with lock:
            if name not in self._engines or not self._engines[name].is_loaded:
                await self._load_engine(name)
            return self._engines[name]

    async def _load_engine(self, name: str) -> None:
        """Internal: instantiate + load engine. Must be called under per-engine lock.

        Multiple engines can load concurrently (each has its own lock).
        GPU cache is cleared before loading to maximize available memory.
        CUDA OOM is caught and surfaced as ModelRuntimeError.
        """
        cls = get_engine_class(name)
        kwargs = self._engine_kwargs.get(name, {})
        engine = cls(**kwargs)
        try:
            gpu_info = _get_gpu_memory_info()
            if gpu_info:
                loaded = [n for n, e in self._engines.items() if e.is_loaded]
                logger.info(
                    "Loading engine '%s' (already loaded: %s). GPU: %s",
                    name, loaded or 'none', gpu_info,
                )
            _clear_gpu_cache()
            await engine.load()
        except Exception as exc:
            failure = classify_model_error(exc, name)
            logger.exception("Engine '%s' failed to load: %s", name, failure.detail)
            _clear_gpu_cache()
            if failure is exc:
                raise
            raise failure from exc
        self._engines[name] = engine
        logger.info("Engine '%s' ready.", name)

    # ── Hot-swap ──────────────────────────────────────────────────────────────

    async def hot_swap(self, name: str, **kwargs: Any) -> None:
        """
        Unload the current instance of `name` and reload with new kwargs.

        This is the correct way to change model_size / device at runtime
        without restarting the server.
        """
        name = name.lower()
        lock = self._locks.setdefault(name, asyncio.Lock())

        async with lock:
            if name in self._engines:
                old_engine = self._engines[name]
                await old_engine.unload()
                del self._engines[name]
                # Free GPU memory from the unloaded engine before loading new one
                _clear_gpu_cache()
                logger.info("Engine '%s' unloaded for hot-swap.", name)

            if kwargs:
                self._engine_kwargs[name] = kwargs

            await self._load_engine(name)
            logger.info("Engine '%s' hot-swapped.", name)

    # ── Unload ────────────────────────────────────────────────────────────────

    async def unload_engine(self, name: str) -> None:
        """Unload a single engine and free its resources."""
        name = name.lower()
        if name in self._engines:
            async with self._locks.get(name, asyncio.Lock()):
                if name in self._engines:
                    await self._engines[name].unload()
                    del self._engines[name]
                    logger.info("Engine '%s' unloaded.", name)

    async def shutdown(self) -> None:
        """Unload all engines.  Call from FastAPI lifespan on_shutdown."""
        from app.core.inference_scheduler import shutdown_inference_scheduler

        await shutdown_inference_scheduler()
        for name in list(self._engines):
            await self.unload_engine(name)
        logger.info("All ASR engines unloaded.")

    # ── Introspection ─────────────────────────────────────────────────────────

    def get_gpu_memory_info(self) -> dict[str, Any]:
        """Return current GPU memory info for diagnostics."""
        return _get_gpu_memory_info()

    def list_engines(self) -> list[dict[str, Any]]:
        """Return metadata for all known engines (loaded or not)."""
        result: list[dict[str, Any]] = []
        for name in available_engines():
            if name in self._engines:
                info = self._engines[name].info()
            else:
                try:
                    cls = get_engine_class(name)
                    kwargs = self._engine_kwargs.get(name, {})
                    dummy = cls(**kwargs)
                    info = dummy.info()
                    info["is_loaded"] = False
                except Exception as exc:
                    info = {"engine": name, "is_loaded": False, "error": str(exc)}
            result.append(info)
        return result

    def is_loaded(self, name: str) -> bool:
        engine = self._engines.get(name.lower())
        return engine is not None and engine.is_loaded


# ── Singleton ─────────────────────────────────────────────────────────────────

_manager: ModelManager | None = None


def get_model_manager() -> ModelManager:
    """Return the application-wide ModelManager singleton."""
    global _manager
    if _manager is None:
        _manager = ModelManager()
        # Apply defaults from settings
        _manager.configure(
            "fireredasr2",
            model_name=settings.default_fireredasr2_model,
            model_dir=str(settings.fireredasr2_model_dir),
            device=settings.default_fireredasr2_device,
            asr_type=settings.fireredasr2_asr_type,
            beam_size=settings.fireredasr2_beam_size,
            batch_size=settings.fireredasr2_batch_size,
            return_timestamp=settings.fireredasr2_return_timestamp,
            use_half=settings.fireredasr2_use_half,
            src_path=(
                str(settings.fireredasr2_src_path)
                if settings.fireredasr2_src_path
                else None
            ),
        )
        _manager.configure(
            "whisper",
            model_size=settings.default_whisper_model,
            device=settings.default_whisper_device,
            compute_type=settings.default_whisper_compute_type,
        )
        _manager.configure(
            "sensevoice",
            model_dir=str(settings.sensevoice_model_dir),
            device=settings.default_sensevoice_device,
            src_path=str(settings.sensevoice_src_path) if settings.sensevoice_src_path else None,
            batch_size_s=settings.sensevoice_batch_size_s,
        )
        _manager.configure(
            "qwen3asr",
            model_name=settings.default_qwen3asr_model,
            model_dir=str(settings.qwen3asr_model_dir),
            device=settings.default_qwen3asr_device,
            torch_dtype=settings.qwen3asr_torch_dtype,
        )
        _manager.configure(
            "x-asr",
            model_name=settings.default_x_asr_model,
            model_dir=str(settings.x_asr_model_dir),
            provider=settings.default_x_asr_provider,
            num_threads=settings.x_asr_num_threads,
            text_format=settings.x_asr_text_format,
        )
    return _manager
