"""
app/core/asr/router.py
───────────────────────
ModelRouter dispatches audio to one or more ASR engines and merges results.

Single engine  →  pass-through, return ASRResult directly.
Multi engine   →  run all engines concurrently, merge results by strategy.

Merge strategies
────────────────
first   : Return the result of the first engine in the list (others run for
          logging / comparison but their output is discarded from the primary
          transcript).
vote    : Majority-vote at segment level (WER-style alignment then vote on
          each word; falls back to "first" when engines disagree equally).
concat  : Concatenate all results labelled by engine name (useful for
          comparing outputs side-by-side).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from app.core.asr.base import ASRResult, EngineOptions
from app.core.model_manager import ModelManager

logger = logging.getLogger(__name__)

MergeStrategy = Literal["first", "vote", "concat"]


class ModelRouter:
    """
    Stateless router: pass in a ModelManager, call run().

    Parameters
    ──────────
    manager        : ModelManager singleton.
    engines        : Ordered list of engine names to use.
    merge_strategy : How to combine results when len(engines) > 1.
    """

    def __init__(
        self,
        manager: ModelManager,
        engines: list[str],
        merge_strategy: MergeStrategy = "first",
    ) -> None:
        if not engines:
            raise ValueError("At least one engine must be specified.")
        self._manager = manager
        self._engines = engines
        self._merge = merge_strategy

    # ── Public API ────────────────────────────────────────────────────────────

    async def run(
        self,
        audio_bytes: bytes,
        options: EngineOptions | None = None,
    ) -> ASRResult:
        """
        Transcribe `audio_bytes` using the configured engine(s).

        If a single engine is configured the result is returned as-is.
        If multiple engines are configured they run concurrently and their
        results are merged according to `merge_strategy`.
        """
        if len(self._engines) == 1:
            engine = await self._manager.get_engine(self._engines[0])
            return await engine.transcribe(audio_bytes, options)

        # Multi-engine: run concurrently
        tasks = [
            self._safe_transcribe(name, audio_bytes, options)
            for name in self._engines
        ]
        results: list[ASRResult | None] = await asyncio.gather(*tasks)

        # Filter out failed results
        valid: list[ASRResult] = [r for r in results if r is not None]
        if not valid:
            raise RuntimeError(
                f"All ASR engines failed: {self._engines}"
            )

        return self._merge_results(valid)

    # ── Internal helpers ──────────────────────────────────────────────────────

    async def _safe_transcribe(
        self,
        engine_name: str,
        audio_bytes: bytes,
        options: EngineOptions | None,
    ) -> ASRResult | None:
        """Catch per-engine errors so one failure doesn't abort the whole run."""
        try:
            engine = await self._manager.get_engine(engine_name)
            result = await engine.transcribe(audio_bytes, options)
            logger.info("Engine '%s' returned %d chars.", engine_name, len(result.full_text))
            return result
        except Exception as exc:
            logger.error("Engine '%s' failed: %s", engine_name, exc, exc_info=True)
            return None

    def _merge_results(self, results: list[ASRResult]) -> ASRResult:
        """Apply the configured merge strategy."""
        if self._merge == "first":
            return self._merge_first(results)
        elif self._merge == "vote":
            return self._merge_vote(results)
        elif self._merge == "concat":
            return self._merge_concat(results)
        else:
            return self._merge_first(results)

    @staticmethod
    def _merge_first(results: list[ASRResult]) -> ASRResult:
        """Return the first result; attach all raw outputs for inspection."""
        primary = results[0]
        primary.raw["all_engines"] = {
            r.engine_name: {"full_text": r.full_text, "confidence": r.confidence}
            for r in results
        }
        primary.engine_name = f"{primary.engine_name}+{len(results)-1}_others"
        return primary

    @staticmethod
    def _merge_vote(results: list[ASRResult]) -> ASRResult:
        """
        Simple majority-vote on full text tokens.

        For n engines we split each full_text into tokens, align by position
        and pick the most common token at each slot.  Falls back to `first`
        if no clear majority.
        """
        tokenised = [r.full_text.split() for r in results]
        max_len = max(len(t) for t in tokenised)

        voted_tokens: list[str] = []
        for i in range(max_len):
            candidates: list[str] = []
            for tokens in tokenised:
                if i < len(tokens):
                    candidates.append(tokens[i])
            if not candidates:
                continue
            # Majority token
            from collections import Counter
            winner, count = Counter(candidates).most_common(1)[0]
            if count >= (len(results) // 2 + 1) or len(results) == 2:
                voted_tokens.append(winner)
            else:
                # No clear majority → use first engine's token
                voted_tokens.append(tokenised[0][i] if i < len(tokenised[0]) else "")

        full_text = " ".join(voted_tokens).strip()
        avg_conf = _avg_confidence(results)

        return ASRResult(
            full_text=full_text,
            segments=results[0].segments,  # use segments from primary
            language=results[0].language,
            engine_name="vote:" + "+".join(r.engine_name for r in results),
            confidence=avg_conf,
            raw={
                "strategy": "vote",
                "engines": {r.engine_name: r.full_text for r in results},
            },
        )

    @staticmethod
    def _merge_concat(results: list[ASRResult]) -> ASRResult:
        """Concatenate outputs from all engines, labelled by engine name."""
        parts: list[str] = []
        for r in results:
            parts.append(f"[{r.engine_name}] {r.full_text}")

        return ASRResult(
            full_text="\n".join(parts),
            segments=[],
            language=results[0].language,
            engine_name="concat:" + "+".join(r.engine_name for r in results),
            confidence=_avg_confidence(results),
            raw={
                "strategy": "concat",
                "engines": {r.engine_name: r.full_text for r in results},
            },
        )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _avg_confidence(results: list[ASRResult]) -> float | None:
    confs = [r.confidence for r in results if r.confidence is not None]
    if not confs:
        return None
    return round(sum(confs) / len(confs), 4)