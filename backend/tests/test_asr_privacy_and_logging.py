from __future__ import annotations

from types import SimpleNamespace
import pytest

from app.api.v1.transcribe import should_archive_debug_data
from app.core.llm import log_asr_ai_polish_result
from app.core.streaming.session import StreamConfig
from app.schemas.transcribe import TranscribeOptions


def test_server_debug_archive_is_opt_in_by_default() -> None:
    assert should_archive_debug_data(TranscribeOptions()) is False
    assert should_archive_debug_data(TranscribeOptions(allow_server_data_collection=False)) is False
    assert should_archive_debug_data(TranscribeOptions(allow_server_data_collection=True)) is True
    assert StreamConfig().archive is False


def test_ai_polish_result_is_written_to_backend_log(caplog: pytest.LogCaptureFixture) -> None:
    outputs = SimpleNamespace(polish=SimpleNamespace(text='润色后的最终结果'))
    with caplog.at_level('INFO', logger='app.core.llm'):
        log_asr_ai_polish_result('task-log-test', outputs)
    assert 'task-log-test' in caplog.text
    assert '润色后的最终结果' in caplog.text
