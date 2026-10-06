"""Explicit fallback cache locations for libraries that can fetch model assets."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def huggingface_cache_dir(settings: Any) -> Path:
    """Use the host's managed cache contract without changing its environment."""
    explicit = os.environ.get("HF_HUB_CACHE") or os.environ.get("HUGGINGFACE_HUB_CACHE")
    if explicit:
        return Path(os.path.expandvars(explicit)).expanduser()
    home = os.environ.get("HF_HOME")
    if home:
        return Path(os.path.expandvars(home)).expanduser() / "hub"
    return Path(settings.project_root) / "cache" / "huggingface" / "hub"
