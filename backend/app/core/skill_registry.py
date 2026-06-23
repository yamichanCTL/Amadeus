"""
app/core/skill_registry.py
──────────────────────────
Central registry for agent skills.

Skills are named callables that the agent can invoke via [[agent_tool]] directives.
Each skill declares its name, description, parameters, and category.

Pattern: follows the same lazy-registration design as app/core/asr/registry.py.

Usage:
    from app.core.skill_registry import get_skill_registry

    registry = get_skill_registry()
    result = await registry.execute("tts", {"text": "Hello"})
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import sys
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from app.config import get_settings
from app.schemas.skill import SkillDefinition, SkillExecuteResult, SkillParameter

logger = logging.getLogger(__name__)

settings = get_settings()
PROJECT_ROOT = settings.project_root
FRONTEND_DESKTOP_DIR = settings.frontend_desktop_dir

SkillHandler = Callable[..., Awaitable[SkillExecuteResult]]


def _param(name: str, type_: str = "string", description: str = "", required: bool = False, default: Any = None) -> SkillParameter:
    return SkillParameter(name=name, type=type_, description=description, required=required, default=default)


# ── Skill implementations ──────────────────────────────────────────────────────

async def _skill_tts(**params: Any) -> SkillExecuteResult:
    """Synthesize speech from text using the configured TTS provider."""
    text = str(params.get("text", "")).strip()
    if not text:
        return SkillExecuteResult(skill="tts", success=False, error="text is required")

    voice = str(params.get("voice", "alloy"))
    speed = float(params.get("speed", 1.0))
    fmt = str(params.get("format", "mp3"))

    try:
        from app.core.llm import synthesize_speech
        from app.schemas.llm import LLMSpeechRequest

        # Read credentials from settings – same as the LLM route
        from app.config import get_settings
        settings = get_settings()

        # Use the agent TTS model or fall back to the main LLM model
        # In a real flow these come from the frontend; we expose defaults here
        # and the frontend can pass base_url/api_token/model via parameters.
        base_url = str(params.get("base_url", ""))
        api_token = str(params.get("api_token", ""))
        model = str(params.get("model", ""))

        if not base_url or not api_token:
            return SkillExecuteResult(
                skill="tts",
                success=False,
                error="TTS requires base_url and api_token parameters from the frontend settings",
            )

        request = LLMSpeechRequest(
            text=text,
            model=model or "tts-1",
            voice=voice,
            base_url=base_url,
            api_token=api_token,
            response_format=fmt,
            speed=speed,
        )
        content, media_type = await synthesize_speech(request)
        # We don't return the raw audio bytes via this text channel;
        # instead, the frontend calls the speech endpoint directly.
        return SkillExecuteResult(
            skill="tts",
            success=True,
            output=f"TTS synthesized {len(content)} bytes of {media_type} audio for: {text[:120]}",
            metadata={"bytes": len(content), "media_type": media_type, "voice": voice, "speed": speed},
        )
    except Exception as exc:
        logger.error("TTS skill failed: %s", exc)
        return SkillExecuteResult(skill="tts", success=False, error=str(exc))


async def _skill_shell(**params: Any) -> SkillExecuteResult:
    """Run a shell command inside the project workspace."""
    command = str(params.get("command", "")).strip()
    if not command:
        return SkillExecuteResult(skill="shell", success=False, error="command is required")

    cwd = PROJECT_ROOT
    if params.get("cwd"):
        custom_cwd = (PROJECT_ROOT / str(params["cwd"])).resolve()
        if PROJECT_ROOT in custom_cwd.parents or custom_cwd == PROJECT_ROOT:
            cwd = custom_cwd
        else:
            return SkillExecuteResult(skill="shell", success=False, error=f"cwd must be inside project: {PROJECT_ROOT}")

    timeout = min(int(params.get("timeout", 30)), 120)
    try:
        process = await asyncio.create_subprocess_shell(
            command,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        stdout_text = stdout.decode("utf-8", errors="replace")[-4000:]
        stderr_text = stderr.decode("utf-8", errors="replace")[-2000:]
        output = stdout_text or stderr_text or "(no output)"
        return SkillExecuteResult(
            skill="shell",
            success=process.returncode == 0,
            output=output.strip()[:4000],
            error=stderr_text.strip()[:1000] if process.returncode != 0 else None,
            metadata={"exit_code": process.returncode, "cwd": str(cwd), "timeout": timeout},
        )
    except asyncio.TimeoutError:
        return SkillExecuteResult(skill="shell", success=False, error=f"Command timed out after {timeout}s")
    except Exception as exc:
        return SkillExecuteResult(skill="shell", success=False, error=str(exc))


async def _skill_read_file(**params: Any) -> SkillExecuteResult:
    """Read a file's content from the project workspace."""
    path_str = str(params.get("path", "")).strip()
    if not path_str:
        return SkillExecuteResult(skill="read_file", success=False, error="path is required")

    file_path = (PROJECT_ROOT / path_str).resolve()
    if PROJECT_ROOT not in file_path.parents and file_path != PROJECT_ROOT:
        return SkillExecuteResult(skill="read_file", success=False, error=f"path must be inside project: {PROJECT_ROOT}")

    if not file_path.exists():
        return SkillExecuteResult(skill="read_file", success=False, error=f"File not found: {path_str}")

    if file_path.is_dir():
        return SkillExecuteResult(skill="read_file", success=False, error=f"Path is a directory: {path_str}")

    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
        max_chars = int(params.get("max_chars", 8000))
        truncated = len(content) > max_chars
        display = content[:max_chars]
        return SkillExecuteResult(
            skill="read_file",
            success=True,
            output=display,
            metadata={"path": str(file_path), "size": len(content), "truncated": truncated, "max_chars": max_chars},
        )
    except Exception as exc:
        return SkillExecuteResult(skill="read_file", success=False, error=str(exc))


