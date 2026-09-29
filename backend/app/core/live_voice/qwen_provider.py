"""Qwen Audio realtime and optional Qwen reasoning adapter."""
from __future__ import annotations
import asyncio
import base64
import json
from collections import deque
from datetime import datetime
from zoneinfo import ZoneInfo
import httpx
import websockets
from .connection import endpoint, setup_event

MODEL = "qwen-audio-3.1-realtime-plus"
BRAIN_MODEL = "qwen3.7-plus"
BASE_TOOLS = [
    {"type": "function", "function": {"name": "get_local_time",
        "description": "读取当前北京时间、日期和星期。",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "list_capabilities",
        "description": "列出本次会话实际接入的工具。用户问你会做什么、能调用哪些函数时必须调用。",
        "parameters": {"type": "object", "properties": {}}}},
]
BRAIN_TOOL = {"type": "function", "function": {"name": "ask_brain",
    "description": "将需要多步推理、分析或规划的问题交给 Qwen3.7-Plus 深度思考模型；你可以先简短告知用户正在思考，随后根据工具结果作答。",
    "parameters": {"type": "object", "properties": {
        "question": {"type": "string", "description": "完整的问题和必要上下文，不要包含无关隐私"}},
        "required": ["question"]}}}


def capabilities(brain_enabled: bool) -> list[dict[str, str]]:
    rows = [
        {"name": "get_local_time", "label": "查询本机北京时间"},
        {"name": "list_capabilities", "label": "查看本次会话已接入的工具"},
    ]
    if brain_enabled:
        rows.append({"name": "ask_brain", "label": "交给 Qwen3.7-Plus 深度思考后回答"})
    return rows


def instructions(brain_enabled: bool) -> str:
    names = "、".join(row["name"] for row in capabilities(brain_enabled))
    return (
        "你是艾米斯，一个自然、亲切的中文语音助手。回答简洁，可以被用户随时打断。"
        f"本次会话实际接入的工具只有：{names}。用户询问能力或可用函数时，先调用 list_capabilities，"
        "严格按照结果回答，不要把文档示例当成已接入功能。"
        "询问当前时间、日期或星期时先调用 get_local_time。"
        + ("遇到复杂推理、分析、规划或用户要求深度思考时，调用 ask_brain；可以先简短告知用户正在思考。"
           if brain_enabled else "当前没有接入外部深度思考模型。")
        + "没有天气查询、屏幕读取、提醒器、文件读写、网络搜索或桌面控制能力。"
          "没有实际工具调用成功时，不要声称已经执行操作。"
    )


class QwenTurnState:
    def __init__(self) -> None:
        self.active_response_id: str | None = None
        self.last_response_id: str | None = None
        self.suppressed_response_ids: set[str] = set()
        self.cancel_requested = False
        self.speech_epoch = 0
        self.tool_task: asyncio.Task | None = None
        self.pending_responses: deque[dict] = deque()
        self.request_serial = 0


async def request_response(upstream, state: QwenTurnState, epoch: int) -> None:
    if epoch != state.speech_epoch:
        return
    state.request_serial += 1
    request = {"epoch": epoch, "event_id": f"local_response_{state.request_serial}"}
    # Register before sending: speech can arrive before response.created.
    state.pending_responses.append(request)
    try:
        await send_json(upstream, {"type": "response.create", "event_id": request["event_id"],
                                  "response": {"modalities": ["audio", "text"]}})
    except Exception:
        if request in state.pending_responses:
            state.pending_responses.remove(request)
        raise


async def interrupt_turn(upstream, state: QwenTurnState) -> str | None:
    state.speech_epoch += 1
    if state.tool_task and not state.tool_task.done():
        state.tool_task.cancel()
        await asyncio.gather(state.tool_task, return_exceptions=True)
    target = state.active_response_id or state.last_response_id
    if target:
        state.suppressed_response_ids.add(target)
    if state.active_response_id and not state.cancel_requested:
        state.cancel_requested = True
        await send_json(upstream, {"type": "response.cancel"})
    return target


async def send_json(ws, payload: dict) -> None:
    await ws.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


