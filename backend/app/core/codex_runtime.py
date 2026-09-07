"""Bounded conversational Codex runtime shared by HTTP and final ASR events."""

from __future__ import annotations

import asyncio
import shutil
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from app.config import Settings, get_settings
from app.core.codex_connection import CodexError, prepare_connection, public_error
from app.core.codex_transport import CodexTransport
from app.core.codex_usage import CodexLedger, normalize_usage, usage_delta
from app.schemas.codex import CodexOptions, CodexTurnResult, CodexUsage

EventSink = Callable[[dict], Awaitable[None]]


@dataclass
class _Session:
    client: CodexTransport
    thread_id: str
    model: str | None
    total: CodexUsage | None = None


class CodexRuntime:
    def __init__(self, settings: Settings, ledger: CodexLedger, transport_factory=CodexTransport):
        self.settings = settings
        self.ledger = ledger
        self.transport_factory = transport_factory
        self._sessions: dict[str, _Session] = {}
        self._active: dict[str, asyncio.Task] = {}
        self._cancel_requested: set[asyncio.Task] = set()
        self._closing = False

    async def inspect(self) -> dict:
        if not shutil.which(self.settings.codex_binary):
            raise CodexError("codex_unavailable", "未找到 Codex CLI，请安装或设置 CODEX_BINARY。")
        connection = prepare_connection(self.settings)
        async with self.transport_factory(self.settings.codex_binary, connection) as client:
            models = []
            cursor = None
            for _ in range(10):
                page = await client.request("model/list", {"limit": 100, "cursor": cursor})
                for item in page.get("data", []):
                    models.append(
                        {
                            "id": item.get("model") or item.get("id"),
                            "name": item.get("displayName"),
                            "default": item.get("isDefault", False),
                            "efforts": [
                                option["reasoningEffort"]
                                for option in item.get("supportedReasoningEfforts", [])
                            ],
                            "default_effort": item.get("defaultReasoningEffort"),
                            "source": "codex_catalog",
                        }
                    )
                cursor = page.get("nextCursor")
                if not cursor:
                    break
            if connection.model and not any(item["id"] == connection.model for item in models):
                models.insert(
                    0,
                    {
                        "id": connection.model,
                        "name": connection.model,
                        "default": True,
                        "efforts": [],
                        "default_effort": connection.effort,
                        "source": "configured_provider",
                    },
                )
            return {
                "available": True,
                "provider": connection.provider,
                "endpoint": connection.endpoint,
                "configured_model": connection.model,
                "configured_effort": connection.effort,
                "models": models,
                "source": "Codex / CC Switch selected connection",
                "note": (
                    "模型目录不保证自定义提供方可用；可直接指定该提供方支持的模型 ID。"
                    "每轮读取当前连接配置。"
                ),
            }

    async def turn(
        self,
        text: str,
        options: CodexOptions,
        *,
        source: str = "text",
        emit: EventSink | None = None,
    ) -> CodexTurnResult:
        if self._closing:
            raise CodexError("codex_unavailable", "后端正在关闭。")
        if options.session_id in self._active:
            raise CodexError("codex_busy", "此会话已有执行中的请求，请等待或取消。")
        if len(self._active) >= self.settings.codex_max_active_turns:
            raise CodexError("codex_capacity", "Codex 当前任务已满，请稍后重试。")
        connection = prepare_connection(self.settings)
        task = asyncio.create_task(self._run(text, options, connection, source, emit))
        self._active[options.session_id] = task
        try:
            return await task
        finally:
            self._cancel_requested.discard(task)
            if self._active.get(options.session_id) is task:
                self._active.pop(options.session_id, None)

    async def _run(self, text, options, connection, source, emit) -> CodexTurnResult:
        result = CodexTurnResult(
            call_id=str(uuid.uuid4()),
            session_id=options.session_id,
            status="failed",
            model=options.model or connection.model,
            provider=connection.provider,
            effort=options.effort if options.effort is not None else connection.effort,
        )
        # Refuse execution if the accounting row cannot be committed.
        recording = asyncio.create_task(self.ledger.begin(result, source))
        try:
            await asyncio.shield(recording)
        except asyncio.CancelledError:
            # Cancellation can arrive while SQLite is committing the initial row.
            # Settle that transaction before publishing a terminal cancellation.
            await recording
            result.status = "cancelled"
            result.error_code = "cancelled"
            result.error = "任务已取消。"
            await self.ledger.finish(result)
            if emit:
                await emit(
                    {
                        "type": "agent.completed",
                        "call_id": result.call_id,
                        "session_id": result.session_id,
                        "result": result.model_dump(),
                    }
                )
            return result
        started = time.monotonic()
        session = self._sessions.get(options.session_id)
        previous = None
        observed = None

        async def publish(kind: str, **payload):
            if emit:
                await emit(
                    {
                        "type": f"agent.{kind}",
                        "call_id": result.call_id,
                        "session_id": options.session_id,
                        **payload,
                    }
                )

        async def execute():
            nonlocal session, previous, observed
            if session and session.client.connection.fingerprint != connection.fingerprint:
                await session.client.close()
                self._sessions.pop(options.session_id, None)
                session = None
            if session is None:
                while len(self._sessions) >= self.settings.codex_max_sessions:
                    idle = next((key for key in self._sessions if key not in self._active), None)
                    if idle is None:
                        raise CodexError("codex_capacity", "Codex 会话已满，请关闭闲置会话。")
                    await self._sessions.pop(idle).client.close()
                client = self.transport_factory(self.settings.codex_binary, connection)
                try:
                    await client.start()
                    response = await client.request(
                        "thread/start",
                        {
                            "model": result.model,
                            "modelProvider": connection.provider,
                            "cwd": str(connection.workspace),
                            "sandbox": "read-only",
                            "approvalPolicy": "never",
                            "ephemeral": True,
                        },
                    )
                    session = _Session(
                        client, response["thread"]["id"], response.get("model") or result.model
                    )
                    self._sessions[options.session_id] = session
                except BaseException:
                    await client.close()
                    raise
            previous = session.total
            result.thread_id = session.thread_id
            result.model = result.model or session.model
            # All packets from the previous completed turn have already been consumed.
            response = await session.client.request(
                "turn/start",
                {
                    "threadId": session.thread_id,
                    "input": [
                        {
                            "type": "text",
                            "text": (
                                f"[对话设定与参考上下文]\n{options.context}\n\n[用户输入]\n{text}"
                                if options.context
                                else text
                            ),
                            "text_elements": [],
                        }
                    ],
                    "model": result.model,
                    "effort": result.effort,
                },
            )
            result.turn_id = response["turn"]["id"]
            await publish(
                "started",
                thread_id=result.thread_id,
                turn_id=result.turn_id,
                model=result.model,
                provider=result.provider,
                effort=result.effort,
            )
            final_messages: dict[str, str] = {}
            delta_text = ""
            while True:
                event = await session.client.events.get()
                method = event.get("method")
                params = event.get("params", {})
                if method == "transport/error":
                    raise event["error"]
                if params.get("threadId") not in {None, result.thread_id}:
                    continue
                event_turn = params.get("turnId") or params.get("turn", {}).get("id")
                if event_turn and event_turn != result.turn_id:
                    continue
                if method == "thread/tokenUsage/updated":
                    # This is a cumulative snapshot, not an additive per-notification count.
                    current = normalize_usage(params.get("tokenUsage", {}).get("total"))
                    if current is not None:
                        observed = current
                elif method == "item/agentMessage/delta":
                    delta = str(params.get("delta", ""))
                    delta_text = (delta_text + delta)[-64000:]
                    await publish("delta", text=delta)
                elif method == "item/completed":
                    item = params.get("item", {})
                    if item.get("type") == "agentMessage":
                        final_messages[item.get("id", "final")] = str(item.get("text", ""))[-64000:]
                elif method == "error" and not params.get("willRetry", False):
                    raise public_error(params.get("error", {}))
                elif method == "turn/completed":
                    turn = params.get("turn", {})
                    if turn.get("status") == "interrupted":
                        result.status = "cancelled"
                    elif turn.get("status") != "completed":
                        raise public_error(turn.get("error", {}))
                    else:
                        result.status = "completed"
                        result.text = ("\n".join(final_messages.values()) or delta_text)[-64000:]
                        if not result.text.strip():
                            raise CodexError("codex_empty", "Codex 未返回回答。")
                    return

        try:
            await asyncio.wait_for(execute(), timeout=options.timeout_sec)
        except asyncio.CancelledError:
            result.status = "cancelled"
            result.error_code = "cancelled"
            result.error = "任务已取消。"
        except TimeoutError:
            result.status = "timed_out"
            result.error_code = "codex_timeout"
            result.error = "Codex 请求超时。"
        except Exception as error:
            result.status = "failed"
            failure = error if isinstance(error, CodexError) else public_error(error)
            result.error_code, result.error = failure.code, str(failure)
        finally:
            result.elapsed_sec = round(time.monotonic() - started, 3)
            result.usage = usage_delta(observed, previous)
            if session:
                session.total = observed or previous
                if result.status != "completed" or observed is None:
                    # No cumulative baseline after a missing-usage turn: reset to avoid
                    # attributing that unknown turn's tokens to the next request.
                    await session.client.close()
                    self._sessions.pop(options.session_id, None)
            await self.ledger.finish(result)
        await publish("completed", result=result.model_dump())
        return result

    async def cancel(self, session_id: str) -> bool:
        task = self._active.get(session_id)
        if not task:
            return False
        if task not in self._cancel_requested:
            self._cancel_requested.add(task)
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return True

    async def reset(self, session_id: str) -> None:
        await self.cancel(session_id)
        session = self._sessions.pop(session_id, None)
        if session:
            await session.client.close()

    async def shutdown(self) -> None:
        self._closing = True
        for key in list(self._active):
            await self.cancel(key)
        for key in list(self._sessions):
            await self.reset(key)


_runtime: CodexRuntime | None = None


def get_codex_runtime() -> CodexRuntime:
    global _runtime
    if _runtime is None:
        from app.db.session import AsyncSessionLocal

        _runtime = CodexRuntime(get_settings(), CodexLedger(AsyncSessionLocal))
    return _runtime


async def close_codex_runtime() -> None:
    global _runtime
    if _runtime:
        await _runtime.shutdown()
        _runtime = None
