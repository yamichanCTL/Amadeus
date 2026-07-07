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


def test_summary_transcript_accepts_date_range(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import app.core.archive as archive_module

    monkeypatch.setattr(archive_module.settings, "archive_dir", tmp_path)
    for day, text in (
        (datetime(2026, 7, 1, 9, 0, tzinfo=timezone.utc), "七月一号记录"),
        (datetime(2026, 7, 3, 10, 0, tzinfo=timezone.utc), "七月三号记录"),
        (datetime(2026, 7, 6, 11, 0, tzinfo=timezone.utc), "七月六号不应进入"),
    ):
        archive_module.archive_pcm_record(
            pcm_bytes=b"\x00\x00" * 1600,
            sample_rate=16_000,
            user_id="summary-range-user",
            category="实时转录",
            text=text,
            engine="mock",
            language="zh",
            started_at=day,
            ended_at=day,
            duration_sec=0.1,
        )

    transcript, source_count, _, truncated = build_summary_transcript(
        user_id="summary-range-user",
        date="2026-07-01",
        end_date="2026-07-05",
        category="实时转录",
        start_time="00:00",
        end_time="23:59",
        max_chars=24000,
    )

    assert source_count == 2
    assert "七月一号记录" in transcript
    assert "七月三号记录" in transcript
    assert "七月六号不应进入" not in transcript
    assert "[2026-07-01 " in transcript
    assert truncated is False
