"""
Core data types for agent execution requests and results.

These types are used by all agent adapters and the orchestrator.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentRunRequest:
    """Request to execute a task via a CLI agent.

    Attributes:
        task: The natural-language task description.
        cwd: Working directory for the agent (defaults to project root).
        agent_name: Preferred agent name, or None for auto-selection.
        timeout_seconds: Max execution time in seconds.
        dry_run: If True, only check availability and return what would run.
        extra_args: Additional CLI arguments to pass to the agent binary.
        env: Extra environment variables for the subprocess.
    """

    task: str
    cwd: str | None = None
    agent_name: str | None = None
    timeout_seconds: int = 300
    dry_run: bool = False
    extra_args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.task.strip():
            raise ValueError("task must not be blank")


@dataclass
class AgentRunResult:
    """Structured result from a CLI agent execution.

    Attributes:
        agent_name: Which agent handled the request.
        success: True if the agent completed without error.
        available: True if the agent binary was found and usable.
        exit_code: Process exit code (None if unavailable).
        stdout: Captured standard output (truncated if very long).
        stderr: Captured standard error (truncated if very long).
        summary: Human-readable summary of what happened.
        started_at: ISO-8601 start timestamp.
        finished_at: ISO-8601 finish timestamp.
        duration_seconds: Wall-clock duration.
        command: The actual command that was executed (with task placeholders).
        artifacts: Paths to any output files created.
        dry_run: Whether this was a dry run.
    """

    agent_name: str
    success: bool = False
    available: bool = True
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    summary: str = ""
    started_at: str = ""
    finished_at: str = ""
    duration_seconds: float = 0.0
    command: list[str] = field(default_factory=list)
    artifacts: list[str] = field(default_factory=list)
    dry_run: bool = False


@dataclass
class PipelineTiming:
    """Per-stage latency measurements for a pipeline run.

    All durations in seconds. Captures every stage of the pipeline
    for observability and optimization.
    """

    # Input stage
    asr_duration: float = 0.0
    asr_engine: str = ""

    # Agent stage
    agent_duration: float = 0.0
    agent_name: str = ""
    agent_ttft: float = 0.0  # Time To First Token (for streaming LLMs)

    # Post-processing
    compress_duration: float = 0.0
    memory_write_duration: float = 0.0

    # TTS stage
    tts_duration: float = 0.0
    tts_provider: str = ""
    tts_sentence_count: int = 0
    tts_first_sentence_duration: float = 0.0  # Perceived latency

    # Totals
    total_duration: float = 0.0
    overhead_duration: float = 0.0  # Non-stage overhead

    input_text: str = ""
    output_audio_path: str = ""

    def to_dict(self) -> dict:
        return {
            "asr_duration": round(self.asr_duration, 3),
            "asr_engine": self.asr_engine,
            "agent_duration": round(self.agent_duration, 3),
            "agent_name": self.agent_name,
            "agent_ttft": round(self.agent_ttft, 3),
            "compress_duration": round(self.compress_duration, 3),
            "memory_write_duration": round(self.memory_write_duration, 3),
            "tts_duration": round(self.tts_duration, 3),
            "tts_provider": self.tts_provider,
            "tts_sentence_count": self.tts_sentence_count,
            "tts_first_sentence_duration": round(self.tts_first_sentence_duration, 3),
            "total_duration": round(self.total_duration, 3),
            "overhead_duration": round(self.overhead_duration, 3),
            "input_text": self.input_text[:100],
            "output_audio_path": self.output_audio_path,
        }
