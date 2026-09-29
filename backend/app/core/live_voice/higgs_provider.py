"""Boson Higgs Realtime adapter for Amadeus.

Protocol: https://docs.boson.ai/api-reference/realtime/client-events
Speech is native S2S. Visible input captions use separately billed higgs-stt-3.1.
No keys, transcripts, or audio are logged or persisted by this module.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

import websockets


MODEL = "higgs-realtime"
UPSTREAM = "wss://api.boson.ai/v1/realtime"
INPUT_RATE = 16000
OUTPUT_RATE = 24000
TRANSCRIPTION_MODEL = "higgs-stt-3.1"
VOICES = {"default", "chloe", "eleanor", "nora", "jake", "marcus", "oliver"}
TOOLS = [
    {"type": "function", "name": "get_local_time", "description": "读取当前北京时间、日期和星期。",
     "parameters": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"type": "function", "name": "list_capabilities", "description": "列出本次会话真正接入的函数和能力。",
     "parameters": {"type": "object", "properties": {}, "additionalProperties": False}},
]
CAPABILITIES = [
    {"name": "get_local_time", "label": "查询本机北京时间"},
    {"name": "list_capabilities", "label": "查看本次会话已接入的工具"},
]
INSTRUCTIONS = (
    "你是艾米斯，一个自然、亲切的语音助手。默认用简洁自然的中文回答；"
    "用户指定其他语言或要求翻译时，按用户指定的语言和任务回答。"
    "结合本会话的上下文回答最新问题；用户纠正先前信息时，以最新纠正为准。"
    "本次实际工具只有 get_local_time 和 list_capabilities。"
    "问当前时间或日期时调用 get_local_time；问你的工具能力时调用 list_capabilities。"
    "当前没有外接深度思考模型、天气查询、网络搜索、文件操作、屏幕读取、提醒或桌面控制。"
    "没有实际工具结果时不得声称完成了操作。"
)


def valid_voice(voice: object) -> bool:
    return isinstance(voice, str) and (voice in VOICES or
        re.fullmatch(r"voice_[A-Za-z0-9_-]{1,100}", voice) is not None)


def setup_message(voice: str, instructions: str = "") -> dict:
    return {"type": "session.update", "session": {
        "model": MODEL, "instructions": instructions or INSTRUCTIONS, "output_modalities": ["audio"],
        "audio": {
            "input": {"format": {"type": "audio/pcm", "rate": INPUT_RATE},
                      "transcription": {"model": TRANSCRIPTION_MODEL, "language": "zh"},
                      "turn_detection": {"type": "semantic_vad"}},
            "output": {"format": {"type": "audio/pcm", "rate": OUTPUT_RATE}, "voice": voice},
        },
        "tools": TOOLS, "tool_choice": "auto", "max_output_tokens": 1536,
    }}


async def send_json(ws, event: dict) -> None:
    await ws.send(json.dumps(event, ensure_ascii=False, separators=(",", ":")))


def error_message(event: dict) -> str:
    # Never reflect provider message/code strings: they can echo a credential.
    error = event.get("error") or {}
    if not isinstance(error, dict):
        return "Higgs 请求失败，请检查模型配置与网络。"
    kind = "insufficient_quota" if error.get("type") == "insufficient_quota" else error.get("code") or error.get("type")
    return {
        "insufficient_quota": "Higgs 没有可用额度或已达到消费上限。请先在 Boson 控制台领取试用额度。",
        "invalid_api_key": "Higgs API Key 无效，请检查本机 BOSON_API_KEY。",
        "authentication_error": "Higgs 身份验证失败，请检查本机 BOSON_API_KEY。",
        "invalid_voice": "Higgs 无法使用所选音色，请选择默认音色后重试。",
        "rate_limit_exceeded": "Higgs 请求过于频繁，请稍后重试。",
    }.get(kind, "Higgs 拒绝了请求，请检查音色、会话配置或模型额度。")


@dataclass
class TurnState:
    epoch: int = 0
    serial: int = 0
    active_response: str | None = None
    last_response: str | None = None
    suppressed: set[str] = field(default_factory=set)
    cancel_sent: set[str] = field(default_factory=set)
    executed_calls: set[str] = field(default_factory=set)
    response_generations: dict[str, int] = field(default_factory=dict)
    current_identity: dict[str, str] = field(default_factory=dict)
    upstream_identity: dict[str, str] = field(default_factory=dict)
    tool_task: asyncio.Task | None = None
    speaking: bool = False
    block_until_input: bool = False


async def request_response(upstream, state: TurnState, epoch: int) -> None:
    if state.epoch != epoch:
        return
    state.serial += 1
    # Unlike a FIFO, echoed metadata cannot confuse automatic VAD responses
    # with older explicit requests that arrive after the user has interrupted.
    await send_json(upstream, {"type": "response.create", "event_id": f"higgs_response_{state.serial}",
        "response": {"metadata": {"amadeus_epoch": str(epoch), "amadeus_request": str(state.serial)}}})


async def suppress_turn(upstream, state: TurnState, *, manual: bool) -> str | None:
    state.epoch += 1
    task = state.tool_task
    if task and not task.done():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    target = state.active_response or state.last_response
    if target:
        state.suppressed.add(target)
    if manual:
        state.block_until_input = True
        if state.active_response and state.active_response not in state.cancel_sent:
            state.cancel_sent.add(state.active_response)
            await send_json(upstream, {"type": "response.cancel", "response_id":
                state.upstream_identity.get(state.active_response, state.active_response)})
    # Native speech_started already cancels upstream. Do not race a second cancel.
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
                previous = audio_samples
                audio_samples += len(pcm) // 2
                if audio_samples // INPUT_RATE > previous // INPUT_RATE:
                    await send_json(browser, {"type": "capture_ack", "seconds": round(audio_samples / INPUT_RATE, 1)})
        elif kind == "audio_end":
            # Automatic turn detection needs a trailing quiet interval when the
            # physical mic stops; commit is documented for manual mode only.
            silent = base64.b64encode(b"\0" * 3200).decode("ascii")
            for _ in range(10):
                await send_json(upstream, {"type": "input_audio_buffer.append", "audio": silent})
                await asyncio.sleep(0.1)
        elif kind == "text":
            value = event.get("text")
            if isinstance(value, str) and 0 < len(value.strip()) <= 2000:
                await suppress_turn(upstream, state, manual=True)
                state.block_until_input = False
                state.speaking = False
                await send_json(upstream, {"type": "conversation.item.create", "item": {
                    "type": "message", "role": "user", "content": [{"type": "input_text", "text": value.strip()}]}})
                await request_response(upstream, state, state.epoch)
        elif kind == "interrupt":
            target = event.get("response_id")
            if isinstance(target, str) and target in (state.active_response, state.last_response):
                state.suppressed.add(target)
            target = await suppress_turn(upstream, state, manual=True)
            await send_json(browser, {"type": "interrupted", "response_id": target, "reason": "manual"})


async def run_tools(browser, upstream, state: TurnState, calls: list[dict], epoch: int) -> None:
    pending = [call for call in calls if isinstance(call, dict) and isinstance(call.get("call_id"), str)]
    try:
        for call in pending:
            if epoch != state.epoch:
                raise asyncio.CancelledError
            call_id = call["call_id"]
            if call_id in state.executed_calls:
                continue
            try:
                arguments = json.loads(call.get("arguments") or "{}")
            except (ValueError, TypeError):
                arguments = None
            name = call.get("name")
            if not isinstance(arguments, dict) or arguments:
                answer, label = {"error": "工具参数无效"}, "参数无效"
            elif name == "get_local_time":
                now = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")
                answer, label = {"beijing_time": now}, now
            elif name == "list_capabilities":
                answer, label = {"tools": CAPABILITIES, "external_brain": False}, "已返回实际工具清单"
            else:
                answer, label = {"error": "此工具未接入"}, "不可用"
            # Mark before awaiting to avoid duplicate tool outputs if cancelled.
            state.executed_calls.add(call_id)
            await send_json(upstream, {"type": "conversation.item.create", "item": {
                "type": "function_call_output", "call_id": call_id,
                "output": json.dumps(answer, ensure_ascii=False)}})
            if epoch != state.epoch:
                raise asyncio.CancelledError
            await send_json(browser, {"type": "tool", "name": name if name in {t['name'] for t in TOOLS} else "unknown",
                                      "result": label})
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


async def from_higgs(browser, upstream, state: TurnState) -> None:
    async for raw in upstream:
        event = json.loads(raw)
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        raw_response_id = event.get("response_id")
        response_id = state.current_identity.get(raw_response_id, raw_response_id) if raw_response_id else (
            state.active_response or state.last_response)
        if kind == "error":
            error = event.get("error") or {}
            if isinstance(error, dict) and error.get("code") in {"response_not_active", "response_id_mismatch"}:
                # Expected if manual stop raced the provider's own completion.
                continue
            await send_json(browser, {"type": "error", "message": error_message(event)})
            if isinstance(error, dict) and "insufficient_quota" in (error.get("type"), error.get("code")):
                return
        elif kind == "response.created":
            response = event.get("response") or {}
            raw_response_id = response.get("id")
            if not isinstance(raw_response_id, str):
                continue
            # Observed live: cancelled/merged speech turns can reuse Boson's ID.
            # Each response.created is a fresh generation; the browser must not
            # mistake it for previously suppressed playback with the same ID.
            generation = state.response_generations.get(raw_response_id, 0) + 1
            state.response_generations[raw_response_id] = generation
            response_id = raw_response_id if generation == 1 else f"{raw_response_id}:generation:{generation}"
            state.current_identity[raw_response_id] = response_id
            state.upstream_identity[response_id] = raw_response_id
            state.active_response = state.last_response = response_id
            metadata = response.get("metadata") or {}
            stale = isinstance(metadata, dict) and metadata.get("amadeus_epoch") not in (None, str(state.epoch))
            if stale or state.block_until_input or state.speaking:
                state.suppressed.add(response_id)
                state.cancel_sent.add(response_id)
                await send_json(browser, {"type": "response_suppressed", "response_id": response_id})
                await send_json(upstream, {"type": "response.cancel", "response_id": raw_response_id})
            else:
                await send_json(browser, {"type": "response_started", "response_id": response_id})
        elif kind == "input_audio_buffer.speech_started":
            target = await suppress_turn(upstream, state, manual=False)
            state.speaking = True
            state.block_until_input = False
            await send_json(browser, {"type": "speech_started", "response_id": target,
                "audio_start_ms": event.get("audio_start_ms"), "item_id": event.get("item_id")})
            await send_json(browser, {"type": "interrupted", "response_id": target, "reason": "turn_detected"})
        elif kind == "input_audio_buffer.speech_stopped":
            state.speaking = False
            await send_json(browser, {"type": "speech_stopped", "audio_end_ms": event.get("audio_end_ms"),
                                      "item_id": event.get("item_id")})
        elif kind == "conversation.item.input_audio_transcription.completed":
            await send_json(browser, {"type": "input_transcript", "text": event.get("transcript") or "",
                                      "item_id": event.get("item_id"), "final": True})
        elif kind in {"response.output_audio.delta", "response.output_audio_transcript.delta", "response.output_text.delta"}:
            if response_id and response_id not in state.suppressed and not state.block_until_input:
                delta = event.get("delta")
                if isinstance(delta, str) and delta:
                    audio = kind == "response.output_audio.delta"
                    await send_json(browser, {"type": "audio" if audio else "output_transcript",
                        "response_id": response_id, "item_id": event.get("item_id"),
                        "data" if audio else "text": delta})
        elif kind == "response.done":
            response = event.get("response") or {}
            raw_response_id = response.get("id")
            response_id = state.current_identity.get(raw_response_id, raw_response_id)
            if state.active_response == response_id:
                state.active_response = None
            if response.get("status") == "cancelled" or response_id in state.suppressed:
                if response_id:
                    state.suppressed.add(response_id)
                await send_json(browser, {"type": "interrupted", "response_id": response_id,
                    "provider_cancelled": response.get("status") == "cancelled"})
                continue
            if response.get("status") in {"failed", "incomplete"}:
                # Reserved by Boson's schema even though the current service
                # documents completed/cancelled only. Never echo error details.
                await send_json(browser, {"type": "error", "message": "Higgs 本次回答失败或未完整生成，请重试。"})
                await send_json(browser, {"type": "turn_complete", "response_id": response_id,
                                          "status": response.get("status")})
                continue
            calls = [item for item in response.get("output", [])
                     if isinstance(item, dict) and item.get("type") == "function_call"]
            if calls:
                state.tool_task = asyncio.create_task(run_tools(browser, upstream, state, calls, state.epoch))
            else:
                await send_json(browser, {"type": "turn_complete", "response_id": response_id,
                                          "status": response.get("status")})
        elif kind in {"session.idle_timeout", "session.max_duration_reached"}:
            await send_json(browser, {"type": "error", "message": "Higgs 会话已达到空闲或时长限制，请重新连接。"})
            return


async def handle_higgs(browser, config: dict[str, str], start: dict) -> None:
    """Own one Higgs WS session; config is server-only and never sent to browser."""
    voice = start.get("voice") or "default"
    if not valid_voice(voice):
        await send_json(browser, {"type": "error", "message": "Higgs 音色配置无效。"})
        return
    if start.get("brain") not in (None, "off"):
        await send_json(browser, {"type": "error", "message": "Higgs 当前尚未接入外部大脑，请选择关闭。"})
        return
    key = (config.get("BOSON_API_KEY") or "").strip()
    if not key:
        await send_json(browser, {"type": "error", "message": "请先在 backend/.env 配置 BOSON_API_KEY，并在 Boson 控制台领取试用额度。"})
        return
    state, tasks = TurnState(), []
    try:
        async with websockets.connect(UPSTREAM, additional_headers={"Authorization": f"Bearer {key}"},
                open_timeout=20, close_timeout=5, max_size=16 * 1024 * 1024) as upstream:
            await send_json(upstream, setup_message(voice, start.get("instructions", "")))
            deadline = asyncio.get_running_loop().time() + 20
            while True:
                event = json.loads(await asyncio.wait_for(
                        upstream.recv(), timeout=max(0.0, deadline - asyncio.get_running_loop().time())))
                if event.get("type") == "error":
                    await send_json(browser, {"type": "error", "message": error_message(event)})
                    return
                if event.get("type") in {"session.created", "session.updated"}:
                    # Boson acknowledges the FIRST session.update with
                    # session.created (not on socket open); later updates
                    # get session.updated. Both contain applied config:
                    # docs.boson.ai/api-reference/realtime/client-events
                    break
            await send_json(browser, {"type": "ready", "model": MODEL, "voice": voice,
                "capabilities": CAPABILITIES, "input_sample_rate": INPUT_RATE, "output_sample_rate": OUTPUT_RATE,
                "input_transcription_model": TRANSCRIPTION_MODEL, "separate_input_transcription": True,
                "turn_detection": "semantic_vad"})
            tasks = [asyncio.create_task(from_browser(browser, upstream, state)),
                     asyncio.create_task(from_higgs(browser, upstream, state))]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
    except websockets.exceptions.ConnectionClosed as exc:
        code = exc.rcvd.code if exc.rcvd else 1006
        if code not in (1000, 1001):
            message = {3000: "Higgs API Key 无效或已过期。", 4429: "Higgs 没有可用额度或已达到消费上限。",
                       1013: "Higgs 并发会话已达上限，请稍后重试。"}.get(code, "Higgs 会话连接中断，请检查网络后重新连接。")
            try:
                await send_json(browser, {"type": "error", "message": message})
            except websockets.exceptions.ConnectionClosed:
                pass
    except (OSError, TimeoutError, asyncio.TimeoutError, ValueError, TypeError, websockets.exceptions.WebSocketException):
        try:
            await send_json(browser, {"type": "error", "message": "Higgs 连接失败，请检查本机网络、密钥和试用额度。"})
        except websockets.exceptions.ConnectionClosed:
            pass
    finally:
        pending = tasks + ([state.tool_task] if state.tool_task else [])
        for task in pending:
            if not task.done():
                task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
