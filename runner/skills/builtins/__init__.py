"""
Built-in skills for asrapp.

Small, deterministic tools — NOT agent logic.
Security enforced at handler level: path restrictions, command allowlists.
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

from runner.core.config import PROJECT_ROOT
from runner.memory.temporary import write_temporary_memory
from runner.skills.base import SkillResult

logger = logging.getLogger("asrapp.skills.builtins")

# ── Security constants ───────────────────────────────────────────────────────
_SAFE_COMMANDS: set[str] = {
    "ls", "find", "cat", "head", "tail", "wc", "grep", "git",
    "echo", "date", "which", "pwd", "tree", "du", "df", "sort",
    "uniq", "cut", "tr", "awk", "sed", "xargs",
}

_DANGEROUS_PATTERNS: list[str] = [
    "rm -rf", "sudo", "mkfs", "dd if=", "chmod -R", "chown -R",
    "> /dev", "mkfs.", ":(){", "wget", "curl", "/etc/passwd",
    "/etc/shadow", "~/.ssh", "~/.gnupg",
]


def _is_path_safe(path: str) -> bool:
    """Check that a path is within the project root."""
    try:
        resolved = (PROJECT_ROOT / path).resolve()
        return resolved == PROJECT_ROOT or PROJECT_ROOT in resolved.parents
    except (ValueError, OSError):
        return False


def _is_command_safe(command: str) -> tuple[bool, str]:
    """Check if a shell command is on the allowlist and has no dangerous patterns."""
    cmd_parts = command.strip().split()
    if not cmd_parts:
        return False, "Empty command"

    base_cmd = os.path.basename(cmd_parts[0])
    if base_cmd not in _SAFE_COMMANDS:
        return False, f"Command not in allowlist: {base_cmd}"

    command_lower = command.lower()
    for pattern in _DANGEROUS_PATTERNS:
        if pattern.lower() in command_lower:
            return False, f"Dangerous pattern detected: {pattern}"

    return True, ""


# ── Built-in skill handlers ──────────────────────────────────────────────────


def _skill_get_project_tree(max_depth: int = 3, **kwargs: object) -> SkillResult:
    """Get the project file tree up to max_depth."""
    max_depth = min(int(max_depth), 5)

    # Use git if available (respects .gitignore)
    try:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
            capture_output=True, text=True, timeout=15,
            cwd=str(PROJECT_ROOT),
        )
        if result.returncode == 0 and result.stdout.strip():
            files = sorted(result.stdout.strip().split("\n"))
            # Filter by depth
            filtered = [f for f in files if f.count("/") < max_depth]
            # Format as tree
            output = _format_as_tree(filtered, max_depth)
            return SkillResult(
                skill="get_project_tree",
                success=True,
                output=output[:4000],
                metadata={"file_count": len(filtered), "max_depth": max_depth, "source": "git"},
            )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    # Fallback: os.walk
    lines: list[str] = []
    file_count = 0
    for root, dirs, files in os.walk(str(PROJECT_ROOT)):
        # Skip hidden and venv
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "__pycache__")]
        depth = root.replace(str(PROJECT_ROOT), "").count(os.sep)
        if depth >= max_depth:
            dirs.clear()
            continue
        for f in files:
            if not f.startswith("."):
                rel = os.path.relpath(os.path.join(root, f), str(PROJECT_ROOT))
                lines.append(rel)
                file_count += 1
                if file_count >= 200:
                    break
        if file_count >= 200:
            break

    return SkillResult(
        skill="get_project_tree",
        success=True,
        output="\n".join(sorted(lines)[:200])[:4000],
        metadata={"file_count": file_count, "max_depth": max_depth, "source": "walk"},
    )


def _skill_read_text_file(path: str, max_chars: int = 8000, **kwargs: object) -> SkillResult:
    """Read a text file within the project."""
    path = str(path).strip()
    if not path:
        return SkillResult(skill="read_text_file", success=False, error="path is required")

    if not _is_path_safe(path):
        return SkillResult(
            skill="read_text_file",
            success=False,
            error=f"Path outside project: {path}",
            permission_denied=True,
        )

    file_path = (PROJECT_ROOT / path).resolve()
    if not file_path.exists():
        return SkillResult(skill="read_text_file", success=False, error=f"File not found: {path}")
    if file_path.is_dir():
        return SkillResult(skill="read_text_file", success=False, error=f"Path is a directory: {path}")

    max_chars = min(int(max_chars), 20000)
    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
        truncated = len(content) > max_chars
        display = content[:max_chars]
        return SkillResult(
            skill="read_text_file",
            success=True,
            output=display,
            metadata={
                "path": str(file_path),
                "size": len(content),
                "truncated": truncated,
            },
        )
    except Exception as exc:
        return SkillResult(skill="read_text_file", success=False, error=str(exc))


def _skill_write_temporary_memory(
    summary: str,
    source: str = "skill",
    metadata: dict | None = None,
    **kwargs: object,
) -> SkillResult:
    """Write an entry to temporary memory."""
    if not summary or not str(summary).strip():
        return SkillResult(skill="write_temporary_memory", success=False, error="summary is required")

    try:
        write_temporary_memory(
            entry={
                "source": str(source),
                "summary": str(summary)[:1000],
                "metadata": metadata or {},
            }
        )
        return SkillResult(
            skill="write_temporary_memory",
            success=True,
            output=f"Memory written: {str(summary)[:200]}",
            metadata={"source": str(source)},
        )
    except Exception as exc:
        return SkillResult(skill="write_temporary_memory", success=False, error=str(exc))


def _skill_get_git_status(**kwargs: object) -> SkillResult:
    """Get the current git status (read-only)."""
    try:
        result = subprocess.run(
            ["git", "status", "--short"],
            capture_output=True, text=True, timeout=15,
            cwd=str(PROJECT_ROOT),
        )
        if result.returncode == 0:
            output = result.stdout.strip() or "(clean)"
            # Count changes
            lines = [l for l in result.stdout.split("\n") if l.strip()]
            modified = sum(1 for l in lines if l.strip() and not l.strip().startswith("??"))
            untracked = sum(1 for l in lines if l.strip().startswith("??"))
            return SkillResult(
                skill="get_git_status",
                success=True,
                output=output[:3000],
                metadata={
                    "modified": modified,
                    "untracked": untracked,
                    "total_changes": len(lines),
                },
            )
        else:
            return SkillResult(
                skill="get_git_status",
                success=False,
                error=result.stderr.strip()[:500],
            )
    except FileNotFoundError:
        return SkillResult(skill="get_git_status", success=False, error="git not found")
    except subprocess.TimeoutExpired:
        return SkillResult(skill="get_git_status", success=False, error="git status timed out")


def _skill_run_safe_command(command: str, timeout: int = 30, **kwargs: object) -> SkillResult:
    """Run a safe command from the allowlist within the project root."""
    command = str(command).strip()
    if not command:
        return SkillResult(skill="run_safe_command", success=False, error="command is required")

    is_safe, reason = _is_command_safe(command)
    if not is_safe:
        return SkillResult(
            skill="run_safe_command",
            success=False,
            error=reason,
            permission_denied=True,
        )

    timeout = min(int(timeout), 60)
    try:
        result = subprocess.run(
            command, shell=True,
            capture_output=True, text=True, timeout=timeout,
            cwd=str(PROJECT_ROOT),
        )
        output = (result.stdout or result.stderr or "(no output)")[:4000]
        return SkillResult(
            skill="run_safe_command",
            success=result.returncode == 0,
            output=output,
            metadata={
                "exit_code": result.returncode,
                "command": command[:200],
            },
        )
    except subprocess.TimeoutExpired:
        return SkillResult(skill="run_safe_command", success=False, error=f"Command timed out after {timeout}s")
    except Exception as exc:
        return SkillResult(skill="run_safe_command", success=False, error=str(exc))


# ── Helpers ──────────────────────────────────────────────────────────────────


def _format_as_tree(files: list[str], max_depth: int) -> str:
    """Format a flat file list as an indented tree."""
    tree: dict[str, dict] = {}
    for f in files:
        parts = f.split("/")
        node = tree
        for part in parts:
            node = node.setdefault(part, {})

    lines: list[str] = []

    def _walk(d: dict, prefix: str, depth: int) -> None:
        if depth > max_depth:
            return
        items = sorted(d.items())
        for i, (name, children) in enumerate(items):
            is_last = i == len(items) - 1
            connector = "└── " if is_last else "├── "
            lines.append(f"{prefix}{connector}{name}")
            if children:
                new_prefix = prefix + ("    " if is_last else "│   ")
                _walk(children, new_prefix, depth + 1)

    _walk(tree, "", 0)
    return "\n".join(lines)


def register_all(registry: object) -> None:
    """Register all built-in skills into the given SkillRegistry."""
    registry.register(
        "get_project_tree",
        _skill_get_project_tree,
        [],
        "Get project file structure as a tree, up to max_depth (default 3, max 5)",
    )
    registry.register(
        "read_text_file",
        _skill_read_text_file,
        ["path"],
        "Read a text file from within the project. Path must be inside project root.",
    )
    registry.register(
        "write_temporary_memory",
        _skill_write_temporary_memory,
        ["summary"],
        "Write a summary entry to temporary memory (JSONL).",
    )
    registry.register(
        "get_git_status",
        _skill_get_git_status,
        [],
        "Get current git status (read-only). Shows modified, untracked files.",
    )
    registry.register(
        "run_safe_command",
        _skill_run_safe_command,
        ["command"],
        "Run a safe command from the allowlist (ls, find, cat, git, etc.) within project root.",
    )
