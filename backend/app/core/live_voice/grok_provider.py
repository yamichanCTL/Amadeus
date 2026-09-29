"""xAI Grok speech-to-speech adapter for Amadeus.

Official protocol: https://docs.x.ai/developers/rest-api-reference/inference/voice
No credentials, transcripts, or audio are logged or persisted here.
"""

from __future__ import annotations

import asyncio
import base64
import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import websockets


MODEL = "grok-voice-think-fast-2.0"
UPSTREAM = f"wss://api.x.ai/v1/realtime?model={MODEL}"
INPUT_RATE, OUTPUT_RATE = 16000, 24000
VOICES = frozenset(item["id"] for item in json.loads(
    Path(__file__).with_name("grok_voices.json").read_text(encoding="utf-8")))
TOOLS = [
    {"type": "function", "name": "get_local_time", "description": "读取当前北京时间、日期和星期。",
     "parameters": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"type": "function", "name": "list_capabilities", "description": "列出本次会话真正接入的工具。",
     "parameters": {"type": "object", "properties": {}, "additionalProperties": False}},
]
CAPABILITIES = [
    {"name": "get_local_time", "label": "查询本机北京时间"},
    {"name": "list_capabilities", "label": "查看本次会话已接入的工具"},
]
# Follow the provider's recommended section structure, with a general task
# prompt. Do not seed test answers, scripted greetings, or a translation mode.
INSTRUCTIONS = """## Role & Persona
You are 艾米斯, a friendly conversational assistant.
## Objective
Help the user with their current request. Follow the requested task and output language across turns until the user changes them.
## Conversation Flow
Use the conversation context and the user's latest corrections. Call get_local_time for the current date or time. Call list_capabilities when asked what tools you can use.
## Guardrails & Escalation
Only get_local_time and list_capabilities are connected in this evaluation. Do not claim to browse, operate the desktop, schedule reminders, or perform other actions without a connected tool and a successful result.
## Voice & Communication Style
Default to concise, natural Chinese. When the user specifies another language or a translation task, follow that request. Avoid repeating greetings. Ask briefly when you cannot understand the input.
"""


def setup_message(voice: str, reasoning: str = "high", instructions: str = "") -> dict:
    return {"type": "session.update", "session": {
        "voice": voice, "instructions": instructions or INSTRUCTIONS, "reasoning": {"effort": reasoning},
        "turn_detection": {"type": "server_vad", "threshold": 0.85,
                           "prefix_padding_ms": 333, "silence_duration_ms": 700},
        "audio": {
            "input": {"format": {"type": "audio/pcm", "rate": INPUT_RATE},
                      "transcription": {"model": "grok-transcribe"}},
            "output": {"format": {"type": "audio/pcm", "rate": OUTPUT_RATE}},
        },
        "tools": TOOLS,
    }}


def acknowledged_settings_match(session: object, voice: str, reasoning: str) -> bool:
    """Validate critical settings if the provider includes them in its ack.

    An omitted field is not evidence of a mismatch, but an explicit different
    model/codec/rate must never be relabelled as our requested configuration.
    """
    if not isinstance(session, dict):
        return False
    if "model" in session and session["model"] != MODEL:
        return False
    if "voice" in session and session["voice"] != voice:
        return False
    if "reasoning" in session:
        if not isinstance(session["reasoning"], dict) or session["reasoning"].get("effort", reasoning) != reasoning:
            return False
    if "turn_detection" in session:
        if not isinstance(session["turn_detection"], dict) or session["turn_detection"].get("type", "server_vad") != "server_vad":
            return False
    audio = session.get("audio", {})
    if not isinstance(audio, dict):
        return False
    for direction, rate in (("input", INPUT_RATE), ("output", OUTPUT_RATE)):
        config = audio.get(direction, {})
        if not isinstance(config, dict):
            return False
        fmt = config.get("format", {})
        if not isinstance(fmt, dict) or fmt.get("type", "audio/pcm") != "audio/pcm" or fmt.get("rate", rate) != rate:
            return False
    return True


async def send_json(ws, event: dict) -> None:
    await ws.send(json.dumps(event, ensure_ascii=False, separators=(",", ":")))


def error_message(event: dict) -> str:
    # Provider errors can reflect request data; use only a closed message map.
    error = event.get("error")
    if not isinstance(error, dict):
        return "Grok 请求失败，请检查网络和会话配置。"
    known = {
        "insufficient_quota": "Grok 账户没有可用额度或已达到消费上限。",
        "invalid_api_key": "Grok API Key 无效，请检查本机 XAI_API_KEY。",
        "authentication_error": "Grok 身份验证失败，请检查本机 XAI_API_KEY。",
        "rate_limit_exceeded": "Grok 请求频率或并发已达上限，请稍后重试。",
        "invalid_voice": "Grok 无法使用所选音色，请选择 Eve 后重试。",
    }
    return known.get(error.get("code"), known.get(error.get("type"),
        "Grok 拒绝了请求，请检查会话配置、模型权限和账户额度。"))