async def ask_brain(question: str, values: dict[str, str]) -> dict:
    workspace = values["DASHSCOPE_WORKSPACE_ID"]
    region = values.get("DASHSCOPE_REGION", "cn-beijing")
    if not workspace.replace("-", "").isalnum() or region not in ("cn-beijing", "ap-southeast-1"):
        return {"error": "推理模型的业务空间配置无效"}
    url = f"https://{workspace}.{region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions"
    payload = {"model": BRAIN_MODEL, "enable_thinking": True,
               "max_tokens": 3072, "messages": [
                   {"role": "system", "content": "你是艾米斯的深度推理大脑。认真分析问题，最终只给出简洁、准确、可直接朗读的中文结论。不得声称已经执行外部工具或操作。"},
                   {"role": "user", "content": question[:1200]},
               ]}
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            response = await client.post(url, headers={
                "Authorization": f"Bearer {values['DASHSCOPE_API_KEY']}"}, json=payload)
            response.raise_for_status()
            result = response.json()
        content = result["choices"][0]["message"].get("content")
        if not isinstance(content, str) or not content.strip():
            return {"error": "深度模型没有返回可朗读的结论"}
        return {"model": BRAIN_MODEL, "answer": content.strip()[:3000],
                "usage": result.get("usage") or {}}
    except httpx.HTTPStatusError as exc:
        return {"error": f"深度模型返回 HTTP {exc.response.status_code}"}
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
        return {"error": "深度模型请求失败或超时；请稍后重试"}


async def run_tools(local, upstream, calls: list[dict], state: QwenTurnState,
                    brain_enabled: bool, values: dict[str, str], speech_epoch: int) -> None:
    answered = set()
    try:
        for call in calls:
            if state.speech_epoch != speech_epoch:
                raise asyncio.CancelledError
            name = call.get("name")
            if name == "get_local_time":
                now = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")
                answer = {"beijing_time": now}
                label = now
            elif name == "list_capabilities":
                answer = {"tools": capabilities(brain_enabled),
                          "unavailable": ["天气查询", "屏幕读取", "提醒器", "文件操作", "桌面控制"]}
                label = "已返回实际工具清单"
            elif name == "ask_brain" and brain_enabled:
                try:
                    args = json.loads(call.get("arguments") or "{}")
                except (ValueError, TypeError):
                    args = {}
                question = args.get("question") if isinstance(args, dict) else None
                if isinstance(question, str) and question.strip():
                    await send_json(local, {"type": "thinking_status", "status": "IN_PROGRESS",
                                            "model": BRAIN_MODEL})
                    answer = await ask_brain(question.strip(), values)
                    label = (f"{BRAIN_MODEL} 已返回" if "answer" in answer else answer["error"])
                else:
                    answer, label = {"error": "缺少问题"}, "缺少问题"
            else:
                answer, label = {"error": "工具未在本次会话中注册"}, "不可用"
            if state.speech_epoch != speech_epoch:
                raise asyncio.CancelledError
            await send_json(local, {"type": "tool", "name": str(name), "result": label})
            if state.speech_epoch != speech_epoch:
                raise asyncio.CancelledError
            answered.add(call.get("call_id"))
            await send_json(upstream, {"type": "conversation.item.create", "item": {
                "type": "function_call_output", "call_id": call.get("call_id"),
                "output": json.dumps(answer, ensure_ascii=False),
            }})
        await request_response(upstream, state, speech_epoch)
    except asyncio.CancelledError:
        # Close the provider's outstanding call without making it speak a stale answer.
        for call in calls:
            if call.get("call_id") in answered:
                continue
            try:
                await send_json(upstream, {"type": "conversation.item.create", "item": {
                    "type": "function_call_output", "call_id": call.get("call_id"),
                    "output": json.dumps({"error": "用户已插话，旧任务取消"}, ensure_ascii=False),
                }})
            except websockets.exceptions.ConnectionClosed:
                break
        raise
    finally:
        try:
            await send_json(local, {"type": "thinking_status", "status": "IDLE"})
        except websockets.exceptions.ConnectionClosed:
            pass


