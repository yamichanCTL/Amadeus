"""
tests/test_api.py
──────────────────
API-level integration tests.
Uses the async_client fixture (no real models, in-memory DB).
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.tests.conftest import make_wav_bytes
from app.api.v1.transcribe import _long_audio_timeout_sec, _run_with_timeout
from app.config import get_settings
from app.db.crud import create_task
from app.db.models import ASRTask
from app.schemas.transcribe import TranscribeOptions


class _FakeLLMResponse:
    def __init__(self, payload: dict | None = None, status_code: int = 200) -> None:
        self._payload = payload or {
            "choices": [{"message": {"content": "润色后的文本"}}],
        }
        self.status_code = status_code
        self.content = b"fake-audio"
        self.headers = {"content-type": "audio/mpeg"}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            request = httpx.Request("POST", "https://llm.test/v1/chat/completions")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("provider failed", request=request, response=response)

    def json(self) -> dict:
        return self._payload


class _FakeLLMStream:
    def __init__(self, payload: dict) -> None:
        self.status_code = 200
        self._payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args) -> None:
        return None

    def raise_for_status(self) -> None:
        return None

    async def aiter_lines(self):
        for text in ("流式", "总结"):
            yield 'data: {"choices":[{"delta":{"content":"' + text + '"}}]}'
        yield "data: [DONE]"


class _FakeLLMClient:
    calls: list[dict] = []
    status_code = 200

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args) -> None:
        return None

    async def post(self, url: str, json: dict, headers: dict) -> _FakeLLMResponse:
        self.calls.append({"url": url, "json": json, "headers": headers})
        if url.endswith("/audio/speech"):
            return _FakeLLMResponse({}, self.status_code)
        raw_content = json["messages"][1]["content"]
        if isinstance(raw_content, list):
            first_text = next((part.get("text", "") for part in raw_content if part.get("type") == "text"), "multimodal")
        else:
            first_text = raw_content
        content = f"{first_text.splitlines()[0]} OK"
        return _FakeLLMResponse({"choices": [{"message": {"content": content}}]}, self.status_code)

    def stream(self, method: str, url: str, json: dict, headers: dict) -> _FakeLLMStream:
        self.calls.append({"method": method, "url": url, "json": json, "headers": headers, "stream": True})
        return _FakeLLMStream(json)


@pytest.fixture
def fake_llm(monkeypatch):
    _FakeLLMClient.calls = []
    _FakeLLMClient.status_code = 200
    monkeypatch.setattr("app.core.llm.httpx.AsyncClient", _FakeLLMClient)
    return _FakeLLMClient


# ── Health endpoints ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_liveness(async_client: AsyncClient) -> None:
    resp = await async_client.get("/v1/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "uptime_sec" in data


@pytest.mark.asyncio
async def test_readiness(async_client: AsyncClient) -> None:
    resp = await async_client.get("/v1/health/ready")
    # May be 200 or 503 depending on DB state in test; just check it responds
    assert resp.status_code in (200, 503)
    assert "status" in resp.json()


# ── Transcribe endpoint ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_transcribe_short_audio_sync(async_client: AsyncClient) -> None:
    """Short audio (< SYNC_MAX_DURATION_SEC) should return a synchronous result."""
    wav = make_wav_bytes(1.0)
    resp = await async_client.post(
        "/v1/transcribe",
        files={"file": ("test.wav", wav, "audio/wav")},
        data={"options": '{"engine": "mock"}'},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "success"
    assert data["full_text"] == "测试识别结果"
    assert data["engine_used"] == "mock"
    assert data["task_id"]


def test_transcribe_timeout_defaults_to_twenty_seconds() -> None:
    assert get_settings().transcribe_timeout_sec == 20
    assert TranscribeOptions(engine="mock").timeout_sec == 20


def test_llm_defaults_are_blank_custom_configuration() -> None:
    settings = get_settings()
    assert settings.llm_default_provider == "custom"
    assert settings.llm_default_base_url == ""
    assert settings.llm_default_model == ""


def test_long_audio_timeout_scales_with_duration() -> None:
    assert _long_audio_timeout_sec(duration_sec=600, requested_timeout_sec=20) >= 1800
    assert _long_audio_timeout_sec(duration_sec=600, requested_timeout_sec=0) == 0


@pytest.mark.asyncio
async def test_transcribe_timeout_guard() -> None:
    async def slow_operation() -> None:
        await asyncio.sleep(1)

    with pytest.raises(TimeoutError, match="ASR execution exceeded 0.01 seconds"):
        await _run_with_timeout(slow_operation, 0.01)


@pytest.mark.asyncio
async def test_create_task_keeps_legacy_diarize_column_false(db_session: AsyncSession) -> None:
    """Existing SQLite DBs still require the removed diarize flag column."""
    task = await create_task(
        db_session,
        engines=["mock"],
        filename="recording.webm",
        mime_type="audio/webm",
    )
    await db_session.commit()
    saved = await db_session.get(ASRTask, task.id)
    assert saved is not None
    assert saved.diarize_enabled is False


@pytest.mark.asyncio
async def test_transcribe_missing_file(async_client: AsyncClient) -> None:
    resp = await async_client.post("/v1/transcribe")
    assert resp.status_code == 422  # Unprocessable entity — file field required


@pytest.mark.asyncio
async def test_transcribe_invalid_engine(async_client: AsyncClient) -> None:
    wav = make_wav_bytes(0.5)
    resp = await async_client.post(
        "/v1/transcribe",
        files={"file": ("test.wav", wav, "audio/wav")},
        data={"options": '{"engine": "nonexistent"}'},
    )
    assert resp.status_code == 422  # Pydantic validation rejects unknown engine


@pytest.mark.asyncio
async def test_transcribe_invalid_options_json(async_client: AsyncClient) -> None:
    wav = make_wav_bytes(0.5)
    resp = await async_client.post(
        "/v1/transcribe",
        files={"file": ("test.wav", wav, "audio/wav")},
        data={"options": "not valid json"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_transcribe_auto_llm_success(
    async_client: AsyncClient, db_session: AsyncSession, fake_llm
) -> None:
    wav = make_wav_bytes(0.5)
    token = "secret-token"
    resp = await async_client.post(
        "/v1/transcribe",
        files={"file": ("test.wav", wav, "audio/wav")},
        data={
            "options": (
                '{"engine":"mock","llm":{"enable_polish":true,'
                '"model":"demo-model","base_url":"https://llm.test/v1",'
                f'"api_token":"{token}",'
                '"prompt":"请保持原意并修正口语表达"'
                '}}'
            )
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["full_text"] == "测试识别结果"
    assert data["llm_outputs"]["polish"]["model"] == "demo-model"
    assert token not in resp.text
    assert fake_llm.calls[0]["headers"]["Authorization"] == f"Bearer {token}"
    assert fake_llm.calls[0]["json"]["messages"][1]["content"].startswith("请保持原意并修正口语表达")
    saved_task = await db_session.get(ASRTask, data["task_id"])
    assert saved_task is not None
    engine_options = json.loads(saved_task.engine_options or "{}")
    assert engine_options["llm"]["model"] == "demo-model"
    assert engine_options["llm"]["prompt"] == "请保持原意并修正口语表达"
    assert "api_token" not in json.dumps(engine_options)


@pytest.mark.asyncio
async def test_transcribe_auto_llm_failure_keeps_asr_success(
    async_client: AsyncClient, fake_llm
) -> None:
    fake_llm.status_code = 500
    wav = make_wav_bytes(0.5)
    resp = await async_client.post(
        "/v1/transcribe",
        files={"file": ("test.wav", wav, "audio/wav")},
        data={
            "options": (
                '{"engine":"mock","llm":{"enable_translate":true,'
                '"model":"demo-model","base_url":"https://llm.test/v1",'
                '"api_token":"secret-token","target_language":"English"}}'
            )
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "success"
    assert data["full_text"] == "测试识别结果"
    assert data["llm_outputs"] is None
    assert "translate" in data["llm_error"]


# ── LLM endpoint ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_llm_process_success(async_client: AsyncClient, fake_llm) -> None:
    resp = await async_client.post(
        "/v1/llm/process",
        json={
            "text": "测试识别结果",
            "operation": "translate",
            "model": "demo-model",
            "base_url": "https://llm.test/v1",
            "api_token": "secret-token",
            "target_language": "English",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["operation"] == "translate"
    assert data["model"] == "demo-model"
    assert "OK" in data["text"]
    call = fake_llm.calls[0]
    assert call["url"] == "https://llm.test/v1/chat/completions"
    assert call["headers"]["Authorization"] == "Bearer secret-token"


@pytest.mark.asyncio
async def test_llm_process_missing_token(async_client: AsyncClient) -> None:
    resp = await async_client.post(
        "/v1/llm/process",
        json={
            "text": "测试识别结果",
            "operation": "polish",
            "model": "demo-model",
            "base_url": "https://llm.test/v1",
            "api_token": "",
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_llm_process_provider_failure(async_client: AsyncClient, fake_llm) -> None:
    fake_llm.status_code = 502
    resp = await async_client.post(
        "/v1/llm/process",
        json={
            "text": "测试识别结果",
            "operation": "polish",
            "model": "demo-model",
            "base_url": "https://llm.test/v1",
            "api_token": "secret-token",
            "prompt": "我在会议里说了哪些待办？",
        },
    )
    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_llm_chat_success(async_client: AsyncClient, fake_llm) -> None:
    token = "secret-token"
    resp = await async_client.post(
        "/v1/llm/chat",
        json={
            "messages": [
                {"role": "system", "content": "你是桌面语音 agent。"},
                {"role": "user", "content": "刚才说了什么？"},
            ],
            "model": "demo-model",
            "base_url": "https://llm.test/v1",
            "api_token": token,
            "provider": "deepseek",
            "temperature": 0.6,
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["message"]["role"] == "assistant"
    assert "OK" in data["message"]["content"]
    assert data["model"] == "demo-model"
    assert data["provider"] == "deepseek"
    assert token not in resp.text
    call = fake_llm.calls[0]
    assert call["json"]["messages"][0]["role"] == "system"
    assert call["json"]["messages"][1]["content"] == "刚才说了什么？"
    assert call["json"]["temperature"] == 0.6


@pytest.mark.asyncio
async def test_llm_chat_accepts_image_content(async_client: AsyncClient, fake_llm) -> None:
    resp = await async_client.post(
        "/v1/llm/chat",
        json={
            "messages": [
                {"role": "system", "content": "你是视觉 agent。"},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "请看截图"},
                        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
                    ],
                },
            ],
            "model": "vision-demo",
            "base_url": "https://llm.test/v1",
            "api_token": "secret-token",
        },
    )
    assert resp.status_code == 200, resp.text
    call = fake_llm.calls[0]
    content = call["json"]["messages"][1]["content"]
    assert content[0]["type"] == "text"
    assert content[1]["type"] == "image_url"


@pytest.mark.asyncio
async def test_llm_chat_rejects_empty_messages(async_client: AsyncClient) -> None:
    resp = await async_client.post(
        "/v1/llm/chat",
        json={
            "messages": [],
            "model": "demo-model",
            "base_url": "https://llm.test/v1",
            "api_token": "secret-token",
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_llm_chat_stream_success(async_client: AsyncClient, fake_llm) -> None:
    resp = await async_client.post(
        "/v1/llm/chat/stream",
        json={
            "messages": [
                {"role": "system", "content": "你是桌面语音 agent。"},
                {"role": "user", "content": "实时回复"},
            ],
            "model": "demo-model",
            "base_url": "https://llm.test/v1",
            "api_token": "secret-token",
        },
    )
    assert resp.status_code == 200, resp.text
    events = [json.loads(line) for line in resp.text.splitlines()]
    assert events[0] == {"type": "delta", "text": "流式"}
    assert events[1] == {"type": "delta", "text": "总结"}
    assert events[-1]["type"] == "done"
    assert events[-1]["result"]["message"]["content"] == "流式总结"
    call = fake_llm.calls[0]
    assert call["stream"] is True
    assert call["json"]["stream"] is True
    assert call["json"]["messages"][1]["content"] == "实时回复"


@pytest.mark.asyncio
async def test_llm_speech_success(async_client: AsyncClient, fake_llm) -> None:
    token = "secret-token"
    resp = await async_client.post(
        "/v1/llm/speech",
        json={
            "text": "你好，我是语音 agent。",
            "model": "tts-demo",
            "voice": "alloy",
            "base_url": "https://llm.test/v1",
            "api_token": token,
            "response_format": "mp3",
            "speed": 1.1,
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.content == b"fake-audio"
    assert resp.headers["content-type"].startswith("audio/mpeg")
    assert token.encode() not in resp.content
    call = fake_llm.calls[0]
    assert call["url"] == "https://llm.test/v1/audio/speech"
    assert call["headers"]["Authorization"] == f"Bearer {token}"
    assert call["json"]["input"] == "你好，我是语音 agent。"
    assert call["json"]["model"] == "tts-demo"
    assert call["json"]["voice"] == "alloy"
    assert call["json"]["speed"] == 1.1


# ── Tasks endpoint ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_task_after_transcribe(async_client: AsyncClient) -> None:
    wav = make_wav_bytes(1.0)
    post_resp = await async_client.post(
        "/v1/transcribe",
        files={"file": ("t.wav", wav, "audio/wav")},
        data={"options": '{"engine": "mock"}'},
    )
    assert post_resp.status_code == 200
    task_id = post_resp.json()["task_id"]

    get_resp = await async_client.get(f"/v1/tasks/{task_id}")
    assert get_resp.status_code == 200
    task_data = get_resp.json()
    assert task_data["id"] == task_id
    assert task_data["status"] == "success"
    assert task_data["full_text"] == "测试识别结果"


@pytest.mark.asyncio
async def test_get_task_not_found(async_client: AsyncClient) -> None:
    resp = await async_client.get("/v1/tasks/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_list_tasks(async_client: AsyncClient) -> None:
    # Create a task first
    wav = make_wav_bytes(0.5)
    await async_client.post(
        "/v1/transcribe",
        files={"file": ("a.wav", wav, "audio/wav")},
    )
    resp = await async_client.get("/v1/tasks")
    assert resp.status_code == 200
    data = resp.json()
    assert "tasks" in data
    assert isinstance(data["tasks"], list)
    assert len(data["tasks"]) >= 1


# ── Models endpoint ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_list_models(async_client: AsyncClient) -> None:
    resp = await async_client.get("/v1/models")
    assert resp.status_code == 200
    data = resp.json()
    assert "engines" in data
    assert "default_engine" in data
    assert isinstance(data["engines"], list)


# ── Records endpoint ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_list_archived_records(async_client: AsyncClient) -> None:
    from datetime import datetime, timezone
    from pathlib import Path

    from app.core.archive import archive_pcm_record

    started_at = datetime.now(timezone.utc)
    archive_paths = archive_pcm_record(
        pcm_bytes=b"\x00\x00" * 1600,
        sample_rate=16_000,
        user_id="user-a",
        category="stream",
        text="hello",
        engine="mock",
        language="zh",
        started_at=started_at,
        ended_at=started_at,
        duration_sec=0.1,
    )

    resp = await async_client.get("/v1/records", params={"user_id": "user-a", "category": "stream"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 1
    assert data["items"][0]["text"] == "hello"
    assert data["items"][0]["audio_path"].endswith(".wav")
    audio_name = Path(archive_paths["audio_path"]).name
    expected_prefix = started_at.astimezone().strftime("%Y-%m-%d_%H-%M-%S_mock_")
    assert audio_name.startswith(expected_prefix)


@pytest.mark.asyncio
async def test_archive_summary_uses_compact_transcript(async_client: AsyncClient, fake_llm) -> None:
    from datetime import datetime, timezone

    from app.core.archive import archive_pcm_record

    started_at = datetime.now(timezone.utc)
    date = started_at.astimezone().strftime("%Y-%m-%d")
    archive_pcm_record(
        pcm_bytes=b"\x00\x00" * 1600,
        sample_rate=16_000,
        user_id="dsm",
        category="实时转写",
        text="今天讨论项目进度和待办事项",
        engine="mock",
        language="zh",
        started_at=started_at,
        ended_at=started_at,
        duration_sec=0.1,
        metadata={"session_id": "should-not-be-sent", "job_id": 19},
    )

    resp = await async_client.post(
        "/v1/llm/archive-summary",
        json={
            "date": date,
            "user_id": "dsm",
            "category": "实时转写",
            "provider": "deepseek",
            "model": "demo-model",
            "base_url": "https://llm.test/v1",
            "api_token": "secret-token",
            "prompt": "我在会议里说了哪些待办？",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["source_count"] == 1
    assert data["provider"] == "deepseek"
    assert "secret-token" not in resp.text
    prompt = fake_llm.calls[0]["json"]["messages"][1]["content"]
    assert prompt.index("Prompt：我在会议里说了哪些待办？") < prompt.index("ASR：")
    assert "今天讨论项目进度和待办事项" in prompt
    assert "should-not-be-sent" not in prompt
    assert "user_id" not in prompt
    assert "dsm" not in prompt


@pytest.mark.asyncio
async def test_archive_summary_accepts_explicit_local_records_without_server_archive(
    async_client: AsyncClient,
    fake_llm,
) -> None:
    resp = await async_client.post(
        "/v1/llm/archive-summary",
        json={
            "date": "2026-07-03",
            "start_date": "2026-07-03",
            "end_date": "2026-07-05",
            "user_id": "local-only-user",
            "category": "实时转录",
            "provider": "deepseek",
            "model": "demo-model",
            "base_url": "https://llm.test/v1",
            "api_token": "secret-token",
            "prompt": "总结本机记录",
            "records": [
                {
                    "started_at": "2026-07-03T09:10:00+08:00",
                    "ended_at": "2026-07-03T09:11:00+08:00",
                    "category": "实时转录",
                    "text": "这是只保存在用户电脑上的实时记录",
                }
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["source_count"] == 1
    assert data["start_date"] == "2026-07-03"
    assert data["end_date"] == "2026-07-05"
    prompt = fake_llm.calls[0]["json"]["messages"][1]["content"]
    assert "这是只保存在用户电脑上的实时记录" in prompt
    assert "2026-07-03 至 2026-07-05" in prompt
    assert "local-only-user" not in prompt
    assert "secret-token" not in prompt

    rejected = await async_client.post(
        "/v1/llm/archive-summary",
        json={
            "date": "2026-07-03",
            "model": "demo-model",
            "base_url": "https://llm.test/v1",
            "api_token": "secret-token",
            "records": [{"text": "本机记录", "audio_path": "/private/audio.wav"}],
        },
    )
    assert rejected.status_code == 422


@pytest.mark.asyncio
async def test_archive_summary_streams_deltas(async_client: AsyncClient, fake_llm) -> None:
    from datetime import datetime, timezone
    import json

    from app.core.archive import archive_pcm_record

    started_at = datetime.now(timezone.utc)
    date = started_at.astimezone().strftime("%Y-%m-%d")
    archive_pcm_record(
        pcm_bytes=b"\x00\x00" * 1600,
        sample_rate=16_000,
        user_id="stream-user",
        category="实时转写",
        text="需要边生成边显示总结",
        engine="mock",
        language="zh",
        started_at=started_at,
        ended_at=started_at,
        duration_sec=0.1,
        metadata={"user_id": "must-not-send"},
    )

    async with async_client.stream(
        "POST",
        "/v1/llm/archive-summary/stream",
        json={
            "date": date,
            "user_id": "stream-user",
            "category": "实时转写",
            "provider": "deepseek",
            "model": "demo-model",
            "base_url": "https://llm.test/v1",
            "api_token": "secret-token",
            "prompt": "我刚才提到的关键结论是什么？",
        },
    ) as resp:
        assert resp.status_code == 200, await resp.aread()
        events = [json.loads(line) async for line in resp.aiter_lines() if line]

    assert any(event["type"] == "delta" for event in events)
    done = next(event for event in events if event["type"] == "done")
    assert done["result"]["summary"] == "流式总结"
    prompt = next(call for call in fake_llm.calls if call.get("stream"))["json"]["messages"][1]["content"]
    assert prompt.index("Prompt：我刚才提到的关键结论是什么？") < prompt.index("ASR：")
    assert "需要边生成边显示总结" in prompt
    assert "stream-user" not in prompt
    assert "must-not-send" not in prompt


# ── Auth endpoints ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_register_and_login(async_client: AsyncClient) -> None:
    # Register — keep password well under 72 bytes
    reg = await async_client.post(
        "/v1/auth/register",
        json={"username": "testuser", "password": "TestPass123"},
    )
    assert reg.status_code == 201
    assert reg.json()["username"] == "testuser"

    # Login
    login = await async_client.post(
        "/v1/auth/token",
        data={"username": "testuser", "password": "TestPass123"},
    )
    assert login.status_code == 200
    token = login.json()["access_token"]
    assert token

    # /me
    me = await async_client.get(
        "/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me.status_code == 200
    assert me.json()["username"] == "testuser"


@pytest.mark.asyncio
async def test_register_duplicate_username(async_client: AsyncClient) -> None:
    body = {"username": "dupuser", "password": "Password123"}
    r1 = await async_client.post("/v1/auth/register", json=body)
    assert r1.status_code == 201
    r2 = await async_client.post("/v1/auth/register", json=body)
    assert r2.status_code == 409


@pytest.mark.asyncio
async def test_me_unauthenticated(async_client: AsyncClient) -> None:
    resp = await async_client.get("/v1/auth/me")
    assert resp.status_code == 401


# ── WebSocket stream ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stream_returns_ready(async_client: AsyncClient) -> None:
    """The streaming endpoint should accept and announce a ready session."""
    pytest.importorskip("httpx_ws", reason="httpx_ws not installed")

    import json
    from httpx_ws import aconnect_ws  # type: ignore[import]

    async with aconnect_ws("/v1/stream", async_client) as ws:
        msg = await ws.receive_text()
        data = json.loads(msg)
        assert data["type"] == "ready"
        await ws.send_text('{"type":"end"}')