@dataclass
class TurnState:
    epoch: int = 0
    serial: int = 0
    active_response: str | None = None
    last_response: str | None = None
    suppressed: set[str] = field(default_factory=set)
    cancel_sent: set[str] = field(default_factory=set)
    finished: set[str] = field(default_factory=set)
    executed_calls: set[str] = field(default_factory=set)
    response_calls: dict[str, dict[str, dict]] = field(default_factory=dict)
    tool_tasks: set[asyncio.Task] = field(default_factory=set)
    speaking: bool = False
    block_until_input: bool = False
    reasoning: str = "high"


async def request_response(upstream, state: TurnState, epoch: int) -> None:
    if epoch != state.epoch or state.speaking or state.block_until_input:
        return
    state.serial += 1
    # OpenAI-compatible response metadata provides an extra stale-response
    # guard if echoed. Native VAD responses need no explicit response.create.
    await send_json(upstream, {"type": "response.create", "event_id": f"grok_{state.serial}",
        "response": {"metadata": {"amadeus_epoch": str(epoch)}}})


async def suppress_turn(upstream, state: TurnState, *, manual: bool) -> str | None:
    state.epoch += 1
    target = state.active_response or state.last_response
    if target:
        state.suppressed.add(target)
    tasks = list(state.tool_tasks)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    if manual:
        state.block_until_input = True
        if state.active_response and state.active_response not in state.cancel_sent:
            state.cancel_sent.add(state.active_response)
            await send_json(upstream, {"type": "response.cancel", "response_id": state.active_response})
    # server_vad already cancels the upstream turn; a second cancellation can
    # race its completion or the next response.
    return target


async def from_browser(browser, upstream, state: TurnState) -> None:
    audio_samples = 0
    async for raw in browser:
        if not isinstance(raw, str) or len(raw) > 150_000:
            continue
        try:
            event = json.loads(raw)
        except (ValueError, TypeError):
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "audio":
            data = event.get("data")
            if not isinstance(data, str) or len(data) > 130_000:
                continue
            try:
                pcm = base64.b64decode(data, validate=True)
            except (ValueError, base64.binascii.Error):
                continue
            if not pcm or len(pcm) > 96_000 or len(pcm) % 2:
                continue
            await send_json(upstream, {"type": "input_audio_buffer.append", "audio": data})
            if not event.get("padding"):
                previous, audio_samples = audio_samples, audio_samples + len(pcm) // 2
                if audio_samples // INPUT_RATE > previous // INPUT_RATE:
                    await send_json(browser, {"type": "capture_ack", "seconds": round(audio_samples / INPUT_RATE, 1)})
        elif kind == "audio_end":
            # commit is only supported with turn_detection=null. Let the
            # configured VAD observe trailing quiet when the mic stops.
            quiet = base64.b64encode(b"\0" * 3200).decode("ascii")
            for _ in range(10):
                await send_json(upstream, {"type": "input_audio_buffer.append", "audio": quiet})
                await asyncio.sleep(0.1)
        elif kind == "text":
            text = event.get("text")
            if isinstance(text, str) and 0 < len(text.strip()) <= 2000:
                await suppress_turn(upstream, state, manual=True)
                state.block_until_input = state.speaking = False
                await send_json(upstream, {"type": "conversation.item.create", "item": {
                    "type": "message", "role": "user", "content": [{"type": "input_text", "text": text.strip()}]}})
                await request_response(upstream, state, state.epoch)
        elif kind == "interrupt":
            target = await suppress_turn(upstream, state, manual=True)
            await send_json(browser, {"type": "interrupted", "response_id": target, "reason": "manual"})