async def from_browser(local, upstream, state: QwenTurnState) -> None:
    audio_samples = 0
    async for raw in local:
        if not isinstance(raw, str) or len(raw) > 150_000:
            continue
        try:
            event = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        kind = event.get("type")
        if kind == "audio":
            data = event.get("data", "")
            if not isinstance(data, str) or len(data) > 130_000:
                continue
            try:
                pcm = base64.b64decode(data, validate=True)
            except (ValueError, base64.binascii.Error):
                continue
            if not pcm or len(pcm) > 96_000 or len(pcm) % 2:
                continue
            await send_json(upstream, {"type": "input_audio_buffer.append", "audio": data})
            previous = audio_samples
            audio_samples += len(pcm) // 2
            if audio_samples // 16000 > previous // 16000:
                await send_json(local, {"type": "capture_ack", "seconds": round(audio_samples / 16000, 1)})
        elif kind == "audio_end":
            # smart_turn ends a turn after silence; it ignores manual commit.
            silent = base64.b64encode(b"\0" * 3200).decode("ascii")
            for _ in range(10):
                await send_json(upstream, {"type": "input_audio_buffer.append", "audio": silent})
                await asyncio.sleep(0.1)
        elif kind == "text":
            value = event.get("text", "")
            if isinstance(value, str) and 0 < len(value.strip()) <= 2000:
                await interrupt_turn(upstream, state)
                await send_json(upstream, {"type": "conversation.item.create", "item": {
                    "type": "message", "role": "user", "content": [
                        {"type": "input_text", "text": value.strip()},
                    ]}})
                await request_response(upstream, state, state.speech_epoch)
        elif kind == "interrupt":
            target = event.get("response_id")
            if isinstance(target, str) and target:
                state.suppressed_response_ids.add(target)
            await interrupt_turn(upstream, state)


async def from_qwen(local, upstream, state: QwenTurnState,
                    brain_enabled: bool, values: dict[str, str]) -> None:
    pending_calls: list[dict] = []
    async for raw in upstream:
        event = json.loads(raw)
        kind = event.get("type", "")
        # Qwen omits response_id on audio/transcript deltas in live sessions.
        # Its WebSocket produces one response at a time, so associate these
        # deltas with the response.created that is currently active.
        response_id = event.get("response_id") or state.active_response_id or state.last_response_id
        if kind == "error":
            error = event.get("error") or {}
            failed_id = error.get("event_id")
            state.pending_responses = deque(request for request in state.pending_responses
                                            if request["event_id"] != failed_id)
            await send_json(local, {"type": "error", "message":
                                    "千问请求失败，请检查会话配置、模型权限或剩余额度。"})
            continue
        if kind == "response.created":
            response_id = (event.get("response") or {}).get("id")
            if isinstance(response_id, str):
                state.active_response_id = response_id
                state.last_response_id = response_id
                state.cancel_requested = False
                request = state.pending_responses.popleft() if state.pending_responses else None
                if request and request["epoch"] != state.speech_epoch:
                    state.suppressed_response_ids.add(response_id)
                    state.cancel_requested = True
                    await send_json(local, {"type": "response_suppressed", "response_id": response_id,
                                            "reason": "superseded"})
                    await send_json(upstream, {"type": "response.cancel"})
                    continue
                await send_json(local, {"type": "response_started", "response_id": response_id})
            continue
        if kind == "input_audio_buffer.speech_started":
            target = await interrupt_turn(upstream, state)
            await send_json(local, {"type": "speech_started", "response_id": target,
                                    "audio_start_ms": event.get("audio_start_ms"),
                                    "item_id": event.get("item_id")})
        elif kind == "input_audio_buffer.speech_stopped":
            await send_json(local, {"type": "speech_stopped",
                                    "audio_end_ms": event.get("audio_end_ms"),
                                    "reason": event.get("reason"), "item_id": event.get("item_id")})
        elif kind == "conversation.item.ambient_audio_transcription.delta":
            await send_json(local, {"type": "ambient_audio", "item_id": event.get("item_id"),
                                    "text": str(event.get("text") or "") + str(event.get("stash") or ""),
                                    "final": False})
        elif kind == "conversation.item.ambient_audio_transcription.completed":
            await send_json(local, {"type": "ambient_audio", "item_id": event.get("item_id"),
                                    "text": event.get("transcript") or "", "final": True})
        elif kind == "conversation.item.input_audio_transcription.delta":
            await send_json(local, {"type": "input_transcript", "item_id": event.get("item_id"),
                                    "text": event.get("text", "") + event.get("stash", ""), "final": False})
        elif kind == "conversation.item.input_audio_transcription.completed":
            await send_json(local, {"type": "input_transcript", "item_id": event.get("item_id"),
                                    "text": event.get("transcript", ""), "final": True})
        elif kind == "response.audio_transcript.delta" and event.get("delta"):
            if response_id not in state.suppressed_response_ids:
                await send_json(local, {"type": "output_transcript", "response_id": response_id,
                                        "text": event["delta"]})
        elif kind == "response.audio.delta" and event.get("delta"):
            if response_id not in state.suppressed_response_ids:
                await send_json(local, {"type": "audio", "response_id": response_id,
                                        "data": event["delta"]})
        elif kind == "response.function_call_arguments.done":
            if response_id not in state.suppressed_response_ids:
                pending_calls.append(event)
        elif kind == "response.done":
            response = event.get("response") or {}
            response_id = response.get("id")
            cancelled = response.get("status") == "cancelled" or response_id in state.suppressed_response_ids
            if state.active_response_id == response_id:
                state.active_response_id = None
                state.cancel_requested = False
            if cancelled:
                pending_calls = []
                details = response.get("status_details") or {}
                await send_json(local, {"type": "interrupted", "response_id": response_id,
                                        "reason": details.get("reason")})
                continue
            if pending_calls:
                calls, pending_calls = pending_calls, []
                state.tool_task = asyncio.create_task(run_tools(
                    local, upstream, calls, state, brain_enabled, values, state.speech_epoch))
            else:
                await send_json(local, {"type": "turn_complete",
                                        "response_id": response_id, "status": response.get("status")})


