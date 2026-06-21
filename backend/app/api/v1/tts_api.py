"""
TTS API — GPT-SoVITS speech synthesis and voice pipeline.

POST /v1/tts/speak    — Text → GPT-SoVITS → WAV audio
POST /v1/tts/pipeline  — Audio file → ASR → Agent → GPT-SoVITS → WAV audio
"""

from __future__ import annotations

import logging
import math
import sys
import asyncio
import base64
import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator, Iterator

import httpx
from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Query, WebSocket, WebSocketDisconnect, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.core.model_errors import ModelRuntimeError, classify_model_error

logger = logging.getLogger(__name__)

# Ensure runner is importable
_RUNNER_ROOT = Path(__file__).resolve().parents[4]
if str(_RUNNER_ROOT) not in sys.path:
    sys.path.insert(0, str(_RUNNER_ROOT))

router = APIRouter(prefix="/tts", tags=["tts"])


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000, description="Text to synthesize")
    text_lang: str = Field("zh", description="Language: zh, ja, en, ko, yue")
    speed: float = Field(1.0, ge=0.5, le=2.0, description="Speech speed")
    engine: str = Field("gpt_sovits", description="TTS engine: gpt_sovits, voxcpm2")


class TTSResponse(BaseModel):
    text: str
    audio_size: int
    format: str = "wav"
    engine: str = "gpt_sovits"


class HiggsTTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000, description="Text to synthesize")
    higgs_base_url: str = Field("http://localhost:8002", description="Higgs API base URL")
    provider: str = Field("local", pattern="^(local|boson)$")
    api_token: str = Field("", description="Boson API token; forwarded only in Authorization header")
    model: str = Field("higgs-audio-v3-tts", description="Remote Higgs model name")
    voice: str = Field("default", description="Higgs voice name")
    response_format: str = Field("wav", description="wav, mp3, flac, opus, aac, pcm")
    speed: float = Field(1.0, ge=0.25, le=4.0)
    temperature: float = Field(0.7, ge=0.0, le=2.0)
    top_p: float = Field(0.95, ge=0.0, le=1.0)
    top_k: int = Field(50, ge=0, le=500)
    seed: int = Field(-1, ge=-1)
    max_new_tokens: int = Field(2048, ge=16, le=8192)
    reference_audio: str = Field("", description="Reference audio data URL")
    reference_url: str = Field("", description="Reference audio URL")
    reference_text: str = Field("", description="Transcript for reference audio")
    reference_codes_json: str = Field("", description="JSON array shaped [T,8]; overrides reference audio")
    emotion: str = Field("", description="Higgs emotion control tag value")
    style: str = Field("", description="Higgs style control tag value")
    prosody_speed: str = Field("", description="Higgs prosody speed control tag value")
    pitch: str = Field("", description="Higgs pitch control tag value")
    expressiveness: str = Field("", description="Higgs expressiveness control tag value")
    initial_codec_chunk_frames: int = Field(1, ge=0, le=16)
    stream: bool = Field(False, description="Forward stream flag to Higgs and stream chunks when used by WebSocket")


class HiggsVoicePresetRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80, description="Persistent local voice preset name")
    higgs_base_url: str = Field("http://localhost:8002", description="Higgs API base URL used when the preset was saved")
    reference_audio: str = Field("", description="Reference audio data URL")
    reference_url: str = Field("", description="Reference audio URL")
    reference_text: str = Field("", description="Transcript for reference audio")
    reference_codes_json: str = Field("", description="JSON array shaped [T,8]; overrides reference audio")


class HiggsConnectionRequest(BaseModel):
    provider: str = Field("local", pattern="^(local|boson)$")
    base_url: str = "http://localhost:8002"
    api_token: str = ""


class HiggsAudioTiming(BaseModel):
    asr_sec: float = 0
    tts_sec: float = 0
    total_sec: float = 0


class HiggsAudioToSpeechMetadata(BaseModel):
    text: str
    engine: str
    language: str | None = None
    confidence: float | None = None
    timing: HiggsAudioTiming


def _normalize_higgs_base_url(value: str | None) -> str:
    base = (value or "http://localhost:8002").strip().rstrip("/")
    if not base:
        base = "http://localhost:8002"
    if not base.startswith(("http://", "https://")):
        base = "http://" + base
    return base


def _higgs_speech_url(base_url: str) -> str:
    base = _normalize_higgs_base_url(base_url)
    return f"{base}/audio/speech" if base.endswith("/v1") else f"{base}/v1/audio/speech"


def _higgs_auth_headers(api_token: str = "") -> dict[str, str]:
    headers = {"Content-Type": "application/json", "Accept": "*/*"}
    if api_token.strip():
        headers["Authorization"] = f"Bearer {api_token.strip()}"
    return headers


def _higgs_voice_presets_path() -> Path:
    configured = os.getenv("ASRAPP_HIGGS_VOICE_PRESETS")
    if configured:
        return Path(configured).expanduser()
    return _RUNNER_ROOT / "data" / "higgs_voice_presets.json"


def _higgs_voices_dir() -> Path:
    configured = os.getenv("ASRAPP_TTS_VOICES_DIR")
    if configured:
        return Path(configured).expanduser()
    return _RUNNER_ROOT / "data" / "tts" / "voices"


def _voice_id_from_name(value: str) -> str:
    cleaned = _clean_voice_name(value)
    safe = re.sub(r"[^\w\u4e00-\u9fff.-]+", "_", cleaned, flags=re.UNICODE).strip("._-")
    return (safe or "voice")[:80]


def _clean_voice_name(value: str) -> str:
    name = " ".join((value or "").strip().split())
    if not name:
        raise ValueError("音色名不能为空")
    if any(char in name for char in ("\n", "\r", "\t")):
        raise ValueError("音色名不能包含换行或制表符")
    return name[:80]


def _split_data_url(value: str) -> tuple[str, bytes] | None:
    raw = value.strip()
    if not raw.startswith("data:") or ";base64," not in raw:
        return None
    header, payload = raw.split(",", 1)
    media_type = header.removeprefix("data:").split(";", 1)[0] or "audio/wav"
    return media_type, base64.b64decode(payload)


def _media_extension(media_type: str) -> str:
    mapping = {
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/flac": ".flac",
        "audio/ogg": ".ogg",
        "audio/webm": ".webm",
        "audio/aac": ".aac",
    }
    return mapping.get(media_type.lower().split(";", 1)[0], ".wav")


def _read_legacy_higgs_voice_presets() -> list[dict[str, Any]]:
    path = _higgs_voice_presets_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Failed to read Higgs voice presets from %s: %s", path, exc)
        return []
    if not isinstance(data, list):
        return []
    presets: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict) or not item.get("name"):
            continue
        preset = {
            "name": str(item.get("name") or "").strip(),
            "higgs_base_url": str(item.get("higgs_base_url") or "http://localhost:8002"),
            "reference_audio": str(item.get("reference_audio") or ""),
            "reference_url": str(item.get("reference_url") or ""),
            "reference_text": str(item.get("reference_text") or ""),
            "reference_codes_json": str(item.get("reference_codes_json") or ""),
            "created_at": str(item.get("created_at") or ""),
            "updated_at": str(item.get("updated_at") or ""),
        }
        if preset["name"]:
            presets.append(preset)
    return presets


def _read_voice_dir_preset(path: Path) -> dict[str, Any] | None:
    meta_path = path / "meta.json"
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Failed to read Higgs voice metadata from %s: %s", meta_path, exc)
        return None
    if not isinstance(meta, dict) or not meta.get("name"):
        return None
    reference_text_path = path / "reference.txt"
    reference_codes_path = path / "reference_codes.json"
    audio_suffixes = {".wav", ".mp3", ".flac", ".ogg", ".webm", ".aac"}
    audio_path = next((
        item for item in sorted(path.iterdir())
        if item.name.startswith("reference.")
        and item.is_file()
        and item.suffix.lower() in audio_suffixes
    ), None)
    reference_audio = ""
    reference_audio_path = ""
    reference_audio_name = ""
    if audio_path:
        reference_audio_path = str(audio_path)
        reference_audio_name = audio_path.name
        try:
            suffix = audio_path.suffix.lower()
            media_type = {
                ".wav": "audio/wav",
                ".mp3": "audio/mpeg",
                ".flac": "audio/flac",
                ".ogg": "audio/ogg",
                ".webm": "audio/webm",
                ".aac": "audio/aac",
            }.get(suffix, "audio/wav")
            reference_audio = f"data:{media_type};base64,{base64.b64encode(audio_path.read_bytes()).decode('ascii')}"
        except Exception as exc:
            logger.warning("Failed to read Higgs voice audio from %s: %s", audio_path, exc)
    return {
        "id": str(meta.get("id") or path.name),
        "name": str(meta.get("name") or "").strip(),
        "higgs_base_url": str(meta.get("higgs_base_url") or "http://localhost:8002"),
        "reference_audio": reference_audio,
        "reference_audio_path": reference_audio_path,
        "reference_audio_name": reference_audio_name,
        "reference_url": str(meta.get("reference_url") or ""),
        "reference_text": reference_text_path.read_text(encoding="utf-8") if reference_text_path.exists() else str(meta.get("reference_text") or ""),
        "reference_codes_json": reference_codes_path.read_text(encoding="utf-8") if reference_codes_path.exists() else str(meta.get("reference_codes_json") or ""),
        "created_at": str(meta.get("created_at") or ""),
        "updated_at": str(meta.get("updated_at") or ""),
    }


