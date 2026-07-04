from __future__ import annotations

import pytest

from app.core import llm
from app.schemas.llm import ArchiveSummaryRequest


@pytest.mark.asyncio
async def test_multi_chunk_summary_uses_streaming_provider_for_every_stage(monkeypatch) -> None:
    monkeypatch.setattr(llm, "_summary_transcript", lambda _request: ("archive", 2, 7, False))
    monkeypatch.setattr(llm, "_split_text", lambda _text, max_chars: ["chunk-1", "chunk-2"])
    calls: list[str] = []

    async def fake_stream(**kwargs):
        calls.append(kwargs["user_prompt"])
        yield "最终总结" if len(calls) == 3 else f"压缩-{len(calls)}"

    monkeypatch.setattr(llm, "_chat_completion_stream", fake_stream)
    request = ArchiveSummaryRequest(
        date="2026-07-04",
        model="demo",
        base_url="https://llm.test/v1",
        api_token="token",
    )

    events = [event async for event in llm.summarize_archive_stream(request)]

    assert len(calls) == 3
    assert [event["message"] for event in events if event["type"] == "status"] == [
        "压缩第 1/2 段记录",
        "已完成第 1/2 段压缩",
        "压缩第 2/2 段记录",
        "已完成第 2/2 段压缩",
        "大模型生成总结中",
    ]
    assert next(event for event in events if event["type"] == "delta")["text"] == "最终总结"
    assert next(event for event in events if event["type"] == "done")["result"]["summary"] == "最终总结"
