"""
app/core/asr/registry.py
─────────────────────────
Central registry mapping engine name strings to their classes.

To add a new engine:
  1. Create `app/core/asr/engines/my_engine.py` implementing BaseASREngine.
  2. Import and register it here.
  3. The ModelManager picks it up automatically.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.core.asr.base import BaseASREngine

# Engine name → class (lazy imports to avoid loading heavy deps at startup)
_REGISTRY: dict[str, type] = {}


def _register_defaults() -> None:
    from app.core.asr.engines.fireredasr2 import FireRedASR2Engine
    from app.core.asr.engines.qwen3asr import Qwen3ASREngine
    from app.core.asr.engines.sensevoice import SenseVoiceEngine
    from app.core.asr.engines.whisper import WhisperEngine
    from app.core.asr.engines.x_asr import XASREngine

    _REGISTRY["fireredasr2"] = FireRedASR2Engine
    _REGISTRY["sensevoice"] = SenseVoiceEngine
    _REGISTRY["qwen3asr"] = Qwen3ASREngine
    _REGISTRY["whisper"] = WhisperEngine
    _REGISTRY["x-asr"] = XASREngine


# Populate on first import
_register_defaults()


def get_engine_class(name: str) -> type["BaseASREngine"]:
    """
    Return the engine class for `name`.
    Raises KeyError with a helpful message if not found.
    """
    cls = _REGISTRY.get(name.lower())
    if cls is None:
        available = ", ".join(sorted(_REGISTRY))
        raise KeyError(
            f"Unknown ASR engine '{name}'. Available engines: {available}"
        )
    return cls


def available_engines() -> list[str]:
    """Return a sorted list of all registered engine names."""
    return sorted(_REGISTRY.keys())


def register_engine(name: str, cls: type["BaseASREngine"]) -> None:
    """
    Register a custom engine at runtime.
    Useful for plugins or tests.
    """
    _REGISTRY[name.lower()] = cls
