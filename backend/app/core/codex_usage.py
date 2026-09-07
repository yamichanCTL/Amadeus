"""Application-only accounting. Never scrape the user's development sessions."""

from __future__ import annotations

from datetime import datetime, timezone

from app.db.models import CodexCall
from app.schemas.codex import CodexTurnResult, CodexUsage
from sqlalchemy import select

_FIELDS = {
    "input_tokens": "inputTokens",
    "cached_input_tokens": "cachedInputTokens",
    "output_tokens": "outputTokens",
    "reasoning_output_tokens": "reasoningOutputTokens",
    "total_tokens": "totalTokens",
}


def normalize_usage(value: dict | None) -> CodexUsage | None:
    if not isinstance(value, dict):
        return None
    values = {key: value.get(raw) for key, raw in _FIELDS.items()}
    if any(type(item) is not int or item < 0 for item in values.values()):
        return None
    if values["total_tokens"] != values["input_tokens"] + values["output_tokens"]:
        return None
    if values["cached_input_tokens"] > values["input_tokens"]:
        return None
    if values["reasoning_output_tokens"] > values["output_tokens"]:
        return None
    return CodexUsage(**values)


def usage_delta(current: CodexUsage | None, previous: CodexUsage | None) -> CodexUsage | None:
    if current is None:
        return None
    baseline = previous.model_dump() if previous else dict.fromkeys(_FIELDS, 0)
    values = {key: getattr(current, key) - baseline[key] for key in _FIELDS}
    return normalize_usage({_FIELDS[key]: value for key, value in values.items()})


class CodexLedger:
    def __init__(self, session_factory):
        self.session_factory = session_factory

    async def begin(self, result: CodexTurnResult, source: str) -> None:
        async with self.session_factory() as session:
            session.add(
                CodexCall(
                    id=result.call_id,
                    session_id=result.session_id,
                    model=result.model,
                    provider=result.provider,
                    effort=result.effort,
                    source=source,
                    status="running",
                    created_at=datetime.now(timezone.utc),
                )
            )
            await session.commit()

    async def finish(self, result: CodexTurnResult) -> None:
        async with self.session_factory() as session:
            row = await session.get(CodexCall, result.call_id)
            if row is None:
                raise RuntimeError("Codex accounting record missing")
            row.status = result.status
            row.model = result.model
            row.elapsed_sec = result.elapsed_sec
            row.error_code = result.error_code
            row.finished_at = datetime.now(timezone.utc)
            if result.usage:
                for key, value in result.usage.model_dump().items():
                    setattr(row, key, value)
            await session.commit()

    async def recover(self) -> None:
        from sqlalchemy import update

        async with self.session_factory() as session:
            await session.execute(
                update(CodexCall)
                .where(CodexCall.status == "running")
                .values(
                    status="interrupted",
                    finished_at=datetime.now(timezone.utc),
                    error_code="backend_restarted",
                )
            )
            await session.commit()

    async def summary(self, session_id: str | None = None, model: str | None = None) -> dict:
        from sqlalchemy import case, func

        query = select(
            CodexCall.model,
            CodexCall.provider,
            func.count().label("calls"),
            func.sum(case((CodexCall.total_tokens.is_(None), 1), else_=0)).label("missing_usage"),
            *(func.sum(getattr(CodexCall, key)).label(key) for key in _FIELDS),
        ).group_by(CodexCall.model, CodexCall.provider)
        if session_id:
            query = query.where(CodexCall.session_id == session_id)
        if model:
            query = query.where(CodexCall.model == model)
        async with self.session_factory() as session:
            groups = [dict(row) for row in (await session.execute(query)).mappings()]
        totals = {
            key: sum(row[key] or 0 for row in groups)
            for key in ("calls", "missing_usage", *_FIELDS)
        }
        return {
            "scope": "amadeus",
            "session_id": session_id,
            "model": model,
            "source": "Codex thread/tokenUsage/updated cumulative deltas",
            **totals,
            "complete": totals["missing_usage"] == 0,
            "models": groups,
            "cost": None,
            "remaining_quota": None,
            "note": (
                "仅本应用调用；缓存输入包含在输入中，推理输出包含在输出中。"
                "已知 token 小计不等于账单或账号剩余额度。"
            ),
        }
