"""Lazy FunASR CT-Transformer punctuation restoration."""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()
_model: Any = None
_model_lock = threading.Lock()


def _load_model() -> Any:
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        try:
            from funasr import AutoModel
        except ImportError as exc:
            raise RuntimeError(
                "标点恢复需要 FunASR，请安装项目的 sensevoice/punctuation 依赖。"
            ) from exc
        logger.info("Loading punctuation model %s on %s", settings.punctuation_model, settings.punctuation_device)
        _model = AutoModel(
            model=settings.punctuation_model,
            device=settings.punctuation_device,
            disable_update=True,
        )
        return _model


def _restore_sync(text: str) -> str:
    result = _load_model().generate(input=text)
    if isinstance(result, list) and result:
        value = result[0]
        if isinstance(value, dict):
            restored = str(value.get("text") or "").strip()
            if restored:
                return restored
    raise RuntimeError("标点模型未返回有效文本")


async def restore_punctuation(text: str, language: str | None = None) -> str:
    """
    Restore punctuation in `text`.

    Parameters
    ──────────
    text     : Raw ASR output (no punctuation).
    language : BCP-47 language hint.

    Returns
    ───────
    Text with punctuation added.

    The model is loaded once and inference is moved off the event loop.  FunASR
    downloads ``ct-punc`` on first use when it is not already in its cache.
    """
    clean = text.strip()
    if not clean:
        return clean
    return await asyncio.to_thread(_restore_sync, clean)