async def _skill_write_file(**params: Any) -> SkillExecuteResult:
    """Write content to a file in the project workspace."""
    path_str = str(params.get("path", "")).strip()
    content = str(params.get("content", ""))
    if not path_str:
        return SkillExecuteResult(skill="write_file", success=False, error="path is required")

    file_path = (PROJECT_ROOT / path_str).resolve()
    if PROJECT_ROOT not in file_path.parents and file_path != PROJECT_ROOT:
        return SkillExecuteResult(skill="write_file", success=False, error=f"path must be inside project: {PROJECT_ROOT}")

    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding="utf-8")
        return SkillExecuteResult(
            skill="write_file",
            success=True,
            output=f"Wrote {len(content)} chars to {path_str}",
            metadata={"path": str(file_path), "size": len(content)},
        )
    except Exception as exc:
        return SkillExecuteResult(skill="write_file", success=False, error=str(exc))


async def _skill_list_dir(**params: Any) -> SkillExecuteResult:
    """List files in a directory within the project workspace."""
    path_str = str(params.get("path", ".")).strip() or "."
    file_path = (PROJECT_ROOT / path_str).resolve()
    if PROJECT_ROOT not in file_path.parents and file_path != PROJECT_ROOT:
        return SkillExecuteResult(skill="list_dir", success=False, error=f"path must be inside project: {PROJECT_ROOT}")

    if not file_path.exists():
        return SkillExecuteResult(skill="list_dir", success=False, error=f"Directory not found: {path_str}")

    if not file_path.is_dir():
        return SkillExecuteResult(skill="list_dir", success=False, error=f"Not a directory: {path_str}")

    try:
        items = sorted(file_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        max_items = int(params.get("max_items", 50))
        lines: list[str] = []
        for item in items[:max_items]:
            suffix = "/" if item.is_dir() else ""
            try:
                size = item.stat().st_size if item.is_file() else 0
                size_str = f" ({_format_size(size)})" if item.is_file() else ""
            except OSError:
                size_str = ""
            lines.append(f"  {item.name}{suffix}{size_str}")
        output = "\n".join(lines) or "(empty)"
        return SkillExecuteResult(
            skill="list_dir",
            success=True,
            output=f"{path_str}:\n{output}",
            metadata={"path": str(file_path), "count": min(len(items), max_items), "total": len(items)},
        )
    except Exception as exc:
        return SkillExecuteResult(skill="list_dir", success=False, error=str(exc))


async def _skill_git_clone(**params: Any) -> SkillExecuteResult:
    """Clone a git repository into the project workspace."""
    url = str(params.get("url", "")).strip()
    if not url:
        return SkillExecuteResult(skill="git_clone", success=False, error="url is required")
    # Safety: only allow http/https git URLs
    if not (url.startswith("https://") or url.startswith("http://") or url.startswith("git@")):
        return SkillExecuteResult(skill="git_clone", success=False, error="Only https:// and git@ URLs are allowed")

    target = str(params.get("target", ""))
    if not target:
        # Derive target from URL
        target = url.rstrip("/").split("/")[-1].replace(".git", "")

    target_path = (PROJECT_ROOT / target).resolve()
    if PROJECT_ROOT not in target_path.parents and target_path != PROJECT_ROOT:
        return SkillExecuteResult(skill="git_clone", success=False, error=f"target must be inside project: {PROJECT_ROOT}")

    if target_path.exists():
        return SkillExecuteResult(skill="git_clone", success=False, error=f"Target already exists: {target}")

    depth = int(params.get("depth", 1))
    branch = str(params.get("branch", ""))
    timeout = min(int(params.get("timeout", 180)), 600)

    try:
        cmd = ["git", "clone"]
        if depth > 0:
            cmd.extend(["--depth", str(depth)])
        if branch:
            cmd.extend(["--branch", branch])
        cmd.extend([url, str(target_path)])

        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(PROJECT_ROOT),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)

        if process.returncode == 0:
            return SkillExecuteResult(
                skill="git_clone",
                success=True,
                output=f"Cloned {url} → {target}",
                metadata={"url": url, "target": target, "depth": depth},
            )
        else:
            err = stderr.decode("utf-8", errors="replace")[-1000:]
            return SkillExecuteResult(skill="git_clone", success=False, error=err)
    except asyncio.TimeoutError:
        return SkillExecuteResult(skill="git_clone", success=False, error=f"Clone timed out after {timeout}s")
    except Exception as exc:
        return SkillExecuteResult(skill="git_clone", success=False, error=str(exc))


