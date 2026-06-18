"""
Central configuration for the asrapp agent runtime.

All paths, defaults, and feature flags are defined here.
"""

from __future__ import annotations

from pathlib import Path

# ── Project root (asrapp/ directory) ──────────────────────────────────────────
_PROJECT_ROOT = Path(__file__).resolve().parents[2]

PROJECT_ROOT: Path = _PROJECT_ROOT
"""Absolute path to the asrapp project root."""

# ── Runtime directories ───────────────────────────────────────────────────────
RUNTIME_DIR: Path = PROJECT_ROOT / ".runtime"
LOGS_DIR: Path = RUNTIME_DIR / "logs"
MEMORY_DIR: Path = RUNTIME_DIR / "memory"

# ── Memory files ──────────────────────────────────────────────────────────────
TEMPORARY_MEMORY_FILE: Path = MEMORY_DIR / "temporary.jsonl"
PERMANENT_MEMORY_FILE: Path = MEMORY_DIR / "permanent.jsonl"
AGENT_RUNS_FILE: Path = MEMORY_DIR / "agent_runs.jsonl"
TIMINGS_FILE: Path = MEMORY_DIR / "timings.jsonl"

# ── Agent defaults ────────────────────────────────────────────────────────────
DEFAULT_TIMEOUT_SECONDS: int = 300
MAX_CAPTURE_CHARS: int = 20000
"""Max characters to retain from agent stdout / stderr before truncation."""

DEFAULT_CWD: Path = PROJECT_ROOT
"""Default working directory for agent subprocesses."""

# ── TTS defaults ──────────────────────────────────────────────────────────────
TTS_MAX_TEXT_LENGTH: int = 2000
"""Max text length that TTS will attempt to vocalize."""

# ── Context compression ───────────────────────────────────────────────────────
COMPRESSION_MAX_SUMMARY_CHARS: int = 500
"""Max characters in a context-compressed summary."""

# ── Logging ───────────────────────────────────────────────────────────────────
LOG_FORMAT: str = "json"
"""Log output format: 'json' for structured, 'console' for human-readable."""

# ── Security ───────────────────────────────────────────────────────────────────
WORKSPACE_BOUND: bool = True
"""If True, agent execution is restricted to the project root and its children."""


def ensure_runtime_dirs() -> None:
    """Create runtime directories if they don't exist."""
    for d in (LOGS_DIR, MEMORY_DIR):
        d.mkdir(parents=True, exist_ok=True)