async def run_tools(browser, upstream, state: TurnState, calls: list[dict], epoch: int) -> None:
    pending = [call for call in calls if isinstance(call, dict) and isinstance(call.get("call_id"), str)]
    try:
        for call in pending:
            if state.epoch != epoch:
                raise asyncio.CancelledError
            call_id = call["call_id"]
            if call_id in state.executed_calls:
                continue
            try:
                args = json.loads(call.get("arguments") or "{}")
            except (ValueError, TypeError):
                args = None
            name = call.get("name")
            if not isinstance(args, dict) or args:
                answer, label = {"error": "工具参数无效"}, "参数无效"
            elif name == "get_local_time":
                now = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")
                answer, label = {"beijing_time": now}, now
            elif name == "list_capabilities":
                answer = {"tools": CAPABILITIES, "external_brain": False, "native_reasoning": state.reasoning}
                label = "已返回实际工具清单"
            else:
                answer, label = {"error": "此工具未接入"}, "不可用"
            state.executed_calls.add(call_id)
            await send_json(upstream, {"type": "conversation.item.create", "item": {
                "type": "function_call_output", "call_id": call_id,
                "output": json.dumps(answer, ensure_ascii=False)}})
            if state.epoch != epoch:
                raise asyncio.CancelledError
            await send_json(browser, {"type": "tool", "name": name if name in {t["name"] for t in TOOLS} else "unknown",
                                      "result": label})
        # One continuation after every function result in this response batch.
        await request_response(upstream, state, epoch)
    except asyncio.CancelledError:
        for call in pending:
            if call["call_id"] not in state.executed_calls:
                state.executed_calls.add(call["call_id"])
                try:
                    await send_json(upstream, {"type": "conversation.item.create", "item": {
                        "type": "function_call_output", "call_id": call["call_id"],
                        "output": '{"error":"用户已插话，旧任务取消"}'}})
                except websockets.exceptions.ConnectionClosed:
                    break
        raise


async def from_grok(browser, upstream, state: TurnState) -> None:
    async for raw in upstream:
        try:
            event = json.loads(raw)
        except (ValueError, TypeError):
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        response_id = event.get("response_id") or state.active_response or state.last_response
        if kind == "error":
            error = event.get("error") or {}
            if isinstance(error, dict) and error.get("code") in {"response_cancel_not_active", "response_not_active"}:
                continue
            await send_json(browser, {"type": "error", "message": error_message(event)})
        elif kind == "response.created":
            response = event.get("response") or {}
            response_id = response.get("id")
            if not isinstance(response_id, str):
                continue
            # Unlike Boson's observed reused IDs, xAI documents per-response
            # identity. Do not manufacture new generations without evidence.
            if response_id in state.finished:
                continue
            state.active_response = state.last_response = response_id
            metadata = response.get("metadata") or {}
            stale = isinstance(metadata, dict) and metadata.get("amadeus_epoch") not in (None, str(state.epoch))
            if stale or state.speaking or state.block_until_input:
                state.suppressed.add(response_id)
                if response_id not in state.cancel_sent:
                    state.cancel_sent.add(response_id)
                    await send_json(upstream, {"type": "response.cancel", "response_id": response_id})
                await send_json(browser, {"type": "response_suppressed", "response_id": response_id})
            else:
                await send_json(browser, {"type": "response_started", "response_id": response_id})
        elif kind == "input_audio_buffer.speech_started":
            target = await suppress_turn(upstream, state, manual=False)
            state.speaking, state.block_until_input = True, False
            await send_json(browser, {"type": "speech_started", "response_id": target,
                "audio_start_ms": event.get("audio_start_ms"), "item_id": event.get("item_id")})
            await send_json(browser, {"type": "interrupted", "response_id": target, "reason": "turn_detected"})
        elif kind == "input_audio_buffer.speech_stopped":
            state.speaking = False
            await send_json(browser, {"type": "speech_stopped", "audio_end_ms": event.get("audio_end_ms"),
                                      "item_id": event.get("item_id")})
        elif kind in {"conversation.item.input_audio_transcription.updated", "conversation.item.input_audio_transcription.completed"}:
            # Both xAI events carry cumulative text, never append as a delta.
            await send_json(browser, {"type": "input_transcript", "text": event.get("transcript") or "",
                "item_id": event.get("item_id"), "final": kind.endswith("completed")})
        elif kind in {"response.output_audio.delta", "response.audio.delta", "response.output_audio_transcript.delta",
                      "response.audio_transcript.delta", "response.output_text.delta", "response.text.delta"}:
            if response_id and response_id not in state.suppressed and response_id not in state.finished and not state.block_until_input:
                delta = event.get("delta")
                if isinstance(delta, str) and delta:
                    is_audio = kind in {"response.output_audio.delta", "response.audio.delta"}
                    await send_json(browser, {"type": "audio" if is_audio else "output_transcript",
                        "response_id": response_id, "item_id": event.get("item_id"),
                        "data" if is_audio else "text": delta})
        elif kind == "response.function_call_arguments.done":
            if response_id and response_id not in state.suppressed and isinstance(event.get("call_id"), str):
                state.response_calls.setdefault(response_id, {})[event["call_id"]] = event
        elif kind == "response.done":
            response = event.get("response") or {}
            response_id = response.get("id") or response_id
            if not isinstance(response_id, str) or response_id in state.finished:
                continue
            state.finished.add(response_id)
            if state.active_response == response_id:
                state.active_response = None
            calls = state.response_calls.pop(response_id, {})
            if response.get("status") == "cancelled" or response_id in state.suppressed:
                state.suppressed.add(response_id)
                await send_json(browser, {"type": "interrupted", "response_id": response_id,
                    "provider_cancelled": response.get("status") == "cancelled"})
                continue
            if response.get("status") in {"failed", "incomplete"}:
                await send_json(browser, {"type": "error", "message": "Grok 本次回答失败或未完整生成，请重试。"})
                await send_json(browser, {"type": "turn_complete", "response_id": response_id, "status": response.get("status")})
                continue
            for item in response.get("output") or []:
                if isinstance(item, dict) and item.get("type") == "function_call" and isinstance(item.get("call_id"), str):
                    calls[item["call_id"]] = item
            calls = [call for call_id, call in calls.items() if call_id not in state.executed_calls]
            if calls:
                task = asyncio.create_task(run_tools(browser, upstream, state, calls, state.epoch))
                state.tool_tasks.add(task)
                # Keep completed tasks until cleanup so any unexpected failure
                # is retrieved; tasks contain no transcript/audio data.
            else:
                await send_json(browser, {"type": "turn_complete", "response_id": response_id, "status": response.get("status")})