async def _skill_delegate_agent(**params: Any) -> SkillExecuteResult:
    """Delegate a coding task to an external agent CLI (codex, claude, claudecode)."""
    agent_name = str(params.get("agent", "codex")).lower()
    prompt = str(params.get("prompt", "")).strip()
    if not prompt:
        return SkillExecuteResult(skill="delegate_agent", success=False, error="prompt is required")
    if agent_name not in ("codex", "claude", "claudecode"):
        return SkillExecuteResult(skill="delegate_agent", success=False, error=f"Unsupported agent: {agent_name}")

    try:
        from app.core.agent import delegate_to_agent
        from app.schemas.agent import AgentDelegateRequest

        timeout = min(int(params.get("timeout", 240)), 900)
        request = AgentDelegateRequest(
            agent=agent_name,
            prompt=prompt[:6000],
            cwd=str(params.get("cwd", ".")),
            sandbox="workspace-write",
            timeout_sec=timeout,
        )
        result = await delegate_to_agent(request)
        final_text = (result.final_message or result.stdout or result.stderr or "").strip()[:3000]
        status_text = "超时" if result.timed_out else f"退出码 {result.exit_code}"
        return SkillExecuteResult(
            skill="delegate_agent",
            success=result.exit_code == 0 and not result.timed_out,
            output=f"[{agent_name}] {status_text}: {final_text or '无输出'}",
            error=result.stderr[:1000] if result.exit_code != 0 else None,
            metadata={
                "agent": agent_name,
                "exit_code": result.exit_code,
                "timed_out": result.timed_out,
                "elapsed_sec": result.elapsed_sec,
            },
        )
    except FileNotFoundError as exc:
        return SkillExecuteResult(skill="delegate_agent", success=False, error=str(exc))
    except Exception as exc:
        return SkillExecuteResult(skill="delegate_agent", success=False, error=str(exc))


async def _skill_download_model(**params: Any) -> SkillExecuteResult:
    """Download a model from HuggingFace or a URL into the models directory."""
    source = str(params.get("source", "")).strip()  # huggingface repo id or URL
    if not source:
        return SkillExecuteResult(skill="download_model", success=False, error="source is required (huggingface repo id or URL)")

    engine = str(params.get("engine", "unknown")).strip()

    from app.config import get_settings
    settings = get_settings()
    target_dir = settings.models_dir / engine / source.replace("/", "_")
    target_dir.mkdir(parents=True, exist_ok=True)

    # Try huggingface hub first, then git clone as fallback
    try:
        # Try using huggingface_hub if available
        import importlib
        if importlib.util.find_spec("huggingface_hub"):
            from huggingface_hub import snapshot_download
            downloaded = snapshot_download(
                repo_id=source,
                local_dir=str(target_dir),
                local_dir_use_symlinks=False,
            )
            return SkillExecuteResult(
                skill="download_model",
                success=True,
                output=f"Downloaded {source} → {target_dir}",
                metadata={"source": source, "target": str(target_dir), "method": "huggingface_hub"},
            )
    except Exception:
        pass

    # Fallback: git clone from huggingface
    hf_url = f"https://huggingface.co/{source}"
    result = await _skill_git_clone(url=hf_url, target=str(target_dir.relative_to(PROJECT_ROOT)), depth=1)
    result.skill = "download_model"
    return result


async def _skill_speak_frontend(**params: Any) -> SkillExecuteResult:
    """Signal the frontend to speak text via TTS (browser or server-side).
    This skill is a no-op on the backend; the frontend intercepts the tool call
    and handles speech locally.
    """
    text = str(params.get("text", "")).strip()
    if not text:
        return SkillExecuteResult(skill="speak", success=False, error="text is required")
    voice = str(params.get("voice", "alloy"))
    speed = float(params.get("speed", 1.0))
    return SkillExecuteResult(
        skill="speak",
        success=True,
        output=f"Speaking: {text[:120]}",
        metadata={"text": text, "voice": voice, "speed": speed, "handled_by": "frontend"},
    )


async def _skill_get_runtime_context(**params: Any) -> SkillExecuteResult:
    """Return the current runtime context snapshot. The frontend fills this in,
    but the backend provides a fallback summary.
    """
    from app.config import get_settings
    settings = get_settings()
    return SkillExecuteResult(
        skill="get_context",
        success=True,
        output=f"Backend running. Default engine: {settings.default_engine}. Models dir: {settings.models_dir}",
        metadata={
            "default_engine": settings.default_engine,
            "models_dir": str(settings.models_dir),
        },
    )


async def _skill_web_search(**params: Any) -> SkillExecuteResult:
    """Search the web using DuckDuckGo HTML (no API key required)."""
    query = str(params.get("query", "")).strip()
    if not query:
        return SkillExecuteResult(skill="web_search", success=False, error="query is required")

    max_results = min(int(params.get("max_results", 5)), 10)
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                "https://html.duckduckgo.com/html/",
                params={"q": query},
                headers={"User-Agent": "ASRAPP-Agent/0.1"},
                follow_redirects=True,
            )
            response.raise_for_status()
            html = response.text

        # Simple extraction of result snippets
        results: list[str] = []
        import re
        # Extract result snippets: <a class="result__snippet">...</a>
        snippets = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', html, re.DOTALL)
        titles = re.findall(r'class="result__title"[^>]*>.*?<a[^>]*>(.*?)</a>', html, re.DOTALL)
        urls = re.findall(r'class="result__title"[^>]*>.*?<a[^>]*href="([^"]*)"', html, re.DOTALL)

        for i in range(min(len(titles), max_results)):
            title = re.sub(r'<[^>]+>', '', titles[i]).strip()
            snippet = re.sub(r'<[^>]+>', '', snippets[i]).strip() if i < len(snippets) else ''
            url_clean = urls[i] if i < len(urls) else ''
            results.append(f"{i + 1}. {title}\n   {snippet}\n   {url_clean}")

        output = "\n\n".join(results) if results else f"No results found for: {query}"
        return SkillExecuteResult(
            skill="web_search",
            success=True,
            output=output[:4000],
            metadata={"query": query, "results_count": len(results)},
        )
    except Exception as exc:
        return SkillExecuteResult(skill="web_search", success=False, error=str(exc))


