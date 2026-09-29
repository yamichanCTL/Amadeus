"""A local capability token for Codex turns with Windows user permissions."""

from __future__ import annotations

import os
import secrets
from pathlib import Path


def _token_path() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        local_app_data = str(Path.home() / "AppData" / "Local")
    return Path(local_app_data) / "Amadeus" / "work-token"


def _load_token() -> str:
    path = _token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        token = path.read_text(encoding="utf-8").strip()
        if len(token) >= 40:
            return token
    except FileNotFoundError:
        pass
    token = secrets.token_urlsafe(48)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(token, encoding="utf-8")
    os.replace(temporary, path)
    return token


WORK_TOKEN = _load_token()


def valid_work_token(value: str | None) -> bool:
    return bool(value) and secrets.compare_digest(value, WORK_TOKEN)
