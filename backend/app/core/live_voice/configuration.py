"""Server-side realtime settings and credential-free provider catalog."""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from pathlib import Path

from dotenv import dotenv_values

ENV_PATH = Path(__file__).resolve().parents[3] / ".env"
DIRECTORY = Path(__file__).resolve().parent
KEY_FIELDS = ("DASHSCOPE_API_KEY", "GEMINI_API_KEY", "BOSON_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY")
CONFIG_FIELDS = (*KEY_FIELDS, "DASHSCOPE_WORKSPACE_ID", "DASHSCOPE_REGION")
_write_lock = threading.Lock()


def local_config() -> dict[str, str]:
    values = {key: value for key, value in dotenv_values(ENV_PATH, interpolate=False).items()
              if isinstance(value, str)} if ENV_PATH.exists() else {}
    values.update(os.environ)
    return values


def _voices(filename: str) -> list[dict]:
    rows = json.loads((DIRECTORY / filename).read_text(encoding="utf-8-sig"))
    return [{"id": row["id"], "name": row.get("name") or row.get("label") or row["id"],
             "gender": row.get("gender", "unknown"),
             "description": row.get("description") or row.get("style") or "",
             "gender_source": row.get("gender_source", "unknown")} for row in rows]


def catalog(values: dict[str, str] | None = None) -> dict:
    values = local_config() if values is None else values
    credentials = {field: bool(values.get(field, "").strip()) for field in KEY_FIELDS}
    qwen_ready = (credentials["DASHSCOPE_API_KEY"] and bool(re.fullmatch(
        r"[A-Za-z0-9-]{1,100}", values.get("DASHSCOPE_WORKSPACE_ID", "")))
        and values.get("DASHSCOPE_REGION", "cn-beijing") in {"cn-beijing", "ap-southeast-1"})
    specs = [
        ("qwen", "千问 Audio 3.1", "qwen-audio-3.1-realtime-plus", qwen_ready,
         "longanqian_v3.1", "voices.json"),
        ("gemini_live", "Gemini Live", "gemini-3.8-live", credentials["GEMINI_API_KEY"],
         "Zephyr", "gemini_voices.json"),
        ("gemini_thinking", "Gemini Live 深度思考", "gemini-3.8-live-extended-thinking",
         credentials["GEMINI_API_KEY"], "Zephyr", "gemini_voices.json"),
        ("higgs", "Higgs Realtime", "higgs-realtime", credentials["BOSON_API_KEY"],
         "chloe", "higgs_voices.json"),
        ("grok", "Grok Voice Think Fast 2", "grok-voice-think-fast-2.0", credentials["XAI_API_KEY"],
         "eve", "grok_voices.json"),
        ("openai", "GPT Live", "gpt-live-1", credentials["OPENAI_API_KEY"], "", None),
    ]
    providers = []
    for id_, label, model, configured, voice, filename in specs:
        available = configured and (id_ != "grok" or values.get("GROK_EVAL_ENABLED") == "1")
        reason = "" if available else "请先配置 API Key" if not configured else "Grok 尚未确认免费额度，当前禁止发起 API 会话"
        if id_ == "qwen" and not configured:
            reason = "请先配置百炼 API Key 和业务空间 ID"
        providers.append({"id": id_, "label": label, "model": model, "configured": configured,
                          "available": available, "unavailable_reason": reason,
                          "default_voice": voice, "voices": _voices(filename) if filename else [],
                          "supports_brain": id_ == "qwen",
                          "deployment_note": "保留配置入口；按计划稍后部署 GPT Live" if id_ == "openai" else "",
                          "transport": "webrtc" if id_ == "openai" else "websocket"})
    return {"providers": providers,
            "config": {"dashscope_workspace_id": values.get("DASHSCOPE_WORKSPACE_ID", ""),
                       "dashscope_region": values.get("DASHSCOPE_REGION", "cn-beijing")},
            "credential_status": credentials,
            "brain_available": bool(qwen_ready and values.get("QWEN_BRAIN_ENABLED") == "1")}


def save_config(fields: object) -> None:
    """Apply an allowlist atomically. Blank credentials leave existing keys untouched."""
    if not isinstance(fields, dict) or set(fields) - set(CONFIG_FIELDS):
        raise ValueError("只接受实时语音的密钥、业务空间与地域配置")
    updates = {}
    for key, value in fields.items():
        if not isinstance(value, str) or len(value) > 1024 or any(ord(c) < 32 for c in value):
            raise ValueError("配置必须为单行文本，且不超过 1024 个字符")
        value = value.strip()
        if not value:
            continue
        if key == "DASHSCOPE_REGION":
            if value not in {"cn-beijing", "ap-southeast-1"}:
                raise ValueError("百炼地域无效")
        elif key == "DASHSCOPE_WORKSPACE_ID":
            if not re.fullmatch(r"[A-Za-z0-9-]{1,100}", value):
                raise ValueError("百炼业务空间 ID 无效")
        elif not re.fullmatch(r"[A-Za-z0-9._~+/=-]{1,1024}", value):
            raise ValueError("API Key 格式无效")
        updates[key] = value
    if not updates:
        return
    with _write_lock:
        old = ENV_PATH.read_text(encoding="utf-8-sig") if ENV_PATH.exists() else ""
        lines, applied = [], set()
        for line in old.splitlines():
            match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
            name = match.group(1) if match else None
            if name in updates:
                if name not in applied:
                    lines.append(f"{name}={updates[name]}")
                    applied.add(name)
            else:
                lines.append(line)
        lines.extend(f"{name}={value}" for name, value in updates.items() if name not in applied)
        ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".env.", suffix=".tmp", dir=ENV_PATH.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                stream.write("\n".join(lines) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, ENV_PATH)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        # Changes take effect immediately even if an inherited process value existed.
        os.environ.update(updates)
        from app.config import get_settings
        get_settings.cache_clear()
