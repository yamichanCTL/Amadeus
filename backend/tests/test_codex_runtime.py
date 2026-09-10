"""Real JSONL subprocess tests; no external account or model calls."""

from __future__ import annotations

import asyncio
import json
import os
import sys

import pytest
import pytest_asyncio
from app.config import Settings
from app.core.codex_asr import CodexASRBridge
from app.core.codex_connection import CodexError, prepare_connection
from app.core.codex_runtime import CodexRuntime
from app.core.codex_usage import CodexLedger
from app.db.models import Base, CodexCall
from app.schemas.codex import CodexOptions
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture(scope="session")
def event_loop_policy():
    try:
        import uvloop

        return uvloop.EventLoopPolicy()
    except ImportError:
        return asyncio.DefaultEventLoopPolicy()


@pytest.fixture
def connection_settings(tmp_path, monkeypatch):
    home = tmp_path / "source-home"
    home.mkdir()
    (home / "auth.json").write_text('{"OPENAI_API_KEY":"private-source-token"}')
    (home / "config.toml").write_text("""model = "custom-model"
model_provider = "test-provider"
model_reasoning_effort = "low"
[model_providers.test-provider]
name = "test"
base_url = "https://user:private-url-token@example.test/v1?key=private-query-token"
env_key = "TEST_CODEX_TOKEN"
[mcp_servers.private]
command = "must-not-run"
[features]
plugins = true
""")
    monkeypatch.setenv("TEST_CODEX_TOKEN", "private-provider-token")
    monkeypatch.setenv("UNRELATED_SECRET", "private-unrelated-token")
    binary = tmp_path / "fake-codex"
    binary.write_text(
        f"#!{sys.executable}\n"
        + r"""
import json, os, sys, time
total = 0
turn = 0
history = []
def send(value):
    print(json.dumps(value), flush=True)
def notification(method, params):
    send({'method':method, 'params':{'threadId':'test-thread', **params}})
for line in sys.stdin:
    message=json.loads(line)
    method=message.get('method')
    identifier=message.get('id')
    params=message.get('params',{})
    if identifier is None: continue
    if method=='initialize': result={}
    elif method=='account/read':
        assert params['refreshToken'] is False
        result=json.load(open('account-state.json')) if os.path.exists('account-state.json') else {
            'account':{'type':'apiKey'},'requiresOpenaiAuth':True}
    elif method=='model/list':
        result={'data':[{'model':'catalog-model','displayName':'Catalog','isDefault':True,
            'supportedReasoningEfforts':[{'reasoningEffort':'low'}],'defaultReasoningEffort':'low'}]}
    elif method=='thread/start': result={'thread':{'id':'test-thread'},'model':params.get('model')}
    elif method=='turn/start':
        turn+=1
        text=params['input'][0]['text']
        send({'id':identifier,'result':{'turn':{'id':str(turn)}}})
        if text=='WAIT': time.sleep(60)
        if text=='FAIL':
            notification('turn/completed',{'turn':{'id':str(turn),'status':'failed',
                'error':{'message':'401 private-provider-token private-source-token'}}})
            continue
        history.append(text)
        output=' | '.join(history)
        notification('item/agentMessage/delta',{'turnId':str(turn),'delta':output})
        notification('item/completed',{'turnId':str(turn),'item':{'id':str(turn),'type':'agentMessage','text':output}})
        if text!='MISSING':
            total+=100
            usage={'inputTokens':total,'cachedInputTokens':total//2,'outputTokens':total//5,
                'reasoningOutputTokens':total//10,'totalTokens':total+total//5}
            for _ in range(2):
                notification('thread/tokenUsage/updated',{'turnId':str(turn),'tokenUsage':{'total':usage,'last':usage}})
        notification('turn/completed',{'turn':{'id':str(turn),'status':'completed'}})
        continue
    else: result={}
    send({'id':identifier,'result':result})
"""
    )
    binary.chmod(0o700)
    return Settings(
        _env_file=None,
        project_root=tmp_path,
        codex_config_home=home,
        codex_runtime_dir=tmp_path / "runtime",
        codex_binary=str(binary),
    )


@pytest_asyncio.fixture
async def runtime(connection_settings):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    service = CodexRuntime(connection_settings, CodexLedger(factory))
    yield service
    await service.shutdown()
    await engine.dispose()


