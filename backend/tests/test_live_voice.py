"""Offline API and lifecycle tests; every provider socket is replaced locally."""
from __future__ import annotations

import asyncio
import base64
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.v1 import live_voice
from app.core.live_voice import configuration, session


@pytest.fixture
def local_voice(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    monkeypatch.setattr(configuration, "ENV_PATH", env)
    for field in (*configuration.CONFIG_FIELDS, "QWEN_BRAIN_ENABLED", "GROK_EVAL_ENABLED"):
        monkeypatch.setenv(field, "")
    values = {"DASHSCOPE_API_KEY": "test-qwen-secret", "DASHSCOPE_WORKSPACE_ID": "test-space",
              "DASHSCOPE_REGION": "cn-beijing", "GEMINI_API_KEY": "test-gemini-secret",
              "BOSON_API_KEY": "test-boson-secret", "XAI_API_KEY": "test-xai-secret",
              "OPENAI_API_KEY": "", "QWEN_BRAIN_ENABLED": "1", "GROK_EVAL_ENABLED": "0"}
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    app = FastAPI()
    app.include_router(live_voice.router, prefix="/v1")
    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 43210)) as client:
        yield client, env, values


def test_catalog_has_real_models_no_credentials_and_free_only_grok(local_voice):
    client, _, values = local_voice
    response = client.get("/v1/live-voice/catalog")
    assert response.status_code == 200
    data = response.json()
    rows = {row["id"]: row for row in data["providers"]}
    assert rows["qwen"]["model"] == "qwen-audio-3.1-realtime-plus"
    assert rows["gemini_thinking"]["model"] == "gemini-3.8-live-extended-thinking"
    assert rows["grok"]["configured"] and not rows["grok"]["available"]
    assert rows["openai"]["transport"] == "webrtc"
    assert data["brain_available"]
    assert all(value not in response.text for key, value in values.items() if key.endswith("API_KEY") and value)
    assert {row["gender"] for row in rows["grok"]["voices"]} == {"unknown"}
    assert rows["qwen"]["default_voice"] in {row["id"] for row in rows["qwen"]["voices"]}


@pytest.mark.parametrize("headers", [
    {"Origin": "https://evil.example"}, {"Origin": "null"},
    {"Host": "rebind.evil.example"}, {"Origin": "http://127.0.0.1.evil.example"},
])
def test_untrusted_browser_cannot_read_or_start(local_voice, headers):
    client, _, _ = local_voice
    assert client.get("/v1/live-voice/catalog", headers=headers).status_code == 403
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("ws://127.0.0.1:8000/v1/live-voice/ws", headers=headers):
            pass


def test_remote_client_cannot_read_catalog():
    app = FastAPI()
    app.include_router(live_voice.router, prefix="/v1")
    with TestClient(app, base_url="http://127.0.0.1", client=("192.168.1.20", 1234)) as client:
        assert client.get("/v1/live-voice/catalog").status_code == 403


def test_config_atomic_preserves_unrelated_gates_and_blank_keys(local_voice):
    client, env, _ = local_voice
    env.write_text("# existing\nGROK_EVAL_ENABLED=0\nOTHER_SETTING=retained\nGEMINI_API_KEY=old\n", encoding="utf-8")
    response = client.put("/v1/live-voice/config", headers={"X-Amadeus-Config": "1"}, json={
        "GEMINI_API_KEY": "replacement-key", "BOSON_API_KEY": "", "DASHSCOPE_WORKSPACE_ID": "new-space"})
    assert response.status_code == 200
    assert "replacement-key" not in response.text
    assert response.json()["credential_status"]["GEMINI_API_KEY"]
    assert response.json()["config"]["dashscope_workspace_id"] == "new-space"
    content = env.read_text(encoding="utf-8")
    assert "GROK_EVAL_ENABLED=0" in content and "OTHER_SETTING=retained" in content
    assert "GEMINI_API_KEY=replacement-key" in content and "BOSON_API_KEY=" not in content
    assert list(env.parent.glob(".env.*.tmp")) == []


