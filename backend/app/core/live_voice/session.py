"""Bounded ASGI bridge for the native provider adapters."""
from __future__ import annotations

import asyncio
import json

from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState
from websockets.exceptions import ConnectionClosedOK
from websockets.frames import Close

from .configuration import catalog
from .gemini_provider import handle_gemini
from .grok_provider import handle_grok
from .higgs_provider import handle_higgs
from .qwen_provider import handle_qwen

HANDLERS = {"qwen": handle_qwen, "gemini_live": handle_gemini,
            "gemini_thinking": handle_gemini, "higgs": handle_higgs, "grok": handle_grok}
MAX_MESSAGE = 150_000


def validate_start(start: object, values: dict[str, str]) -> dict:
    if not isinstance(start, dict) or start.get("type") != "start":
        raise ValueError("请先发送 start 会话配置")
    model = start.get("model")
    if not isinstance(model, str) or model not in HANDLERS:
        raise ValueError("请选择受支持的实时语音模型")
    current = catalog(values)
    provider = next(p for p in current["providers"] if p["id"] == model)
    if not provider["available"]:
        raise ValueError(provider["unavailable_reason"])
    voice = start.get("voice") or provider["default_voice"]
    if not isinstance(voice, str) or voice not in {row["id"] for row in provider["voices"]}:
        raise ValueError("所选音色不属于当前模型")
    brain = start.get("brain") or "off"
    if not isinstance(brain, str) or brain not in {"off", "qwen3.7-plus"}:
        raise ValueError("外部大脑配置无效")
    if brain != "off" and (model != "qwen" or not current["brain_available"]):
        raise ValueError("当前模型未启用此大脑")
    instructions = start.get("instructions", "")
    if not isinstance(instructions, str) or len(instructions) > 4000:
        raise ValueError("角色提示词不能超过 4000 个字符")
    reasoning = start.get("reasoning") or ("high" if model == "grok" else "low")
    allowed = {"high", "none"} if model == "grok" else {"low", "medium", "high"}
    if not isinstance(reasoning, str) or reasoning not in allowed:
        raise ValueError("思考级别无效")
    if instructions.strip():
        names = "get_local_time" if model.startswith("gemini_") else "get_local_time、list_capabilities"
        if brain != "off":
            names += "、ask_brain"
        instructions = instructions.strip() + (
            f"\n\n【本次实际工具】仅接入 {names}。问当前时间时调用 get_local_time。"
            "没有接入天气、联网搜索、屏幕读取、桌面控制、文件操作或提醒功能；"
            "即使角色设定提及这些能力，也必须以本次工具清单为准。"
            "只有工具返回成功后才能声称已完成操作。"
            + ("复杂分析、规划或用户要求深度思考时可调用 ask_brain，等待时可继续与用户交谈。" if brain != "off" else "")
        )
    return {"type": "start", "model": model, "voice": voice, "brain": brain,
            "reasoning": reasoning, "instructions": instructions}


def _closed() -> ConnectionClosedOK:
    return ConnectionClosedOK(Close(1000, ""), Close(1000, ""), True)


class BrowserBridge:
    """Expose the tested adapters' send/recv interface without a second server."""
    def __init__(self, websocket: WebSocket, values: dict[str, str]):
        self.websocket = websocket
        self.messages: asyncio.Queue[str] = asyncio.Queue(maxsize=64)
        self.closed = False
        self._send_lock = asyncio.Lock()
        self._secrets = tuple(value for key, value in values.items()
                              if key.endswith("API_KEY") and value)

    async def receive(self) -> None:
        try:
            while True:
                message = await self.websocket.receive()
                if message["type"] == "websocket.disconnect":
                    return
                raw = message.get("text")
                if not isinstance(raw, str) or len(raw) > MAX_MESSAGE:
                    await self.close(1009, "Message too large or not text")
                    return
                try:
                    event = json.loads(raw)
                except (ValueError, TypeError):
                    await self.close(1008, "Invalid JSON")
                    return
                if not isinstance(event, dict) or event.get("type") not in {"text", "audio", "audio_end", "interrupt", "stop"}:
                    await self.close(1008, "Invalid event")
                    return
                if event["type"] == "stop":
                    return
                await self.messages.put(raw)
        finally:
            self.closed = True

    async def recv(self) -> str:
        if self.closed:
            raise _closed()
        return await self.messages.get()

    def __aiter__(self):
        return self

    async def __anext__(self) -> str:
        if self.closed:
            raise StopAsyncIteration
        return await self.recv()

    async def send(self, raw: str) -> None:
        if self.closed:
            raise _closed()
        event = json.loads(raw)
        if event.get("type") == "error":
            for secret in self._secrets:
                raw = raw.replace(secret, "[REDACTED]")
        async with self._send_lock:
            try:
                await self.websocket.send_text(raw)
            except (WebSocketDisconnect, RuntimeError):
                self.closed = True
                raise _closed() from None

    async def close(self, code: int = 1000, reason: str = "") -> None:
        if not self.closed:
            self.closed = True
            if self.websocket.application_state != WebSocketState.DISCONNECTED:
                await self.websocket.close(code=code, reason=reason)


async def run_session(websocket: WebSocket, values: dict[str, str], start: dict) -> None:
    bridge = BrowserBridge(websocket, values)
    receiver = asyncio.create_task(bridge.receive())
    provider = asyncio.create_task(HANDLERS[start["model"]](bridge, values, start))
    tasks = [receiver, provider]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
