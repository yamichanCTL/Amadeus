from __future__ import annotations

import base64
import io
import json
import sys
import wave
from pathlib import Path
from typing import Any

import numpy as np
import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


def _fake_higgs_json(_base_url: str, path: str, _timeout: float = 20.0) -> Any:
    if path == "/health":
        return {"running": True, "stages": ["ready"], "total_requests": 1}
    if path == "/v1/audio/voices":
        return {"voices": [{"name": "default"}, {"name": "elysia"}]}
    raise AssertionError(f"unexpected Higgs path: {path}")


def _fake_higgs_audio(payload: dict[str, Any], _base_url: str, _timeout: float = 1800.0, *, api_token: str = ""):
    assert payload["input"]
    assert "voice" in payload
    return b"RIFFfake-higgs-wav", "audio/wav", {"x-sample-rate": "24000"}


def _fake_higgs_audio_stream(payload: dict[str, Any], _base_url: str, _timeout: float = 1800.0, _chunk_size: int = 4096, *, api_token: str = ""):
    assert payload["input"]
    assert payload["stream"] is True
    assert payload["response_format"] == "pcm"
    headers = {"x-sample-rate": "24000", "x-channels": "1", "x-bit-depth": "16"}
    silence = np.zeros(480, dtype="<i2").tobytes()
    voice = np.full(480, 2000, dtype="<i2").tobytes()
    yield silence + voice, "audio/pcm", headers
    yield silence * 10, "audio/pcm", headers


async def _fake_higgs_audio_async_stream(payload: dict[str, Any], _base_url: str, _timeout: float = 1800.0, _chunk_size: int = 32768, *, api_token: str = ""):
    for item in _fake_higgs_audio_stream(payload, _base_url, _timeout, _chunk_size):
        yield item


async def _fake_higgs_audio_long_tail(payload: dict[str, Any], _base_url: str, *args, **kwargs):
    del payload, _base_url, args, kwargs
    headers = {"x-sample-rate": "24000", "x-channels": "1", "x-bit-depth": "16"}
    voice = np.full(480, 2000, dtype="<i2").tobytes()
    silence = np.zeros(480, dtype="<i2").tobytes()
    yield voice * 22 + silence * 50, "audio/pcm", headers


class _FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def send_text(self, text: str) -> None:
        self.messages.append(json.loads(text))


class _DirectUpload:
    filename = "input.wav"

    def __init__(self, data: bytes) -> None:
        self._data = data

    async def read(self) -> bytes:
        return self._data