def test_imports_only_selected_connection(connection_settings):
    connection = prepare_connection(connection_settings)
    config = (connection.home / "config.toml").read_text()
    assert "mcp_servers" not in config
    assert "must-not-run" not in config
    assert "UNRELATED_SECRET" not in connection.env
    assert connection.env["TEST_CODEX_TOKEN"] == "private-provider-token"
    assert connection.endpoint == "https://example.test/v1"
    assert (connection.home / "auth.json").stat().st_mode & 0o077 == 0
    (connection.home / "auth.json").write_text("refreshed-credentials")
    assert prepare_connection(connection_settings).home == connection.home
    assert (connection.home / "auth.json").read_text() == "refreshed-credentials"
    (connection_settings.codex_config_home / "auth.json").write_text("new-source-credentials")
    assert prepare_connection(connection_settings).home != connection.home


async def test_real_subprocess_multiturn_and_usage_not_double_counted(runtime):
    events = []

    async def emit(event):
        events.append(event)

    one = await runtime.turn("private-user-utterance", CodexOptions(), emit=emit)
    two = await runtime.turn("follow-up", CodexOptions(model="selected-model", effort="high"))
    assert one.status == two.status == "completed"
    assert two.text == "private-user-utterance | follow-up"
    assert two.model == "selected-model" and two.effort == "high"
    assert one.usage.total_tokens == two.usage.total_tokens == 120
    assert any(event["type"] == "agent.delta" for event in events)
    summary = await runtime.ledger.summary()
    assert summary["calls"] == 2 and summary["total_tokens"] == 240
    assert summary["cached_input_tokens"] == 100 and summary["complete"] is True
    assert (await runtime.ledger.summary(model="selected-model"))["total_tokens"] == 120
    async with runtime.ledger.session_factory() as db:
        records = (await db.execute(select(CodexCall))).scalars().all()
        assert "private-user-utterance" not in repr([vars(row) for row in records])


async def test_missing_usage_is_unknown_and_resets_baseline(runtime):
    missing = await runtime.turn("MISSING", CodexOptions())
    assert missing.status == "completed" and missing.usage is None
    assert "default" not in runtime._sessions
    await runtime.turn("next", CodexOptions())
    summary = await runtime.ledger.summary()
    assert summary["missing_usage"] == 1 and summary["complete"] is False
    assert summary["total_tokens"] == 120


async def test_failure_is_real_not_mock_and_redacts_errors(runtime):
    result = await runtime.turn("FAIL", CodexOptions())
    assert result.status == "failed" and result.error_code == "codex_auth"
    assert "private-" not in result.model_dump_json()
    assert "mock" not in result.model_dump_json()
    assert (await runtime.ledger.summary())["missing_usage"] == 1


async def test_cancel_stops_actual_process_and_session_can_restart(runtime):
    started = asyncio.Event()

    async def emit(event):
        if event["type"] == "agent.started":
            started.set()

    task = asyncio.create_task(runtime.turn("WAIT", CodexOptions(), emit=emit))
    await asyncio.wait_for(started.wait(), 5)
    pid = runtime._sessions["default"].client.process.pid
    with pytest.raises(CodexError, match="已有"):
        await runtime.turn("duplicate", CodexOptions())
    assert await runtime.cancel("default") is True
    result = await task
    assert result.status == "cancelled"
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    await asyncio.sleep(0)
    assert (await runtime.turn("restart", CodexOptions())).status == "completed"


async def test_asr_bridge_forwards_only_final_once_and_finishes_in_order(runtime):
    output = asyncio.Queue()
    bridge = CodexASRBridge(runtime, output, "voice-session")
    await bridge.configure({"enabled": True, "model": "voice-model"})
    try:
        await bridge.submit({"type": "partial", "job_id": "1", "text": "partial"})
        await bridge.submit({"type": "final", "job_id": "empty", "text": " "})
        await bridge.submit({"type": "final", "job_id": "1", "text": "voice-one"})
        await bridge.submit({"type": "final", "job_id": "1", "text": "duplicate"})
        await bridge.submit({"type": "final", "job_id": "2", "text": "voice-two"})
        bridge.finish({"type": "done"})
        events = []
        while True:
            event = await asyncio.wait_for(output.get(), 5)
            events.append(event)
            if event["type"] == "agent.drained":
                break
        results = [event for event in events if event["type"] == "agent.completed"]
        assert [event["source_job_id"] for event in results] == ["1", "2"]
        assert results[-1]["result"]["text"] == "voice-one | voice-two"
        assert (await runtime.ledger.summary("voice-session"))["calls"] == 2
    finally:
        await bridge.close()