async def _skill_web_fetch(**params: Any) -> SkillExecuteResult:
    """Fetch and extract text content from a URL."""
    url = str(params.get("url", "")).strip()
    if not url:
        return SkillExecuteResult(skill="web_fetch", success=False, error="url is required")
    if not (url.startswith("https://") or url.startswith("http://")):
        return SkillExecuteResult(skill="web_fetch", success=False, error="Only http/https URLs are allowed")

    max_chars = min(int(params.get("max_chars", 4000)), 15000)
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                url,
                headers={"User-Agent": "ASRAPP-Agent/0.1"},
                follow_redirects=True,
            )
            response.raise_for_status()
            html = response.text

        # Basic HTML to text extraction
        import re
        # Remove scripts and styles
        text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)
        # Remove HTML tags
        text = re.sub(r'<[^>]+>', ' ', text)
        # Normalize whitespace
        text = re.sub(r'\s+', ' ', text).strip()
        # Truncate
        truncated = len(text) > max_chars
        display = text[:max_chars]

        return SkillExecuteResult(
            skill="web_fetch",
            success=True,
            output=display,
            metadata={"url": url, "size": len(text), "truncated": truncated, "status_code": response.status_code},
        )
    except Exception as exc:
        return SkillExecuteResult(skill="web_fetch", success=False, error=str(exc))


async def _skill_system_info(**params: Any) -> SkillExecuteResult:
    """Get system information: OS, CPU, memory, Python version, disk space."""
    try:
        import shutil as _shutil
        info = {
            "os": platform.system(),
            "os_release": platform.release(),
            "hostname": platform.node(),
            "python": sys.version.split()[0],
            "cpu_count": os.cpu_count(),
            "cwd": str(PROJECT_ROOT),
        }
        try:
            disk = _shutil.disk_usage(str(PROJECT_ROOT))
            info["disk_free_gb"] = round(disk.free / (1024**3), 1)
            info["disk_total_gb"] = round(disk.total / (1024**3), 1)
        except Exception:
            pass

        lines = [f"{k}: {v}" for k, v in info.items()]
        return SkillExecuteResult(
            skill="system_info",
            success=True,
            output="\n".join(lines),
            metadata=info,
        )
    except Exception as exc:
        return SkillExecuteResult(skill="system_info", success=False, error=str(exc))


async def _skill_run_python(**params: Any) -> SkillExecuteResult:
    """Run a Python expression/script safely in the backend process."""
    code = str(params.get("code", "")).strip()
    if not code:
        return SkillExecuteResult(skill="run_python", success=False, error="code is required")

    # Safety: block dangerous builtins
    dangerous = {"__import__", "eval", "exec", "compile", "open", "os", "subprocess", "shutil", "importlib"}
    for word in dangerous:
        if word in code:
            return SkillExecuteResult(skill="run_python", success=False, error=f"Dangerous keyword blocked: {word}")

    try:
        # Restricted execution with limited globals
        safe_globals: dict[str, Any] = {
            "__builtins__": {
                "abs": abs, "all": all, "any": any, "bin": bin, "bool": bool,
                "chr": chr, "dict": dict, "enumerate": enumerate, "filter": filter,
                "float": float, "format": format, "frozenset": frozenset,
                "hex": hex, "int": int, "isinstance": isinstance,
                "len": len, "list": list, "map": map, "max": max, "min": min,
                "oct": oct, "ord": ord, "pow": pow, "print": print,
                "range": range, "repr": repr, "reversed": reversed,
                "round": round, "set": set, "slice": slice, "sorted": sorted,
                "str": str, "sum": sum, "tuple": tuple, "type": type, "zip": zip,
                "divmod": divmod, "hash": hash, "id": id,
                "complex": complex, "bytes": bytes, "bytearray": bytearray,
            },
            "__name__": "__skill__",
            "json": json,
            "math": __import__("math"),
            "datetime": __import__("datetime"),
            "re": __import__("re"),
            "collections": __import__("collections"),
            "itertools": __import__("itertools"),
        }
        import textwrap
        dedented = textwrap.dedent(code)
        # Capture stdout
        import io
        buf = io.StringIO()
        safe_globals["__builtins__"]["print"] = lambda *a, **kw: print(*a, **kw, file=buf)

        result = eval(dedented, safe_globals, {})
        printed = buf.getvalue()
        output = printed + (repr(result) if result is not None else "")
        if not output.strip():
            output = "(no output)"

        return SkillExecuteResult(
            skill="run_python",
            success=True,
            output=output.strip()[:3000],
            metadata={},
        )
    except Exception as exc:
        return SkillExecuteResult(skill="run_python", success=False, error=f"{type(exc).__name__}: {exc}")


