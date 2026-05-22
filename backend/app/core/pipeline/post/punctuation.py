"""
app/core/pipeline/post/punctuation.py
──────────────────────────────────────
Punctuation restoration — reserved.

When ENABLE_PUNCTUATION=true this module will:
  - Pass the raw transcript through a punctuation model
    (e.g. deepmultilingualpunctuation or a custom CT2 model).
  - Return the text with proper sentence boundaries, commas, etc.

Current state: identity pass-through.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


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

    TODO: integrate deepmultilingualpunctuation when ENABLE_PUNCTUATION=true.
    """
    logger.debug("Punctuation: stub — returning text unchanged.")
    return text