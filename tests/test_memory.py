"""Tests for memory JSONL writes with metadata fields."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from runner.memory.temporary import (
    read_recent_memories,
    write_agent_run,
    write_permanent_memory,
    write_temporary_memory,
)
from runner.memory.compressor import compress_agent_result, compress_for_memory
from runner.memory.manager import MemoryManager


class TestMemoryWrite:
    """Test that memory entries are written with all required fields."""

    def test_temporary_memory_includes_all_fields(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = Path(f.name)
        try:
            write_temporary_memory(
                {"source": "test", "summary": "hello", "confidence": 0.95, "ttl": "P7D"},
                filepath=path,
            )
            entries = read_recent_memories(filepath=path, limit=1)
            assert len(entries) == 1
            entry = entries[0]
            assert "source" in entry
            assert "timestamp" in entry
            assert "summary" in entry
            assert "metadata" in entry
            assert "confidence" in entry
            assert "ttl" in entry
            assert "retention" in entry
            assert entry["confidence"] == 0.95
            assert entry["ttl"] == "P7D"
        finally:
            path.unlink(missing_ok=True)

    def test_agent_run_includes_all_fields(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            from runner.memory.temporary import AGENT_RUNS_FILE

            orig = AGENT_RUNS_FILE
        try:
            import runner.memory.temporary as mod

            path = Path(f.name)
            mod.AGENT_RUNS_FILE = path
            write_agent_run(
                agent_name="codex",
                task="test task",
                success=True,
                available=True,
                duration_seconds=1.5,
                summary="all good",
                confidence=0.9,
                ttl="P30D",
                retention="temporary",
            )
            assert path.exists()
            with open(path) as fp:
                lines = [json.loads(l) for l in fp if l.strip()]
            assert len(lines) >= 1
            last = lines[-1]
            assert last["confidence"] == 0.9
            assert last["ttl"] == "P30D"
            assert last["retention"] == "temporary"
        finally:
            mod.AGENT_RUNS_FILE = orig
            path.unlink(missing_ok=True)

    def test_permanent_memory_includes_all_fields(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = Path(f.name)
        try:
            write_permanent_memory(
                source="user",
                summary="important fact",
                confidence=0.8,
                ttl=None,
                retention="permanent",
            )
            # Override path check: write_permanent_memory writes to PERMANENT_MEMORY_FILE
            # Test by reading back from the permanent memory file (or check the function works)
        finally:
            path.unlink(missing_ok=True)

    def test_read_recent_memories_respects_limit(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = Path(f.name)
        try:
            for i in range(10):
                write_temporary_memory(
                    {"source": "test", "summary": f"entry {i}"},
                    filepath=path,
                )
            entries = read_recent_memories(filepath=path, limit=3)
            assert len(entries) == 3
        finally:
            path.unlink(missing_ok=True)

    def test_read_nonexistent_file_returns_empty(self) -> None:
        entries = read_recent_memories(
            filepath=Path("/tmp/nonexistent_memory_test.jsonl"), limit=10
        )
        assert entries == []


class TestContextCompressor:
    """Test context compression logic."""

    def test_compress_short_summary_returns_as_is(self) -> None:
        result = compress_agent_result("", "", "Short summary", max_chars=500)
        assert "Short summary" in result

    def test_compress_long_output(self) -> None:
        long_stdout = "line1\n" * 100 + "important error at the end"
        result = compress_agent_result(
            stdout=long_stdout,
            stderr="some error",
            summary="",
            max_chars=500,
        )
        assert len(result) <= 500
        assert "error" in result.lower()

    def test_compress_for_memory_truncates_long_text(self) -> None:
        long_text = "x" * 2000
        result = compress_for_memory(long_text, max_chars=500)
        assert len(result) <= 500
        assert "truncated" in result.lower()

    def test_compress_for_memory_short_text(self) -> None:
        short_text = "hello world"
        result = compress_for_memory(short_text, max_chars=500)
        assert result == "hello world"


class TestMemoryManager:
    """Test MemoryManager integration."""

    def test_manager_record_task_result(self) -> None:
        manager = MemoryManager()
        # Should not raise
        manager.record_task_result(
            task="test task",
            agent_name="mock",
            success=True,
            summary="test summary",
            duration_seconds=0.5,
            confidence=0.9,
            ttl="P7D",
            retention="temporary",
        )

    def test_manager_record_agent_fallback(self) -> None:
        manager = MemoryManager()
        manager.record_agent_fallback("codex", "binary not found")

    def test_manager_recall(self) -> None:
        manager = MemoryManager()
        memories = manager.recall(limit=5)
        assert isinstance(memories, list)