async def handle_qwen(local, values: dict[str, str], start: dict) -> None:
    try:
        voice = start.get("voice") or "longanqian_v3.1"
        brain_enabled = start.get("brain") == BRAIN_MODEL
        if start.get("brain") not in (None, "off", BRAIN_MODEL):
            await local.close(code=1008, reason="Invalid brain")
            return
        if brain_enabled and values.get("QWEN_BRAIN_ENABLED") != "1":
            await send_json(local, {"type": "error", "message": "推理模型尚未在本机启用。"})
            return
        url, headers = endpoint("qwen_audio", values)
        async with websockets.connect(url, additional_headers=headers, open_timeout=20,
                                      close_timeout=5, max_size=16 * 1024 * 1024) as upstream:
            setup = setup_event("qwen_audio")
            setup["session"].update({"voice": voice,
                                      "instructions": start.get("instructions") or instructions(brain_enabled),
                                      "tools": BASE_TOOLS + ([BRAIN_TOOL] if brain_enabled else [])})
            await send_json(upstream, setup)
            deadline = asyncio.get_running_loop().time() + 20
            while True:
                event = json.loads(await asyncio.wait_for(
                    upstream.recv(), timeout=max(0.0, deadline - asyncio.get_running_loop().time())))
                if event.get("type") == "session.updated":
                    break
                if event.get("type") == "error":
                    error = event.get("error") or {}
                    await send_json(local, {"type": "error", "message":
                                            "千问建连失败，请检查会话配置、模型权限或剩余额度。"})
                    return
            await send_json(local, {"type": "ready", "model": MODEL, "voice": voice,
                                    "brain": BRAIN_MODEL if brain_enabled else None,
                                    "capabilities": capabilities(brain_enabled)})
            state = QwenTurnState()
            tasks = (asyncio.create_task(from_browser(local, upstream, state)),
                     asyncio.create_task(from_qwen(local, upstream, state,
                                                   brain_enabled, values)))
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                pending = list(tasks) + ([state.tool_task] if state.tool_task else [])
                for task in pending:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
    except websockets.exceptions.ConnectionClosed:
        pass