def _make_wav_bytes(duration_sec: float = 0.2, sample_rate: int = 16_000) -> bytes:
    pcm = np.zeros(int(duration_sec * sample_rate), dtype=np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _isolate_higgs_voice_presets(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("ASRAPP_HIGGS_VOICE_PRESETS", str(tmp_path / "higgs_voice_presets.json"))
    monkeypatch.setenv("ASRAPP_TTS_VOICES_DIR", str(tmp_path / "data" / "tts" / "voices"))


@pytest.mark.asyncio
async def test_higgs_health_and_voices(monkeypatch) -> None:
    from app.api.v1 import tts_api

    monkeypatch.setattr(tts_api, "_higgs_json_request", _fake_higgs_json)

    health = await tts_api.higgs_health("localhost:8002")
    assert health["connected"] is True
    assert health["base_url"] == "http://localhost:8002"

    voices = await tts_api.higgs_voices("http://localhost:8002")
    assert voices["voices"] == ["default", "elysia"]


@pytest.mark.asyncio
async def test_higgs_text_tts_returns_audio_and_timing(monkeypatch) -> None:
    from app.api.v1 import tts_api

    monkeypatch.setattr(tts_api, "_higgs_audio_request", _fake_higgs_audio)

    resp = await tts_api.higgs_speak(tts_api.HiggsTTSRequest(
        text="你好，端到端测试。",
        higgs_base_url="http://localhost:8002",
        voice="default",
        response_format="wav",
    ))
    assert resp.body == b"RIFFfake-higgs-wav"
    assert resp.headers["x-tts-engine"] == "higgs"
    assert float(resp.headers["x-timing-tts"]) >= 0


@pytest.mark.asyncio
async def test_higgs_text_tts_forwards_voice_clone_and_control_tags(monkeypatch) -> None:
    from app.api.v1 import tts_api

    calls: list[dict[str, Any]] = []

    def capture_higgs_audio(payload: dict[str, Any], _base_url: str, _timeout: float = 1800.0, **_kwargs):
        calls.append(payload)
        return b"RIFFfake-higgs-wav", "audio/wav", {"x-sample-rate": "24000"}

    monkeypatch.setattr(tts_api, "_higgs_audio_request", capture_higgs_audio)

    await tts_api.higgs_speak(tts_api.HiggsTTSRequest(
        text="你好，端到端测试。",
        higgs_base_url="http://localhost:8002",
        voice="elysia",
        response_format="aac",
        reference_url="https://example.test/ref.wav",
        reference_text="参考音频文本",
        emotion="amusement",
        style="whispering",
        prosody_speed="speed_slow",
        pitch="pitch_high",
        expressiveness="expressive_high",
    ))

    payload = calls[-1]
    assert payload["input"].startswith(
        "<|emotion:amusement|><|style:whispering|><|prosody:speed_slow|><|prosody:pitch_high|><|prosody:expressive_high|>"
    )
    assert payload["response_format"] == "aac"
    assert payload["references"] == [{"audio_path": "https://example.test/ref.wav", "text": "参考音频文本"}]


@pytest.mark.asyncio
async def test_higgs_text_tts_reference_codes_override_reference_audio(monkeypatch) -> None:
    from app.api.v1 import tts_api

    calls: list[dict[str, Any]] = []

    def capture_higgs_audio(payload: dict[str, Any], _base_url: str, _timeout: float = 1800.0, **_kwargs):
        calls.append(payload)
        return b"RIFFfake-higgs-wav", "audio/wav", {"x-sample-rate": "24000"}

    monkeypatch.setattr(tts_api, "_higgs_audio_request", capture_higgs_audio)

    await tts_api.higgs_speak(tts_api.HiggsTTSRequest(
        text="测试 reference codes。",
        higgs_base_url="http://localhost:8002",
        provider="local",
        api_token="",
        model="higgs-audio-v3-tts",
        reference_audio="data:audio/wav;base64,ZmFrZQ==",
        reference_text="参考文本",
        reference_codes_json="[[1,2,3,4,5,6,7,8]]",
    ))

    payload = calls[-1]
    assert payload["reference_codes"] == [[1, 2, 3, 4, 5, 6, 7, 8]]
    assert payload["reference_text"] == "参考文本"
    assert "references" not in payload


@pytest.mark.asyncio
async def test_higgs_voice_preset_persists_and_merges_with_voices(monkeypatch) -> None:
    from app.api.v1 import tts_api

    monkeypatch.setattr(tts_api, "_higgs_json_request", _fake_higgs_json)

    saved = await tts_api.save_higgs_voice_preset(tts_api.HiggsVoicePresetRequest(
        name="Elysia clone",
        higgs_base_url="localhost:8002",
        reference_audio="data:audio/wav;base64,ZmFrZS13YXY=",
        reference_text="这是一段准确参考文本。",
    ))

    assert saved["preset"]["name"] == "Elysia clone"
    assert saved["preset"]["higgs_base_url"] == "http://localhost:8002"
    assert Path(saved["preset"]["reference_audio_path"]).exists()
    assert Path(saved["preset"]["reference_audio_path"]).name == "reference.wav"
    assert Path(saved["preset"]["reference_audio_path"]).with_name("reference.txt").read_text(encoding="utf-8") == "这是一段准确参考文本。"

    presets = await tts_api.higgs_voice_presets()
    assert presets["voices"] == ["Elysia clone"]
    assert presets["path"].endswith("data/tts/voices")

    voices = await tts_api.higgs_voices("http://localhost:8002")
    assert voices["voices"] == ["Elysia clone", "default", "elysia"]
    assert voices["presets"][0]["reference_audio"].startswith("data:audio/wav;base64,")


def test_higgs_legacy_voice_presets_migrate_to_directory(tmp_path, monkeypatch) -> None:
    from app.api.v1 import tts_api

    legacy_path = tmp_path / "higgs_voice_presets.json"
    voices_dir = tmp_path / "tts" / "voices"
    monkeypatch.setenv("ASRAPP_HIGGS_VOICE_PRESETS", str(legacy_path))
    monkeypatch.setenv("ASRAPP_TTS_VOICES_DIR", str(voices_dir))
    legacy_path.write_text(json.dumps([
        {
            "name": "legacy voice",
            "higgs_base_url": "localhost:8002",
            "reference_audio": "data:audio/wav;base64,ZmFrZS13YXY=",
            "reference_text": "旧音色文本",
            "reference_codes_json": "",
            "created_at": "2026-06-18T22:00:00",
            "updated_at": "2026-06-18T22:00:00",
        }
    ]), encoding="utf-8")

    presets = tts_api._read_higgs_voice_presets()

    assert [preset["name"] for preset in presets] == ["legacy voice"]
    assert (voices_dir / "legacy_voice" / "meta.json").exists()
    assert (voices_dir / "legacy_voice" / "reference.wav").read_bytes() == b"fake-wav"
    assert (voices_dir / "legacy_voice" / "reference.txt").read_text(encoding="utf-8") == "旧音色文本"
    assert json.loads(legacy_path.read_text(encoding="utf-8")) == []


def test_higgs_payload_resolves_saved_voice_preset() -> None:
    from app.api.v1 import tts_api

    tts_api._upsert_higgs_voice_preset(tts_api.HiggsVoicePresetRequest(
        name="saved-voice",
        reference_codes_json="[[1,2,3,4,5,6,7,8]]",
        reference_text="保存的参考文本",
    ))

    payload = tts_api._build_higgs_payload(tts_api.HiggsTTSRequest(
        text="使用保存音色。",
        voice="saved-voice",
    ))

    assert payload["voice"] == "saved-voice"
    assert payload["reference_codes"] == [[1, 2, 3, 4, 5, 6, 7, 8]]
    assert payload["reference_text"] == "保存的参考文本"


@pytest.mark.asyncio
async def test_higgs_audio_to_speech_runs_asr_then_tts(monkeypatch) -> None:
    from app.api.v1 import tts_api

    monkeypatch.setattr(tts_api, "_higgs_audio_request", _fake_higgs_audio)
    upload = _DirectUpload(_make_wav_bytes())
    resp = await tts_api.higgs_audio_to_speech(
        audio=upload,  # type: ignore[arg-type]
        higgs_base_url="http://localhost:8002",
        provider="local",
        api_token="",
        model="higgs-audio-v3-tts",
        voice="default",
        response_format="wav",
        speed=1.0,
        temperature=0.7,
        top_p=0.95,
        top_k=50,
        seed=-1,
        max_new_tokens=2048,
        engine="mock",
        language="zh",
    )
    assert resp.body == b"RIFFfake-higgs-wav"
    assert resp.headers["x-asr-engine"] == "mock"
    assert base64.b64decode(resp.headers["x-asr-text-b64"]).decode("utf-8") == "测试识别结果"
    assert float(resp.headers["x-timing-asr"]) >= 0
    assert float(resp.headers["x-timing-tts"]) >= 0


@pytest.mark.asyncio
async def test_higgs_reference_asr_uses_current_asr_engine() -> None:
    from app.api.v1 import tts_api

    upload = _DirectUpload(_make_wav_bytes())
    result = await tts_api.higgs_reference_asr(
        audio=upload,  # type: ignore[arg-type]
        engine="mock",
        language="zh",
    )
    assert result["text"] == "测试识别结果"
    assert result["engine"] == "mock"


def test_higgs_stream_tts_event_payload(monkeypatch) -> None:
    from app.api.v1 import tts_api

    monkeypatch.setattr(tts_api, "_higgs_audio_request", _fake_higgs_audio)
    event = tts_api._synthesize_stream_tts_event(
        session_id="fake-session",
        job_id=1,
        text="测试识别结果",
        asr_sec=0.123,
        config=tts_api._stream_tts_config({
            "higgs_base_url": "http://localhost:8002",
            "voice": "default",
            "response_format": "wav",
        }),
    )
    assert event["type"] == "tts"
    assert event["text"] == "测试识别结果"
    assert base64.b64decode(event["audio_b64"]) == b"RIFFfake-higgs-wav"
    assert event["timing"]["asr_sec"] == 0.123
    assert event["timing"]["tts_sec"] >= 0


@pytest.mark.asyncio
async def test_higgs_stream_tts_forwards_audio_chunks(monkeypatch) -> None:
    from app.api.v1 import tts_api

    monkeypatch.setattr(tts_api, "_aiter_higgs_audio_stream_request", _fake_higgs_audio_async_stream)
    websocket = _FakeWebSocket()

    await tts_api._send_stream_tts_events(
        websocket,  # type: ignore[arg-type]
        session_id="fake-session",
        job_id=7,
        text="测试识别结果",
        asr_sec=0.2,
        config=tts_api._stream_tts_config({
            "higgs_base_url": "http://localhost:8002",
            "voice": "default",
            "response_format": "wav",
        }),
        source_event="partial",
        speculative=True,
    )

    types = [message["type"] for message in websocket.messages]
    assert types == ["tts_start", "tts_chunk", "tts_chunk", "tts_done"]
    assert websocket.messages[0]["source_event"] == "partial"
    assert websocket.messages[0]["speculative"] is True
    chunks = [message for message in websocket.messages if message["type"] == "tts_chunk"]
    assert chunks[0]["seq"] == 1
    assert chunks[0]["sample_rate"] == "24000"
    assert chunks[0]["channels"] == 1
    assert chunks[0]["bit_depth"] == 16
    assert base64.b64decode(chunks[0]["audio_b64"]) == np.full(480, 2000, dtype="<i2").tobytes()
    done = websocket.messages[-1]
    assert done["chunks"] == 2
    assert done["audio_bytes"] == 2880
    assert done["trimmed_silence_ms"] == 180.0
    assert done["timing"]["tts_first_token_sec"] == done["timing"]["tts_first_chunk_sec"]
    assert done["timing"]["e2e_first_audio_sec"] >= 0.2
    assert done["timing"]["e2e_first_audio_sec"] < 1.0


@pytest.mark.asyncio
async def test_higgs_stream_tts_aborts_long_generated_tail_silence(monkeypatch) -> None:
    from app.api.v1 import tts_api

    monkeypatch.setattr(tts_api, "_aiter_higgs_audio_stream_request", _fake_higgs_audio_long_tail)
    websocket = _FakeWebSocket()
    await tts_api._send_stream_tts_events(
        websocket,  # type: ignore[arg-type]
        session_id="fake-session",
        job_id=8,
        text="今天天气真好。",
        asr_sec=0.2,
        config=tts_api._stream_tts_config({}),
    )

    done = websocket.messages[-1]
    assert done["type"] == "tts_done"
    assert done["tail_silence_aborted"] is True
    assert done["trimmed_silence_ms"] == 960.0


def test_higgs_stream_tts_config_defaults_to_speculative_partial() -> None:
    from app.api.v1 import tts_api

    config = tts_api._stream_tts_config({})
    assert config["stream"] is True
    assert config["speculative_partial_tts"] is True
    assert config["partial_first_min_chars"] == 6
    assert config["partial_segment_min_chars"] == 8
    assert config["partial_max_chars"] == 8
    assert config["partial_lookahead_chars"] == 1


def test_higgs_stream_tts_uses_stable_incremental_text_then_final_remainder() -> None:
    from app.api.v1 import tts_api

    config = tts_api._stream_tts_config({})
    state = tts_api._IncrementalTTSState(job_id=1)
    segments: list[str] = []
    assert tts_api._stream_tts_incremental_segments(
        {"type": "partial", "text": "今", "stable_text": ""},
        state=state,
        config=config,
    ) == []
    first = tts_api._stream_tts_incremental_segments(
        {"type": "partial", "text": "今天天气真好，我们", "stable_text": "今天天气真好，"},
        state=state,
        config=config,
    )
    assert first == [("今天天气真好，", 1)]
    segments.extend(text for text, _ in first)
    assert tts_api._stream_tts_incremental_segments(
        {"type": "partial", "text": "今天天气真好，我们一起出去", "stable_text": "今天天气真好，我们一起出去"},
        state=state,
        config=config,
    ) == []
    second = tts_api._stream_tts_incremental_segments(
        {"type": "partial", "text": "今天天气真好，我们一起出去散散步，好", "stable_text": "今天天气真好，我们一起出去散散步，"},
        state=state,
        config=config,
    )
    assert second == [("我们一起出去散散步，", 2)]
    segments.extend(text for text, _ in second)
    final = tts_api._stream_tts_incremental_segments(
        {"type": "final", "text": "今天天气真好，我们一起出去散散步，好吗？"},
        state=state,
        config=config,
    )
    assert final == [("好吗？", 3)]
    segments.extend(text for text, _ in final)
    assert "".join(segments) == "今天天气真好，我们一起出去散散步，好吗？"


def test_higgs_stream_tts_does_not_positional_slice_corrected_final() -> None:
    from app.api.v1 import tts_api

    config = tts_api._stream_tts_config({})
    state = tts_api._IncrementalTTSState(job_id=1)
    assert tts_api._stream_tts_incremental_segments(
        {"type": "partial", "text": "我今天想去公园，然后", "stable_text": "我今天想去公园，"},
        state=state,
        config=config,
    ) == [("我今天想去公园，", 1)]
    assert tts_api._stream_tts_incremental_segments(
        {"type": "final", "text": "我今天想去公司。"},
        state=state,
        config=config,
    ) == []


def test_higgs_stream_tts_non_speculative_waits_for_final() -> None:
    from app.api.v1 import tts_api

    config = {**tts_api._stream_tts_config({}), "speculative_partial_tts": False}
    state = tts_api._IncrementalTTSState(job_id=1)
    assert tts_api._stream_tts_incremental_segments(
        {"type": "partial", "text": "你好", "stable_text": "你好"},
        state=state,
        config=config,
    ) == []
    assert tts_api._stream_tts_incremental_segments(
        {"type": "final", "text": "你好"},
        state=state,
        config=config,
    ) == [("你好", 1)]


def test_higgs_stream_tts_starts_before_final_without_punctuation() -> None:
    from app.api.v1 import tts_api

    config = tts_api._stream_tts_config({})
    state = tts_api._IncrementalTTSState(job_id=1)

    partial = tts_api._stream_tts_incremental_segments(
        {
            "type": "partial",
            "text": "我还有好多好多话想对",
            "stable_text": "我还有好多好多话想对",
        },
        state=state,
        config=config,
    )
    assert partial == [("我还有好多好多话", 1)]
    final = tts_api._stream_tts_incremental_segments(
        {"type": "final", "text": "我还有好多好多话想对你说"},
        state=state,
        config=config,
    )
    assert final == [("想对你说", 2)]
    assert "".join(text for text, _ in [*partial, *final]) == "我还有好多好多话想对你说"


def test_tts_echo_guard_blocks_other_job_but_not_source_job() -> None:
    from app.api.v1 import tts_api

    guard = tts_api._TTSEchoGuard(window_sec=8)
    guard.remember(1, "今天天气真好，", now=10)

    assert guard.match(1, "今天天气真好，", now=11) is None
    assert guard.match(2, "今天天气真好", now=11) == "今天天气真好，"
    assert guard.match(2, "今天天气真好", now=19) is None
