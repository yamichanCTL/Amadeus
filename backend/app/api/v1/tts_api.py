"""
TTS API — GPT-SoVITS speech synthesis and voice pipeline.

POST /v1/tts/speak    — Text → GPT-SoVITS → WAV audio
POST /v1/tts/pipeline  — Audio file → ASR → Agent → GPT-SoVITS → WAV audio
"""

from __future__ import annotations

import logging
import sys
import asyncio
import base64
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Query, WebSocket, WebSocketDisconnect, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

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
    stream: bool = Field(False, description="Forward stream flag to Higgs; response is still buffered by this proxy")


class HiggsVoicePresetRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80, description="Persistent local voice preset name")
    higgs_base_url: str = Field("http://localhost:8002", description="Higgs API base URL used when the preset was saved")
    reference_audio: str = Field("", description="Reference audio data URL")
    reference_url: str = Field("", description="Reference audio URL")
    reference_text: str = Field("", description="Transcript for reference audio")
    reference_codes_json: str = Field("", description="JSON array shaped [T,8]; overrides reference audio")


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


def _read_higgs_voice_presets() -> list[dict[str, Any]]:
    by_name: dict[str, dict[str, Any]] = {}
    for preset in _read_legacy_higgs_voice_presets():
        if preset.get("name"):
            by_name[str(preset["name"])] = preset
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


def _higgs_audio_request(payload: dict[str, Any], base_url: str, timeout: float = 1800.0) -> tuple[bytes, str, dict[str, str]]:
    import json

    url = f"{_normalize_higgs_base_url(base_url)}/v1/audio/speech"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "*/*"},
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

    payload: dict[str, Any] = {
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
    }


def _asr_observed_sec(event: dict[str, Any]) -> float:
    ended = event.get("real_time_end")
    if not isinstance(ended, str) or not ended:
        return 0.0
    try:
        ended_at = datetime.fromisoformat(ended)
        return max(0.0, (datetime.now(ended_at.tzinfo) - ended_at).total_seconds())
    except Exception:
        return 0.0


def _higgs_request_from_stream_text(text: str, config: dict[str, Any]) -> HiggsTTSRequest:
    return HiggsTTSRequest(
        text=text,
        higgs_base_url=config["higgs_base_url"],
        voice=config["voice"],
        response_format=config["response_format"],
        speed=config["speed"],
        temperature=config["temperature"],
        top_p=config["top_p"],
        top_k=config["top_k"],
        seed=config["seed"],
        max_new_tokens=config["max_new_tokens"],
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
    from app.core.asr.router import ModelRouter
    from app.core.model_manager import get_model_manager

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Audio is empty")
    started = time.perf_counter()
    try:
        router_obj = ModelRouter(manager=get_model_manager(), engines=[engine])
        result = await router_obj.run(audio_bytes, EngineOptions(language=language or None))
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
        audio_bytes, media_type, higgs_headers = _higgs_audio_request(payload, request.higgs_base_url)
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
    - {"type":"config", "engine":"sensevoice", "final_engine":"mock", "higgs_base_url":"http://localhost:8002", ...}
    - {"type":"audio", "data":"<base64 pcm_s16le>"}
    - {"type":"end"}

    Server forwards ASR session events and emits:
    - {"type":"tts", "text":"...", "audio_b64":"...", "media_type":"audio/wav", "timing":{...}}
    """

    from app.core.streaming.session import StreamingASRSession, parse_stream_config

    await websocket.accept()
    session = StreamingASRSession()
    tts_config = _stream_tts_config({})
    await session.send_ready()

    async def send_loop() -> None:
        loop = asyncio.get_running_loop()
        while True:
            event: dict[str, Any] = await session.queue.get()
            await websocket.send_text(json.dumps(event, ensure_ascii=False))
            if event.get("type") == "final":
                text = str(event.get("text") or "").strip()
                if not text:
                    continue
                asr_sec = _asr_observed_sec(event)
                try:
                    # Run blocking HTTP call in thread to keep event loop responsive,
                    # otherwise the browser WebSocket times out during TTS synthesis.
                    tts_event = await loop.run_in_executor(
                        None,
                        lambda: _synthesize_stream_tts_event(
                            session_id=session.session_id,
                            job_id=event.get("job_id"),
                            text=text,
                            asr_sec=asr_sec,
                            config=tts_config,
                        ),
                    )
                    await websocket.send_text(json.dumps(tts_event, ensure_ascii=False))
                except Exception as exc:
                    await websocket.send_text(json.dumps(
                        {
                            "type": "error",
                            "session_id": session.session_id,
                            "message": f"Higgs TTS failed: {exc}",
                        },
                        ensure_ascii=False,
                    ))
            if event.get("type") == "done":
                return

    sender = asyncio.create_task(send_loop())
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
                        "type": "configured",
                        "session_id": session.session_id,
                        "engine": session.config.engine,
                        "final_engine": session.config.final_engine,
                        "language": session.config.language,
                        "tts_engine": "higgs",
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
    except Exception as exc:
        logger.exception("Higgs stream failed: %s", exc)
        await session.queue.put({"type": "error", "session_id": session.session_id, "message": str(exc)})
    finally:
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
    from app.core.asr.router import ModelRouter
    from app.core.model_manager import get_model_manager

    total_started = time.perf_counter()
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Audio is empty")

    try:
        asr_started = time.perf_counter()
        router_obj = ModelRouter(manager=get_model_manager(), engines=[engine])
        asr_result = await router_obj.run(audio_bytes, EngineOptions(language=language or None))
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
