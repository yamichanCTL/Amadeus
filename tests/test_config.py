"""
Tests for runner config constants and ensure_runtime_dirs().
"""

import os
import tempfile
from pathlib import Path
from unittest import mock

from runner.core.config import (
    COMPRESSION_MAX_SUMMARY_CHARS,
    DEFAULT_CWD,
    DEFAULT_TIMEOUT_SECONDS,
    LOG_FORMAT,
    LOGS_DIR,
    MAX_CAPTURE_CHARS,
    MEMORY_DIR,
    PROJECT_ROOT,
    RUNTIME_DIR,
    TTS_MAX_TEXT_LENGTH,
    WORKSPACE_BOUND,
    ensure_runtime_dirs,
)


class TestConfigConstants:
    """Verify key configuration values."""

    def test_project_root_is_absolute(self) -> None:
        assert PROJECT_ROOT.is_absolute()

    def test_project_root_exists(self) -> None:
        assert PROJECT_ROOT.exists()

    def test_runtime_dir_under_project_root(self) -> None:
        assert str(RUNTIME_DIR).startswith(str(PROJECT_ROOT))

    def test_logs_dir_under_runtime(self) -> None:
        assert str(LOGS_DIR).startswith(str(RUNTIME_DIR))

    def test_memory_dir_under_runtime(self) -> None:
        assert str(MEMORY_DIR).startswith(str(RUNTIME_DIR))

    def test_default_timeout_is_positive(self) -> None:
        assert DEFAULT_TIMEOUT_SECONDS > 0
        assert DEFAULT_TIMEOUT_SECONDS == 300

    def test_max_capture_chars_is_positive(self) -> None:
        assert MAX_CAPTURE_CHARS > 0
        assert MAX_CAPTURE_CHARS == 20000

    def test_tts_max_text_length_is_positive(self) -> None:
        assert TTS_MAX_TEXT_LENGTH > 0
        assert TTS_MAX_TEXT_LENGTH == 2000

    def test_compression_max_summary_chars_is_positive(self) -> None:
        assert COMPRESSION_MAX_SUMMARY_CHARS > 0
        assert COMPRESSION_MAX_SUMMARY_CHARS == 500

    def test_log_format_is_valid(self) -> None:
        assert LOG_FORMAT in ("json", "console")

    def test_workspace_bound_is_true(self) -> None:
        assert WORKSPACE_BOUND is True

    def test_default_cwd_is_project_root(self) -> None:
        assert DEFAULT_CWD == PROJECT_ROOT


class TestEnsureRuntimeDirs:
    """Tests for ensure_runtime_dirs()."""

    def test_ensure_runtime_dirs_creates_directories(self) -> None:
        """ensure_runtime_dirs should not raise and should create dirs."""
        # Does not raise when dirs already exist
        ensure_runtime_dirs()
        assert LOGS_DIR.exists()
        assert MEMORY_DIR.exists()

    def test_ensure_runtime_dirs_idempotent(self) -> None:
        """Calling twice should not fail."""
        ensure_runtime_dirs()
        ensure_runtime_dirs()  # second call should succeed

    @mock.patch.object(Path, "mkdir")
    def test_ensure_runtime_dirs_calls_mkdir_with_correct_args(
        self, mock_mkdir: mock.MagicMock,
    ) -> None:
        """Verify mkdir is called with parents=True, exist_ok=True."""
        ensure_runtime_dirs()
        calls = mock_mkdir.call_args_list
        for call in calls:
            assert call[1].get("parents") is True
            assert call[1].get("exist_ok") is True
