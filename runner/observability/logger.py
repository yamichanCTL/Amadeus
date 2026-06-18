"""
Structured JSON logger for the asrapp runtime.

Uses structlog for machine-readable structured logging.
All agent execution traces go through this module.
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timezone

try:
    import structlog
except ImportError:
    structlog = None  # type: ignore[assignment]


def _build_logger() -> logging.Logger | object:
    """Build a structured or fallback logger."""
    if structlog is not None:
        structlog.configure(
            processors=[
                structlog.stdlib.filter_by_level,
                structlog.stdlib.add_logger_name,
                structlog.stdlib.add_log_level,
                structlog.stdlib.PositionalArgumentsFormatter(),
                structlog.processors.TimeStamper(fmt="iso", utc=True),
                structlog.processors.StackInfoRenderer(),
                structlog.processors.format_exc_info,
                structlog.processors.UnicodeDecoder(),
                structlog.dev.ConsoleRenderer()
                if sys.stderr.isatty()
                else structlog.processors.JSONRenderer(),
            ],
            context_class=dict,
            logger_factory=structlog.stdlib.LoggerFactory(),
            wrapper_class=structlog.stdlib.BoundLogger,
            cache_logger_on_first_use=True,
        )
        return structlog.get_logger("asrapp")
    else:
        # Fallback: plain stdlib logger
        logger = logging.getLogger("asrapp")
        logger.setLevel(logging.DEBUG)
        if not logger.handlers:
            h = logging.StreamHandler(sys.stderr)
            h.setFormatter(
                logging.Formatter(
                    "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
                    datefmt="%Y-%m-%dT%H:%M:%S",
                )
            )
            logger.addHandler(h)
        return logger


_logger: logging.Logger | object = _build_logger()


def get_logger() -> logging.Logger | object:
    """Return the configured asrapp logger."""
    return _logger


def log_agent_run(
    agent_name: str,
    task: str,
    success: bool,
    available: bool,
    duration_seconds: float,
    exit_code: int | None = None,
    summary: str = "",
    **extra: object,
) -> None:
    """Log a structured agent-run event."""
    entry = {
        "agent_name": agent_name,
        "task": task[:200],
        "success": success,
        "available": available,
        "duration_seconds": duration_seconds,
        "exit_code": exit_code,
        "summary": summary[:500],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **extra,
    }
    logger = _logger
    if structlog is not None:
        logger.info("agent_run", **entry)  # type: ignore[union-attr]
    else:
        entry["event"] = "agent_run"
        logger.info(entry)  # type: ignore[union-attr]


def log_orchestrator_run(
    input_text: str,
    agent_name: str,
    success: bool,
    total_duration: float,
    tts_text: str = "",
    **extra: object,
) -> None:
    """Log a full orchestrator invocation."""
    entry = {
        "input_text": input_text[:200],
        "agent_name": agent_name,
        "success": success,
        "total_duration_seconds": total_duration,
        "tts_text": tts_text[:200],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **extra,
    }
    logger = _logger
    if structlog is not None:
        logger.info("orchestrator_run", **entry)  # type: ignore[union-attr]
    else:
        entry["event"] = "orchestrator_run"
        logger.info(entry)  # type: ignore[union-attr]
