"""Filesystem archive for retained audio and recognition JSON."""

from __future__ import annotations

import json
import re
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import get_settings

settings = get_settings()

_SAFE = re.compile(r"[^\w.-]+", re.UNICODE)


def archive_pcm_record(
    *,
    pcm_bytes: bytes,
    sample_rate: int,
    user_id: str | None,
    category: str | None,
    text: str,
    engine: str,
    language: str | None,
    started_at: datetime,
    ended_at: datetime,
    duration_sec: float,
    metadata: dict[str, Any] | None = None,
) -> dict[str, str]:
    """Save a streaming utterance as WAV plus adjacent JSON metadata."""

    now = datetime.now(timezone.utc)
    root = _record_root(user_id, category, now)
    stem = f"{started_at.strftime('%H%M%S')}_{_safe(engine)}_{now.strftime('%f')}"
    wav_path = root / f"{stem}.wav"
    json_path = root / f"{stem}.json"

    _write_wav(wav_path, pcm_bytes, sample_rate)
    payload = {
        "user_id": user_id or "anonymous",
        "category": category or settings.stream_archive_category,
        "type": category or settings.stream_archive_category,
        "engine": engine,
        "language": language,
        "text": text,
        "duration_sec": round(duration_sec, 3),
        "real_time_start": started_at.astimezone().isoformat(),
        "real_time_end": ended_at.astimezone().isoformat(),
        "spoken_at": {
            "start": started_at.astimezone().isoformat(),
            "end": ended_at.astimezone().isoformat(),
        },
        "created_at": now.astimezone().isoformat(),
        "audio_file": wav_path.name,
        "metadata": metadata or {},
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"audio_path": str(wav_path), "json_path": str(json_path)}


def archive_file_record(
    *,
    audio_bytes: bytes,
    suffix: str,
    user_id: str | None,
    category: str | None,
    text: str,
    engine: str,
    language: str | None,
    duration_sec: float | None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, str]:
    """Save an uploaded audio file plus adjacent JSON metadata."""

    now = datetime.now(timezone.utc)
    root = _record_root(user_id, category, now)
    clean_suffix = suffix if suffix.startswith(".") else f".{suffix}"
    stem = f"{now.strftime('%H%M%S')}_{_safe(engine)}_{now.strftime('%f')}"
    audio_path = root / f"{stem}{clean_suffix or '.audio'}"
    json_path = root / f"{stem}.json"

    audio_path.write_bytes(audio_bytes)
    payload = {
        "user_id": user_id or "anonymous",
        "category": category or settings.upload_archive_category,
        "type": category or settings.upload_archive_category,
        "engine": engine,
        "language": language,
        "text": text,
        "duration_sec": duration_sec,
        "real_time_start": now.astimezone().isoformat(),
        "real_time_end": now.astimezone().isoformat(),
        "spoken_at": {
            "start": now.astimezone().isoformat(),
            "end": now.astimezone().isoformat(),
        },
        "created_at": now.astimezone().isoformat(),
        "audio_file": audio_path.name,
        "metadata": metadata or {},
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"audio_path": str(audio_path), "json_path": str(json_path)}


def archive_file_error_record(
    *,
    audio_bytes: bytes,
    suffix: str,
    user_id: str | None,
    category: str | None,
    engine: str,
    language: str | None,
    duration_sec: float | None,
    error: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, str]:
    """Save received audio even when recognition fails."""

    return archive_file_record(
        audio_bytes=audio_bytes,
        suffix=suffix,
        user_id=user_id,
        category=category,
        text="",
        engine=engine,
        language=language,
        duration_sec=duration_sec,
        metadata={**(metadata or {}), "status": "failed", "error": error},
    )


def list_archived_records(
    *,
    user_id: str | None = None,
    date: str | None = None,
    category: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """Return saved audio/json records grouped by user, day, and category."""

    base = settings.archive_dir
    if not base.exists():
        return []

    records: list[tuple[float, dict[str, Any]]] = []
    user_dirs = [_existing_dir(base / _safe(user_id))] if user_id else _child_dirs(base)
    for user_dir in [path for path in user_dirs if path is not None]:
        day_dirs = [_existing_dir(user_dir / _safe(date))] if date else _child_dirs(user_dir)
        for day_dir in [path for path in day_dirs if path is not None]:
            category_dirs = [_existing_dir(day_dir / _safe(category))] if category else _child_dirs(day_dir)
            for category_dir in [path for path in category_dirs if path is not None]:
                for json_path in category_dir.glob("*.json"):
                    try:
                        payload = json.loads(json_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        continue
                    if not isinstance(payload, dict):
                        continue
                    audio_name = payload.get("audio_file")
                    audio_path = json_path.with_name(audio_name) if isinstance(audio_name, str) else None
                    item = {
                        **payload,
                        "user_id": payload.get("user_id") or user_dir.name,
                        "date": day_dir.name,
                        "category": payload.get("category") or category_dir.name,
                        "json_path": str(json_path),
                        "audio_path": str(audio_path) if audio_path else None,
                    }
                    records.append((json_path.stat().st_mtime, item))

    records.sort(key=lambda entry: entry[0], reverse=True)
    start = max(offset, 0)
    end = start + max(limit, 0)
    return [item for _, item in records[start:end]]


def _record_root(user_id: str | None, category: str | None, when: datetime) -> Path:
    user_part = _safe(user_id or "anonymous")
    category_part = _safe(category or settings.stream_archive_category)
    day = when.astimezone().strftime("%Y-%m-%d")
    root = settings.archive_dir / user_part / day / category_part
    root.mkdir(parents=True, exist_ok=True)
    return root


def _write_wav(path: Path, pcm_bytes: bytes, sample_rate: int) -> None:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)


def _safe(value: str) -> str:
    cleaned = _SAFE.sub("_", value.strip())
    return cleaned[:96] or "unknown"


def _existing_dir(path: Path) -> Path | None:
    return path if path.is_dir() else None


def _child_dirs(path: Path) -> list[Path]:
    try:
        return [child for child in path.iterdir() if child.is_dir()]
    except OSError:
        return []
