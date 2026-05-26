"""
tests/test_api.py
──────────────────
API-level integration tests.
Uses the async_client fixture (no real models, in-memory DB).
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from tests.conftest import make_wav_bytes


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
        data={"options": '{"engines": ["mock"]}'},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "success"
    assert data["full_text"] == "测试识别结果"
    assert data["engine_used"] == "mock"
    assert data["task_id"]


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
        data={"options": '{"engines": ["nonexistent"]}'},
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


# ── Tasks endpoint ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_task_after_transcribe(async_client: AsyncClient) -> None:
    wav = make_wav_bytes(1.0)
    post_resp = await async_client.post(
        "/v1/transcribe",
        files={"file": ("t.wav", wav, "audio/wav")},
        data={"options": '{"engines": ["mock"]}'},
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

    from app.core.archive import archive_pcm_record

    started_at = datetime.now(timezone.utc)
    archive_pcm_record(
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