@pytest.mark.parametrize("fields", [
    {"GROK_EVAL_ENABLED": "1"}, {"GEMINI_API_KEY": "secret\nOPENAI_API_KEY=injected"},
    {"GEMINI_API_KEY": {"secret": "never-echo-this"}}, {"DASHSCOPE_REGION": "evil-host"},
    {"DASHSCOPE_WORKSPACE_ID": "space@evil.example"},
])
def test_config_rejects_injection_without_echoing_secrets(local_voice, fields):
    client, env, _ = local_voice
    response = client.put("/v1/live-voice/config", headers={"X-Amadeus-Config": "1"}, json=fields)
    assert response.status_code == 422
    assert "never-echo-this" not in response.text and "injected" not in response.text
    assert not env.exists()


def test_config_needs_custom_header_and_limits_size(local_voice):
    client, env, _ = local_voice
    assert client.put("/v1/live-voice/config", json={"GEMINI_API_KEY": "x"}).status_code == 403
    assert client.put("/v1/live-voice/config", headers={"X-Amadeus-Config": "1"}, content="x" * 17000).status_code == 413
    assert not env.exists()


def test_legacy_qwen_sdp_cannot_start_wrong_model(local_voice, monkeypatch):
    import httpx
    client, _, _ = local_voice
    monkeypatch.setattr(httpx.AsyncClient, "post", lambda *a, **kw: pytest.fail("No legacy Qwen upstream call"))
    response = client.post("/v1/live-voice/session", json={"provider": "qwen", "sdp": "v=0" + " " * 30})
    assert response.status_code == 409
    assert "/v1/live-voice/ws" in response.json()["detail"]


@pytest.mark.parametrize("start", [
    {"type": "start", "model": "grok"},
    {"type": "start", "model": "qwen", "voice": "Zephyr"},
    {"type": "start", "model": "gemini_live", "brain": "qwen3.7-plus"},
    {"type": "start", "model": "gemini_live", "instructions": "a" * 4001},
    {"type": "start", "model": "openai"},
    {"type": "start", "model": {"id": "qwen"}},
])
def test_start_validation_blocks_before_upstream(local_voice, monkeypatch, start):
    import websockets
    client, _, _ = local_voice
    monkeypatch.setattr(websockets, "connect", lambda *a, **k: pytest.fail("Must not connect upstream"))
    with client.websocket_connect("ws://127.0.0.1:8000/v1/live-voice/ws") as ws:
        ws.send_json(start)
        assert ws.receive_json()["type"] == "error"


class FakeUpstream:
    def __init__(self, provider):
        self.provider = provider
        self.sent = []
        self.incoming = asyncio.Queue()
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        self.closed = True

    async def send(self, raw):
        event = json.loads(raw)
        self.sent.append(event)
        if "setup" in event:
            await self.incoming.put(json.dumps({"setupComplete": {}}))
        elif event.get("type") == "session.update":
            await self.incoming.put(json.dumps({"type": "session.created" if self.provider == "higgs" else "session.updated", "session": {}}))

    async def recv(self):
        return await self.incoming.get()

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.recv()


