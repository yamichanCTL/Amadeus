"""Filesystem archive for retained audio and recognition JSON."""

from __future__ import annotations

import json
import re
import wave
from datetime import datetime, time, timezone
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
    stem = _archive_stem(started_at, engine, now)
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
    stem = _archive_stem(now, engine, now)
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


def build_summary_transcript(
    *,
    user_id: str | None,
    date: str,
    category: str | None,
    start_time: str | None,
    end_time: str | None,
    max_chars: int,
) -> tuple[str, int, int, bool]:
    """Build a compact transcript from archived JSON records for LLM input."""

    records = list_archived_records(
        user_id=user_id,
        date=date,
        category=category,
        limit=20000,
        offset=0,
    )
    range_start = _parse_clock(start_time)
    range_end = _parse_clock(end_time)
    lines: list[tuple[datetime | None, str]] = []
    for record in records:
        text = _record_text(record)
        if not text:
            continue
        started_at = _parse_datetime(
            _nested_get(record, "spoken_at", "start")
            or record.get("real_time_start")
            or record.get("created_at")
        )
        ended_at = _parse_datetime(
            _nested_get(record, "spoken_at", "end")
            or record.get("real_time_end")
            or record.get("created_at")
        )
        if not _within_clock_range(started_at, ended_at, range_start, range_end):
            continue
        prefix = _format_time_prefix(started_at, ended_at)
        lines.append((started_at, f"{prefix} {text}"))

    lines.sort(key=lambda entry: entry[0].timestamp() if entry[0] else 0)
    compact_lines = _drop_adjacent_duplicates([line for _, line in lines])

    used_chars = 0
    selected: list[str] = []
    truncated = False
    for line in compact_lines:
        next_size = used_chars + len(line) + 1
        if next_size > max_chars:
            truncated = True
            break
        selected.append(line)
        used_chars = next_size

    return "\n".join(selected), len(compact_lines), used_chars, truncated


def save_summary_record(
    *,
    summary: dict[str, Any],
    user_id: str | None,
    category: str | None,
) -> str:
    now = datetime.now(timezone.utc)
    root = _record_root(user_id, category or "当日总结", now)
    stem = _archive_stem(now, "summary", now)
    path = root / f"{stem}.json"
    payload = {
      "user_id": user_id or "anonymous",
      "category": category or "当日总结",
      "type": "当日总结",
      "created_at": now.astimezone().isoformat(),
      "summary": summary,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(path)


def _record_root(user_id: str | None, category: str | None, when: datetime) -> Path:
    user_part = _safe(user_id or "anonymous")
    category_part = _safe(category or settings.stream_archive_category)
    day = when.astimezone().strftime("%Y-%m-%d")
    root = settings.archive_dir / user_part / day / category_part
    root.mkdir(parents=True, exist_ok=True)
    return root


def _archive_stem(event_time: datetime, label: str, unique_time: datetime | None = None) -> str:
    local_time = event_time.astimezone()
    unique = unique_time or event_time
    return f"{local_time.strftime('%Y-%m-%d_%H-%M-%S')}_{_safe(label)}_{unique.strftime('%f')}"


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


def _parse_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _parse_clock(value: str | None) -> time | None:
    if not value:
        return None
    try:
        parts = [int(part) for part in value.split(":")]
    except ValueError:
        return None
    if len(parts) == 2:
        parts.append(0)
    try:
        return time(parts[0], parts[1], parts[2])
    except ValueError:
        return None


def _within_clock_range(
    started_at: datetime | None,
    ended_at: datetime | None,
    range_start: time | None,
    range_end: time | None,
) -> bool:
    if range_start is None and range_end is None:
        return True
    start_clock = started_at.timetz().replace(tzinfo=None) if started_at else None
    end_clock = ended_at.timetz().replace(tzinfo=None) if ended_at else start_clock
    if start_clock is None:
        return False
    if range_start and end_clock and end_clock < range_start:
        return False
    if range_end and start_clock > range_end:
        return False
    return True


def _nested_get(record: dict[str, Any], key: str, child: str) -> object:
    value = record.get(key)
    if not isinstance(value, dict):
        return None
    return value.get(child)


def _record_text(record: dict[str, Any]) -> str:
    text = record.get("text") or record.get("full_text")
    if not isinstance(text, str):
        return ""
    return re.sub(r"\s+", " ", text).strip()


def _record_speaker(record: dict[str, Any]) -> str:
    speaker = record.get("speaker")
    if isinstance(speaker, str) and speaker.strip():
        return speaker.strip()[:32]
    metadata = record.get("metadata")
    if isinstance(metadata, dict):
        value = metadata.get("speaker")
        if isinstance(value, str) and value.strip():
            return value.strip()[:32]
    return ""


def _format_time_prefix(started_at: datetime | None, ended_at: datetime | None) -> str:
    if not started_at:
        return "[--:--:--]"
    start = started_at.strftime("%H:%M:%S")
    end = ended_at.strftime("%H:%M:%S") if ended_at else start
    return f"[{start}-{end}]"


def _drop_adjacent_duplicates(lines: list[str]) -> list[str]:
    compact: list[str] = []
    previous_text = ""
    for line in lines:
        text = line.split("] ", 1)[-1]
        if text and text == previous_text:
            continue
        compact.append(line)
        previous_text = text
    return compact