async def test_model_catalog_keeps_configured_provider_model(runtime):
    result = await runtime.inspect()
    assert result["configured_model"] == "custom-model"
    assert [model["id"] for model in result["models"]] == ["custom-model", "catalog-model"]
    assert "private-" not in json.dumps(result)


@pytest.mark.parametrize("requires_auth", [True, False])
async def test_model_catalog_checks_missing_account(runtime, requires_auth):
    connection = prepare_connection(runtime.settings)
    (connection.workspace / "account-state.json").write_text(
        json.dumps({"account": None, "requiresOpenaiAuth": requires_auth})
    )
    if requires_auth:
        with pytest.raises(CodexError) as error:
            await runtime.inspect()
        assert error.value.code == "codex_auth"
    else:
        assert (await runtime.inspect())["models"]


async def test_meeting_explanations_are_isolated_and_dispose_sessions(runtime):
    from app.api.v1.codex import router
    from app.core.codex_runtime import get_codex_runtime
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    app = FastAPI()
    app.include_router(router, prefix="/v1")
    app.dependency_overrides[get_codex_runtime] = lambda: runtime
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        first = await client.post("/v1/agents/codex/explanations", json={"target": "独立话题甲"})
        second = await client.post("/v1/agents/codex/explanations", json={
            "target": "独立话题乙", "preceding_context": "明确提供的前文" * 800,
            "recent_excerpt": "独立话题乙", "focus": "recent_window",
            "preset_prompt": "面向后端开发者解释", "focus_points": "业务意义与风险",
            "recent_weight": 5, "lookback_seconds": 180, "recent_seconds": 45,
        })
        assert first.status_code == second.status_code == 200
        a, b = first.json(), second.json()
        assert a["result"]["session_id"] != b["result"]["session_id"]
        assert b["target"] == "独立话题乙"
        assert "独立话题甲" not in b["result"]["text"]
        assert "明确提供的前文" in b["result"]["text"]
        assert "面向后端开发者解释" in b["result"]["text"]
        assert "业务意义与风险" in b["result"]["text"]
        assert '"recent_weight": 5' in b["result"]["text"]
        assert "触发之前" in b["result"]["text"]
        assert "自行判断" in b["result"]["text"]
        assert '"focus": "recent_window"' in b["result"]["text"]
        assert not runtime._sessions
        assert (await runtime.ledger.summary())["calls"] == 2
        for body in [
            {"target": "   "},
            {"target": "x", "session_id": "old-chat"},
            {"target": "x", "context": "old-persona"},
            {"target": "x", "preceding_context": "字" * 8001},
            {"target": "x", "recent_excerpt": "不属于原话"},
            {"target": "x", "recent_weight": 6},
            {"target": "x", "lookback_seconds": 10, "recent_seconds": 30},
            {"target": "x", "preset_prompt": "字" * 4001},
            {"target": "x", "focus_points": "字" * 2001},
            {"target": "字" * 12001},
            {"following_context": "后文", "focus": "target"},
        ]:
            rejected = await client.post("/v1/agents/codex/explanations", json=body)
            assert rejected.status_code == 422
        # The old post-trigger contract is rejected rather than silently reversing intent.
        leading = await client.post("/v1/agents/codex/explanations", json={
            "following_context": "未来的话", "focus": "after_trigger",
        })
        assert leading.status_code == 422
        assert not runtime._sessions



async def test_cancel_during_initial_accounting_commit_leaves_terminal_row(runtime, monkeypatch):
    entered = asyncio.Event()
    release = asyncio.Event()
    original = runtime.ledger.begin

    async def delayed(result, source):
        await original(result, source)
        entered.set()
        await release.wait()

    monkeypatch.setattr(runtime.ledger, "begin", delayed)
    turn = asyncio.create_task(runtime.turn("must not execute", CodexOptions()))
    await asyncio.wait_for(entered.wait(), 5)
    cancelled = asyncio.create_task(runtime.cancel("default"))
    await asyncio.sleep(0.01)
    duplicate = asyncio.create_task(runtime.cancel("default"))
    release.set()
    result = await asyncio.wait_for(turn, 5)
    await asyncio.gather(cancelled, duplicate)
    assert result.status == "cancelled" and not runtime._sessions
    async with runtime.ledger.session_factory() as db:
        row = await db.get(CodexCall, result.call_id)
        assert row.status == "cancelled"