async def handle_grok(browser, config: dict[str, str], start: dict) -> None:
    """Server-only key handling; ready means session.update was acknowledged."""
    voice = start.get("voice", "eve")
    reasoning = start.get("reasoning", "high")
    if not isinstance(voice, str) or voice not in VOICES or not isinstance(reasoning, str) or reasoning not in {"high", "none"}:
        await send_json(browser, {"type": "error", "message": "Grok 音色或思考配置无效。"})
        return
    if start.get("brain") not in (None, "off"):
        await send_json(browser, {"type": "error", "message": "Grok 使用自身的思考能力，请先关闭外部大脑。"})
        return
    key = (config.get("XAI_API_KEY") or "").strip()
    if not key:
        await send_json(browser, {"type": "error", "message": "请先在 backend/.env 配置 XAI_API_KEY，并确认 xAI 账户有可用额度。"})
        return
    if config.get("GROK_EVAL_ENABLED") != "1":
        await send_json(browser, {"type": "error", "message": "Grok 付费测试尚未启用，请先确认可用额度和测试预算。"})
        return
    state, tasks = TurnState(reasoning=reasoning), []
    try:
        async with websockets.connect(UPSTREAM, additional_headers={"Authorization": f"Bearer {key}"},
                open_timeout=20, close_timeout=5, max_size=16 * 1024 * 1024) as upstream:
            await send_json(upstream, setup_message(voice, reasoning, start.get("instructions", "")))
            deadline = asyncio.get_running_loop().time() + 20
            while True:
                event = json.loads(await asyncio.wait_for(
                        upstream.recv(), timeout=max(0.0, deadline - asyncio.get_running_loop().time())))
                if not isinstance(event, dict):
                    continue
                if event.get("type") == "error":
                    await send_json(browser, {"type": "error", "message": error_message(event)})
                    return
                if event.get("type") == "session.updated":
                    if not acknowledged_settings_match(event.get("session", {}), voice, reasoning):
                        await send_json(browser, {"type": "error", "message": "Grok 确认的模型、音色或音频配置与请求不一致，已停止会话。"})
                        return
                    break
            await send_json(browser, {"type": "ready", "model": MODEL, "voice": voice,
                "capabilities": CAPABILITIES, "input_sample_rate": INPUT_RATE, "output_sample_rate": OUTPUT_RATE,
                "turn_detection": "server_vad", "reasoning": reasoning,
                "input_transcription_model": "grok-transcribe"})
            tasks = [asyncio.create_task(from_browser(browser, upstream, state)),
                     asyncio.create_task(from_grok(browser, upstream, state))]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
    except websockets.exceptions.InvalidStatus as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        message = {401: "Grok API Key 无效或已过期。", 403: "Grok API Key 没有此模型的访问权限。",
                   402: "Grok 账户没有可用额度。", 429: "Grok 请求频率或并发已达上限。"}.get(
                       status, "Grok 握手失败，请检查网络、密钥和账户额度。")
        await send_json(browser, {"type": "error", "message": message})
    except websockets.exceptions.ConnectionClosed as exc:
        if not exc.rcvd or exc.rcvd.code not in (1000, 1001):
            try:
                await send_json(browser, {"type": "error", "message": "Grok 会话连接中断，请检查网络后重新连接。"})
            except websockets.exceptions.ConnectionClosed:
                pass
    except (OSError, TimeoutError, asyncio.TimeoutError, ValueError, TypeError, websockets.exceptions.WebSocketException):
        try:
            await send_json(browser, {"type": "error", "message": "Grok 连接失败，请检查本机网络、密钥和账户额度。"})
        except websockets.exceptions.ConnectionClosed:
            pass
    finally:
        pending = tasks + list(state.tool_tasks)
        for task in pending:
            if not task.done():
                task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