async def _skill_self_improve(**params: Any) -> SkillExecuteResult:
    """Structured agent self-improvement loop: delegate → verify → report.

    This is the key skill that makes the agent capable of modifying its own system.
    Flow:
    1. Delegate coding task to external agent (codex/claude)
    2. Read back changed files to verify
    3. Run build check
    4. Report consolidated result
    """
    task = str(params.get("task", "")).strip()
    if not task:
        return SkillExecuteResult(skill="self_improve", success=False, error="task is required")

    agent_name = str(params.get("agent", "codex")).lower()
    if agent_name not in ("codex", "claude", "claudecode"):
        return SkillExecuteResult(skill="self_improve", success=False, error=f"Unsupported agent: {agent_name}")

    timeout = min(int(params.get("timeout", 300)), 900)

    try:
        from app.core.agent import delegate_to_agent
        from app.schemas.agent import AgentDelegateRequest

        # Step 1: Delegate the coding task
        coding_prompt = (
            f"You are improving the ASRAPP project at {PROJECT_ROOT}.\n\n"
            f"Task: {task}\n\n"
            f"Rules:\n"
            f"1. Make the minimal changes needed to accomplish the task\n"
            f"2. After making changes, verify by running the build checks:\n"
            f"   - Frontend: cd {FRONTEND_DESKTOP_DIR} && npx tsc --noEmit\n"
            f"   - Backend: cd {PROJECT_ROOT} && .venv/bin/python -m compileall -q backend/app\n"
            f"3. Report what files you changed and what you accomplished\n"
        )

        request = AgentDelegateRequest(
            agent=agent_name,
            prompt=coding_prompt[:6000],
            cwd=".",
            sandbox="workspace-write",
            timeout_sec=timeout,
        )
        delegate_result = await delegate_to_agent(request)

        # Step 2: Try to verify build
        build_ok = None
        build_output = ""
        try:
            frontend_process = await asyncio.create_subprocess_exec(
                "npx",
                "tsc",
                "--noEmit",
                cwd=str(FRONTEND_DESKTOP_DIR),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            frontend_stdout, frontend_stderr = await asyncio.wait_for(
                frontend_process.communicate(), timeout=30
            )
            backend_process = await asyncio.create_subprocess_exec(
                str(PROJECT_ROOT / ".venv/bin/python"),
                "-m",
                "compileall",
                "-q",
                "backend/app",
                cwd=str(PROJECT_ROOT),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            backend_stdout, backend_stderr = await asyncio.wait_for(
                backend_process.communicate(), timeout=30
            )
            build_output = (frontend_stdout + frontend_stderr + backend_stdout + backend_stderr).decode(
                "utf-8", errors="replace"
            )[-2500:]
            build_ok = frontend_process.returncode == 0 and backend_process.returncode == 0
        except Exception:
            build_output = "Build check skipped (timeout or error)"

        # Step 3: Compile result
        delegate_text = (delegate_result.final_message or delegate_result.stdout or "").strip()[:3000]
        status = "超时" if delegate_result.timed_out else f"退出码 {delegate_result.exit_code}"
        build_status = "✅ build passes" if build_ok else ("❌ build fails" if build_ok is False else "⚠ build not checked")

        summary = (
            f"自我改进报告\n"
            f"═══════════\n"
            f"任务: {task[:200]}\n"
            f"执行者: {agent_name}\n"
            f"状态: {status}\n"
            f"构建: {build_status}\n\n"
            f"执行输出:\n{delegate_text}\n\n"
            f"构建输出:\n{build_output[:1000]}"
        )

        return SkillExecuteResult(
            skill="self_improve",
            success=delegate_result.exit_code == 0 and not delegate_result.timed_out,
            output=summary[:4000],
            error=delegate_result.stderr[:500] if delegate_result.exit_code != 0 else None,
            metadata={
                "agent": agent_name,
                "exit_code": delegate_result.exit_code,
                "timed_out": delegate_result.timed_out,
                "build_ok": build_ok,
                "elapsed_sec": delegate_result.elapsed_sec,
            },
        )
    except Exception as exc:
        return SkillExecuteResult(skill="self_improve", success=False, error=str(exc))


async def _skill_tts_gpt_sovits(**params: Any) -> SkillExecuteResult:
    """GPT-SoVITS local TTS synthesis — the same engine Shinsekai uses."""
    text = str(params.get("text", "")).strip()
    if not text:
        return SkillExecuteResult(skill="tts_gpt_sovits", success=False, error="text is required")

    try:
        from app.core.tts.gpt_sovits_adapter import get_tts_adapter

        adapter = get_tts_adapter()
        if not await adapter.ensure_running():
            return SkillExecuteResult(
                skill="tts_gpt_sovits",
                success=False,
                error="GPT-SoVITS server not running. Use tts_start_server first.",
            )

        # Auto-set models if not already set
        if not adapter.gpt_model or not adapter.sovits_model:
            await adapter.set_model(gpt_model="s1v3.ckpt", sovits_model="s2Gv3.pth")

        ref_audio = str(params.get("ref_audio", ""))
        audio_bytes = await adapter.synthesize(
            text=text,
            ref_audio_path=ref_audio or None,
            prompt_text=str(params.get("prompt_text", "")),
            prompt_lang=str(params.get("prompt_lang", "zh")),
            text_lang=str(params.get("text_lang", "zh")),
            speed_factor=float(params.get("speed", 1.0)),
        )

        if audio_bytes:
            # Save to temp file for playback
            output_path = settings.tts_data_dir / "output" / f"tts_{int(time.time()*1000)}.wav"
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(audio_bytes)

            return SkillExecuteResult(
                skill="tts_gpt_sovits",
                success=True,
                output=f"TTS synthesized {len(audio_bytes)} bytes of audio for: {text[:120]}",
                metadata={
                    "bytes": len(audio_bytes),
                    "output_path": str(output_path),
                    "engine": "gpt-sovits",
                },
            )
        else:
            return SkillExecuteResult(skill="tts_gpt_sovits", success=False, error="TTS synthesis returned empty")
    except Exception as exc:
        logger.error("GPT-SoVITS TTS skill failed: %s", exc)
        return SkillExecuteResult(skill="tts_gpt_sovits", success=False, error=str(exc))


async def _skill_tts_start_server(**params: Any) -> SkillExecuteResult:
    """Start the GPT-SoVITS TTS server."""
    try:
        from app.core.tts.gpt_sovits_adapter import get_tts_adapter

        adapter = get_tts_adapter()
        if await adapter.server.is_alive():
            # Set models on already-running server
            await adapter.set_model(gpt_model="s1v3.ckpt", sovits_model="s2Gv3.pth")
            return SkillExecuteResult(
                skill="tts_start_server",
                success=True,
                output="GPT-SoVITS server already running. Models loaded.",
            )

        started = await adapter.server.start()
        if started:
            await adapter.set_model(gpt_model="s1v3.ckpt", sovits_model="s2Gv3.pth")
            return SkillExecuteResult(
                skill="tts_start_server",
                success=True,
                output="GPT-SoVITS server started on http://127.0.0.1:9880",
            )
        else:
            return SkillExecuteResult(
                skill="tts_start_server",
                success=False,
                error="Failed to start GPT-SoVITS server. Configure GPT_SOVITS_DIR and verify api_v2.py exists.",
            )
    except Exception as exc:
        return SkillExecuteResult(skill="tts_start_server", success=False, error=str(exc))


async def _skill_tts_stop_server(**params: Any) -> SkillExecuteResult:
    """Stop the GPT-SoVITS TTS server."""
    try:
        from app.core.tts.gpt_sovits_adapter import get_tts_adapter

        adapter = get_tts_adapter()
        await adapter.server.stop()
        return SkillExecuteResult(skill="tts_stop_server", success=True, output="GPT-SoVITS server stopped")
    except Exception as exc:
        return SkillExecuteResult(skill="tts_stop_server", success=False, error=str(exc))


async def _skill_tts_download_models(**params: Any) -> SkillExecuteResult:
    """Download GPT-SoVITS pretrained models from HuggingFace."""
    try:
        from app.core.tts.download_models import download_required_models, get_model_status

        # First show current status
        status = get_model_status()
        downloaded = [n for n, s in status.items() if s["downloaded"]]
        missing = [n for n, s in status.items() if s["required"] and not s["downloaded"]]

        if not missing:
            return SkillExecuteResult(
                skill="tts_download_models",
                success=True,
                output=f"All required models already downloaded ({len(downloaded)} models).",
                metadata={"models": {n: s["downloaded"] for n, s in status.items()}},
            )

        # Download missing required models
        result = await download_required_models()
        if result["success"]:
            return SkillExecuteResult(
                skill="tts_download_models",
                success=True,
                output=f"Downloaded all required models ({result['total_size_mb']} MB total) to {result['output_dir']}",
                metadata=result,
            )
        else:
            failed = [n for n, r in result["models"].items() if not r.get("success")]
            return SkillExecuteResult(
                skill="tts_download_models",
                success=False,
                error=f"Failed to download: {', '.join(failed)}",
                metadata=result,
            )
    except Exception as exc:
        return SkillExecuteResult(skill="tts_download_models", success=False, error=str(exc))


# ── @skill Decorator (Shinsekai pattern) ─────────────────────────────────────

_SKILL_DECORATOR_REGISTRY: dict[str, tuple[SkillHandler, SkillDefinition]] = {}


def skill(
    name: str | None = None,
    *,
    description: str = "",
    category: str = "general",
    parameters: list[SkillParameter] | None = None,
):
    """
    Declarative skill decorator — Shinsekai @tool pattern adapted for ASRAPP.

    Usage::

        @skill(name="my_skill", description="Does something", category="code",
               parameters=[SkillParameter(name="text", type="string", required=True)])
        async def my_skill(**params):
            return SkillExecuteResult(skill="my_skill", success=True, output="done")

    Decorated functions are auto-registered into the SkillRegistry on first access.
    """
    def _decorator(fn: SkillHandler) -> SkillHandler:
        skill_name = name or fn.__name__.replace("_skill_", "").replace("_", "-")
        skill_def = SkillDefinition(
            name=skill_name,
            description=description or (fn.__doc__ or "").strip().split("\n")[0],
            parameters=parameters or [],
            category=category,
        )
        _SKILL_DECORATOR_REGISTRY[skill_name] = (fn, skill_def)
        return fn
    return _decorator


def apply_decorated_skills(registry: SkillRegistry) -> None:
    """Apply all @skill-decorated functions into the registry."""
    for name, (handler, definition) in _SKILL_DECORATOR_REGISTRY.items():
        registry.register(name, handler, definition)


# ── Registry ──────────────────────────────────────────────────────────────────

_BUILTIN_SKILLS: dict[str, dict[str, Any]] = {
    "tts": {
        "handler": _skill_tts,
        "definition": SkillDefinition(
            name="tts",
            description="Synthesize speech audio from text via the configured TTS provider",
            parameters=[
                _param("text", "string", "Text to speak", required=True),
                _param("voice", "string", "Voice name (alloy, echo, fable, onyx, nova, shimmer)", default="alloy"),
                _param("speed", "number", "Speech speed (0.25-4.0)", default=1.0),
                _param("format", "string", "Audio format (mp3, opus, aac, flac, wav, pcm)", default="mp3"),
                _param("base_url", "string", "LLM base URL (from settings)"),
                _param("api_token", "string", "LLM API token (from settings)"),
                _param("model", "string", "TTS model name"),
            ],
            category="audio",
        ),
    },
    "shell": {
        "handler": _skill_shell,
        "definition": SkillDefinition(
            name="shell",
            description="Run a shell command inside the project workspace and return its output",
            parameters=[
                _param("command", "string", "Shell command to execute", required=True),
                _param("cwd", "string", "Working directory relative to project root", default="."),
                _param("timeout", "number", "Timeout in seconds (max 120)", default=30),
            ],
            category="code",
        ),
    },
    "read_file": {
        "handler": _skill_read_file,
        "definition": SkillDefinition(
            name="read_file",
            description="Read a file's content from the project workspace",
            parameters=[
                _param("path", "string", "File path relative to project root", required=True),
                _param("max_chars", "number", "Maximum characters to return", default=8000),
            ],
            category="fs",
        ),
    },
    "write_file": {
        "handler": _skill_write_file,
        "definition": SkillDefinition(
            name="write_file",
            description="Write content to a file in the project workspace",
            parameters=[
                _param("path", "string", "File path relative to project root", required=True),
                _param("content", "string", "File content to write", required=True),
            ],
            category="fs",
        ),
    },
    "list_dir": {
        "handler": _skill_list_dir,
        "definition": SkillDefinition(
            name="list_dir",
            description="List files and directories in the project workspace",
            parameters=[
                _param("path", "string", "Directory path relative to project root", default="."),
                _param("max_items", "number", "Maximum items to list", default=50),
            ],
            category="fs",
        ),
    },
    "git_clone": {
        "handler": _skill_git_clone,
        "definition": SkillDefinition(
            name="git_clone",
            description="Clone a git repository into the project workspace. Use for pulling third-party repos, models, or tools.",
            parameters=[
                _param("url", "string", "Git repository URL (https:// or git@)", required=True),
                _param("target", "string", "Target directory name (derived from URL if omitted)"),
                _param("branch", "string", "Branch to clone"),
                _param("depth", "number", "Shallow clone depth (1 for fast clone)", default=1),
                _param("timeout", "number", "Timeout in seconds", default=180),
            ],
            category="code",
        ),
    },
    "delegate_agent": {
        "handler": _skill_delegate_agent,
        "definition": SkillDefinition(
            name="delegate_agent",
            description="Delegate a software development task to a local coding agent CLI (codex, claude, claudecode). Use for code changes, bug fixes, or complex multi-step tasks.",
            parameters=[
                _param("agent", "string", "Agent name: codex, claude, or claudecode", default="codex"),
                _param("prompt", "string", "Detailed task description for the coding agent", required=True),
                _param("cwd", "string", "Working directory relative to project root", default="."),
                _param("timeout", "number", "Timeout in seconds (max 900)", default=240),
            ],
            category="agent",
        ),
    },
    "download_model": {
        "handler": _skill_download_model,
        "definition": SkillDefinition(
            name="download_model",
            description="Download a model from HuggingFace or other sources into the local models directory",
            parameters=[
                _param("source", "string", "HuggingFace repo ID (e.g., 'Qwen/Qwen3-ASR-1.7B') or git URL", required=True),
                _param("engine", "string", "Engine category for storage (e.g., 'tts', 'asr', 'llm')", default="unknown"),
            ],
            category="model",
        ),
    },
    "speak": {
        "handler": _skill_speak_frontend,
        "definition": SkillDefinition(
            name="speak",
            description="Speak text through the frontend TTS (browser or server-side). The frontend handles audio playback.",
            parameters=[
                _param("text", "string", "Text to speak aloud", required=True),
                _param("voice", "string", "Voice name", default="alloy"),
                _param("speed", "number", "Speech speed", default=1.0),
            ],
            category="audio",
        ),
    },
    "get_context": {
        "handler": _skill_get_runtime_context,
        "definition": SkillDefinition(
            name="get_context",
            description="Get the current backend runtime context (engines loaded, paths, status)",
            parameters=[],
            category="general",
        ),
    },
    "web_search": {
        "handler": _skill_web_search,
        "definition": SkillDefinition(
            name="web_search",
            description="Search the web using DuckDuckGo and return result snippets. Use when you need to look up current information.",
            parameters=[
                _param("query", "string", "Search query", required=True),
                _param("max_results", "number", "Maximum results (1-10)", default=5),
            ],
            category="web",
        ),
    },
    "web_fetch": {
        "handler": _skill_web_fetch,
        "definition": SkillDefinition(
            name="web_fetch",
            description="Fetch and extract text content from a URL. Use to read web pages.",
            parameters=[
                _param("url", "string", "URL to fetch (https://)", required=True),
                _param("max_chars", "number", "Maximum characters to return", default=4000),
            ],
            category="web",
        ),
    },
    "system_info": {
        "handler": _skill_system_info,
        "definition": SkillDefinition(
            name="system_info",
            description="Get system information: OS, CPU, memory, disk space, Python version",
            parameters=[],
            category="system",
        ),
    },
    "run_python": {
        "handler": _skill_run_python,
        "definition": SkillDefinition(
            name="run_python",
            description="Safely run a simple Python expression for calculation or data processing. Blocked: __import__, eval, exec, open, os, subprocess.",
            parameters=[
                _param("code", "string", "Python expression to evaluate", required=True),
            ],
            category="code",
        ),
    },
    "self_improve": {
        "handler": _skill_self_improve,
        "definition": SkillDefinition(
            name="self_improve",
            description="Self-improvement loop: delegate a coding task to an external agent (codex/claude), then verify the build. Use this when the user asks you to modify the system itself.",
            parameters=[
                _param("task", "string", "Detailed task description for the coding agent", required=True),
                _param("agent", "string", "Coding agent to use: codex, claude, or claudecode", default="codex"),
                _param("timeout", "number", "Timeout in seconds (max 900)", default=300),
            ],
            category="agent",
        ),
    },
    "tts_gpt_sovits": {
        "handler": _skill_tts_gpt_sovits,
        "definition": SkillDefinition(
            name="tts_gpt_sovits",
            description="GPT-SoVITS local TTS synthesis — same engine Shinsekai uses. High-quality zero-shot voice cloning. Requires GPT-SoVITS server running.",
            parameters=[
                _param("text", "string", "Text to synthesize", required=True),
                _param("ref_audio", "string", "Path to reference audio file for voice cloning (5s WAV)"),
                _param("prompt_text", "string", "Text content of the reference audio"),
                _param("text_lang", "string", "Language of text (zh, ja, en, ko, yue)", default="zh"),
                _param("speed", "number", "Speech speed factor (0.5-2.0)", default=1.0),
            ],
            category="audio",
        ),
    },
    "tts_start_server": {
        "handler": _skill_tts_start_server,
        "definition": SkillDefinition(
            name="tts_start_server",
            description="Start the GPT-SoVITS TTS server on port 9880. Call this before using tts_gpt_sovits.",
            parameters=[],
            category="audio",
        ),
    },
    "tts_stop_server": {
        "handler": _skill_tts_stop_server,
        "definition": SkillDefinition(
            name="tts_stop_server",
            description="Stop the GPT-SoVITS TTS server to free resources.",
            parameters=[],
            category="audio",
        ),
    },
    "tts_download_models": {
        "handler": _skill_tts_download_models,
        "definition": SkillDefinition(
            name="tts_download_models",
            description="Download GPT-SoVITS pretrained models (s1v3.ckpt ~155MB + s2Gv3.pth ~769MB) from HuggingFace. Required before using GPT-SoVITS TTS.",
            parameters=[],
            category="model",
        ),
    },
}


# ── Skill Registry Service ────────────────────────────────────────────────────

class SkillRegistry:
    def __init__(self) -> None:
        self._skills: dict[str, dict[str, Any]] = dict(_BUILTIN_SKILLS)
        # Apply any @skill-decorated functions
        for name, (handler, definition) in _SKILL_DECORATOR_REGISTRY.items():
            if name not in self._skills:
                self._skills[name] = {"handler": handler, "definition": definition}

    def list_skills(self, category: str | None = None) -> list[SkillDefinition]:
        """Return all registered skill definitions, optionally filtered by category."""
        skills = [
            entry["definition"]
            for entry in self._skills.values()
            if category is None or entry["definition"].category == category
        ]
        return sorted(skills, key=lambda s: s.name)

    def get_skill(self, name: str) -> SkillDefinition | None:
        entry = self._skills.get(name.lower())
        return entry["definition"] if entry else None

    async def execute(self, name: str, parameters: dict[str, Any] | None = None) -> SkillExecuteResult:
        """Execute a skill by name with the given parameters."""
        entry = self._skills.get(name.lower())
        if not entry:
            return SkillExecuteResult(
                skill=name,
                success=False,
                error=f"Unknown skill '{name}'. Available: {', '.join(sorted(self._skills))}",
            )

        handler: SkillHandler = entry["handler"]
        params = parameters or {}
        started = time.perf_counter()
        try:
            result = await handler(**params)
            result.metadata["elapsed_sec"] = round(time.perf_counter() - started, 3)
            return result
        except Exception as exc:
            logger.error("Skill '%s' execution failed: %s", name, exc)
            return SkillExecuteResult(
                skill=name,
                success=False,
                error=str(exc),
                metadata={"elapsed_sec": round(time.perf_counter() - started, 3)},
            )

    def register(self, name: str, handler: SkillHandler, definition: SkillDefinition) -> None:
        """Register a custom skill at runtime (e.g., from plugins)."""
        self._skills[name.lower()] = {"handler": handler, "definition": definition}
        logger.info("Registered skill: %s", name)


# ── Singleton ─────────────────────────────────────────────────────────────────

_registry: SkillRegistry | None = None


def get_skill_registry() -> SkillRegistry:
    global _registry
    if _registry is None:
        _registry = SkillRegistry()
    return _registry


def _format_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes}B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f}KB"
    return f"{size_bytes / (1024 * 1024):.1f}MB"
