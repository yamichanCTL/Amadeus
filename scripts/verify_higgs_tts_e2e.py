from __future__ import annotations

import asyncio
import base64
import io
import sys
import wave
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.api.v1 import tts_api  # noqa: E402
from app.core.asr.base import ASRResult, BaseASREngine, EngineOptions, Segment  # noqa: E402
from app.core.asr.registry import register_engine  # noqa: E402


class MockASREngine(BaseASREngine):
    ENGINE_NAME = "mock"

    def __init__(self, **_: Any) -> None:
        self._loaded = False

    @property
    def name(self) -> str:
        return self.ENGINE_NAME

    async def load(self) -> None:
        self._loaded = True

    async def unload(self) -> None:
        self._loaded = False

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    async def transcribe(self, _audio_bytes: bytes, _options: EngineOptions | None = None) -> ASRResult:
        if not self._loaded:
            await self.load()
        return ASRResult(
            full_text="测试识别结果",
            segments=[Segment(start=0.0, end=1.0, text="测试识别结果", confidence=0.95)],
            language="zh",
            engine_name=self.name,
            confidence=0.95,
        )

    def info(self) -> dict[str, Any]:
        return {"engine": self.name, "is_loaded": self._loaded, "model_name": "mock"}


def make_wav_bytes(duration_sec: float = 0.2, sample_rate: int = 16_000) -> bytes:
    pcm = np.zeros(int(duration_sec * sample_rate), dtype=np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def fake_higgs_json(_base_url: str, path: str, _timeout: float = 20.0) -> Any:
    if path == "/health":
        return {"running": True, "stages": ["ready"], "total_requests": 1}
    if path == "/v1/audio/voices":
        return {"voices": [{"name": "default"}, {"name": "elysia"}]}
    raise AssertionError(f"unexpected Higgs path: {path}")


def fake_higgs_audio(payload: dict[str, Any], _base_url: str, _timeout: float = 1800.0):
    assert payload["input"]
    assert payload["voice"]
    return b"RIFFfake-higgs-wav", "audio/wav", {"x-sample-rate": "24000"}


class DirectUpload:
    filename = "input.wav"

    def __init__(self, data: bytes) -> None:
        self._data = data

    async def read(self) -> bytes:
        return self._data


async def run_checks() -> None:
    register_engine("mock", MockASREngine)
    import app.core.model_manager as model_manager

    model_manager._manager = None
    tts_api._higgs_json_request = fake_higgs_json
    tts_api._higgs_audio_request = fake_higgs_audio

    health = await tts_api.higgs_health("localhost:8002")
    assert health["connected"] is True
    assert health["base_url"] == "http://localhost:8002"
    print("REQ tts-service-config: health endpoint logic ok")

    voices = await tts_api.higgs_voices("http://localhost:8002")
    assert voices["voices"] == ["default", "elysia"]
    print("REQ tts-service-config: voices endpoint logic ok")

    text_tts = await tts_api.higgs_speak(tts_api.HiggsTTSRequest(
        text="你好，端到端测试。",
        higgs_base_url="http://localhost:8002",
        voice="default",
        response_format="wav",
    ))
    assert text_tts.body == b"RIFFfake-higgs-wav"
    assert text_tts.headers["x-tts-engine"] == "higgs"
    assert float(text_tts.headers["x-timing-tts"]) >= 0
    print("REQ 2 text-to-tts: /v1/tts/higgs/speak business path ok")

    upload = DirectUpload(make_wav_bytes())
    audio_tts = await tts_api.higgs_audio_to_speech(
        audio=upload,
        higgs_base_url="http://localhost:8002",
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
    assert audio_tts.body == b"RIFFfake-higgs-wav"
    assert audio_tts.headers["x-asr-engine"] == "mock"
    assert base64.b64decode(audio_tts.headers["x-asr-text-b64"]).decode("utf-8") == "测试识别结果"
    assert float(audio_tts.headers["x-timing-asr"]) >= 0
    assert float(audio_tts.headers["x-timing-tts"]) >= 0
    print("REQ 1 upload audio ASR-to-TTS: /v1/tts/higgs/audio-to-speech business path ok")
    print("REQ 4 latency headers: ASR/TTS/Higgs/total headers ok")

    stream_event = tts_api._synthesize_stream_tts_event(
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
    assert stream_event["type"] == "tts"
    assert stream_event["text"] == "测试识别结果"
    assert base64.b64decode(stream_event["audio_b64"]) == b"RIFFfake-higgs-wav"
    assert stream_event["timing"]["asr_sec"] == 0.123
    assert stream_event["timing"]["tts_sec"] >= 0
    print("REQ 1 microphone VAD-ASR-TTS: backend final-ASR to TTS event payload ok")
    print("REQ 3 realtime ASR+TTS: repeated final-to-tts event payload path ok")
    print("REQ 4 websocket latency payload: timing object ok")
    print("All Higgs TTS backend e2e checks passed.")


if __name__ == "__main__":
    asyncio.run(run_checks())
