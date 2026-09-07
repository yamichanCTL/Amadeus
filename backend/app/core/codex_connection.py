"""Import the current Codex/CC Switch connection without development plugins."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib

from app.config import Settings

_ENV_KEYS = {
    "PATH",
    "Path",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
}
_PROVIDER_KEYS = {
    "name",
    "base_url",
    "wire_api",
    "env_key",
    "env_key_instructions",
    "experimental_bearer_token",
    "http_headers",
    "env_http_headers",
    "requires_openai_auth",
    "request_max_retries",
    "stream_max_retries",
    "stream_idle_timeout_ms",
    "supports_websockets",
}
_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}


class CodexError(RuntimeError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def public_error(raw: object) -> CodexError:
    """Provider errors can contain URLs and tokens; return fixed messages only."""
    message = str(raw).lower()
    if any(word in message for word in ("401", "unauthorized", "authentication", "refresh token")):
        return CodexError("codex_auth", "Codex 认证失败，请更新 Codex / CC Switch 登录。")
    if any(word in message for word in ("429", "quota", "rate limit", "usage limit", "credit")):
        return CodexError("codex_quota", "Codex 服务限流或额度不足。")
    if "model" in message and any(
        word in message for word in ("not found", "unsupported", "not supported")
    ):
        return CodexError("codex_model", "当前提供方不支持所选模型或推理强度。")
    return CodexError("codex_request", "Codex 请求未完成，请检查模型连接、配置及网络。")


def _toml(data: dict, prefix: tuple[str, ...] = ()) -> str:
    """Serialize the small allowlisted config (JSON scalars are valid TOML here)."""
    lines = []
    if prefix:
        lines.append("[" + ".".join(json.dumps(key) for key in prefix) + "]")
    for key, value in data.items():
        if not isinstance(value, dict) and value is not None:
            lines.append(f"{json.dumps(key)} = {json.dumps(value, ensure_ascii=False)}")
    for key, value in data.items():
        if isinstance(value, dict):
            lines.append(_toml(value, (*prefix, key)))
    return "\n".join(lines) + "\n"


def _private_write(path: Path, data: bytes) -> None:
    # Atomic replacement also preserves mode when refreshing an existing file.
    temporary = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    os.replace(temporary, path)


@dataclass
class CodexConnection:
    model: str | None
    provider: str
    effort: str | None
    endpoint: str
    fingerprint: str
    home: Path
    workspace: Path
    env: dict[str, str] = field(repr=False)


def prepare_connection(settings: Settings) -> CodexConnection:
    source = (
        settings.codex_config_home or Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    ).resolve()
    try:
        config_file = source / "config.toml"
        config = tomllib.loads(config_file.read_text()) if config_file.exists() else {}
        provider = config.get("model_provider", "openai")
        selected = config.get("model_providers", {}).get(provider, {})
        selected = {key: value for key, value in selected.items() if key in _PROVIDER_KEYS}
        auth_file = source / "auth.json"
        auth = auth_file.read_bytes() if auth_file.is_file() else b""
        model = config.get("model") or None
        effort = config.get("model_reasoning_effort")
        effort = effort if effort in _EFFORTS else None
        env = {key: value for key, value in os.environ.items() if key in _ENV_KEYS}
        credential_keys = {selected.get("env_key")}
        credential_keys.update(selected.get("env_http_headers", {}).values())
        if provider == "openai":
            credential_keys.add("OPENAI_API_KEY")
        for key in credential_keys:
            if key and key in os.environ:
                env[key] = os.environ[key]
        if (
            not auth
            and not any(env.get(key) for key in credential_keys if key)
            and not selected.get("experimental_bearer_token")
        ):
            raise CodexError(
                "codex_auth", "未找到 Codex 登录或提供方凭据，请先配置 Codex / CC Switch。"
            )

        runtime = (
            settings.codex_runtime_dir or settings.project_root / ".runtime" / "codex"
        ).resolve()
        # Connection-specific homes let active sessions finish on their original account.
        fingerprint = hashlib.sha256(
            json.dumps(
                [
                    model,
                    provider,
                    selected,
                    effort,
                    hashlib.sha256(auth).hexdigest(),
                    {k: env.get(k) for k in credential_keys if k},
                ],
                sort_keys=True,
            ).encode()
        ).hexdigest()
        home = runtime / "connections" / fingerprint[:24]
        workspace = runtime / "workspace"
        home.mkdir(parents=True, exist_ok=True, mode=0o700)
        workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        isolated = {
            "model": model,
            "model_provider": provider,
            "model_reasoning_effort": effort,
            "cli_auth_credentials_store": "file",
            "web_search": "disabled",
            "features": {
                "shell_tool": False,
                "unified_exec": False,
                "shell_snapshot": False,
                "apps": False,
                "plugins": False,
                "remote_plugin": False,
                "skill_search": False,
                "skip_host_skill_discovery": True,
            },
            "developer_instructions": (
                "You are Amadeus, a voice assistant. User text may be an ASR transcript. "
                "Answer the user's request concisely in their language. Ask for clarification "
                "when speech is ambiguous. Do not claim to execute actions or change files. "
                "Do not use shell, filesystem, browser, MCP or other external tools."
            ),
        }
        if selected:
            isolated["model_providers"] = {provider: selected}
        _private_write(home / "config.toml", _toml(isolated).encode())
        # Keep credentials refreshed by this application; a source change creates a new home.
        if auth and not (home / "auth.json").exists():
            _private_write(home / "auth.json", auth)
        env["CODEX_HOME"] = str(home)
        endpoint = "OpenAI 默认连接"
        if selected.get("base_url"):
            url = urlsplit(selected["base_url"])
            endpoint = urlunsplit((url.scheme, url.hostname or "", url.path, "", ""))
        return CodexConnection(model, provider, effort, endpoint, fingerprint, home, workspace, env)
    except CodexError:
        raise
    except (OSError, ValueError, TypeError, AttributeError):
        raise CodexError(
            "codex_config", "无法读取 Codex 连接配置，请检查配置格式及文件权限。"
        ) from None