async def test_http_accepts_completed_asr_result_and_rejects_unfinished(runtime):
    from app.api.v1.codex import router
    from app.core.codex_runtime import get_codex_runtime
    from app.db.models import ASRTask, TaskStatus, Transcript
    from app.db.session import get_db
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    async with runtime.ledger.session_factory() as db:
        db.add_all(
            [
                ASRTask(id="ready", status=TaskStatus.SUCCESS),
                ASRTask(id="pending", status=TaskStatus.PENDING),
                Transcript(
                    task_id="ready", full_text="actual stored ASR result", engine_used="test"
                ),
            ]
        )
        await db.commit()

    async def database():
        async with runtime.ledger.session_factory() as db:
            yield db

    app = FastAPI()
    app.include_router(router, prefix="/v1")
    app.dependency_overrides[get_codex_runtime] = lambda: runtime
    app.dependency_overrides[get_db] = database
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/v1/agents/codex/turns", json={"task_id": "ready"})
        assert response.status_code == 200, response.text
        assert response.json()["text"] == "actual stored ASR result"
        assert (
            await client.post("/v1/agents/codex/turns", json={"task_id": "pending"})
        ).status_code == 409
        assert (
            await client.post("/v1/agents/codex/turns", json={"task_id": "unknown"})
        ).status_code == 404
        assert (
            await client.post(
                "/v1/agents/codex/turns", json={"task_id": "ready", "text": "override"}
            )
        ).status_code == 422
        assert (await client.get("/v1/agents/codex/usage")).json()["calls"] == 1


async def test_socket_sender_delivers_agent_answer_before_done(runtime):
    from types import SimpleNamespace

    from app.api.v1.stream import _send_loop

    events = []

    class Socket:
        async def send_text(self, value):
            events.append(json.loads(value))

    queue = asyncio.Queue()
    bridge = CodexASRBridge(runtime, queue, "socket-session")
    await bridge.configure({"enabled": True})
    await queue.put({"type": "final", "job_id": 1, "text": "speech"})
    await queue.put({"type": "done"})
    try:
        await asyncio.wait_for(_send_loop(Socket(), SimpleNamespace(queue=queue), bridge), 5)
        assert events[-1]["type"] == "done"
        assert (
            next(e for e in events if e["type"] == "agent.completed")["result"]["text"] == "speech"
        )
    finally:
        await bridge.close()


async def test_bridge_disconnect_cancels_active_turn_and_discards_queue(runtime):
    output = asyncio.Queue()
    bridge = CodexASRBridge(runtime, output, "disconnect")
    await bridge.configure({"enabled": True})
    await bridge.submit({"type": "final", "job_id": "1", "text": "WAIT"})
    await bridge.submit({"type": "final", "job_id": "2", "text": "must not run"})
    while (await asyncio.wait_for(output.get(), 5))["type"] != "agent.started":
        pass
    pid = runtime._sessions["disconnect"].client.process.pid
    await bridge.close()
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    assert (await runtime.ledger.summary("disconnect"))["calls"] == 1


def test_firered_accepts_browser_frames_without_losing_analysis_overlap():
    from types import SimpleNamespace

    import numpy as np
    from app.core.streaming.vad import EnergyVad, FireRedVad

    seen = []

    def detect(chunk):
        seen.append(chunk.copy())
        return []

    vad = FireRedVad.__new__(FireRedVad)
    vad._audio_buffer = np.empty(0, dtype=np.int16)
    vad._fast_vad = EnergyVad(80, 700)
    vad._vad = SimpleNamespace(detect_chunk=detect, reset=lambda: None)
    audio = np.arange(4096, dtype=np.int16)
    for start in range(0, len(audio), 128):
        vad.accept_pcm(audio[start : start + 128].tobytes())
    assert len(seen) == 2
    np.testing.assert_array_equal(seen[0], audio[:1840])
    np.testing.assert_array_equal(seen[1], audio[1600:3440])
    vad.reset()
    assert vad._audio_buffer.size == 0


async def test_ui_persona_context_reaches_codex_with_voice_input(runtime):
    options = CodexOptions(session_id="ui-context", context="角色：简短回答。\n记忆：偏好中文。")
    result = await runtime.turn("这是语音结果", options, source="asr_stream")
    assert result.status == "completed"
    assert "角色：简短回答。" in result.text
    assert "记忆：偏好中文。" in result.text
    assert result.text.endswith("[用户输入]\n这是语音结果")
    assert (await runtime.ledger.summary("ui-context"))["calls"] == 1