def _read_directory_higgs_voice_presets() -> list[dict[str, Any]]:
    voices_dir = _higgs_voices_dir()
    if not voices_dir.exists():
        return []
    presets: list[dict[str, Any]] = []
    for path in sorted(item for item in voices_dir.iterdir() if item.is_dir()):
        preset = _read_voice_dir_preset(path)
        if preset and preset.get("name"):
            presets.append(preset)
    return presets


def _clear_legacy_higgs_voice_presets(path: Path) -> None:
    try:
        path.write_text("[]\n", encoding="utf-8")
    except Exception as exc:
        logger.warning("Failed to clear migrated Higgs legacy presets at %s: %s", path, exc)


def _migrate_legacy_higgs_voice_presets() -> None:
    legacy_path = _higgs_voice_presets_path()
    legacy_presets = _read_legacy_higgs_voice_presets()
    if not legacy_presets:
        return
    existing_names = {
        str(preset.get("name") or "")
        for preset in _read_directory_higgs_voice_presets()
        if preset.get("name")
    }
    for preset in legacy_presets:
        name = str(preset.get("name") or "").strip()
        if not name or name in existing_names:
            continue
        try:
            stored = _write_voice_directory_preset(
                {
                    "name": name,
                    "higgs_base_url": _normalize_higgs_base_url(str(preset.get("higgs_base_url") or "")),
                    "reference_url": str(preset.get("reference_url") or ""),
                    "created_at": str(preset.get("created_at") or datetime.now().isoformat(timespec="seconds")),
                    "updated_at": str(preset.get("updated_at") or datetime.now().isoformat(timespec="seconds")),
                },
                HiggsVoicePresetRequest(
                    name=name,
                    higgs_base_url=str(preset.get("higgs_base_url") or "http://localhost:8002"),
                    reference_audio=str(preset.get("reference_audio") or ""),
                    reference_url=str(preset.get("reference_url") or ""),
                    reference_text=str(preset.get("reference_text") or ""),
                    reference_codes_json=str(preset.get("reference_codes_json") or ""),
                ),
            )
            existing_names.add(str(stored.get("name") or name))
        except Exception as exc:
            logger.warning("Failed to migrate Higgs legacy voice preset %s: %s", name, exc)
            return
    _clear_legacy_higgs_voice_presets(legacy_path)


def _read_higgs_voice_presets() -> list[dict[str, Any]]:
    _migrate_legacy_higgs_voice_presets()
    by_name: dict[str, dict[str, Any]] = {}
    for preset in _read_directory_higgs_voice_presets():
        if preset.get("name"):
            by_name[str(preset["name"])] = preset
    return sorted(by_name.values(), key=lambda item: str(item.get("name") or "").lower())


