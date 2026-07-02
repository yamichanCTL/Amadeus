from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.archive import archive_file_record, build_summary_transcript
from app.schemas.transcribe import TranscribeOptions


def test_desktop_user_id_is_validated_and_kept_in_options() -> None:
    options = TranscribeOptions(engine="sensevoice", user_id="amadeus-user")
    assert options.user_id == "amadeus-user"
    with pytest.raises(ValidationError):
        TranscribeOptions(engine="sensevoice", user_id="x" * 129)


def test_archive_uses_desktop_user_id(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import app.core.archive as archive_module

    monkeypatch.setattr(archive_module.settings, "archive_dir", tmp_path)
    paths = archive_file_record(
        audio_bytes=b"RIFF-amadeus",
        suffix=".wav",
        user_id="amadeus-user",
        category="一段语音转写",
        text="好啊",
        engine="sensevoice",
        language="zh",
        duration_sec=0.5,
        llm_outputs={
            "polish": {
                "operation": "polish",
                "text": "润色后的归档文本",
                "model": "demo-model",
                "elapsed_sec": 0.1,
            }
        },
    )
    metadata = json.loads(Path(paths["json_path"]).read_text(encoding="utf-8"))
    assert metadata["user_id"] == "amadeus-user"
    assert metadata["llm_outputs"]["polish"]["text"] == "润色后的归档文本"
    assert metadata["labels"]["ai_polished"] == "润色后的归档文本"
    assert "amadeus-user" in Path(paths["json_path"]).parts


def test_summary_both_uses_only_time_and_preferred_labels(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import app.core.archive as archive_module

    monkeypatch.setattr(archive_module.settings, "archive_dir", tmp_path)
    def outputs(text: str) -> dict:
        return {
            "polish": {
                "operation": "polish",
                "text": text,
                "model": "demo-model",
                "elapsed_sec": 0.1,
            }
        }
    for category, raw, polished in (
        ("一段语音转写", "离线原始文本不能发送", "离线 AI 标签"),
        ("实时转录", "实时 ASR 标签", None),
    ):
        archive_file_record(
            audio_bytes=b"RIFF-amadeus",
            suffix=".wav",
            user_id="summary-user",
            category=category,
            text=raw,
            engine="sensevoice",
            language="zh",
            duration_sec=0.5,
            llm_outputs=outputs(polished) if polished else None,
        )
    archive_file_record(
        audio_bytes=b"RIFF-amadeus",
        suffix=".wav",
        user_id="summary-user",
        category="其他记录",
        text="没有润色结果的原始文本",
        engine="sensevoice",
        language="zh",
        duration_sec=0.5,
    )

    transcript, source_count, _, truncated = build_summary_transcript(
        user_id="summary-user",
        date=datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d"),
        category=None,
        start_time="00:00",
        end_time="23:59:59",
        max_chars=24000,
    )

    assert source_count == 2
    assert "离线 AI 标签" in transcript
    assert "实时 ASR 标签" in transcript
    assert "离线原始文本不能发送" not in transcript
    assert "没有润色结果的原始文本" not in transcript
    assert "demo-model" not in transcript
    assert "summary-user" not in transcript
    assert "[" in transcript and "]" in transcript
    assert truncated is False
