from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.archive import archive_file_record
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
    )
    metadata = json.loads(Path(paths["json_path"]).read_text(encoding="utf-8"))
    assert metadata["user_id"] == "amadeus-user"
    assert "amadeus-user" in Path(paths["json_path"]).parts