def _write_voice_directory_preset(preset: dict[str, Any], request: HiggsVoicePresetRequest) -> dict[str, Any]:
    voice_id = _voice_id_from_name(str(preset["name"]))
    voice_dir = _higgs_voices_dir() / voice_id
    voice_dir.mkdir(parents=True, exist_ok=True)

    reference_audio = request.reference_audio.strip()
    reference_audio_path = ""
    reference_audio_name = ""
    parsed_audio = _split_data_url(reference_audio)
    if parsed_audio:
        media_type, audio_bytes = parsed_audio
        audio_path = voice_dir / f"reference{_media_extension(media_type)}"
        for old_audio in voice_dir.glob("reference.*"):
            if old_audio != audio_path:
                old_audio.unlink(missing_ok=True)
        audio_path.write_bytes(audio_bytes)
        reference_audio_path = str(audio_path)
        reference_audio_name = audio_path.name
    elif reference_audio:
        # Keep non-data URL references in metadata. They may be remote URLs or
        # paths understood by the Higgs service.
        reference_audio_path = reference_audio

    reference_text = request.reference_text.strip()
    reference_codes_json = request.reference_codes_json.strip()
    if reference_text:
        (voice_dir / "reference.txt").write_text(reference_text, encoding="utf-8")
    else:
        (voice_dir / "reference.txt").unlink(missing_ok=True)
    if reference_codes_json:
        (voice_dir / "reference_codes.json").write_text(reference_codes_json, encoding="utf-8")
    else:
        (voice_dir / "reference_codes.json").unlink(missing_ok=True)

    metadata = {
        "id": voice_id,
        "name": preset["name"],
        "higgs_base_url": preset["higgs_base_url"],
        "reference_url": preset["reference_url"],
        "reference_audio_path": reference_audio_path,
        "reference_audio_name": reference_audio_name,
        "created_at": preset["created_at"],
        "updated_at": preset["updated_at"],
    }
    (voice_dir / "meta.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    stored = _read_voice_dir_preset(voice_dir)
    if not stored:
        raise ValueError("音色保存后读取失败")
    return stored


def _find_higgs_voice_preset(name: str) -> dict[str, Any] | None:
    target = (name or "").strip()
    if not target:
        return None
    for preset in _read_higgs_voice_presets():
        if preset.get("name") == target:
            return preset
    return None


def _upsert_higgs_voice_preset(request: HiggsVoicePresetRequest) -> dict[str, Any]:
    name = _clean_voice_name(request.name)
    reference_audio = request.reference_audio.strip()
    reference_url = request.reference_url.strip()
    reference_text = request.reference_text.strip()
    reference_codes_json = request.reference_codes_json.strip()
    if not reference_audio and not reference_url and not reference_codes_json:
        raise ValueError("请至少提供参考音频、参考音频链接或 Code JSON")
    if reference_codes_json:
        _parse_reference_codes(reference_codes_json)
    now = datetime.now().isoformat(timespec="seconds")
    presets = _read_higgs_voice_presets()
    existing = next((item for item in presets if item.get("name") == name), None)
    created_at = str(existing.get("created_at") or now) if existing else now
    preset = {
        "name": name,
        "higgs_base_url": _normalize_higgs_base_url(request.higgs_base_url),
        "reference_audio": reference_audio,
        "reference_url": reference_url,
        "reference_text": reference_text,
        "reference_codes_json": reference_codes_json,
        "created_at": created_at,
        "updated_at": now,
    }
    return _write_voice_directory_preset(preset, request)


def _higgs_json_request(base_url: str, path: str, timeout: float = 20.0) -> Any:
    url = f"{_normalize_higgs_base_url(base_url)}{path}"
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as resp:
            import json

            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Higgs API HTTP {exc.code}: {body[:1000] or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Higgs API unavailable: {exc.reason}") from exc


def _higgs_audio_request(payload: dict[str, Any], base_url: str, timeout: float = 1800.0, api_token: str = "") -> tuple[bytes, str, dict[str, str]]:
    import json

    url = _higgs_speech_url(base_url)
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=_higgs_auth_headers(api_token),
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as resp:
            headers = {key.lower(): value for key, value in resp.headers.items()}
            media_type = headers.get("content-type", "audio/wav").split(";", 1)[0]
            return resp.read(), media_type, headers
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Higgs API HTTP {exc.code}: {body[:1000] or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Higgs API unavailable: {exc.reason}") from exc


def _higgs_audio_stream_request(
    payload: dict[str, Any],
    base_url: str,
    timeout: float = 1800.0,
    chunk_size: int = 32768,
    api_token: str = "",
) -> Iterator[tuple[bytes, str, dict[str, str]]]:
    import json

    url = _higgs_speech_url(base_url)
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=_higgs_auth_headers(api_token),
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as resp:
            headers = {key.lower(): value for key, value in resp.headers.items()}
            media_type = headers.get("content-type", "audio/pcm").split(";", 1)[0]
            channels = int(headers.get("x-channels", "1") or "1")
            bit_depth = int(headers.get("x-bit-depth", "16") or "16")
            if channels != 1 or bit_depth != 16:
                raise RuntimeError(f"Unsupported Higgs stream format: channels={channels}, bit_depth={bit_depth}")
            while True:
                chunk = resp.read(chunk_size)
                if not chunk:
                    break
                if len(chunk) % 2:
                    chunk = chunk[:-1]
                if not chunk:
                    continue
                yield chunk, media_type, headers
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Higgs API HTTP {exc.code}: {body[:1000] or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Higgs API unavailable: {exc.reason}") from exc


async def _aiter_higgs_audio_stream_request(
    payload: dict[str, Any],
    base_url: str,
    timeout: float = 1800.0,
    chunk_size: int | None = None,
    api_token: str = "",
) -> AsyncIterator[tuple[bytes, str, dict[str, str]]]:
    url = _higgs_speech_url(base_url)
    request_timeout = httpx.Timeout(timeout, connect=15.0)
    async with httpx.AsyncClient(timeout=request_timeout, trust_env=False) as client:
        try:
            async with client.stream(
                "POST",
                url,
                json=payload,
                headers=_higgs_auth_headers(api_token),
            ) as resp:
                body = b""
                if resp.status_code >= 400:
                    body = await resp.aread()
                    detail = body.decode("utf-8", errors="replace")
                    raise RuntimeError(f"Higgs API HTTP {resp.status_code}: {detail[:1000] or resp.reason_phrase}")
                headers = {key.lower(): value for key, value in resp.headers.items()}
                media_type = headers.get("content-type", "audio/pcm").split(";", 1)[0]
                channels = int(headers.get("x-channels", "1") or "1")
                bit_depth = int(headers.get("x-bit-depth", "16") or "16")
                if channels != 1 or bit_depth != 16:
                    raise RuntimeError(f"Unsupported Higgs stream format: channels={channels}, bit_depth={bit_depth}")
                # Do not aggregate Higgs' first codec frame into a larger
                # application buffer. The upstream first chunk is already
                # playable PCM and defines time-to-first-audio.
                iterator = resp.aiter_raw(chunk_size=chunk_size)
                async for chunk in iterator:
                    if not chunk:
                        continue
                    if len(chunk) % 2:
                        chunk = chunk[:-1]
                    if not chunk:
                        continue
                    yield chunk, media_type, headers
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Higgs API unavailable: {exc}") from exc


_HIGGS_EMOTIONS = {
    "affection",
    "amusement",
    "anger",
    "arousal",
    "awe",
    "bitterness",
    "confusion",
    "contemplation",
    "contentment",
    "determination",
    "disgust",
    "elation",
    "enthusiasm",
    "fear",
    "helplessness",
    "longing",
    "pride",
    "relief",
    "sadness",
    "shame",
    "surprise",
}
_HIGGS_STYLES = {"singing", "shouting", "whispering"}
_HIGGS_PROSODY_SPEEDS = {"speed_very_slow", "speed_slow", "speed_fast", "speed_very_fast"}
_HIGGS_PITCHES = {"pitch_low", "pitch_high"}
_HIGGS_EXPRESSIVENESS = {"expressive_high", "expressive_low"}


def _tagged_text(request: HiggsTTSRequest) -> str:
    tags: list[str] = []
    emotion = request.emotion.strip()
    style = request.style.strip()
    prosody_speed = request.prosody_speed.strip()
    pitch = request.pitch.strip()
    expressiveness = request.expressiveness.strip()
    if emotion in _HIGGS_EMOTIONS:
        tags.append(f"<|emotion:{emotion}|>")
    if style in _HIGGS_STYLES:
        tags.append(f"<|style:{style}|>")
    if prosody_speed in _HIGGS_PROSODY_SPEEDS:
        tags.append(f"<|prosody:{prosody_speed}|>")
    if pitch in _HIGGS_PITCHES:
        tags.append(f"<|prosody:{pitch}|>")
    if expressiveness in _HIGGS_EXPRESSIVENESS:
        tags.append(f"<|prosody:{expressiveness}|>")
    return "".join(tags) + request.text.strip()


def _parse_reference_codes(value: str) -> list[list[int]] | None:
    raw = value.strip()
    if not raw:
        return None
    try:
        codes = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"reference_codes is not valid JSON: {exc}") from exc
    if not isinstance(codes, list) or any(
        not isinstance(row, list)
        or len(row) != 8
        or any(not isinstance(item, int) for item in row)
        for row in codes
    ):
        raise ValueError("reference_codes must be a JSON array shaped [T,8] with integer values")
    return codes


def _build_higgs_payload(request: HiggsTTSRequest) -> dict[str, Any]:
    voice = request.voice.strip() or "default"
    reference_audio = request.reference_audio.strip()
    reference_url = request.reference_url.strip()
    reference_text = request.reference_text
    reference_codes_json = request.reference_codes_json.strip()
    if not reference_audio and not reference_url and not reference_codes_json and voice != "default":
        preset = _find_higgs_voice_preset(voice)
        if preset:
            reference_audio = str(preset.get("reference_audio") or "").strip()
            reference_url = str(preset.get("reference_url") or "").strip()
            reference_text = str(preset.get("reference_text") or "")
            reference_codes_json = str(preset.get("reference_codes_json") or "").strip()

    if request.provider == "boson":
        payload: dict[str, Any] = {
            "model": request.model.strip() or "higgs-audio-v3-tts",
            "input": _tagged_text(request),
            "voice": voice,
            "response_format": "pcm" if request.stream else request.response_format,
            "stream": request.stream,
        }
        audio_source = reference_audio or reference_url
        if audio_source:
            payload["ref_audio"] = audio_source
            if reference_text:
                payload["ref_text"] = reference_text
        return payload

    payload = {
        "input": _tagged_text(request),
        "voice": voice,
        "response_format": "pcm" if request.stream else request.response_format,
        "stream": request.stream,
        "max_new_tokens": request.max_new_tokens,
        "temperature": request.temperature,
    }
    if abs(request.speed - 1.0) > 1e-9:
        payload["speed"] = request.speed
    if request.top_p > 0:
        payload["top_p"] = request.top_p
    if request.top_k > 0:
        payload["top_k"] = request.top_k
    if request.seed >= 0:
        payload["seed"] = request.seed
    if request.stream:
        payload["initial_codec_chunk_frames"] = request.initial_codec_chunk_frames
    reference_codes = _parse_reference_codes(reference_codes_json)
    if reference_codes is not None:
        payload["reference_codes"] = reference_codes
        payload["reference_text"] = reference_text
    else:
        audio_source = reference_audio or reference_url
        if audio_source:
            payload["references"] = [{"audio_path": audio_source, "text": reference_text}]
    return payload


def _audio_headers(
    *,
    filename: str,
    timing: dict[str, float],
    extra: dict[str, str] | None = None,
) -> dict[str, str]:
    headers = {
        "Content-Disposition": f"inline; filename={filename}",
        "X-Timing-Total": f"{timing.get('total_sec', 0):.3f}",
        "X-Timing-ASR": f"{timing.get('asr_sec', 0):.3f}",
        "X-Timing-TTS": f"{timing.get('tts_sec', 0):.3f}",
        "X-Timing-Higgs-Network": f"{timing.get('higgs_network_sec', 0):.3f}",
    }
    if extra:
        headers.update(extra)
    return headers


def _stream_tts_config(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "higgs_base_url": str(data.get("higgs_base_url") or "http://localhost:8002"),
        "provider": str(data.get("provider") or "local"),
        "api_token": str(data.get("api_token") or ""),
        "model": str(data.get("model") or "higgs-audio-v3-tts"),
        "voice": str(data.get("voice") or "default"),
        "response_format": str(data.get("response_format") or "wav"),
        "speed": float(data.get("speed") or 1.0),
        "temperature": float(data.get("temperature") if data.get("temperature") is not None else 0.7),
        "top_p": float(data.get("top_p") if data.get("top_p") is not None else 0.95),
        "top_k": int(data.get("top_k") or 50),
        "seed": int(data.get("seed") if data.get("seed") is not None else -1),
        "max_new_tokens": int(data.get("max_new_tokens") or 2048),
        "reference_audio": str(data.get("reference_audio") or ""),
        "reference_url": str(data.get("reference_url") or ""),
        "reference_text": str(data.get("reference_text") or ""),
        "reference_codes_json": str(data.get("reference_codes_json") or ""),
        "emotion": str(data.get("emotion") or ""),
        "style": str(data.get("style") or ""),
        "prosody_speed": str(data.get("prosody_speed") or ""),
        "pitch": str(data.get("pitch") or ""),
        "expressiveness": str(data.get("expressiveness") or ""),
        "initial_codec_chunk_frames": int(data.get("initial_codec_chunk_frames") if data.get("initial_codec_chunk_frames") is not None else 1),
        "stream": bool(data.get("stream") if data.get("stream") is not None else True),
        "speculative_partial_tts": bool(data.get("speculative_partial_tts") if data.get("speculative_partial_tts") is not None else True),
        "partial_first_min_chars": max(2, int(data.get("partial_first_min_chars") or 6)),
        "partial_segment_min_chars": max(2, int(data.get("partial_segment_min_chars") or 8)),
        "partial_max_chars": max(6, int(data.get("partial_max_chars") or 8)),
        "partial_lookahead_chars": max(1, int(data.get("partial_lookahead_chars") or 1)),
        "echo_guard_window_sec": max(1.0, float(data.get("echo_guard_window_sec") or 8.0)),
    }


def _event_asr_sec(event: dict[str, Any]) -> float:
    for value in (event.get("asr_elapsed_sec"), event.get("duration_sec")):
        try:
            parsed = max(0.0, float(value or 0))
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            return parsed
    return 0.0


_STRONG_TTS_BOUNDARY_RE = re.compile(r"[。！？!?；;\n]+[\"'”’）】》」』]*")
_WEAK_TTS_BOUNDARY_RE = re.compile(r"[，,、：:]\s*")
_SPACE_TTS_BOUNDARY_RE = re.compile(r"\s+")
_HIGGS_STREAM_WARMED: set[tuple[str, str]] = set()
_HIGGS_STREAM_WARM_LOCK = asyncio.Lock()


@dataclass
class _IncrementalTTSState:
    """Tracks cumulative ASR hypotheses already committed to audible speech."""

    job_id: Any = None
    committed_text: str = ""
    segment_index: int = 0

    def reset(self, job_id: Any) -> None:
        self.job_id = job_id
        self.committed_text = ""
        self.segment_index = 0


def _stream_tts_incremental_segments(
    event: dict[str, Any],
    *,
    state: _IncrementalTTSState,
    config: dict[str, Any],
) -> list[tuple[str, int]]:
    """Extract new stable text from cumulative partial/final ASR events."""

    event_type = str(event.get("type") or "")
    if event_type not in {"partial", "final"}:
        return []
    if event_type == "partial" and not bool(config.get("speculative_partial_tts", True)):
        return []

    raw_hypothesis = event.get("stable_text") if event_type == "partial" else event.get("text")
    hypothesis = str(raw_hypothesis or "").strip()
    if not hypothesis:
        return []

    committed = state.committed_text
    if not hypothesis.startswith(committed):
        # Never slice a corrected final by character count. Once a prefix has
        # been spoken it cannot be retracted; emitting a positional suffix is
        # what produced semantically broken fragments in the previous design.
        return []
    remainder = hypothesis[len(committed) :]

    if not remainder:
        return []
    if event_type == "partial":
        minimum = int(config.get(
            "partial_first_min_chars" if not committed else "partial_segment_min_chars",
            6 if not committed else 8,
        ))
        cut = _choose_stable_tts_cut(
            remainder,
            minimum=minimum,
            maximum=int(config.get("partial_max_chars") or 8),
            lookahead=int(config.get("partial_lookahead_chars") or 1),
        )
        if cut is None:
            return []
        segment = remainder[:cut].strip()
        committed_end = len(committed) + cut
        state.committed_text = hypothesis[:committed_end]
    else:
        segment = remainder.strip()
        state.committed_text = hypothesis

    if not segment or not re.search(r"[\w\u3400-\u9fff]", segment):
        return []
    state.segment_index += 1
    return [(segment, state.segment_index)]


def _choose_stable_tts_cut(
    text: str,
    *,
    minimum: int,
    maximum: int,
    lookahead: int = 1,
) -> int | None:
    """Choose a natural boundary, or a stable prefix with retained look-ahead."""

    strong = [match.end() for match in _STRONG_TTS_BOUNDARY_RE.finditer(text)]
    for position in strong:
        if len(text[:position].strip()) >= minimum:
            return position

    weak = [match.end() for match in _WEAK_TTS_BOUNDARY_RE.finditer(text)]
    for position in weak:
        if len(text[:position].strip()) >= minimum:
            return position

    # X-ASR often emits no punctuation until final. Waiting only for commas or
    # full stops therefore degenerates into final-only TTS. Once enough text is
    # stable, retain a short unspoken look-ahead and submit the older prefix.
    # This never consumes unstable_text and never rewrites spoken characters.
    if len(text.strip()) < maximum + lookahead:
        return None
    safe_limit = min(maximum, max(0, len(text) - lookahead))
    candidates = [
        match.end()
        for match in (*_WEAK_TTS_BOUNDARY_RE.finditer(text[:safe_limit]), *_SPACE_TTS_BOUNDARY_RE.finditer(text[:safe_limit]))
        if match.end() >= minimum
    ]
    if candidates:
        return candidates[-1]
    lexical_cut = _safe_lexical_cut(text, minimum=minimum, safe_limit=safe_limit)
    return lexical_cut if lexical_cut is not None else (safe_limit if safe_limit >= minimum else None)


def _safe_lexical_cut(text: str, *, minimum: int, safe_limit: int) -> int | None:
    """Prefer a Chinese word boundary before the hard stable-prefix limit."""

    try:
        import jieba  # type: ignore[import-untyped]
    except ImportError:
        return None
    offset = 0
    boundaries: list[int] = []
    for token in jieba.cut(text, cut_all=False):
        offset += len(token)
        if minimum <= offset <= safe_limit and token not in {
            "想", "对", "去", "把", "被", "在", "和", "与",
        }:
            boundaries.append(offset)
        if offset > safe_limit:
            break
    return boundaries[-1] if boundaries else None


@dataclass
class _RecentTTSFragment:
    source_job_id: Any
    text: str
    normalized: str
    expires_at: float


class _TTSEchoGuard:
    """Stop a later ASR job from re-synthesizing recently played TTS text."""

    def __init__(self, window_sec: float = 8.0) -> None:
        self.window_sec = max(1.0, window_sec)
        self._recent: list[_RecentTTSFragment] = []

    def remember(self, source_job_id: Any, text: str, *, now: float | None = None) -> None:
        normalized = _normalize_echo_text(text)
        if not normalized:
            return
        timestamp = time.monotonic() if now is None else now
        self._prune(timestamp)
        self._recent.append(
            _RecentTTSFragment(
                source_job_id=source_job_id,
                text=text,
                normalized=normalized,
                expires_at=timestamp + self.window_sec,
            )
        )
        self._recent = self._recent[-24:]

    def match(self, source_job_id: Any, text: str, *, now: float | None = None) -> str | None:
        candidate = _normalize_echo_text(text)
        if len(candidate) < 3:
            return None
        timestamp = time.monotonic() if now is None else now
        self._prune(timestamp)
        for recent in reversed(self._recent):
            if recent.source_job_id == source_job_id:
                continue
            if candidate == recent.normalized:
                return recent.text
            shorter = min(len(candidate), len(recent.normalized))
            if shorter >= 6 and (candidate in recent.normalized or recent.normalized in candidate):
                return recent.text
        return None

    def _prune(self, now: float) -> None:
        self._recent = [item for item in self._recent if item.expires_at >= now]


def _normalize_echo_text(text: str) -> str:
    return re.sub(r"[^0-9a-zA-Z\u3400-\u9fff]+", "", text).lower()


async def _warm_higgs_stream(config: dict[str, Any]) -> None:
    """Warm Higgs preprocessing/codec/vocoder before microphone capture."""

    # Load the optional Chinese tokenizer during the explicit loading phase,
    # never on the first live partial where it would add avoidable latency.
    _safe_lexical_cut("实时语音输出延迟优化", minimum=4, safe_limit=8)
    key = (_normalize_higgs_base_url(config["higgs_base_url"]), str(config["voice"]))
    if key in _HIGGS_STREAM_WARMED:
        return
    async with _HIGGS_STREAM_WARM_LOCK:
        if key in _HIGGS_STREAM_WARMED:
            return
        warm_config = {
            **config,
            "max_new_tokens": min(64, int(config.get("max_new_tokens") or 64)),
            "temperature": min(0.3, float(config.get("temperature") or 0.3)),
            "initial_codec_chunk_frames": 1,
            "stream": True,
        }
        request = _higgs_request_from_stream_text("好。", warm_config)
        async for _chunk, _media_type, _headers in _aiter_higgs_audio_stream_request(
            _build_higgs_payload(request),
            warm_config["higgs_base_url"],
            api_token=warm_config.get("api_token", ""),
        ):
            pass
        _HIGGS_STREAM_WARMED.add(key)


def _higgs_request_from_stream_text(text: str, config: dict[str, Any]) -> HiggsTTSRequest:
    segment_token_budget = max(64, len(text.strip()) * 64)
    return HiggsTTSRequest(
        text=text,
        higgs_base_url=config["higgs_base_url"],
        provider=config["provider"],
        api_token=config["api_token"],
        model=config["model"],
        voice=config["voice"],
        response_format=config["response_format"],
        speed=config["speed"],
        temperature=config["temperature"],
        top_p=config["top_p"],
        top_k=config["top_k"],
        seed=config["seed"],
        max_new_tokens=min(int(config["max_new_tokens"]), segment_token_budget),
        reference_audio=config["reference_audio"],
        reference_url=config["reference_url"],
        reference_text=config["reference_text"],
        reference_codes_json=config["reference_codes_json"],
        emotion=config["emotion"],
        style=config["style"],
        prosody_speed=config["prosody_speed"],
        pitch=config["pitch"],
        expressiveness=config["expressiveness"],
        initial_codec_chunk_frames=config["initial_codec_chunk_frames"],
        stream=bool(config.get("stream", True)),
    )


def _synthesize_stream_tts_event(
    *,
    session_id: str,
    job_id: Any,
    text: str,
    asr_sec: float,
    config: dict[str, Any],
) -> dict[str, Any]:
    tts_started = time.perf_counter()
    request = _higgs_request_from_stream_text(text, config)
    audio_bytes, media_type, higgs_headers = _higgs_audio_request(
        _build_higgs_payload(request),
        config["higgs_base_url"],
        api_token=config.get("api_token", ""),
    )
    tts_sec = time.perf_counter() - tts_started
    return {
        "type": "tts",
        "session_id": session_id,
        "job_id": job_id,
        "text": text,
        "media_type": media_type,
        "audio_b64": base64.b64encode(audio_bytes).decode("ascii"),
        "sample_rate": higgs_headers.get("x-sample-rate"),
        "timing": {
            "asr_sec": round(asr_sec, 3),
            "tts_sec": round(tts_sec, 3),
            "higgs_network_sec": round(tts_sec, 3),
            "total_sec": round(asr_sec + tts_sec, 3),
        },
    }


async def _send_websocket_json(
    websocket: WebSocket,
    payload: dict[str, Any],
    send_lock: asyncio.Lock | None = None,
) -> None:
    message = json.dumps(payload, ensure_ascii=False)
    if send_lock is None:
        await websocket.send_text(message)
        return
    async with send_lock:
        await websocket.send_text(message)


def _pcm_rms(pcm: bytes) -> float:
    even = len(pcm) - len(pcm) % 2
    if even <= 0:
        return 0.0
    samples = memoryview(pcm[:even]).cast("h")
    return math.sqrt(sum(int(sample) * int(sample) for sample in samples) / len(samples))


class _PCMBoundaryGate:
    """Drop leading silence and cap internal/trailing silence between TTS jobs."""

    def __init__(
        self,
        sample_rate: int,
        *,
        threshold: float = 320.0,
        block_ms: int = 20,
        max_internal_silence_ms: int = 160,
        keep_trailing_silence_ms: int = 40,
    ) -> None:
        self.block_bytes = max(2, sample_rate * 2 * block_ms // 1000)
        self.max_internal_bytes = sample_rate * 2 * max_internal_silence_ms // 1000
        self.keep_trailing_bytes = sample_rate * 2 * keep_trailing_silence_ms // 1000
        self.sample_rate = sample_rate
        self.block_ms = block_ms
        self.threshold = threshold
        self.buffer = bytearray()
        self.pending_silence = bytearray()
        self.started = False
        self.trimmed_bytes = 0
        self.voiced_blocks = 0

    @property
    def voiced_ms(self) -> int:
        return self.voiced_blocks * self.block_ms

    @property
    def trailing_silence_ms(self) -> float:
        return len(self.pending_silence) / (self.sample_rate * 2) * 1000

    def feed(self, pcm: bytes) -> list[bytes]:
        self.buffer.extend(pcm)
        output = bytearray()
        while len(self.buffer) >= self.block_bytes:
            block = bytes(self.buffer[: self.block_bytes])
            del self.buffer[: self.block_bytes]
            self._process_block(block, output)
        return [bytes(output)] if output else []

    def finish(self) -> list[bytes]:
        output = bytearray()
        if self.buffer:
            block = bytes(self.buffer)
            self.buffer.clear()
            self._process_block(block, output)
        if self.started and self.pending_silence:
            keep = min(len(self.pending_silence), self.keep_trailing_bytes)
            output.extend(self.pending_silence[:keep])
            self.trimmed_bytes += len(self.pending_silence) - keep
        else:
            self.trimmed_bytes += len(self.pending_silence)
        self.pending_silence.clear()
        return [bytes(output)] if output else []

    def _process_block(self, block: bytes, output: bytearray) -> None:
        if _pcm_rms(block) < self.threshold:
            self.pending_silence.extend(block)
            return
        if self.started and self.pending_silence:
            keep = min(len(self.pending_silence), self.max_internal_bytes)
            output.extend(self.pending_silence[:keep])
            self.trimmed_bytes += len(self.pending_silence) - keep
        elif self.pending_silence:
            self.trimmed_bytes += len(self.pending_silence)
        self.pending_silence.clear()
        self.started = True
        self.voiced_blocks += 1
        output.extend(block)


async def _send_stream_tts_events(
    websocket: WebSocket,
    *,
    session_id: str,
    job_id: Any,
    text: str,
    asr_sec: float,
    config: dict[str, Any],
    source_event: str = "final",
    speculative: bool = False,
    segment_index: int = 1,
    send_lock: asyncio.Lock | None = None,
) -> None:
    tts_started = time.perf_counter()
    request = _higgs_request_from_stream_text(text, {**config, "stream": True})
    payload = _build_higgs_payload(request)
    await _send_websocket_json(
        websocket,
        {
            "type": "tts_start",
            "session_id": session_id,
            "job_id": job_id,
            "text": text,
            "source_event": source_event,
            "speculative": speculative,
            "segment_index": segment_index,
            "timing": {
                "asr_sec": round(asr_sec, 3),
                "total_sec": round(asr_sec, 3),
            },
        },
        send_lock,
    )

    chunks: list[bytes] = []
    raw_chunks: list[bytes] = []
    media_type = "audio/pcm"
    higgs_headers: dict[str, str] = {}
    boundary_gate: _PCMBoundaryGate | None = None
    tail_silence_aborted = False
    first_chunk_sec: float | None = None
    sequence = 0

    async def emit_chunk(chunk: bytes) -> None:
        nonlocal first_chunk_sec, sequence
        if not chunk:
            return
        sequence += 1
        chunks.append(chunk)
        elapsed = time.perf_counter() - tts_started
        if first_chunk_sec is None:
            first_chunk_sec = elapsed
        await _send_websocket_json(
            websocket,
            {
                "type": "tts_chunk",
                "session_id": session_id,
                "job_id": job_id,
                "text": text,
                "source_event": source_event,
                "speculative": speculative,
                "segment_index": segment_index,
                "seq": sequence,
                "media_type": media_type,
                "audio_b64": base64.b64encode(chunk).decode("ascii"),
                "sample_rate": higgs_headers.get("x-sample-rate") or "24000",
                "channels": int(higgs_headers.get("x-channels", "1") or "1"),
                "bit_depth": int(higgs_headers.get("x-bit-depth", "16") or "16"),
                "timing": {
                    "asr_sec": round(asr_sec, 3),
                    "tts_elapsed_sec": round(elapsed, 3),
                    "tts_first_chunk_sec": round(first_chunk_sec, 3),
                    "tts_first_token_sec": round(first_chunk_sec, 3),
                    "e2e_first_audio_sec": round(asr_sec + first_chunk_sec, 3),
                    "total_sec": round(asr_sec + elapsed, 3),
                },
            },
            send_lock,
        )

    stream_iterator = _aiter_higgs_audio_stream_request(
        payload,
        config["higgs_base_url"],
        api_token=config.get("api_token", ""),
    )
    async for item in stream_iterator:
        chunk, media_type, higgs_headers = item
        if not chunk:
            continue
        if sequence == 0:
            raw_chunks.append(chunk)
        if boundary_gate is None:
            boundary_gate = _PCMBoundaryGate(int(higgs_headers.get("x-sample-rate", "24000") or "24000"))
        for playable in boundary_gate.feed(chunk):
            await emit_chunk(playable)
        if sequence > 0:
            raw_chunks.clear()
        minimum_voiced_ms = max(300, min(1800, len(text) * 60))
        if (
            boundary_gate.voiced_ms >= minimum_voiced_ms
            and boundary_gate.trailing_silence_ms >= 900
        ):
            tail_silence_aborted = True
            await stream_iterator.aclose()
            break

    if boundary_gate is not None:
        for playable in boundary_gate.finish():
            await emit_chunk(playable)
    if sequence == 0 and raw_chunks:
        # Safety fallback for unusually quiet voices: preserve audio rather
        # than turning an over-aggressive silence threshold into a drop-out.
        await emit_chunk(b"".join(raw_chunks))

    tts_sec = time.perf_counter() - tts_started
    first_chunk_value = first_chunk_sec if first_chunk_sec is not None else tts_sec
    timing = {
        "asr_sec": round(asr_sec, 3),
        "tts_sec": round(tts_sec, 3),
        "tts_first_chunk_sec": round(first_chunk_value, 3),
        "tts_first_token_sec": round(first_chunk_value, 3),
        "higgs_network_sec": round(tts_sec, 3),
        "e2e_first_audio_sec": round(asr_sec + first_chunk_value, 3),
        "total_sec": round(asr_sec + tts_sec, 3),
    }
    audio_bytes = b"".join(chunks)
    await _send_websocket_json(
        websocket,
        {
            "type": "tts_done",
            "session_id": session_id,
            "job_id": job_id,
            "text": text,
            "source_event": source_event,
            "speculative": speculative,
            "segment_index": segment_index,
            "media_type": media_type,
            "sample_rate": higgs_headers.get("x-sample-rate") or "24000",
            "channels": int(higgs_headers.get("x-channels", "1") or "1"),
            "bit_depth": int(higgs_headers.get("x-bit-depth", "16") or "16"),
            "chunks": sequence,
            "audio_bytes": len(audio_bytes),
            "trimmed_silence_ms": round(
                (boundary_gate.trimmed_bytes / 2 / int(higgs_headers.get("x-sample-rate", "24000") or "24000") * 1000)
                if boundary_gate is not None else 0.0,
                1,
            ),
            "tail_silence_aborted": tail_silence_aborted,
            "timing": timing,
        },
        send_lock,
    )
    # NOTE: We intentionally do NOT send the full combined audio as a single
    # "tts" event here, because the incremental "tts_chunk" events already
    # delivered every byte.  Sending the same audio again base64-encoded in
    # one text frame would easily exceed the default ``websockets`` library
    # max_size of 1 MiB (1024 KiB) for utterances longer than ~16 s at 24 kHz
    # PCM16, causing “Part exceeded maximum size of 1024 KB” on the client.
    # Clients that need the complete audio can reassemble it from the chunks.


@router.get("/higgs/health", summary="Check Higgs TTS service")
async def higgs_health(
    higgs_base_url: str = Query("http://localhost:8002", description="Higgs API base URL"),
):
    started = time.perf_counter()
    try:
        data = _higgs_json_request(higgs_base_url, "/health", 10.0)
        return {
            "connected": True,
            "base_url": _normalize_higgs_base_url(higgs_base_url),
            "elapsed_sec": round(time.perf_counter() - started, 3),
            "data": data,
        }
    except Exception as exc:
        return {
            "connected": False,
            "base_url": _normalize_higgs_base_url(higgs_base_url),
            "elapsed_sec": round(time.perf_counter() - started, 3),
            "message": str(exc),
        }


@router.post("/higgs/connection", summary="Check local or Boson Higgs TTS connection")
async def higgs_connection(request: HiggsConnectionRequest):
    started = time.perf_counter()
    base_url = _normalize_higgs_base_url(request.base_url)
    try:
        if request.provider == "local":
            data = _higgs_json_request(base_url, "/health", 10.0)
        else:
            if not request.api_token.strip():
                raise ValueError("Boson API Token 不能为空")
            url = f"{base_url}/voices" if base_url.endswith("/v1") else f"{base_url}/v1/voices"
            async with httpx.AsyncClient(timeout=10.0, trust_env=False) as client:
                response = await client.get(url, headers=_higgs_auth_headers(request.api_token))
                if response.status_code >= 400:
                    raise RuntimeError(f"Boson API HTTP {response.status_code}: {response.text[:500]}")
                data = response.json() if response.content else {"ok": True}
        return {
            "connected": True,
            "base_url": base_url,
            "elapsed_sec": round(time.perf_counter() - started, 3),
            "data": data,
        }
    except Exception as exc:
        return {
            "connected": False,
            "base_url": base_url,
            "elapsed_sec": round(time.perf_counter() - started, 3),
            "message": str(exc),
        }
@router.get("/higgs/voices", summary="List Higgs voices")
async def higgs_voices(
    higgs_base_url: str = Query("http://localhost:8002", description="Higgs API base URL"),
):
    data: Any = {}
    remote_error = ""
    try:
        data = _higgs_json_request(higgs_base_url, "/v1/audio/voices", 20.0)
    except Exception as exc:
        remote_error = str(exc)

    names: list[str] = ["default"]
    candidates = data
    if isinstance(data, dict):
        candidates = data.get("voices") or data.get("data") or []
    if isinstance(candidates, list):
        for item in candidates:
            if isinstance(item, str):
                names.append(item)
            elif isinstance(item, dict) and item.get("name"):
                names.append(str(item["name"]))
    local_presets = _read_higgs_voice_presets()
    names.extend(str(preset.get("name") or "") for preset in local_presets)
    response = {
        "voices": sorted(set(name for name in names if name.strip())),
        "raw": data,
        "presets": local_presets,
    }
    if remote_error:
        response["message"] = remote_error
    return response


@router.get("/higgs/voice-presets", summary="List local Higgs voice presets")
async def higgs_voice_presets():
    presets = _read_higgs_voice_presets()
    return {
        "presets": presets,
        "voices": sorted({preset["name"] for preset in presets if preset.get("name")}),
        "path": str(_higgs_voices_dir()),
    }


@router.post("/higgs/voice-presets", summary="Save local Higgs voice preset")
async def save_higgs_voice_preset(request: HiggsVoicePresetRequest):
    try:
        preset = _upsert_higgs_voice_preset(request)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    presets = _read_higgs_voice_presets()
    return {
        "preset": preset,
        "presets": presets,
        "voices": sorted({preset_item["name"] for preset_item in presets if preset_item.get("name")}),
        "path": str(_higgs_voices_dir()),
    }


@router.post("/higgs/reference-asr", summary="Generate transcript for Higgs reference audio")
async def higgs_reference_asr(
    audio: UploadFile = File(..., description="Reference audio file"),
    engine: str = Form(default="sensevoice"),
    language: str = Form(default="zh"),
) -> dict[str, Any]:
    from app.core.asr.base import EngineOptions
    from app.core.model_manager import get_model_manager

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Audio is empty")
    started = time.perf_counter()
    try:
        asr_engine = await get_model_manager().get_engine(engine)
        result = await asr_engine.transcribe(audio_bytes, EngineOptions(language=language or None))
    except Exception as exc:
        logger.exception("Higgs reference ASR failed")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc
    return {
        "text": (result.full_text or "").strip(),
        "engine": result.engine_name,
        "language": result.language,
        "confidence": result.confidence,
        "elapsed_sec": round(time.perf_counter() - started, 3),
    }


@router.post("/higgs/speak", summary="Text → Higgs v3 TTS audio")
async def higgs_speak(request: HiggsTTSRequest) -> Response:
    started = time.perf_counter()
    try:
        payload = _build_higgs_payload(request)
        tts_started = time.perf_counter()
        audio_bytes, media_type, higgs_headers = _higgs_audio_request(
            payload,
            request.higgs_base_url,
            api_token=request.api_token,
        )
        tts_sec = time.perf_counter() - tts_started
        total_sec = time.perf_counter() - started
        extension = "wav" if request.stream else request.response_format.lower()
        return Response(
            content=audio_bytes,
            media_type=media_type,
            headers=_audio_headers(
                filename=f"higgs_tts.{extension}",
                timing={
                    "tts_sec": tts_sec,
                    "total_sec": total_sec,
                    "higgs_network_sec": tts_sec,
                },
                extra={
                    "X-TTS-Engine": "higgs",
                    "X-Higgs-Base-URL": _normalize_higgs_base_url(request.higgs_base_url),
                    "X-Higgs-Sample-Rate": higgs_headers.get("x-sample-rate", ""),
                },
            ),
        )
    except Exception as exc:
        logger.exception("Higgs speak failed")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.websocket("/higgs/stream")
async def higgs_stream(websocket: WebSocket) -> None:
    """Stream microphone PCM through backend VAD/ASR and return Higgs TTS audio.

    Client frames:
    - {"type":"config", "engine":"x-asr", "higgs_base_url":"http://localhost:8002", ...}
    - {"type":"audio", "data":"<base64 pcm_s16le>"}
    - {"type":"end"}

    Server forwards ASR session events and emits:
    - {"type":"tts_start", "text":"...", "timing":{...}}
    - {"type":"tts_chunk", "text":"...", "audio_b64":"...", "media_type":"audio/pcm", "timing":{...}}
    - {"type":"tts_done", "text":"...", "timing":{...}}
    - {"type":"tts", "text":"...", "audio_b64":"...", "media_type":"audio/pcm", "timing":{...}} for compatibility
    """

    from app.core.streaming.session import StreamingASRSession, parse_stream_config

    await websocket.accept()
    # Do not block the WebSocket handshake while FireRed VAD loads on the
    # first realtime request. The browser can connect immediately and buffer
    # its config frame while session initialisation finishes in a worker.
    await asyncio.sleep(0)
    try:
        session = await asyncio.to_thread(StreamingASRSession)
    except ModelRuntimeError as exc:
        logger.exception("Could not initialise realtime ASR/TTS model: %s", exc.detail)
        await websocket.send_text(json.dumps(exc.as_event(), ensure_ascii=False))
        await websocket.close(code=1011)
        return
    except Exception as exc:
        logger.exception("Could not initialise realtime ASR/TTS session")
        await websocket.send_text(json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False))
        await websocket.close(code=1011)
        return
    tts_config = _stream_tts_config({})
    send_lock = asyncio.Lock()
    tts_queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    await session.send_ready()

    async def tts_loop() -> None:
        while True:
            item = await tts_queue.get()
            if item is None:
                return
            try:
                await _send_stream_tts_events(
                    websocket,
                    session_id=session.session_id,
                    job_id=item["job_id"],
                    text=item["text"],
                    asr_sec=item["asr_sec"],
                    config=item["config"],
                    source_event=item["source_event"],
                    speculative=item["speculative"],
                    segment_index=item["segment_index"],
                    send_lock=send_lock,
                )
            except Exception as exc:
                failure = classify_model_error(exc, "higgs")
                logger.exception("Higgs streaming model failed: %s", failure.detail)
                await session.record_model_failure(failure)
                return

    async def send_loop() -> None:
        tts_states: dict[Any, _IncrementalTTSState] = {}
        echo_guard = _TTSEchoGuard(float(tts_config.get("echo_guard_window_sec") or 8.0))
        tts_worker = asyncio.create_task(tts_loop())
        while True:
            event: dict[str, Any] = await session.queue.get()
            event_type = str(event.get("type") or "")
            if event_type == "done":
                await tts_queue.put(None)
                await tts_worker
                await _send_websocket_json(websocket, event, send_lock)
                return
            await _send_websocket_json(websocket, event, send_lock)
            if event_type == "error" and event.get("fatal"):
                if not tts_worker.done():
                    tts_worker.cancel()
                    await asyncio.gather(tts_worker, return_exceptions=True)
                try:
                    await websocket.close(code=1011)
                except (WebSocketDisconnect, RuntimeError):
                    pass
                return
            if event_type == "speech_start":
                job_id = event.get("job_id")
                state = _IncrementalTTSState()
                state.reset(job_id)
                tts_states[job_id] = state
            if event_type in {"partial", "final"}:
                job_id = event.get("job_id")
                state = tts_states.setdefault(job_id, _IncrementalTTSState(job_id=job_id))
                for text, segment_index in _stream_tts_incremental_segments(
                    event,
                    state=state,
                    config=tts_config,
                ):
                    echoed_text = echo_guard.match(job_id, text)
                    if echoed_text is not None:
                        await _send_websocket_json(
                            websocket,
                            {
                                "type": "echo_suppressed",
                                "session_id": session.session_id,
                                "job_id": job_id,
                                "text": text,
                                "matched_tts_text": echoed_text,
                                "window_sec": echo_guard.window_sec,
                            },
                            send_lock,
                        )
                        continue
                    echo_guard.remember(job_id, text)
                    await tts_queue.put(
                        {
                            "job_id": f"{job_id}:{segment_index}",
                            "text": text,
                            "asr_sec": _event_asr_sec(event),
                            "config": dict(tts_config),
                            "source_event": event_type,
                            "speculative": event_type == "partial",
                            "segment_index": segment_index,
                        }
                    )
                if event_type == "final":
                    tts_states.pop(job_id, None)

    sender = asyncio.create_task(send_loop())
    failed = False
    try:
        while True:
            message = await websocket.receive()
            if message.get("bytes") is not None:
                await session.accept_audio(message["bytes"] or b"")
                continue
            if message.get("text") is None:
                if message.get("type") == "websocket.disconnect":
                    break
                continue
            data = parse_stream_config(message["text"])
            msg_type = data.get("type")
            if msg_type == "config":
                session.update_config(data)
                tts_config = _stream_tts_config(data)
                await session.queue.put(
                    {
                        "type": "loading",
                        "session_id": session.session_id,
                        "message": "正在预热流式 VAD、ASR 与 TTS 模型",
                        "state": session.state,
                    }
                )
                await asyncio.gather(session.prepare(), _warm_higgs_stream(tts_config))
                await session.queue.put(
                    {
                        "type": "configured",
                        "session_id": session.session_id,
                        "engine": session.config.engine,
                        "language": session.config.language,
                        "tts_engine": "higgs",
                        "tts_stream": bool(tts_config.get("stream", True)),
                        "speculative_partial_tts": bool(tts_config.get("speculative_partial_tts", True)),
                        "higgs_base_url": _normalize_higgs_base_url(tts_config["higgs_base_url"]),
                        "voice": tts_config["voice"],
                        "state": session.state,
                    }
                )
            elif msg_type == "audio":
                payload = data.get("data")
                if not isinstance(payload, str):
                    raise ValueError("audio text frames require base64 string field 'data'")
                await session.accept_audio(base64.b64decode(payload))
            elif msg_type == "end":
                break
            elif msg_type == "ping":
                await session.queue.put({"type": "pong", "session_id": session.session_id, "state": session.state})
            else:
                raise ValueError(f"Unknown stream message type: {msg_type}")
    except WebSocketDisconnect:
        pass
    except ModelRuntimeError as exc:
        failed = True
        logger.exception("Realtime ASR/TTS model failed: %s", exc.detail)
        await session.record_model_failure(exc)
    except Exception as exc:
        failed = True
        logger.exception("Higgs stream failed: %s", exc)
        await session.queue.put(
            {
                "type": "error",
                "code": "stream_failed",
                "session_id": session.session_id,
                "message": str(exc),
                "fatal": True,
            }
        )
    finally:
        if failed or session.fatal_error is not None:
            await session.abort()
        else:
            await session.finish()
        await sender
        try:
            await websocket.close()
        except Exception:
            pass


@router.post("/higgs/audio-to-speech", summary="Audio → ASR → Higgs v3 TTS audio")
async def higgs_audio_to_speech(
    audio: UploadFile = File(..., description="Audio file from recorder or upload"),
    higgs_base_url: str = Form(default="http://localhost:8002"),
    provider: str = Form(default="local"),
    api_token: str = Form(default=""),
    model: str = Form(default="higgs-audio-v3-tts"),
    voice: str = Form(default="default"),
    response_format: str = Form(default="wav"),
    speed: float = Form(default=1.0),
    temperature: float = Form(default=0.7),
    top_p: float = Form(default=0.95),
    top_k: int = Form(default=50),
    seed: int = Form(default=-1),
    max_new_tokens: int = Form(default=2048),
    reference_audio: str = Form(default=""),
    reference_url: str = Form(default=""),
    reference_text: str = Form(default=""),
    reference_codes_json: str = Form(default=""),
    emotion: str = Form(default=""),
    style: str = Form(default=""),
    prosody_speed: str = Form(default=""),
    pitch: str = Form(default=""),
    expressiveness: str = Form(default=""),
    initial_codec_chunk_frames: int = Form(default=1),
    engine: str = Form(default="fireredasr2"),
    language: str = Form(default="zh"),
) -> Response:
    from app.core.asr.base import EngineOptions
    from app.core.model_manager import get_model_manager

    total_started = time.perf_counter()
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Audio is empty")

    try:
        asr_started = time.perf_counter()
        asr_engine = await get_model_manager().get_engine(engine)
        asr_result = await asr_engine.transcribe(audio_bytes, EngineOptions(language=language or None))
        asr_sec = time.perf_counter() - asr_started
        text = (asr_result.full_text or "").strip()
        if not text:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="ASR returned empty text")
        reference_audio_v = reference_audio if isinstance(reference_audio, str) else ""
        reference_url_v = reference_url if isinstance(reference_url, str) else ""
        reference_text_v = reference_text if isinstance(reference_text, str) else ""
        reference_codes_json_v = reference_codes_json if isinstance(reference_codes_json, str) else ""
        emotion_v = emotion if isinstance(emotion, str) else ""
        style_v = style if isinstance(style, str) else ""
        prosody_speed_v = prosody_speed if isinstance(prosody_speed, str) else ""
        pitch_v = pitch if isinstance(pitch, str) else ""
        expressiveness_v = expressiveness if isinstance(expressiveness, str) else ""
        initial_codec_chunk_frames_v = (
            int(initial_codec_chunk_frames)
            if isinstance(initial_codec_chunk_frames, int | float | str)
            else 1
        )

        tts_request = HiggsTTSRequest(
            text=text,
            higgs_base_url=higgs_base_url,
            provider=provider,
            api_token=api_token,
            model=model,
            voice=voice,
            response_format=response_format,
            speed=speed,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            seed=seed,
            max_new_tokens=max_new_tokens,
            reference_audio=reference_audio_v,
            reference_url=reference_url_v,
            reference_text=reference_text_v,
            reference_codes_json=reference_codes_json_v,
            emotion=emotion_v,
            style=style_v,
            prosody_speed=prosody_speed_v,
            pitch=pitch_v,
            expressiveness=expressiveness_v,
            initial_codec_chunk_frames=initial_codec_chunk_frames_v,
        )
        tts_started = time.perf_counter()
        audio_out, media_type, higgs_headers = _higgs_audio_request(
            _build_higgs_payload(tts_request),
            higgs_base_url,
            api_token=api_token,
        )
        tts_sec = time.perf_counter() - tts_started
        total_sec = time.perf_counter() - total_started
        metadata = HiggsAudioToSpeechMetadata(
            text=text,
            engine=asr_result.engine_name,
            language=asr_result.language,
            confidence=asr_result.confidence,
            timing=HiggsAudioTiming(
                asr_sec=round(asr_sec, 3),
                tts_sec=round(tts_sec, 3),
                total_sec=round(total_sec, 3),
            ),
        )
        import base64

        return Response(
            content=audio_out,
            media_type=media_type,
            headers=_audio_headers(
                filename=f"voice_to_higgs.{response_format.lower()}",
                timing={
                    "asr_sec": asr_sec,
                    "tts_sec": tts_sec,
                    "total_sec": total_sec,
                    "higgs_network_sec": tts_sec,
                },
                extra={
                    "X-TTS-Engine": "higgs",
                    "X-ASR-Engine": asr_result.engine_name,
                    "X-ASR-Language": asr_result.language or "",
                    "X-ASR-Confidence": "" if asr_result.confidence is None else f"{asr_result.confidence:.4f}",
                    "X-ASR-Text-B64": base64.b64encode(text.encode("utf-8")).decode("ascii"),
                    "X-Higgs-Sample-Rate": higgs_headers.get("x-sample-rate", ""),
                    "X-Pipeline-Metadata-B64": base64.b64encode(metadata.model_dump_json().encode("utf-8")).decode("ascii"),
                },
            ),
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Higgs audio-to-speech failed")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc


@router.post("/speak", summary="Synthesize speech (GPT-SoVITS or VoxCPM2)")
async def tts_speak(request: TTSRequest) -> Response:
    """Convert text to speech. Select engine via 'engine' field.

    - gpt_sovits: GPT-SoVITS V2 with voice cloning (HTTP server, port 9880)
    - voxcpm2: VoxCPM2 2B model (direct GPU, 48kHz, 30 languages)
    """
    engine = request.engine
    from runner.tts.base import TTSRequest as RunnerTTSRequest

    try:
        if engine == "voxcpm2":
            from runner.tts.voxcpm import VoxCPMProvider
            tts = VoxCPMProvider()
        else:
            from runner.tts.gpt_sovits import GPTSoVITSTTS
            tts = GPTSoVITSTTS(
                text_lang=request.text_lang,
                speed=request.speed,
            )

        result = tts.synthesize(RunnerTTSRequest(
            text=request.text,
            speed=request.speed,
        ))

        if result.success and result.audio_path:
            audio_bytes = Path(result.audio_path).read_bytes()
            return Response(
                content=audio_bytes,
                media_type="audio/wav",
                headers={
                    "Content-Disposition": "inline; filename=speech.wav",
                    "X-TTS-Engine": result.provider,
                    "X-TTS-Text-Len": str(len(request.text)),
                },
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"TTS unavailable ({engine}): {result.error}",
            )
    except ImportError as e:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=f"TTS engine not configured ({engine}): {e}",
        ) from e
    except Exception as e:
        logger.exception("TTS speak failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"TTS failed: {e}",
        ) from e


@router.post("/pipeline", summary="Audio file → ASR → Agent → GPT-SoVITS → audio")
async def tts_pipeline(
    audio: UploadFile = File(..., description="Audio file (WAV, M4A, MP3)"),
    task: str = Form(default="", description="Task description for the agent"),
    agent: str = Form(default="", description="Preferred agent: claude_code, codex, opencode, mock"),
):
    """Full voice pipeline: upload audio → transcribe → agent → TTS.

    Returns WAV audio of the agent's spoken response.
    """
    import tempfile

    # Save uploaded audio to temp file
    suffix = Path(audio.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        audio_path = tmp.name

    try:
        from runner.core.orchestrator import Orchestrator
        from runner.agents.router import AgentRouter

        router = AgentRouter()
        orch = Orchestrator(router=router)

        result = orch.run_audio(
            audio_path=audio_path,
            agent_name=agent or None,
            use_real_tts=True,
        )

        if result.tts_result.success and result.tts_result.audio_path:
            audio_bytes = Path(result.tts_result.audio_path).read_bytes()
            return Response(
                content=audio_bytes,
                media_type="audio/wav",
                headers={
                    "Content-Disposition": "inline; filename=response.wav",
                    "X-ASR-Len": str(len(result.input_text)) if result.input_text else "0",
                    "X-Agent": result.agent_result.agent_name,
                    "X-Agent-Success": str(result.agent_result.success),
                    "X-TTS-Engine": result.tts_result.provider,
                },
            )
        else:
            # Return text result if TTS audio wasn't generated
            return {
                "asr_text": result.input_text,
                "agent_name": result.agent_result.agent_name,
                "agent_success": result.agent_result.success,
                "agent_summary": result.agent_result.summary,
                "tts_error": result.tts_result.error if not result.tts_result.success else None,
            }
    except Exception as e:
        logger.exception("TTS pipeline failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Pipeline failed: {e}",
        ) from e
    finally:
        # Cleanup temp file
        Path(audio_path).unlink(missing_ok=True)
