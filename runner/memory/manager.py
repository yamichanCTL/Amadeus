"""
Memory Manager — coordinates temporary and permanent memory operations.

Provides a unified interface for the orchestrator to interact with
the memory subsystem.
"""

from __future__ import annotations

from typing import Any

from runner.memory.temporary import (
    read_recent_memories,
    write_agent_run,
    write_permanent_memory,
    write_temporary_memory,
)


class MemoryManager:
    """Coordinates memory writes and reads.

    In phase 1, this is a lightweight coordinator over the JSONL files.
    """

    def record_task_result(
        self,
        task: str,
        agent_name: str,
        success: bool,
        summary: str,
        duration_seconds: float,
        confidence: float = 1.0,
        ttl: str | None = None,
        retention: str = "temporary",
        **extra: Any,
    ) -> None:
        """Record a task execution result in temporary memory."""
        write_temporary_memory(
            {
                "source": "orchestrator",
                "summary": f"[{agent_name}] {'OK' if success else 'FAIL'}: {summary[:200]}",
                "metadata": {
                    "task": task[:300],
                    "agent_name": agent_name,
                    "success": success,
                    "duration_seconds": duration_seconds,
                    **extra,
                },
                "confidence": confidence,
                "ttl": ttl,
                "retention": retention,
            }
        )
        write_agent_run(
            agent_name=agent_name,
            task=task,
            success=success,
            available=True,
            duration_seconds=duration_seconds,
            summary=summary,
            confidence=confidence,
            ttl=ttl,
            retention=retention,
        )

    def remember(self, source: str, summary: str, metadata: dict[str, Any] | None = None) -> None:
        """Store a fact in permanent memory."""
        write_permanent_memory(source=source, summary=summary, metadata=metadata)

    def recall(self, limit: int = 20) -> list[dict[str, Any]]:
        """Recall recent temporary memories."""
        return read_recent_memories(limit=limit)

    def record_agent_fallback(self, requested: str, reason: str) -> None:
        """Record that an agent was unavailable and fallback was used."""
        write_temporary_memory(
            {
                "source": "agent_router",
                "summary": f"Agent '{requested}' unavailable: {reason}. Used fallback.",
                "metadata": {
                    "requested_agent": requested,
                    "reason": reason,
                    "fallback_used": True,
                },
            }
        )
