"""Convert engine/provider objects into values accepted by JSON encoders."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel


def json_safe(value: Any, *, _seen: set[int] | None = None) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Enum):
        return json_safe(value.value, _seen=_seen)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)

    seen = _seen if _seen is not None else set()
    identity = id(value)
    if identity in seen:
        return "<recursive>"
    seen.add(identity)
    try:
        if isinstance(value, BaseModel):
            return json_safe(value.model_dump(mode="json"), _seen=seen)
        if is_dataclass(value) and not isinstance(value, type):
            return json_safe(asdict(value), _seen=seen)
        if isinstance(value, Mapping):
            return {str(key): json_safe(item, _seen=seen) for key, item in value.items()}
        if isinstance(value, (list, tuple, set, frozenset)):
            return [json_safe(item, _seen=seen) for item in value]

        for method_name in ("model_dump", "to_dict", "dict"):
            method = getattr(value, method_name, None)
            if callable(method):
                try:
                    result = method(mode="json") if method_name == "model_dump" else method()
                    return json_safe(result, _seen=seen)
                except (TypeError, ValueError):
                    continue

        attributes = getattr(value, "__dict__", None)
        if isinstance(attributes, dict):
            public = {key: item for key, item in attributes.items() if not str(key).startswith("_")}
            if public:
                return json_safe(public, _seen=seen)
        return str(value)
    finally:
        seen.discard(identity)