@pytest.mark.parametrize("provider", ["qwen", "gemini_live", "gemini_thinking", "higgs", "grok"])
def test_all_native_adapters_setup_audio_and_clean_stop(local_voice, monkeypatch, provider):
    import websockets
    client, _, _ = local_voice
    upstream = FakeUpstream(provider)
    # This fake is the only allowed connection; no account is contacted.
    monkeypatch.setattr(websockets, "connect", lambda *a, **kw: upstream)
    if provider == "grok":
        monkeypatch.setenv("GROK_EVAL_ENABLED", "1")
    with client.websocket_connect("ws://127.0.0.1:8000/v1/live-voice/ws", headers={"Origin": "http://localhost:5173"}) as ws:
        ws.send_json({"type": "start", "model": provider, "instructions": "请用一句话回答。"})
        ready = ws.receive_json()
        assert ready["type"] == "ready"
        ws.send_json({"type": "audio", "data": base64.b64encode(b"\x00" * 32000).decode()})
        assert ws.receive_json()["type"] == "capture_ack"
        ws.send_json({"type": "stop"})
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()
    assert upstream.closed
    setup = upstream.sent[0]
    actual = setup["setup"]["systemInstruction"]["parts"][0]["text"] if "setup" in setup else setup["session"]["instructions"]
    assert actual.startswith("请用一句话回答。")
    assert "本次实际工具" in actual and "没有接入天气" in actual
    assert any("realtimeInput" in event or event.get("type") == "input_audio_buffer.append" for event in upstream.sent)


def test_disconnect_cancels_provider_during_handshake(local_voice, monkeypatch):
    client, _, _ = local_voice
    cancelled = []

    async def slow_provider(browser, values, start):
        try:
            await browser.send(json.dumps({"type": "opening"}))
            await asyncio.Future()
        finally:
            cancelled.append(True)

    monkeypatch.setitem(session.HANDLERS, "qwen", slow_provider)
    with client.websocket_connect("ws://127.0.0.1:8000/v1/live-voice/ws") as ws:
        ws.send_json({"type": "start", "model": "qwen"})
        assert ws.receive_json()["type"] == "opening"
    assert cancelled == [True]


def test_failure_does_not_expose_credential_url(local_voice, monkeypatch):
    client, _, values = local_voice

    async def failed_provider(*_):
        raise RuntimeError("wss://provider.example?key=" + values["GEMINI_API_KEY"])

    monkeypatch.setitem(session.HANDLERS, "gemini_live", failed_provider)
    with client.websocket_connect("ws://127.0.0.1:8000/v1/live-voice/ws") as ws:
        ws.send_json({"type": "start", "model": "gemini_live"})
        response = ws.receive_json()
        assert response["type"] == "error"
        assert "key=" not in json.dumps(response) and values["GEMINI_API_KEY"] not in json.dumps(response)


def test_oversized_stream_event_closes_and_cleans_up(local_voice, monkeypatch):
    client, _, _ = local_voice
    cancelled = []

    async def waiting(browser, *_):
        try:
            await browser.send(json.dumps({"type": "ready"}))
            await asyncio.Future()
        finally:
            cancelled.append(True)

    monkeypatch.setitem(session.HANDLERS, "qwen", waiting)
    with client.websocket_connect("ws://127.0.0.1:8000/v1/live-voice/ws") as ws:
        ws.send_json({"type": "start", "model": "qwen"})
        ws.receive_json()
        ws.send_text("a" * 150001)
        with pytest.raises(WebSocketDisconnect) as error:
            ws.receive_json()
        assert error.value.code == 1009
    assert cancelled == [True]


async def test_qwen_caption_completion_marks_final():
    from app.core.live_voice import qwen_provider

    class Stream:
        def __init__(self, events=()):
            self.events = events
            self.sent = []

        def __aiter__(self):
            async def iterate():
                for item in self.events:
                    yield json.dumps(item)
            return iterate()

        async def send(self, value):
            self.sent.append(json.loads(value))

    local = Stream()
    upstream = Stream([
        {"type": "conversation.item.input_audio_transcription.delta", "item_id": "turn-1", "text": "你好"},
        {"type": "conversation.item.input_audio_transcription.completed", "item_id": "turn-1", "transcript": "你好。"},
    ])
    await qwen_provider.from_qwen(local, upstream, qwen_provider.QwenTurnState(), False, {})
    assert [event["final"] for event in local.sent] == [False, True]
    assert [event["item_id"] for event in local.sent] == ["turn-1", "turn-1"]
