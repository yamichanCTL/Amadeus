"""
Context Compressor — reduces long agent outputs to concise summaries.

The compressor is deliberately simple in phase 1:
- Truncates very long text to a manageable summary
- Extracts key information from structured agent results
- Does NOT use an LLM for compression (keeps it predictable and cheap)
"""

from __future__ import annotations

from runner.core.config import COMPRESSION_MAX_SUMMARY_CHARS


def compress_agent_result(
    stdout: str,
    stderr: str,
    summary: str,
    max_chars: int = COMPRESSION_MAX_SUMMARY_CHARS,
) -> str:
    """Compress an agent run result into a short summary.

    Strategy:
    1. If the agent-provided summary fits, use it as-is.
    2. Otherwise, combine the first line of stdout with a length indicator.
    3. If stderr has content, note it briefly.

    Args:
        stdout: Agent standard output.
        stderr: Agent standard error.
        summary: Agent-provided summary string.
        max_chars: Maximum characters in the compressed output.

    Returns:
        Compressed summary string.
    """
    parts: list[str] = []

    # Agent summary is usually the best high-level description
    if summary and len(summary) <= max_chars:
        return summary

    if summary:
        parts.append(summary[:max_chars // 2])

    # Add first meaningful line from stdout
    if stdout:
        first_line = stdout.strip().split("\n")[0][:200]
        if first_line:
            parts.append(f"Output: {first_line}")

    # Note errors if present
    if stderr:
        stderr_preview = stderr.strip().split("\n")[0][:100]
        if stderr_preview:
            parts.append(f"Errors: {stderr_preview}")

    # Add length indicators
    if stdout:
        parts.append(f"({len(stdout)} chars stdout)")
    if stderr:
        parts.append(f"({len(stderr)} chars stderr)")

    result = " | ".join(parts)
    if len(result) > max_chars:
        result = result[: max_chars - 3] + "..."

    return result


def compress_for_memory(text: str, max_chars: int = COMPRESSION_MAX_SUMMARY_CHARS) -> str:
    """Compress arbitrary text for storage in memory.

    Keeps the beginning and end, truncates the middle if needed.
    """
    text = text.strip()
    if len(text) <= max_chars:
        return text

    head_size = max_chars // 2
    tail_size = max_chars // 4
    return text[:head_size] + "\n...(truncated)...\n" + text[-tail_size:]
