"""
Temporary Memory — JSONL-based short-term storage for agent run results.

In phase 1, this is a simple append-only JSONL file.
Each line is a JSON object representing one memory entry.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from runner.core.config import (
    AGENT_RUNS_FILE,
    MEMORY_DIR,
    PERMANENT_MEMORY_FILE,
    TEMPORARY_MEMORY_FILE,
    TIMINGS_FILE,
    ensure_runtime_dirs,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_temporary_memory(
    entry: dict[str, Any],
    filepath: Path = TEMPORARY_MEMORY_FILE,
) -> None:
    """Append a temporary memory entry to the JSONL file.

    Each entry should contain at minimum:
        - source: str — what generated this memory
        - timestamp: str — ISO-8601 timestamp
        - summary: str — human-readable summary
        - metadata: dict — additional structured data
        - confidence: float — 0.0-1.0 confidence score
        - ttl: str | None — time-to-live (ISO duration or None for permanent)
        - retention: str — retention policy ("temporary" | "permanent")
    """
    ensure_runtime_dirs()
    record = {
        "source": entry.get("source", "unknown"),
        "timestamp": entry.get("timestamp", _now_iso()),
        "summary": entry.get("summary", ""),
        "metadata": entry.get("metadata", {}),
        "confidence": entry.get("confidence", 1.0),
        "ttl": entry.get("ttl", None),
        "retention": entry.get("retention", "temporary"),
    }
    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_agent_run(
    agent_name: str,
    task: str,
    success: bool,
    available: bool,
    duration_seconds: float,
    summary: str = "",
    stdout_snippet: str = "",
    confidence: float = 1.0,
    ttl: str | None = None,
    retention: str = "temporary",
    **extra: Any,
) -> None:
    """Record an agent run in agent_runs.jsonl."""
    ensure_runtime_dirs()
    record = {
        "agent_name": agent_name,
        "task": task[:500],
        "success": success,
        "available": available,
        "duration_seconds": duration_seconds,
        "summary": summary[:500],
        "stdout_snippet": stdout_snippet[:300],
        "timestamp": _now_iso(),
        "confidence": confidence,
        "ttl": ttl,
        "retention": retention,
        **extra,
    }
    AGENT_RUNS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(AGENT_RUNS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_permanent_memory(
    source: str,
    summary: str,
    metadata: dict[str, Any] | None = None,
    confidence: float = 0.8,
    ttl: str | None = None,
    retention: str = "permanent",
) -> None:
    """Write an entry to permanent memory.

    Only call this for information that has long-term value.
    Sensitive information should be filtered before calling.
    """
    ensure_runtime_dirs()
    record = {
        "source": source,
        "timestamp": _now_iso(),
        "summary": summary[:1000],
        "metadata": metadata or {},
        "confidence": confidence,
        "ttl": ttl,
        "retention": retention,
    }
    PERMANENT_MEMORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(PERMANENT_MEMORY_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_timing(timing: dict) -> None:
    """Record a pipeline timing entry to timings.jsonl."""
    ensure_runtime_dirs()
    record = {
        "timestamp": _now_iso(),
        **timing,
    }
    TIMINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(TIMINGS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def read_recent_timings(limit: int = 20) -> list[dict[str, Any]]:
    """Read recent timing records."""
    if not TIMINGS_FILE.exists():
        return []
    entries: list[dict[str, Any]] = []
    with open(TIMINGS_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return entries[-limit:]


def read_recent_memories(
    filepath: Path = TEMPORARY_MEMORY_FILE,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Read the most recent memory entries (last N lines)."""
    if not filepath.exists():
        return []
    entries: list[dict[str, Any]] = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return entries[-limit:]
